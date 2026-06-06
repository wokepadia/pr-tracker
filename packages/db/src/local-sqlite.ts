import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  sampleLastSeenAtByPullRequestId,
  samplePullRequests,
  type PullRequestActivity,
  type PullRequestItem,
  type ReviewDecisionEvent,
  type ReviewThread
} from "@pr-tracker/core";
import type {
  GitHubPullRequestSnapshot,
  GitHubReviewSnapshot
} from "@pr-tracker/github";
import { deterministicUuid } from "./ids";
import { localDesktopSchemaSql } from "./local-schema";

export const defaultLocalProfileId = "local";
export const defaultLocalBoardId = "default-board";

export interface LocalDatabase {
  db: DatabaseSync;
  close(): void;
}

export interface OpenLocalDatabaseOptions {
  path?: string;
  initialize?: boolean;
}

export interface LocalPullRequestRow {
  id: string;
  repository_full_name: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  author_login: string;
  state: string;
  is_draft: number;
  latest_commit_sha: string | null;
  github_created_at: string | null;
  github_updated_at: string | null;
  raw_payload_json: string;
}

export interface LocalReviewRequestRow {
  pull_request_id: string;
  reviewer_kind: "user" | "team";
  login: string | null;
  team_slug: string | null;
}

export interface LocalReviewEventRow {
  id: string;
  pull_request_id: string;
  reviewer_login: string;
  decision: ReviewDecisionEvent["decision"];
  commit_sha: string | null;
  body: string | null;
  submitted_at: string;
}

export interface LocalReviewThreadRow {
  id: string;
  pull_request_id: string;
  is_resolved: number;
  file_path: string | null;
  line: number | null;
  last_activity_at: string;
}

export interface LocalReviewThreadParticipantRow {
  review_thread_id: string;
  login: string;
}

export interface LocalActivityEventRow {
  id: string;
  pull_request_id: string;
  event_type: PullRequestActivity["type"];
  actor_login: string;
  occurred_at: string;
  title: string;
  body: string | null;
  url: string | null;
  diff_url: string | null;
}

export interface LocalBoardItemStateRow {
  pull_request_id: string;
  column_id: string | null;
  sort_order: number;
  last_seen_at: string | null;
  is_snoozed: number;
  is_muted: number;
  is_pinned: number;
  archived_at: string | null;
}

export interface LocalBoardColumnRow {
  id: string;
  name: string;
  sort_order: number;
  width_px: number;
}

export interface SaveLocalBoardColumnInput {
  id: string;
  name: string;
  sortOrder: number;
  widthPx: number;
}

export interface SaveLocalBoardItemInput {
  pullRequestId: string;
  columnId: string;
  sortOrder: number;
  snoozed?: boolean;
  muted?: boolean;
  pinned?: boolean;
}

export interface SaveLocalBoardStateInput {
  boardId?: string;
  columns: SaveLocalBoardColumnInput[];
  items: SaveLocalBoardItemInput[];
}

export interface UpsertLocalPullRequestSnapshotResult {
  pullRequestId: string;
  isFreshEnough: boolean;
}

export function defaultLocalDatabasePath(): string {
  return (
    process.env.PR_TRACKER_LOCAL_DB_PATH ??
    join(homedir(), ".pr-tracker", "pr-tracker.sqlite")
  );
}

export function openLocalDatabase(
  options: OpenLocalDatabaseOptions = {}
): LocalDatabase {
  const path = options.path ?? defaultLocalDatabasePath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("pragma foreign_keys = on");

  if (options.initialize !== false) {
    initializeLocalDatabase(db);
  }

  return {
    db,
    close() {
      db.close();
    }
  };
}

export function initializeLocalDatabase(db: DatabaseSync): void {
  db.exec(localDesktopSchemaSql);
}

export function seedLocalSampleData(
  db: DatabaseSync,
  options: { profileId?: string; viewerLogin?: string } = {}
): void {
  const profileId = options.profileId ?? defaultLocalProfileId;
  const viewerLogin = options.viewerLogin ?? "viewer";
  const now = new Date().toISOString();

  transaction(db, () => {
    upsertLocalProfile(db, {
      id: profileId,
      githubLogin: viewerLogin,
      displayName: viewerLogin === "viewer" ? "you" : viewerLogin,
      now
    });
    ensureDefaultBoard(db, profileId, now);

    for (const pullRequest of samplePullRequests) {
      upsertLocalPullRequest(db, pullRequest, now);
      ensureDefaultBoardItem(db, pullRequest, now);
    }

    for (const [pullRequestId, lastSeenAt] of Object.entries(
      sampleLastSeenAtByPullRequestId
    )) {
      setLocalBoardItemSeenAt(db, pullRequestId, lastSeenAt ?? null, now);
    }
  });
}

export function upsertLocalPullRequestSnapshot(
  db: DatabaseSync,
  snapshot: GitHubPullRequestSnapshot,
  options: {
    profileId?: string;
    viewerLogin?: string;
  } = {}
): UpsertLocalPullRequestSnapshotResult {
  const pullRequest = snapshotToPullRequestItem(snapshot);
  const githubNodeId = githubNodeIdFromSnapshot(snapshot);
  const incomingUpdatedAt = pullRequest.updatedAt;
  const isFreshEnough = isFreshEnoughLocalPullRequestPayload(
    db,
    githubNodeId,
    incomingUpdatedAt
  );
  const now = new Date().toISOString();
  const profileId = options.profileId ?? defaultLocalProfileId;
  const viewerLogin = options.viewerLogin ?? "viewer";

  transaction(db, () => {
    upsertLocalProfile(db, {
      id: profileId,
      githubLogin: viewerLogin,
      displayName: viewerLogin,
      now
    });
    ensureDefaultBoard(db, profileId, now);

    if (isFreshEnough) {
      upsertLocalPullRequest(db, pullRequest, now, {
        githubNodeId,
        rawPayload: snapshot
      });
      ensureDefaultBoardItem(db, pullRequest, now);
    }
  });

  return { pullRequestId: pullRequest.id, isFreshEnough };
}

export function listLocalPullRequestRows(
  db: DatabaseSync,
  input: { id?: string } = {}
): LocalPullRequestRow[] {
  return db
    .prepare(
      `
        select
          pr.id,
          repo.full_name as repository_full_name,
          pr.number,
          pr.title,
          pr.body,
          pr.url,
          coalesce(author.login, 'unknown') as author_login,
          pr.state,
          pr.is_draft,
          pr.latest_commit_sha,
          pr.github_created_at,
          pr.github_updated_at,
          pr.raw_payload_json
        from pull_requests pr
        join github_repositories repo on repo.id = pr.repository_id
        left join github_accounts author on author.id = pr.author_account_id
        where ($id is null or pr.id = $id)
          and ($id is not null or pr.state = 'open')
        order by pr.github_updated_at desc
        limit 250
      `
    )
    .all({ $id: input.id ?? null }) as unknown as LocalPullRequestRow[];
}

export function listLocalReviewRequestRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalReviewRequestRow[] {
  return db
    .prepare(
      `
        select
          rr.pull_request_id,
          rr.reviewer_kind,
          account.login,
          team.slug as team_slug
        from pull_request_review_requests rr
        left join github_accounts account on account.id = rr.account_id
        left join github_teams team on team.id = rr.team_id
        where rr.pull_request_id = ?
        order by rr.created_at asc
      `
    )
    .all(pullRequestId) as unknown as LocalReviewRequestRow[];
}

export function listLocalReviewEventRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalReviewEventRow[] {
  return db
    .prepare(
      `
        select
          review.id,
          review.pull_request_id,
          coalesce(account.login, 'unknown') as reviewer_login,
          review.decision,
          review.commit_sha,
          review.body,
          review.submitted_at
        from review_events review
        left join github_accounts account on account.id = review.reviewer_account_id
        where review.pull_request_id = ?
        order by review.submitted_at desc
      `
    )
    .all(pullRequestId) as unknown as LocalReviewEventRow[];
}

export function listLocalReviewThreadRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalReviewThreadRow[] {
  return db
    .prepare(
      `
        select
          id,
          pull_request_id,
          is_resolved,
          file_path,
          line,
          last_activity_at
        from review_threads
        where pull_request_id = ?
        order by last_activity_at desc
      `
    )
    .all(pullRequestId) as unknown as LocalReviewThreadRow[];
}

export function listLocalReviewThreadParticipantRows(
  db: DatabaseSync,
  threadIds: string[]
): LocalReviewThreadParticipantRow[] {
  if (threadIds.length === 0) return [];

  const placeholders = threadIds.map(() => "?").join(", ");
  return db
    .prepare(
      `
        select
          participant.review_thread_id,
          account.login
        from review_thread_participants participant
        join github_accounts account on account.id = participant.account_id
        where participant.review_thread_id in (${placeholders})
        order by participant.id asc
      `
    )
    .all(...threadIds) as unknown as LocalReviewThreadParticipantRow[];
}

export function listLocalActivityEventRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalActivityEventRow[] {
  return db
    .prepare(
      `
        select
          activity.id,
          activity.pull_request_id,
          activity.event_type,
          coalesce(actor.login, 'unknown') as actor_login,
          activity.occurred_at,
          activity.title,
          activity.body,
          json_extract(activity.raw_payload_json, '$.url') as url,
          json_extract(activity.raw_payload_json, '$.diffUrl') as diff_url
        from activity_events activity
        left join github_accounts actor on actor.id = activity.actor_account_id
        where activity.pull_request_id = ?
        order by activity.occurred_at asc
      `
    )
    .all(pullRequestId) as unknown as LocalActivityEventRow[];
}

export function listLocalBoardItemStateRows(
  db: DatabaseSync,
  boardId = defaultLocalBoardId
): LocalBoardItemStateRow[] {
  return db
    .prepare(
      `
        select
          pull_request_id,
          column_id,
          sort_order,
          last_seen_at,
          is_snoozed,
          is_muted,
          is_pinned,
          archived_at
        from board_items
        where board_id = ? and archived_at is null
        order by column_id asc, sort_order asc, pull_request_id asc
      `
    )
    .all(boardId) as unknown as LocalBoardItemStateRow[];
}

export function listLocalBoardColumnRows(
  db: DatabaseSync,
  boardId = defaultLocalBoardId
): LocalBoardColumnRow[] {
  return db
    .prepare(
      `
        select id, name, sort_order, width_px
        from board_columns
        where board_id = ? and archived_at is null
        order by sort_order asc, created_at asc
      `
    )
    .all(boardId) as unknown as LocalBoardColumnRow[];
}

export function saveLocalBoardState(
  db: DatabaseSync,
  input: SaveLocalBoardStateInput
): void {
  const boardId = input.boardId ?? defaultLocalBoardId;
  const now = new Date().toISOString();
  const activeColumnIds = new Set(input.columns.map((column) => column.id));

  transaction(db, () => {
    for (const column of input.columns) {
      db.prepare(
        `
          insert into board_columns (
            id,
            board_id,
            name,
            sort_order,
            width_px,
            created_at,
            updated_at,
            archived_at
          )
          values (?, ?, ?, ?, ?, ?, ?, null)
          on conflict(id)
          do update set
            name = excluded.name,
            sort_order = excluded.sort_order,
            width_px = excluded.width_px,
            archived_at = null,
            updated_at = excluded.updated_at
        `
      ).run(
        column.id,
        boardId,
        column.name,
        column.sortOrder,
        column.widthPx,
        now,
        now
      );
    }

    for (const column of listLocalBoardColumnRows(db, boardId)) {
      if (!activeColumnIds.has(column.id)) {
        db.prepare(
          `
            update board_columns
            set archived_at = ?, updated_at = ?
            where id = ? and board_id = ?
          `
        ).run(now, now, column.id, boardId);
      }
    }

    for (const item of input.items) {
      db.prepare(
        `
          insert into board_items (
            id,
            board_id,
            pull_request_id,
            column_id,
            sort_order,
            is_snoozed,
            is_muted,
            is_pinned,
            created_at,
            updated_at,
            archived_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
          on conflict(board_id, pull_request_id)
          do update set
            column_id = excluded.column_id,
            sort_order = excluded.sort_order,
            is_snoozed = excluded.is_snoozed,
            is_muted = excluded.is_muted,
            is_pinned = excluded.is_pinned,
            archived_at = null,
            updated_at = excluded.updated_at
        `
      ).run(
        deterministicUuid(`board-item:${boardId}:${item.pullRequestId}`),
        boardId,
        item.pullRequestId,
        item.columnId,
        item.sortOrder,
        boolToSqlite(Boolean(item.snoozed)),
        boolToSqlite(Boolean(item.muted)),
        boolToSqlite(Boolean(item.pinned)),
        now,
        now
      );
    }
  });
}

export function markLocalPullRequestSeen(
  db: DatabaseSync,
  input: {
    pullRequestId: string;
    lastSeenAt: string;
    boardId?: string;
  }
): boolean {
  const boardId = input.boardId ?? defaultLocalBoardId;
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
        update board_items
        set last_seen_at = ?, updated_at = ?
        where board_id = ? and pull_request_id = ?
      `
    )
    .run(input.lastSeenAt, now, boardId, input.pullRequestId);

  return result.changes > 0;
}

function upsertLocalProfile(
  db: DatabaseSync,
  input: {
    id: string;
    githubLogin: string;
    displayName: string;
    now: string;
  }
): void {
  const accountId = upsertGithubAccount(db, {
    login: input.githubLogin,
    avatarUrl: undefined,
    accountType: "user",
    now: input.now
  });

  db.prepare(
    `
      insert into local_profile (
        id,
        github_login,
        github_account_id,
        display_name,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?)
      on conflict(id)
      do update set
        github_login = excluded.github_login,
        github_account_id = excluded.github_account_id,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `
  ).run(input.id, input.githubLogin, accountId, input.displayName, input.now, input.now);
}

function ensureDefaultBoard(
  db: DatabaseSync,
  profileId: string,
  now: string
): void {
  db.prepare(
    `
      insert into boards (
        id,
        profile_id,
        name,
        is_default,
        sort_order,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set updated_at = excluded.updated_at
    `
  ).run(defaultLocalBoardId, profileId, "Default", 1, 0, now, now);

  const columns = [
    ["inbox", "Inbox", 0],
    ["reviewing", "Reviewing", 1],
    ["waiting", "Waiting", 2],
    ["later", "Later", 3],
    ["done", "Done", 4]
  ] as const;

  for (const [id, name, sortOrder] of columns) {
    db.prepare(
      `
        insert into board_columns (
          id,
          board_id,
          name,
          sort_order,
          width_px,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(id)
        do update set
          name = excluded.name,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `
    ).run(id, defaultLocalBoardId, name, sortOrder, 232, now, now);
  }
}

function upsertLocalPullRequest(
  db: DatabaseSync,
  pullRequest: PullRequestItem,
  now: string,
  options: {
    githubNodeId?: string;
    rawPayload?: unknown;
  } = {}
): void {
  const [owner, repoName = pullRequest.repository] = pullRequest.repository.split("/");
  const ownerAccountId = upsertGithubAccount(db, {
    login: owner ?? "unknown",
    accountType: "organization",
    now
  });
  const authorAccountId = upsertGithubAccount(db, {
    login: pullRequest.authorId,
    accountType: "user",
    now
  });
  const repositoryId = deterministicUuid(`repository:${pullRequest.repository}`);

  db.prepare(
    `
      insert into github_repositories (
        id,
        github_node_id,
        owner_account_id,
        full_name,
        name,
        is_private,
        html_url,
        raw_payload_json,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(full_name)
      do update set
        owner_account_id = excluded.owner_account_id,
        name = excluded.name,
        html_url = excluded.html_url,
        raw_payload_json = excluded.raw_payload_json,
        updated_at = excluded.updated_at
    `
  ).run(
    repositoryId,
    `repository:${pullRequest.repository}`,
    ownerAccountId,
    pullRequest.repository,
    repoName,
    0,
    `https://github.com/${pullRequest.repository}`,
    JSON.stringify({ full_name: pullRequest.repository }),
    now,
    now
  );

  db.prepare(
    `
      insert into tracked_repositories (
        id,
        profile_id,
        repository_id,
        sync_enabled,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?)
      on conflict(profile_id, repository_id)
      do update set updated_at = excluded.updated_at
    `
  ).run(
    deterministicUuid(`tracked-repository:${defaultLocalProfileId}:${repositoryId}`),
    defaultLocalProfileId,
    repositoryId,
    1,
    now,
    now
  );

  db.prepare(
    `
      insert into pull_requests (
        id,
        github_node_id,
        repository_id,
        number,
        title,
        body,
        url,
        author_account_id,
        state,
        is_draft,
        latest_commit_sha,
        github_created_at,
        github_updated_at,
        raw_payload_json,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(github_node_id)
      do update set
        title = excluded.title,
        body = excluded.body,
        url = excluded.url,
        author_account_id = excluded.author_account_id,
        state = excluded.state,
        is_draft = excluded.is_draft,
        latest_commit_sha = excluded.latest_commit_sha,
        github_created_at = excluded.github_created_at,
        github_updated_at = excluded.github_updated_at,
        raw_payload_json = excluded.raw_payload_json,
        updated_at = excluded.updated_at
    `
  ).run(
    pullRequest.id,
    options.githubNodeId ?? pullRequest.id,
    repositoryId,
    pullRequest.number,
    pullRequest.title,
    pullRequest.description ?? null,
    pullRequest.url,
    authorAccountId,
    pullRequest.state === "merged" ? "closed" : pullRequest.state,
    boolToSqlite(pullRequest.isDraft),
    pullRequest.latestCommitSha,
    pullRequest.createdAt,
    pullRequest.updatedAt,
    JSON.stringify(options.rawPayload ?? pullRequest),
    now,
    now
  );

  replaceLocalReviewRequests(db, pullRequest, now);
  replaceLocalReviews(db, pullRequest.reviews, pullRequest.id, now);
  replaceLocalThreads(db, pullRequest.threads, pullRequest.id, now);
  replaceLocalActivity(db, pullRequest.activity, pullRequest.id, now);
}

function snapshotToPullRequestItem(snapshot: GitHubPullRequestSnapshot): PullRequestItem {
  const pullRequest = snapshot.pull_request;
  const repository = snapshot.repository.full_name;
  const number = pullRequest.number ?? 0;
  const updatedAt = pullRequest.updated_at ?? new Date().toISOString();
  const reviews = compactReviewsForInbox(snapshot.reviews ?? []);
  const url = pullRequest.html_url ?? `https://github.com/${repository}/pull/${number}`;

  return {
    id: livePullRequestId(repository, number),
    repository,
    number,
    title: pullRequest.title ?? "Untitled pull request",
    description: cleanPullRequestDescription(pullRequest.body),
    url,
    authorId: pullRequest.user?.login ?? "unknown",
    state: pullRequest.merged ? "merged" : normalizeSnapshotPullRequestState(pullRequest.state),
    isDraft: pullRequest.draft ?? false,
    createdAt: pullRequest.created_at ?? updatedAt,
    updatedAt,
    latestCommitSha: pullRequest.head?.sha ?? "",
    requestedReviewerIds: (pullRequest.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => Boolean(login)),
    reviews: reviews.flatMap(mapSnapshotReview),
    threads: [],
    activity: buildSnapshotActivity({ ...snapshot, reviews })
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

function mapSnapshotReview(review: GitHubReviewSnapshot): ReviewDecisionEvent[] {
  const reviewerId = review.user?.login;
  if (!reviewerId) {
    return [];
  }

  return [
    {
      id: review.node_id ?? String(review.id),
      reviewerId,
      decision: mapSnapshotReviewDecision(review.state),
      submittedAt: review.submitted_at ?? new Date().toISOString(),
      commitSha: review.commit_id,
      body: review.body ?? undefined
    }
  ];
}

function mapSnapshotReviewDecision(
  state: string | undefined
): ReviewDecisionEvent["decision"] {
  if (state?.toLowerCase() === "approved") {
    return "approved";
  }

  if (state?.toLowerCase() === "changes_requested") {
    return "changes_requested";
  }

  return "commented";
}

function buildSnapshotActivity(
  snapshot: GitHubPullRequestSnapshot
): PullRequestActivity[] {
  const pullRequest = snapshot.pull_request;
  const repository = snapshot.repository.full_name;
  const number = pullRequest.number ?? 0;
  const updatedAt = pullRequest.updated_at ?? new Date().toISOString();
  const authorLogin = pullRequest.user?.login ?? "unknown";
  const pullRequestUrl =
    pullRequest.html_url ?? `https://github.com/${repository}/pull/${number}`;
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
      title: `${review.user.login} ${snapshotReviewTitle(review.state)}`,
      body: review.body ?? undefined
    });
  }

  return activity.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
  );
}

function snapshotReviewTitle(state: string | undefined): string {
  const normalizedState = state?.toLowerCase();
  if (normalizedState === "approved") {
    return "approved this pull request";
  }

  if (normalizedState === "changes_requested") {
    return "requested changes";
  }

  return "reviewed this pull request";
}

function livePullRequestId(repository: string, number: number): string {
  return `github:${repository.replace("/", "~")}:${number}`;
}

function normalizeSnapshotPullRequestState(
  state: string | undefined
): PullRequestItem["state"] {
  if (state === "closed") {
    return "closed";
  }

  if (state === "merged") {
    return "merged";
  }

  return "open";
}

function githubNodeIdFromSnapshot(snapshot: GitHubPullRequestSnapshot): string {
  const pullRequest = snapshot.pull_request;
  if (pullRequest.node_id) {
    return pullRequest.node_id;
  }

  if (typeof pullRequest.id === "number" && pullRequest.id > 0) {
    return String(pullRequest.id);
  }

  return `pull-request:${snapshot.repository.full_name}:${pullRequest.number ?? 0}`;
}

function isFreshEnoughLocalPullRequestPayload(
  db: DatabaseSync,
  githubNodeId: string,
  incomingUpdatedAt: string
): boolean {
  const current = db
    .prepare(`select github_updated_at from pull_requests where github_node_id = ?`)
    .get(githubNodeId) as { github_updated_at: string | null } | undefined;

  if (!current?.github_updated_at) {
    return true;
  }

  return Date.parse(incomingUpdatedAt) >= Date.parse(current.github_updated_at);
}

function ensureDefaultBoardItem(
  db: DatabaseSync,
  pullRequest: PullRequestItem,
  now: string
): void {
  db.prepare(
    `
      insert into board_items (
        id,
        board_id,
        pull_request_id,
        column_id,
        sort_order,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(board_id, pull_request_id)
      do update set updated_at = excluded.updated_at
    `
  ).run(
    deterministicUuid(`board-item:${defaultLocalBoardId}:${pullRequest.id}`),
    defaultLocalBoardId,
    pullRequest.id,
    "inbox",
    0,
    now,
    now
  );
}

function setLocalBoardItemSeenAt(
  db: DatabaseSync,
  pullRequestId: string,
  lastSeenAt: string | null,
  now: string
): void {
  db.prepare(
    `
      update board_items
      set last_seen_at = ?, updated_at = ?
      where board_id = ? and pull_request_id = ?
    `
  ).run(lastSeenAt, now, defaultLocalBoardId, pullRequestId);
}

function replaceLocalReviewRequests(
  db: DatabaseSync,
  pullRequest: PullRequestItem,
  now: string
): void {
  db.prepare(`delete from pull_request_review_requests where pull_request_id = ?`).run(
    pullRequest.id
  );

  for (const reviewerId of pullRequest.requestedReviewerIds) {
    const accountId = upsertGithubAccount(db, {
      login: reviewerId,
      accountType: "user",
      now
    });

    db.prepare(
      `
        insert into pull_request_review_requests (
          id,
          pull_request_id,
          reviewer_kind,
          account_id,
          requested_at,
          created_at
        )
        values (?, ?, ?, ?, ?, ?)
      `
    ).run(
      deterministicUuid(`review-request:${pullRequest.id}:${reviewerId}`),
      pullRequest.id,
      "user",
      accountId,
      null,
      now
    );
  }
}

function replaceLocalReviews(
  db: DatabaseSync,
  reviews: ReviewDecisionEvent[],
  pullRequestId: string,
  now: string
): void {
  db.prepare(`delete from review_events where pull_request_id = ?`).run(pullRequestId);

  for (const review of reviews) {
    const reviewerAccountId = upsertGithubAccount(db, {
      login: review.reviewerId,
      accountType: "user",
      now
    });

    db.prepare(
      `
        insert into review_events (
          id,
          pull_request_id,
          github_node_id,
          reviewer_account_id,
          decision,
          commit_sha,
          body,
          submitted_at,
          raw_payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      review.id,
      pullRequestId,
      review.id,
      reviewerAccountId,
      review.decision,
      review.commitSha ?? null,
      review.body ?? null,
      review.submittedAt,
      JSON.stringify(review)
    );
  }
}

function replaceLocalThreads(
  db: DatabaseSync,
  threads: ReviewThread[],
  pullRequestId: string,
  now: string
): void {
  const existingThreadRows = db
    .prepare(`select id from review_threads where pull_request_id = ?`)
    .all(pullRequestId) as Array<{ id: string }>;

  for (const row of existingThreadRows) {
    db.prepare(`delete from review_thread_participants where review_thread_id = ?`).run(
      row.id
    );
  }
  db.prepare(`delete from review_threads where pull_request_id = ?`).run(pullRequestId);

  for (const thread of threads) {
    db.prepare(
      `
        insert into review_threads (
          id,
          pull_request_id,
          github_node_id,
          is_resolved,
          file_path,
          line,
          last_activity_at,
          raw_payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      thread.id,
      pullRequestId,
      thread.id,
      boolToSqlite(thread.isResolved),
      thread.filePath ?? null,
      thread.line ?? null,
      thread.lastActivityAt,
      JSON.stringify(thread)
    );

    for (const participantId of thread.participantIds) {
      const participantAccountId = upsertGithubAccount(db, {
        login: participantId,
        accountType: "user",
        now
      });
      db.prepare(
        `
          insert into review_thread_participants (
            id,
            review_thread_id,
            account_id,
            created_at
          )
          values (?, ?, ?, ?)
        `
      ).run(
        deterministicUuid(`thread-participant:${thread.id}:${participantId}`),
        thread.id,
        participantAccountId,
        now
      );
    }
  }
}

function replaceLocalActivity(
  db: DatabaseSync,
  events: PullRequestActivity[],
  pullRequestId: string,
  now: string
): void {
  db.prepare(`delete from activity_events where pull_request_id = ?`).run(pullRequestId);

  for (const event of events) {
    const actorAccountId = upsertGithubAccount(db, {
      login: event.actorId,
      accountType: "user",
      now
    });

    db.prepare(
      `
        insert into activity_events (
          id,
          pull_request_id,
          event_type,
          actor_account_id,
          occurred_at,
          title,
          body,
          raw_payload_json,
          created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      event.id,
      pullRequestId,
      event.type,
      actorAccountId,
      event.occurredAt,
      event.title,
      event.body ?? null,
      JSON.stringify(event),
      now
    );
  }
}

function upsertGithubAccount(
  db: DatabaseSync,
  input: {
    login: string;
    accountType: "user" | "organization" | "bot";
    now: string;
    avatarUrl?: string;
  }
): string {
  const id = deterministicUuid(`github-account:${input.login}`);
  db.prepare(
    `
      insert into github_accounts (
        id,
        github_node_id,
        login,
        account_type,
        avatar_url,
        raw_payload_json,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(login)
      do update set
        avatar_url = coalesce(excluded.avatar_url, github_accounts.avatar_url),
        updated_at = excluded.updated_at
    `
  ).run(
    id,
    `account:${input.login}`,
    input.login,
    input.accountType,
    input.avatarUrl ?? null,
    JSON.stringify({ login: input.login }),
    input.now,
    input.now
  );

  return id;
}

function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("begin");
  try {
    const result = callback();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function boolToSqlite(value: boolean): number {
  return value ? 1 : 0;
}
