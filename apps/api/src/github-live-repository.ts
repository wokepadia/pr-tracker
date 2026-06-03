import type {
  Actor,
  PullRequestActivity,
  PullRequestChangedFile,
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
  type GitHubChangedFileSnapshot,
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

  async function loadInbox(now = new Date().toISOString()): Promise<{
    actors: Actor[];
    inbox: ReviewerInbox;
    pullRequests: PullRequestItem[];
    viewer: Actor;
  }> {
    const viewerLogin = await getViewerLogin();
    const snapshots = await listPullRequests(input.source);
    const pullRequests = snapshots.map(snapshotToPullRequestItem);
    const actors = buildActors(pullRequests, [viewerLogin]);
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
    async getReviewerInbox(now) {
      const { inbox } = await loadInbox(now);
      return inbox;
    },

    async getPullRequest(id): Promise<PullRequestDetail | undefined> {
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
  source: ViewerAwareGithubSource
): Promise<GitHubPullRequestSnapshot[]> {
  if (source.listPullRequests) {
    return source.listPullRequests();
  }

  if (source.listOpenPullRequests) {
    return source.listOpenPullRequests();
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
        closedLookbackDays: getGithubClosedLookbackDays(env)
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
}): ReviewerInboxRepository {
  return createGithubLiveRepository({
    source: createGithubTokenPullRequestSource({
      token: input.token,
      repositories: input.repositories,
      apiBaseUrl: input.apiBaseUrl,
      closedLookbackDays: input.closedLookbackDays
    }),
    viewerLogin: input.viewerLogin
  });
}

function snapshotToPullRequestItem(
  snapshot: GitHubPullRequestSnapshot
): PullRequestItem {
  const pullRequest = snapshot.pull_request;
  const repository = snapshot.repository.full_name;
  const number = pullRequest.number ?? 0;
  const authorLogin = pullRequest.user?.login ?? "unknown";
  const updatedAt = pullRequest.updated_at ?? new Date().toISOString();

  return {
    id: livePullRequestId(repository, number),
    repository,
    number,
    title: pullRequest.title ?? "Untitled pull request",
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
    reviews: (snapshot.reviews ?? []).flatMap(mapReview),
    threads: [],
    activity: buildActivity(snapshot),
    changedFiles: mapChangedFiles(snapshot.changed_files, updatedAt)
  };
}

function livePullRequestId(repository: string, number: number): string {
  return `github:${repository.replace("/", "~")}:${number}`;
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
  const activity: PullRequestActivity[] = [
    {
      id: `${livePullRequestId(repository, number)}:updated`,
      type: "pull_request",
      actorId: authorLogin,
      occurredAt: updatedAt,
      title: `${authorLogin} updated this pull request`
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

function mapChangedFiles(
  files: GitHubChangedFileSnapshot[] | undefined,
  changedAt: string
): PullRequestChangedFile[] {
  return (files ?? []).map((file) => ({
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
    changedAt
  }));
}

function buildActors(
  pullRequests: PullRequestItem[],
  extraLogins: string[]
): Actor[] {
  const logins = new Set(extraLogins);

  for (const pullRequest of pullRequests) {
    logins.add(pullRequest.authorId);
    pullRequest.requestedReviewerIds.forEach((login) => logins.add(login));
    pullRequest.reviews.forEach((review) => logins.add(review.reviewerId));
    pullRequest.activity.forEach((event) => logins.add(event.actorId));
  }

  return Array.from(logins).map((login) => ({ id: login, login }));
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
