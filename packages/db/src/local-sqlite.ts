import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  sampleAvatarUrlsByLogin,
  sampleLastSeenAtByPullRequestId,
  samplePullRequests,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestItem,
  type PullRequestLabel,
  type ReviewDecisionEvent,
  type ReviewRequestEvent,
  type ReviewThread
} from "@pr-tracker/core";
import type {
  GitHubIssueCommentSnapshot,
  GitHubPullRequestSnapshot,
  GitHubReviewSnapshot,
  GitHubReviewThreadSnapshot
} from "@pr-tracker/github";
import { deterministicUuid } from "./ids";
import { applyMigrations } from "./migrations";

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

export interface CreateLocalDatabaseBackupOptions {
  sourcePath?: string;
  destinationPath: string;
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
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  github_created_at: string | null;
  github_updated_at: string | null;
  raw_payload_json: string;
}

export interface LocalReviewRequestRow {
  pull_request_id: string;
  reviewer_kind: "user" | "team";
  login: string | null;
  team_slug: string | null;
  requested_at: string | null;
}

export interface LocalPullRequestLabelRow {
  pull_request_id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export interface LocalPullRequestAssigneeRow {
  pull_request_id: string;
  login: string;
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
  is_outdated: number;
  last_actor_login: string | null;
  file_path: string | null;
  line: number | null;
  last_activity_at: string;
}

export interface LocalReviewThreadParticipantRow {
  review_thread_id: string;
  login: string;
}

export interface LocalReviewCommentRow {
  id: string;
  review_thread_id: string | null;
  pull_request_id: string;
  author_login: string;
  body: string;
  file_path: string | null;
  line: number | null;
  created_at_github: string;
  updated_at_github: string | null;
  url: string | null;
}

export interface LocalIssueCommentRow {
  id: string;
  pull_request_id: string;
  author_login: string;
  body: string;
  created_at_github: string;
  updated_at_github: string | null;
  url: string | null;
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

interface ReviewCommentInput {
  id: string;
  reviewThreadId?: string;
  githubNodeId: string;
  authorLogin: string;
  body: string;
  filePath?: string;
  line?: number;
  createdAt: string;
  updatedAt?: string | null;
  url?: string | null;
  rawPayload: unknown;
}

export interface LocalBoardItemStateRow {
  pull_request_id: string;
  last_seen_at: string | null;
  notes: string | null;
  archived_at: string | null;
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

export function createLocalDatabaseBackup(
  options: CreateLocalDatabaseBackupOptions
): void {
  const sourcePath = options.sourcePath ?? defaultLocalDatabasePath();
  if (sourcePath === ":memory:") {
    throw new Error("Cannot back up an in-memory SQLite database.");
  }
  if (!existsSync(sourcePath)) {
    throw new Error("Local SQLite database file does not exist.");
  }

  mkdirSync(dirname(options.destinationPath), { recursive: true });
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec(`vacuum main into ${sqliteStringLiteral(options.destinationPath)}`);
  } finally {
    db.close();
  }
}

export function initializeLocalDatabase(db: DatabaseSync): void {
  applyMigrations(db);
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
      const storedPullRequestId = upsertLocalPullRequest(db, pullRequest, now);
      ensureDefaultBoardItem(db, { ...pullRequest, id: storedPullRequestId }, now);
    }

    for (const [pullRequestId, lastSeenAt] of Object.entries(
      sampleLastSeenAtByPullRequestId
    )) {
      setLocalBoardItemSeenAt(db, pullRequestId, lastSeenAt ?? null, now);
    }
  });
}

/**
 * Removes everything seedLocalSampleData (or the desktop app's historical
 * in-app seeding) put into the database, leaving real data untouched. Live
 * pull requests use github:owner~repo:number ids, so the seeded pr_* ids
 * can never collide. Child rows are deleted explicitly rather than via
 * foreign-key cascade so the purge works regardless of the connection's
 * foreign_keys pragma. Sample repositories and accounts are dropped only
 * when nothing else references them.
 */
export function removeLocalSampleData(db: DatabaseSync): {
  removedPullRequests: number;
} {
  const pullRequestIds = samplePullRequests.map((pullRequest) => pullRequest.id);
  const idPlaceholders = pullRequestIds.map(() => "?").join(", ");
  let removedPullRequests = 0;

  transaction(db, () => {
    db.prepare(
      `delete from review_thread_participants
       where review_thread_id in (
         select id from review_threads where pull_request_id in (${idPlaceholders})
       )`
    ).run(...pullRequestIds);

    const childTables = [
      "pull_request_labels",
      "pull_request_assignees",
      "pull_request_review_requests",
      "review_events",
      "pull_request_check_runs",
      "review_comments",
      "issue_comments",
      "review_threads",
      "activity_events",
      "board_items",
      "ai_summaries"
    ];
    for (const table of childTables) {
      db.prepare(
        `delete from ${table} where pull_request_id in (${idPlaceholders})`
      ).run(...pullRequestIds);
    }

    const result = db
      .prepare(`delete from pull_requests where id in (${idPlaceholders})`)
      .run(...pullRequestIds);
    removedPullRequests = Number(result.changes);

    const repositories = [
      ...new Set(samplePullRequests.map((pullRequest) => pullRequest.repository))
    ];
    const repositoryPlaceholders = repositories.map(() => "?").join(", ");
    db.prepare(
      `delete from tracked_repositories
       where repository_id in (
         select id from github_repositories
         where full_name in (${repositoryPlaceholders})
           and not exists (
             select 1 from pull_requests
             where pull_requests.repository_id = github_repositories.id
           )
       )`
    ).run(...repositories);
    db.prepare(
      `delete from github_repositories
       where full_name in (${repositoryPlaceholders})
         and not exists (
           select 1 from pull_requests
           where pull_requests.repository_id = github_repositories.id
         )`
    ).run(...repositories);

    const sampleLogins = [
      ...new Set([
        ...Object.keys(sampleAvatarUrlsByLogin),
        "viewer",
        // Owner accounts auto-created for the sample repositories.
        ...repositories.map((fullName) => fullName.split("/")[0] ?? "")
      ])
    ].filter((login) => login !== "");
    const loginPlaceholders = sampleLogins.map(() => "?").join(", ");
    const accountReferences = [
      "select 1 from pull_requests where pull_requests.author_account_id = github_accounts.id",
      "select 1 from review_events where review_events.reviewer_account_id = github_accounts.id",
      "select 1 from review_comments where review_comments.author_account_id = github_accounts.id",
      "select 1 from issue_comments where issue_comments.author_account_id = github_accounts.id",
      "select 1 from activity_events where activity_events.actor_account_id = github_accounts.id",
      "select 1 from review_thread_participants where review_thread_participants.account_id = github_accounts.id",
      "select 1 from pull_request_assignees where pull_request_assignees.account_id = github_accounts.id",
      "select 1 from pull_request_review_requests where pull_request_review_requests.account_id = github_accounts.id",
      "select 1 from github_repositories where github_repositories.owner_account_id = github_accounts.id"
    ];
    db.prepare(
      `delete from github_accounts
       where login in (${loginPlaceholders})
         and ${accountReferences
           .map((reference) => `not exists (${reference})`)
           .join("\n         and ")}`
    ).run(...sampleLogins);
  });

  return { removedPullRequests };
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
  const existingPullRequestId = getLocalPullRequestIdByGithubNodeId(
    db,
    githubNodeId
  );
  const isFreshEnough = shouldWriteLocalPullRequestPayload(
    db,
    githubNodeId,
    incomingUpdatedAt,
    JSON.stringify(snapshot)
  );
  const now = new Date().toISOString();
  const profileId = options.profileId ?? defaultLocalProfileId;
  const viewerLogin = options.viewerLogin ?? "viewer";
  let storedPullRequestId = existingPullRequestId ?? pullRequest.id;

  transaction(db, () => {
    upsertLocalProfile(db, {
      id: profileId,
      githubLogin: viewerLogin,
      displayName: viewerLogin,
      now
    });
    ensureDefaultBoard(db, profileId, now);

    if (isFreshEnough) {
      storedPullRequestId = upsertLocalPullRequest(db, pullRequest, now, {
        githubNodeId,
        rawPayload: snapshot,
        skipThreads: snapshot.review_threads === undefined,
        reviewComments: reviewCommentsFromSnapshot(snapshot),
        skipReviewComments: snapshot.review_threads === undefined,
        issueComments: snapshot.issue_comments,
        skipIssueComments: snapshot.issue_comments === undefined
      });
      ensureDefaultBoardItem(db, { ...pullRequest, id: storedPullRequestId }, now);
    }
  });

  return { pullRequestId: storedPullRequestId, isFreshEnough };
}

export function listLocalPullRequestRows(
  db: DatabaseSync,
  input: { id?: string; ids?: string[] } = {}
): LocalPullRequestRow[] {
  const scopedIds = input.id ? undefined : input.ids;
  if (scopedIds?.length === 0) {
    return [];
  }

  const scopeSql = input.id
    ? "pr.id = ?"
    : scopedIds
      ? `pr.id in (${scopedIds.map(() => "?").join(", ")})`
      : "pr.state = 'open'";
  const parameters = input.id ? [input.id] : scopedIds ?? [];

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
          pr.additions,
          pr.deletions,
          pr.changed_files,
          pr.github_created_at,
          pr.github_updated_at,
          pr.raw_payload_json
        from pull_requests pr
        join github_repositories repo on repo.id = pr.repository_id
        left join github_accounts author on author.id = pr.author_account_id
        where ${scopeSql}
        order by pr.github_updated_at desc
        limit 250
      `
    )
    .all(...parameters) as unknown as LocalPullRequestRow[];
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
          team.slug as team_slug,
          rr.requested_at
        from pull_request_review_requests rr
        left join github_accounts account on account.id = rr.account_id
        left join github_teams team on team.id = rr.team_id
        where rr.pull_request_id = ?
        order by rr.created_at asc
      `
    )
    .all(pullRequestId) as unknown as LocalReviewRequestRow[];
}

export function listLocalPullRequestLabelRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalPullRequestLabelRow[] {
  return db
    .prepare(
      `
        select
          pr_label.pull_request_id,
          label.name,
          label.color,
          label.description
        from pull_request_labels pr_label
        join github_labels label on label.id = pr_label.label_id
        where pr_label.pull_request_id = ?
        order by label.name collate nocase asc
      `
    )
    .all(pullRequestId) as unknown as LocalPullRequestLabelRow[];
}

export function listLocalPullRequestAssigneeRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalPullRequestAssigneeRow[] {
  return db
    .prepare(
      `
        select
          assignee.pull_request_id,
          account.login
        from pull_request_assignees assignee
        join github_accounts account on account.id = assignee.account_id
        where assignee.pull_request_id = ?
        order by account.login collate nocase asc
      `
    )
    .all(pullRequestId) as unknown as LocalPullRequestAssigneeRow[];
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
          is_outdated,
          last_actor_login,
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

export function listLocalReviewCommentRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalReviewCommentRow[] {
  return db
    .prepare(
      `
        select
          comment.id,
          comment.review_thread_id,
          comment.pull_request_id,
          coalesce(author.login, 'unknown') as author_login,
          comment.body,
          comment.file_path,
          comment.line,
          comment.created_at_github,
          comment.updated_at_github,
          json_extract(comment.raw_payload_json, '$.url') as url
        from review_comments comment
        left join github_accounts author on author.id = comment.author_account_id
        where comment.pull_request_id = ?
        order by comment.created_at_github asc
      `
    )
    .all(pullRequestId) as unknown as LocalReviewCommentRow[];
}

export function listLocalIssueCommentRows(
  db: DatabaseSync,
  pullRequestId: string
): LocalIssueCommentRow[] {
  return db
    .prepare(
      `
        select
          comment.id,
          comment.pull_request_id,
          coalesce(author.login, 'unknown') as author_login,
          comment.body,
          comment.created_at_github,
          comment.updated_at_github,
          json_extract(comment.raw_payload_json, '$.url') as url
        from issue_comments comment
        left join github_accounts author on author.id = comment.author_account_id
        where comment.pull_request_id = ?
        order by comment.created_at_github asc
      `
    )
    .all(pullRequestId) as unknown as LocalIssueCommentRow[];
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
          last_seen_at,
          notes,
          archived_at
        from board_items
        where board_id = ? and archived_at is null
        order by pull_request_id asc
      `
    )
    .all(boardId) as unknown as LocalBoardItemStateRow[];
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
}

function upsertLocalPullRequest(
  db: DatabaseSync,
  pullRequest: PullRequestItem,
  now: string,
  options: {
    githubNodeId?: string;
    rawPayload?: unknown;
    /** Keep existing thread rows when the snapshot had no thread data. */
    skipThreads?: boolean;
    reviewComments?: ReviewCommentInput[];
    /** Keep existing review comment rows when thread/comment data was unavailable. */
    skipReviewComments?: boolean;
    issueComments?: GitHubIssueCommentSnapshot[];
    /** Keep existing issue comment rows when the issue comments fetch was unavailable. */
    skipIssueComments?: boolean;
  } = {}
): string {
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
        additions,
        deletions,
        changed_files,
        github_created_at,
        github_updated_at,
        raw_payload_json,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(github_node_id)
      do update set
        repository_id = excluded.repository_id,
        title = excluded.title,
        body = excluded.body,
        url = excluded.url,
        author_account_id = excluded.author_account_id,
        state = excluded.state,
        is_draft = excluded.is_draft,
        latest_commit_sha = excluded.latest_commit_sha,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
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
    pullRequest.additions ?? null,
    pullRequest.deletions ?? null,
    pullRequest.changedFiles ?? null,
    pullRequest.createdAt,
    pullRequest.updatedAt,
    JSON.stringify(options.rawPayload ?? pullRequest),
    now,
    now
  );

  const storedPullRequestId = getLocalPullRequestIdByGithubNodeId(
    db,
    options.githubNodeId ?? pullRequest.id
  );
  if (!storedPullRequestId) {
    throw new Error("Could not resolve stored pull request after upsert.");
  }

  const storedPullRequest = { ...pullRequest, id: storedPullRequestId };
  replaceLocalLabels(db, repositoryId, storedPullRequest, now);
  replaceLocalAssignees(db, storedPullRequest, now);
  replaceLocalReviewRequests(db, storedPullRequest, now);
  replaceLocalReviews(db, storedPullRequest.reviews, storedPullRequest.id, now);
  if (!options.skipThreads) {
    replaceLocalThreads(db, storedPullRequest.threads, storedPullRequest.id, now);
  }
  if (!options.skipReviewComments) {
    replaceLocalReviewComments(
      db,
      options.reviewComments ?? [],
      storedPullRequest.id,
      now
    );
  }
  if (!options.skipIssueComments) {
    replaceLocalIssueComments(
      db,
      options.issueComments ?? [],
      storedPullRequest.id,
      now
    );
  }
  replaceLocalActivity(db, storedPullRequest.activity, storedPullRequest.id, now);

  return storedPullRequestId;
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
    labels: (pullRequest.labels ?? [])
      .map(mapSnapshotLabel)
      .filter((label): label is PullRequestLabel => Boolean(label)),
    assigneeIds: (pullRequest.assignees ?? [])
      .map((assignee) => assignee.login)
      .filter((login): login is string => Boolean(login)),
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    requestedReviewerIds: (pullRequest.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => Boolean(login)),
    reviewRequests: mapSnapshotReviewRequests(snapshot),
    reviews: reviews.flatMap(mapSnapshotReview),
    threads: (snapshot.review_threads ?? []).map((thread) =>
      mapSnapshotReviewThread(thread, updatedAt)
    ),
    comments: mapSnapshotComments(snapshot),
    activity: buildSnapshotActivity({ ...snapshot, reviews })
  };
}

/**
 * Pair each currently requested reviewer with the timeline's request time.
 * Reviewers without a known time are omitted so the classifier treats the
 * outstanding request as unanswered instead of inventing a request time.
 */
function mapSnapshotReviewRequests(
  snapshot: GitHubPullRequestSnapshot
): ReviewRequestEvent[] {
  const requestedAtByLogin = new Map(
    (snapshot.review_requests ?? []).map((request) => [
      request.reviewer_login.toLowerCase(),
      request.requested_at
    ])
  );
  return (snapshot.pull_request.requested_reviewers ?? []).flatMap((reviewer) => {
    const login = reviewer.login;
    if (!login) return [];
    const requestedAt = requestedAtByLogin.get(login.toLowerCase());
    return requestedAt ? [{ reviewerId: login, requestedAt }] : [];
  });
}

/** Flatten conversation and inline comments into comment primitives used to
 * detect whether the viewer has responded to a review request. */
function mapSnapshotComments(
  snapshot: GitHubPullRequestSnapshot
): PullRequestComment[] {
  const comments: PullRequestComment[] = [];
  for (const comment of snapshot.issue_comments ?? []) {
    if (!comment.id || !comment.created_at) continue;
    comments.push({
      id: comment.id,
      authorId: comment.author?.login ?? "unknown",
      createdAt: comment.created_at
    });
  }
  for (const thread of snapshot.review_threads ?? []) {
    for (const comment of thread.comments ?? []) {
      if (!comment.id || !comment.created_at) continue;
      comments.push({
        id: comment.id,
        authorId: comment.author?.login ?? "unknown",
        createdAt: comment.created_at
      });
    }
  }
  return comments;
}

function mapSnapshotLabel(
  label: NonNullable<GitHubPullRequestSnapshot["pull_request"]["labels"]>[number]
): PullRequestLabel | undefined {
  if (!label.name) return undefined;

  return {
    name: label.name,
    color: normalizeGithubLabelColor(label.color),
    description: label.description ?? undefined
  };
}

function normalizeGithubLabelColor(value: string | null | undefined): string | undefined {
  const color = value?.replace(/^#/, "").trim();
  return color && /^[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined;
}

function mapSnapshotReviewThread(
  thread: GitHubReviewThreadSnapshot,
  fallbackTimestamp: string
): ReviewThread {
  const comments = (thread.comments ?? [])
    .slice()
    .sort(
      (a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "")
    );
  const lastComment = comments[comments.length - 1];
  const participantIds = [
    ...new Set(
      comments
        .map((comment) => comment.author?.login)
        .filter((login): login is string => Boolean(login))
    )
  ];

  return {
    id: thread.id,
    isResolved: thread.is_resolved ?? false,
    isOutdated: thread.is_outdated ?? false,
    participantIds,
    lastActorId: lastComment?.author?.login,
    filePath: thread.path ?? undefined,
    line: thread.line ?? undefined,
    lastActivityAt: lastComment?.created_at ?? fallbackTimestamp
  };
}

function reviewCommentsFromSnapshot(
  snapshot: GitHubPullRequestSnapshot
): ReviewCommentInput[] {
  const comments: ReviewCommentInput[] = [];

  for (const thread of snapshot.review_threads ?? []) {
    for (const comment of thread.comments ?? []) {
      const githubNodeId = comment.id;
      const body = comment.body?.trim();
      const createdAt = comment.created_at;
      if (!githubNodeId || !body || !createdAt) {
        continue;
      }

      comments.push({
        id: deterministicUuid(`review-comment:${githubNodeId}`),
        reviewThreadId: thread.id,
        githubNodeId,
        authorLogin: comment.author?.login ?? "unknown",
        body,
        filePath: comment.path ?? thread.path ?? undefined,
        line: comment.line ?? thread.line ?? undefined,
        createdAt,
        updatedAt: comment.updated_at,
        url: comment.url,
        rawPayload: { ...comment, review_thread_id: thread.id }
      });
    }
  }

  return comments;
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

function shouldWriteLocalPullRequestPayload(
  db: DatabaseSync,
  githubNodeId: string,
  incomingUpdatedAt: string,
  incomingRawPayloadJson: string
): boolean {
  const current = db
    .prepare(
      `
        select github_updated_at, raw_payload_json
        from pull_requests where github_node_id = ?
      `
    )
    .get(githubNodeId) as
    | { github_updated_at: string | null; raw_payload_json: string | null }
    | undefined;

  if (!current?.github_updated_at) {
    return true;
  }

  if (Date.parse(incomingUpdatedAt) < Date.parse(current.github_updated_at)) {
    return false;
  }

  // An identical snapshot means the sync found nothing new for this pull
  // request. Skipping the rewrite keeps steady-state syncs read-only
  // instead of holding the write lock to re-store the same rows.
  return current.raw_payload_json !== incomingRawPayloadJson;
}

function getLocalPullRequestIdByGithubNodeId(
  db: DatabaseSync,
  githubNodeId: string
): string | undefined {
  return (
    db
      .prepare(`select id from pull_requests where github_node_id = ?`)
      .get(githubNodeId) as { id: string } | undefined
  )?.id;
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
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?)
      on conflict(board_id, pull_request_id)
      do update set updated_at = excluded.updated_at
    `
  ).run(
    deterministicUuid(`board-item:${defaultLocalBoardId}:${pullRequest.id}`),
    defaultLocalBoardId,
    pullRequest.id,
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

function replaceLocalLabels(
  db: DatabaseSync,
  repositoryId: string,
  pullRequest: PullRequestItem,
  now: string
): void {
  db.prepare(`delete from pull_request_labels where pull_request_id = ?`).run(
    pullRequest.id
  );

  for (const label of pullRequest.labels ?? []) {
    const labelId = deterministicUuid(
      `github-label:${repositoryId}:${label.name.toLowerCase()}`
    );

    db.prepare(
      `
        insert into github_labels (
          id,
          repository_id,
          github_node_id,
          name,
          color,
          description,
          raw_payload_json,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(repository_id, name)
        do update set
          color = excluded.color,
          description = excluded.description,
          raw_payload_json = excluded.raw_payload_json,
          updated_at = excluded.updated_at
      `
    ).run(
      labelId,
      repositoryId,
      labelId,
      label.name,
      label.color ?? null,
      label.description ?? null,
      JSON.stringify(label),
      now,
      now
    );

    db.prepare(
      `
        insert into pull_request_labels (
          id,
          pull_request_id,
          label_id,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?)
        on conflict(pull_request_id, label_id)
        do update set updated_at = excluded.updated_at
      `
    ).run(
      deterministicUuid(`pull-request-label:${pullRequest.id}:${labelId}`),
      pullRequest.id,
      labelId,
      now,
      now
    );
  }
}

function replaceLocalAssignees(
  db: DatabaseSync,
  pullRequest: PullRequestItem,
  now: string
): void {
  db.prepare(`delete from pull_request_assignees where pull_request_id = ?`).run(
    pullRequest.id
  );

  for (const assigneeId of pullRequest.assigneeIds ?? []) {
    const accountId = upsertGithubAccount(db, {
      login: assigneeId,
      accountType: "user",
      now
    });

    db.prepare(
      `
        insert into pull_request_assignees (
          id,
          pull_request_id,
          account_id,
          created_at
        )
        values (?, ?, ?, ?)
        on conflict(pull_request_id, account_id) do nothing
      `
    ).run(
      deterministicUuid(`pull-request-assignee:${pullRequest.id}:${assigneeId}`),
      pullRequest.id,
      accountId,
      now
    );
  }
}

function replaceLocalReviewRequests(
  db: DatabaseSync,
  pullRequest: PullRequestItem,
  now: string
): void {
  db.prepare(`delete from pull_request_review_requests where pull_request_id = ?`).run(
    pullRequest.id
  );

  const requestedAtByReviewer = new Map(
    (pullRequest.reviewRequests ?? []).map((request) => [
      request.reviewerId.toLowerCase(),
      request.requestedAt
    ])
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
      requestedAtByReviewer.get(reviewerId.toLowerCase()) ?? null,
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
          is_outdated,
          last_actor_login,
          file_path,
          line,
          last_activity_at,
          raw_payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      thread.id,
      pullRequestId,
      thread.id,
      boolToSqlite(thread.isResolved),
      boolToSqlite(thread.isOutdated ?? false),
      thread.lastActorId ?? null,
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

function replaceLocalReviewComments(
  db: DatabaseSync,
  comments: ReviewCommentInput[],
  pullRequestId: string,
  now: string
): void {
  db.prepare(`delete from review_comments where pull_request_id = ?`).run(
    pullRequestId
  );

  for (const comment of comments) {
    const authorAccountId = upsertGithubAccount(db, {
      login: comment.authorLogin,
      accountType: "user",
      now
    });

    db.prepare(
      `
        insert into review_comments (
          id,
          review_thread_id,
          pull_request_id,
          github_node_id,
          author_account_id,
          body,
          file_path,
          line,
          created_at_github,
          updated_at_github,
          raw_payload_json,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      comment.id,
      comment.reviewThreadId ?? null,
      pullRequestId,
      comment.githubNodeId,
      authorAccountId,
      comment.body,
      comment.filePath ?? null,
      comment.line ?? null,
      comment.createdAt,
      comment.updatedAt ?? null,
      JSON.stringify(comment.rawPayload),
      now,
      now
    );
  }
}

function replaceLocalIssueComments(
  db: DatabaseSync,
  comments: GitHubIssueCommentSnapshot[],
  pullRequestId: string,
  now: string
): void {
  db.prepare(`delete from issue_comments where pull_request_id = ?`).run(
    pullRequestId
  );

  for (const comment of comments) {
    const body = comment.body.trim();
    if (!body) {
      continue;
    }

    const authorAccountId = upsertGithubAccount(db, {
      login: comment.author?.login ?? "unknown",
      accountType: "user",
      now
    });

    db.prepare(
      `
        insert into issue_comments (
          id,
          pull_request_id,
          github_node_id,
          author_account_id,
          body,
          created_at_github,
          updated_at_github,
          raw_payload_json,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      deterministicUuid(`issue-comment:${comment.id}`),
      pullRequestId,
      comment.id,
      authorAccountId,
      body,
      comment.created_at,
      comment.updated_at ?? null,
      JSON.stringify(comment),
      now,
      now
    );
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
