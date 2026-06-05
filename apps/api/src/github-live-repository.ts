import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecision,
  ReviewDecisionEvent
} from "@pr-tracker/core";
import {
  buildReviewerInbox,
  type ReviewerInbox
} from "@pr-tracker/reviewer-workflow";
import {
  createGithubTokenPullRequestSource,
  getGithubClosedLookbackDays,
  getGithubTokenEnv,
  parseGithubRepositories,
  type GitHubPullRequestSnapshot,
  type GitHubPullRequestSource,
  type GitHubReviewSnapshot
} from "@pr-tracker/github";
import type {
  PullRequestDetail,
  ReviewerInboxRepository
} from "./repository";

type ViewerAwareGithubSource = GitHubPullRequestSource & {
  getViewerLogin?: () => Promise<string>;
};

export function createGithubLiveRepository(input: {
  source: ViewerAwareGithubSource;
  viewerLogin?: string;
}): ReviewerInboxRepository {
  const lastSeenAtByPullRequestId: Record<string, string | undefined> = {};
  let resolvedViewerLogin = input.viewerLogin;

  async function getViewerLogin(): Promise<string> {
    if (resolvedViewerLogin) {
      return resolvedViewerLogin;
    }

    if (!input.source.getViewerLogin) {
      throw new Error(
        "PR_TRACKER_VIEWER_LOGIN is required when the GitHub source cannot resolve the viewer."
      );
    }

    resolvedViewerLogin = await input.source.getViewerLogin();
    return resolvedViewerLogin;
  }

  async function loadInbox(
    now = new Date().toISOString(),
    options?: { githubSearchQuery?: string }
  ): Promise<{
    actors: Actor[];
    inbox: ReviewerInbox;
    pullRequests: PullRequestItem[];
    viewer: Actor;
  }> {
    const viewerLogin = await getViewerLogin();
    const snapshots = await listPullRequests(input.source, options);
    const pullRequests = snapshots.map(snapshotToPullRequestItem);
    const actors = buildActors(pullRequests, [viewerLogin], snapshots);
    const viewer = ensureActor(actors, viewerLogin);
    const inbox = buildReviewerInbox({
      viewer,
      actors,
      pullRequests,
      now,
      lastSeenAtByPullRequestId
    });

    return { actors, inbox, pullRequests, viewer };
  }

  return {
    async getReviewerInbox(now, options) {
      const { inbox } = await loadInbox(now, options);
      return inbox;
    },

    async getPullRequest(id): Promise<PullRequestDetail | undefined> {
      if (input.source.getPullRequest) {
        const lookup = lookupFromLivePullRequestId(id);
        if (lookup) {
          const viewerLogin = await getViewerLogin();
          const snapshot = await input.source.getPullRequest(lookup);
          if (!snapshot) {
            return undefined;
          }

          const pullRequests = [snapshotToPullRequestItem(snapshot)];
          const actors = buildActors(pullRequests, [viewerLogin], [snapshot]);
          const viewer = ensureActor(actors, viewerLogin);
          const inbox = buildReviewerInbox({
            viewer,
            actors,
            pullRequests,
            now: new Date().toISOString(),
            lastSeenAtByPullRequestId
          });
          const item = inbox.items[0];

          return item ? { viewer, actors, item } : undefined;
        }
      }

      const { actors, inbox, viewer } = await loadInbox();
      const item = inbox.items.find((candidate) => candidate.pullRequest.id === id);

      return item ? { viewer, actors, item } : undefined;
    },

    async markSeen(input) {
      const { pullRequests } = await loadInbox();
      const pullRequest = pullRequests.find((item) => item.id === input.pullRequestId);

      if (!pullRequest) {
        return undefined;
      }

      lastSeenAtByPullRequestId[input.pullRequestId] = input.lastSeenAt;
      return input;
    }
  };
}

function listPullRequests(
  source: ViewerAwareGithubSource,
  options?: { githubSearchQuery?: string }
): Promise<GitHubPullRequestSnapshot[]> {
  if (source.listPullRequests) {
    return source.listPullRequests({ searchQuery: options?.githubSearchQuery });
  }

  if (source.listOpenPullRequests) {
    return source.listOpenPullRequests({ searchQuery: options?.githubSearchQuery });
  }

  throw new Error("GitHub source must provide a pull request list method.");
}

export function createGithubLiveRepositoryFromEnv(
  env: Record<string, string | undefined> = process.env
): ReviewerInboxRepository | undefined {
  const tokenEnv = getGithubTokenEnv(env);
  if (tokenEnv) {
    return createGithubLiveRepository({
      source: createGithubTokenPullRequestSource({
        token: tokenEnv.GITHUB_TOKEN,
        repositories: parseGithubRepositories(tokenEnv.GITHUB_REPOSITORIES),
        apiBaseUrl: tokenEnv.GITHUB_API_BASE_URL,
        closedLookbackDays: getGithubClosedLookbackDays(env),
        maxPullRequests: getGithubMaxPullRequests(env)
      }),
      viewerLogin: env.PR_TRACKER_VIEWER_LOGIN
    });
  }

  return undefined;
}

export function createGithubLiveRepositoryFromCredentials(input: {
  token: string;
  repositories: string[];
  viewerLogin?: string;
  apiBaseUrl?: string;
  closedLookbackDays?: number;
  maxPullRequests?: number;
}): ReviewerInboxRepository {
  return createGithubLiveRepository({
    source: createGithubTokenPullRequestSource({
      token: input.token,
      repositories: input.repositories,
      apiBaseUrl: input.apiBaseUrl,
      closedLookbackDays: input.closedLookbackDays,
      maxPullRequests: input.maxPullRequests
    }),
    viewerLogin: input.viewerLogin
  });
}

function getGithubMaxPullRequests(
  env: Record<string, string | undefined>
): number | undefined {
  const raw = env.GITHUB_MAX_PULL_REQUESTS;
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function snapshotToPullRequestItem(
  snapshot: GitHubPullRequestSnapshot
): PullRequestItem {
  const pullRequest = snapshot.pull_request;
  const repository = snapshot.repository.full_name;
  const number = pullRequest.number ?? 0;
  const authorLogin = pullRequest.user?.login ?? "unknown";
  const updatedAt = pullRequest.updated_at ?? new Date().toISOString();
  const reviews = compactReviewsForInbox(snapshot.reviews ?? []);

  return {
    id: livePullRequestId(repository, number),
    repository,
    number,
    title: pullRequest.title ?? "Untitled pull request",
    description: cleanPullRequestDescription(pullRequest.body),
    url: pullRequest.html_url ?? `https://github.com/${repository}/pull/${number}`,
    authorId: authorLogin,
    state: pullRequest.merged ? "merged" : normalizePullRequestState(pullRequest.state),
    isDraft: pullRequest.draft ?? false,
    createdAt: pullRequest.created_at ?? updatedAt,
    updatedAt,
    latestCommitSha: pullRequest.head?.sha ?? "",
    requestedReviewerIds: (pullRequest.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => Boolean(login)),
    reviews: reviews.flatMap(mapReview),
    threads: [],
    activity: buildActivity({ ...snapshot, reviews })
  };
}

function cleanPullRequestDescription(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function compactReviewsForInbox(
  reviews: GitHubReviewSnapshot[]
): GitHubReviewSnapshot[] {
  const latestByReviewer = new Map<string, GitHubReviewSnapshot>();
  const newestReviews = reviews
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.submitted_at ?? "") - Date.parse(a.submitted_at ?? "")
    );

  for (const review of newestReviews) {
    const reviewerLogin = review.user?.login;
    if (!reviewerLogin || latestByReviewer.has(reviewerLogin)) {
      continue;
    }

    latestByReviewer.set(reviewerLogin, review);
  }

  return uniqueReviewsById([...newestReviews.slice(0, 20), ...latestByReviewer.values()])
    .sort(
      (a, b) =>
        Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? "")
    );
}

function uniqueReviewsById(
  reviews: GitHubReviewSnapshot[]
): GitHubReviewSnapshot[] {
  const seenIds = new Set<string>();
  const uniqueReviews: GitHubReviewSnapshot[] = [];

  for (const review of reviews) {
    const id = review.node_id ?? String(review.id);
    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    uniqueReviews.push(review);
  }

  return uniqueReviews;
}

function livePullRequestId(repository: string, number: number): string {
  return `github:${repository.replace("/", "~")}:${number}`;
}

function lookupFromLivePullRequestId(
  id: string
): { repository: string; number: number } | undefined {
  const match = /^github:([^:]+):(\d+)$/.exec(id);
  if (!match) {
    return undefined;
  }

  const repository = match[1]?.replace("~", "/");
  const number = Number.parseInt(match[2] ?? "", 10);
  if (!repository || !Number.isFinite(number)) {
    return undefined;
  }

  return { repository, number };
}

function normalizePullRequestState(state: string | undefined): PullRequestItem["state"] {
  if (state === "closed") {
    return "closed";
  }

  if (state === "merged") {
    return "merged";
  }

  return "open";
}

function mapReview(review: GitHubReviewSnapshot): ReviewDecisionEvent[] {
  const reviewerId = review.user?.login;
  if (!reviewerId) {
    return [];
  }

  return [
    {
      id: review.node_id ?? String(review.id),
      reviewerId,
      decision: mapReviewDecision(review.state),
      submittedAt: review.submitted_at ?? new Date().toISOString(),
      commitSha: review.commit_id,
      body: review.body ?? undefined
    }
  ];
}

function mapReviewDecision(state: string | undefined): ReviewDecision {
  if (state?.toLowerCase() === "approved") {
    return "approved";
  }

  if (state?.toLowerCase() === "changes_requested") {
    return "changes_requested";
  }

  return "commented";
}

function buildActivity(snapshot: GitHubPullRequestSnapshot): PullRequestActivity[] {
  const pullRequest = snapshot.pull_request;
  const repository = snapshot.repository.full_name;
  const number = pullRequest.number ?? 0;
  const updatedAt = pullRequest.updated_at ?? new Date().toISOString();
  const authorLogin = pullRequest.user?.login ?? "unknown";
  const pullRequestUrl = pullRequest.html_url ?? `https://github.com/${repository}/pull/${number}`;
  const activity: PullRequestActivity[] = [
    {
      id: `${livePullRequestId(repository, number)}:updated`,
      type: "pull_request",
      actorId: authorLogin,
      occurredAt: updatedAt,
      title: `${authorLogin} updated this pull request`,
      url: pullRequestUrl,
      diffUrl: `${pullRequestUrl}/files`
    }
  ];

  for (const reviewer of pullRequest.requested_reviewers ?? []) {
    if (!reviewer.login) {
      continue;
    }

    activity.push({
      id: `${livePullRequestId(repository, number)}:review-request:${reviewer.login}`,
      type: "review_request",
      actorId: authorLogin,
      occurredAt: updatedAt,
      title: `${authorLogin} requested review from ${reviewer.login}`
    });
  }

  for (const review of snapshot.reviews ?? []) {
    if (!review.user?.login) {
      continue;
    }

    activity.push({
      id: `${livePullRequestId(repository, number)}:review:${review.node_id ?? review.id}`,
      type: "review",
      actorId: review.user.login,
      occurredAt: review.submitted_at ?? updatedAt,
      title: `${review.user.login} ${reviewTitle(review.state)}`,
      body: review.body ?? undefined
    });
  }

  return activity.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
  );
}

function reviewTitle(state: string | undefined): string {
  const normalizedState = state?.toLowerCase();
  if (normalizedState === "approved") {
    return "approved this pull request";
  }

  if (normalizedState === "changes_requested") {
    return "requested changes";
  }

  return "reviewed this pull request";
}

function buildActors(
  pullRequests: PullRequestItem[],
  extraLogins: string[],
  snapshots: GitHubPullRequestSnapshot[] = []
): Actor[] {
  const actors = new Map<string, Actor>();

  for (const login of extraLogins) {
    upsertActor(actors, login);
  }

  for (const snapshot of snapshots) {
    upsertActor(
      actors,
      snapshot.pull_request.user?.login,
      snapshot.pull_request.user?.avatar_url
    );
    for (const reviewer of snapshot.pull_request.requested_reviewers ?? []) {
      upsertActor(actors, reviewer.login, reviewer.avatar_url);
    }
    for (const review of snapshot.reviews ?? []) {
      upsertActor(actors, review.user?.login, review.user?.avatar_url);
    }
  }

  for (const pullRequest of pullRequests) {
    upsertActor(actors, pullRequest.authorId);
    pullRequest.requestedReviewerIds.forEach((login) => upsertActor(actors, login));
    pullRequest.reviews.forEach((review) => upsertActor(actors, review.reviewerId));
    pullRequest.activity.forEach((event) => upsertActor(actors, event.actorId));
  }

  return Array.from(actors.values());
}

function upsertActor(
  actors: Map<string, Actor>,
  login: string | undefined,
  avatarUrl?: string
): void {
  if (!login) {
    return;
  }

  const existing = actors.get(login);
  actors.set(login, {
    id: login,
    login,
    avatarUrl: existing?.avatarUrl ?? avatarUrl
  });
}

function ensureActor(actors: Actor[], id: string): Actor {
  const actor = actors.find((candidate) => candidate.id === id);
  if (actor) {
    return actor;
  }

  const created = { id, login: id };
  actors.push(created);
  return created;
}
