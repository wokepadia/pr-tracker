import {
  defaultLocalBoardId,
  listLocalActivityEventRows,
  listLocalBoardColumnRows,
  listLocalBoardItemStateRows,
  listLocalPullRequestRows,
  listLocalReviewEventRows,
  listLocalReviewRequestRows,
  listLocalReviewThreadParticipantRows,
  listLocalReviewThreadRows,
  markLocalPullRequestSeen,
  openLocalDatabase,
  saveLocalBoardState,
  seedLocalSampleData,
  type LocalDatabase,
  type LocalPullRequestRow
} from "@pr-tracker/db";
import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecisionEvent,
  ReviewThread
} from "@pr-tracker/core";
import { buildReviewerInbox } from "@pr-tracker/reviewer-workflow";
import type {
  PullRequestDetail,
  ReviewerInboxRepository
} from "./repository";
import type { BoardState } from "./repository";

export interface LocalSqliteRepositoryOptions {
  path?: string;
  viewerLogin?: string;
  seedSampleData?: boolean;
}

export function createLocalSqliteRepository(
  options: LocalSqliteRepositoryOptions = {}
): ReviewerInboxRepository {
  const local = openLocalDatabase({ path: options.path });
  const viewerLogin =
    options.viewerLogin ?? process.env.PR_TRACKER_VIEWER_LOGIN ?? "viewer";

  if (options.seedSampleData !== false && isLocalDatabaseEmpty(local)) {
    seedLocalSampleData(local.db, { viewerLogin });
  }

  return {
    async getReviewerInbox(now) {
      const pullRequests = loadPullRequests(local);
      const actors = buildActors(pullRequests, [viewerLogin]);
      const viewer = ensureActor(actors, viewerLogin);
      const lastSeenAtByPullRequestId = loadLastSeen(local);

      return buildReviewerInbox({
        viewer,
        actors,
        pullRequests,
        now,
        lastSeenAtByPullRequestId
      });
    },

    async getPullRequest(id): Promise<PullRequestDetail | undefined> {
      const pullRequests = loadPullRequests(local, id);
      const pullRequest = pullRequests[0];
      if (!pullRequest) {
        return undefined;
      }

      const actors = buildActors(pullRequests, [viewerLogin]);
      const viewer = ensureActor(actors, viewerLogin);
      const inbox = buildReviewerInbox({
        viewer,
        actors,
        pullRequests,
        now: new Date().toISOString(),
        lastSeenAtByPullRequestId: loadLastSeen(local)
      });
      const item = inbox.items[0];

      return item ? { viewer, actors, item } : undefined;
    },

    async markSeen(input) {
      const updated = markLocalPullRequestSeen(local.db, {
        boardId: defaultLocalBoardId,
        pullRequestId: input.pullRequestId,
        lastSeenAt: input.lastSeenAt
      });

      return updated ? input : undefined;
    },

    async getBoardState() {
      return loadBoardState(local);
    },

    async saveBoardState(state) {
      saveLocalBoardState(local.db, toSaveLocalBoardStateInput(local, state));
      return loadBoardState(local);
    },

    async close() {
      local.close();
    }
  };
}

function loadBoardState(local: LocalDatabase): BoardState {
  const columns = listLocalBoardColumnRows(local.db);
  const itemRows = listLocalBoardItemStateRows(local.db);
  const localQueueState: BoardState["localQueueState"] = {};
  const userBucketItemOrder = Object.fromEntries(
    columns.map((column) => [column.id, [] as string[]])
  );
  const bucketColumnWidths = Object.fromEntries(
    columns.map((column) => [column.id, column.width_px])
  );

  for (const row of itemRows) {
    if (row.column_id) {
      userBucketItemOrder[row.column_id] ??= [];
      userBucketItemOrder[row.column_id]?.push(row.pull_request_id);
    }

    localQueueState[row.pull_request_id] = {
      bucketId: row.column_id ?? undefined,
      snoozed: row.is_snoozed ? true : undefined,
      muted: row.is_muted ? true : undefined,
      pinned: row.is_pinned ? true : undefined
    };
  }

  return {
    buckets: columns.map((column) => ({ id: column.id, label: column.name })),
    localQueueState,
    userBucketItemOrder,
    bucketColumnWidths
  };
}

function toSaveLocalBoardStateInput(
  local: LocalDatabase,
  state: BoardState
): Parameters<typeof saveLocalBoardState>[1] {
  const bucketIds = new Set(state.buckets.map((bucket) => bucket.id));
  const fallbackBucketId = state.buckets[0]?.id ?? "inbox";
  const knownPullRequestIds = new Set(
    listLocalPullRequestRows(local.db).map((row) => row.id)
  );
  const itemByPullRequestId = new Map<
    string,
    {
      pullRequestId: string;
      columnId: string;
      sortOrder: number;
      snoozed?: boolean;
      muted?: boolean;
      pinned?: boolean;
    }
  >();

  for (const [bucketId, itemIds] of Object.entries(state.userBucketItemOrder)) {
    if (!bucketIds.has(bucketId)) continue;

    itemIds.forEach((pullRequestId, index) => {
      if (!knownPullRequestIds.has(pullRequestId)) return;
      itemByPullRequestId.set(pullRequestId, {
        pullRequestId,
        columnId: bucketId,
        sortOrder: index
      });
    });
  }

  for (const [pullRequestId, itemState] of Object.entries(state.localQueueState)) {
    if (!knownPullRequestIds.has(pullRequestId)) continue;
    const current = itemByPullRequestId.get(pullRequestId);
    const columnId =
      itemState.bucketId && bucketIds.has(itemState.bucketId)
        ? itemState.bucketId
        : current?.columnId ?? fallbackBucketId;

    itemByPullRequestId.set(pullRequestId, {
      pullRequestId,
      columnId,
      sortOrder: current?.sortOrder ?? itemByPullRequestId.size,
      snoozed: itemState.snoozed,
      muted: itemState.muted,
      pinned: itemState.pinned
    });
  }

  return {
    columns: state.buckets.map((bucket, index) => ({
      id: bucket.id,
      name: bucket.label,
      sortOrder: index,
      widthPx: state.bucketColumnWidths[bucket.id] ?? 232
    })),
    items: [...itemByPullRequestId.values()]
  };
}

function isLocalDatabaseEmpty(local: LocalDatabase): boolean {
  const row = local.db
    .prepare(`select count(*) as count from pull_requests`)
    .get() as { count: number };
  return row.count === 0;
}

function loadPullRequests(
  local: LocalDatabase,
  id?: string
): PullRequestItem[] {
  return listLocalPullRequestRows(local.db, { id }).map((row) =>
    toPullRequestItem(local, row)
  );
}

function toPullRequestItem(
  local: LocalDatabase,
  row: LocalPullRequestRow
): PullRequestItem {
  const reviewRequests = listLocalReviewRequestRows(local.db, row.id);
  const reviewThreads = listLocalReviewThreadRows(local.db, row.id);
  const participantRows = listLocalReviewThreadParticipantRows(
    local.db,
    reviewThreads.map((thread) => thread.id)
  );
  const participantIdsByThreadId = new Map<string, string[]>();

  for (const participant of participantRows) {
    participantIdsByThreadId.set(participant.review_thread_id, [
      ...(participantIdsByThreadId.get(participant.review_thread_id) ?? []),
      participant.login
    ]);
  }

  return {
    id: row.id,
    repository: row.repository_full_name,
    number: row.number,
    title: row.title,
    description: row.body ?? descriptionFromRawPayload(row.raw_payload_json),
    url: row.url,
    authorId: row.author_login,
    state: row.state as PullRequestItem["state"],
    isDraft: Boolean(row.is_draft),
    createdAt: row.github_created_at ?? new Date().toISOString(),
    updatedAt: row.github_updated_at ?? new Date().toISOString(),
    latestCommitSha: row.latest_commit_sha ?? "",
    requestedReviewerIds: reviewRequests.flatMap((request) =>
      request.login ? [request.login] : []
    ),
    reviews: listLocalReviewEventRows(local.db, row.id).map(toReview),
    threads: reviewThreads.map((thread): ReviewThread => ({
      id: thread.id,
      isResolved: Boolean(thread.is_resolved),
      participantIds: participantIdsByThreadId.get(thread.id) ?? [],
      filePath: thread.file_path ?? undefined,
      line: thread.line ?? undefined,
      lastActivityAt: thread.last_activity_at
    })),
    activity: listLocalActivityEventRows(local.db, row.id).map(
      (event): PullRequestActivity => ({
        id: event.id,
        type: event.event_type,
        actorId: event.actor_login,
        occurredAt: event.occurred_at,
        title: event.title,
        body: event.body ?? undefined,
        url: event.url ?? undefined,
        diffUrl: event.diff_url ?? undefined
      })
    )
  };
}

function toReview(row: {
  id: string;
  reviewer_login: string;
  decision: ReviewDecisionEvent["decision"];
  commit_sha: string | null;
  body: string | null;
  submitted_at: string;
}): ReviewDecisionEvent {
  return {
    id: row.id,
    reviewerId: row.reviewer_login,
    decision: row.decision,
    submittedAt: row.submitted_at,
    commitSha: row.commit_sha ?? undefined,
    body: row.body ?? undefined
  };
}

function loadLastSeen(
  local: LocalDatabase
): Record<string, string | undefined> {
  return Object.fromEntries(
    listLocalBoardItemStateRows(local.db).map((row) => [
      row.pull_request_id,
      row.last_seen_at ?? undefined
    ])
  );
}

function buildActors(
  pullRequests: PullRequestItem[],
  extraLogins: string[]
): Actor[] {
  const logins = new Set<string>(extraLogins);

  for (const pullRequest of pullRequests) {
    logins.add(pullRequest.authorId);
    pullRequest.requestedReviewerIds.forEach((login) => logins.add(login));
    pullRequest.reviews.forEach((review) => logins.add(review.reviewerId));
    pullRequest.threads.forEach((thread) =>
      thread.participantIds.forEach((login) => logins.add(login))
    );
    pullRequest.activity.forEach((event) => logins.add(event.actorId));
  }

  return Array.from(logins).map((login) => ({ id: login, login }));
}

function ensureActor(actors: Actor[], id: string): Actor {
  const actor = actors.find((candidate) => candidate.id === id);
  if (!actor) {
    const created = { id, login: id };
    actors.push(created);
    return created;
  }

  return actor;
}

function descriptionFromRawPayload(rawPayloadJson: string): string | undefined {
  try {
    const rawPayload = JSON.parse(rawPayloadJson) as { description?: unknown };
    return typeof rawPayload.description === "string"
      ? rawPayload.description
      : undefined;
  } catch {
    return undefined;
  }
}
