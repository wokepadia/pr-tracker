import { randomUUID } from "node:crypto";
import { createOrm } from "@pr-tracker/db";
import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecision,
  ReviewDecisionEvent,
  ReviewThread
} from "@pr-tracker/core";
import { buildReviewerInbox } from "@pr-tracker/reviewer-workflow";
import type {
  PullRequestDetail,
  ReviewerInboxRepository
} from "./repository";

interface PullRequestRow {
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  author_login: string;
  state: string;
  is_draft: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  latest_commit_sha: string;
}

interface ReviewRow {
  id: string;
  reviewer_login: string;
  decision: ReviewDecision;
  commit_sha: string | null;
  body: string | null;
  submitted_at: Date | string;
}

interface ThreadRow {
  id: string;
  is_resolved: boolean;
  participant_logins: string[] | string;
  file_path: string | null;
  line: number | null;
  last_activity_at: Date | string;
}

interface ActivityRow {
  id: string;
  event_type: PullRequestActivity["type"];
  actor_login: string;
  occurred_at: Date | string;
  title: string;
  body: string | null;
}

interface ReviewerRow {
  reviewer_login: string;
}

interface LocalStateRow {
  pull_request_id: string;
  last_seen_at: Date | string | null;
}

export function createDatabaseRepository(
  viewerLogin = process.env.PR_TRACKER_VIEWER_LOGIN ?? "viewer"
): ReviewerInboxRepository {
  let ormPromise: ReturnType<typeof createOrm> | undefined;
  const getOrm = () => {
    ormPromise ??= createOrm();
    return ormPromise;
  };

  return {
    async getReviewerInbox(now) {
      const orm = await getOrm();
      const pullRequests = await loadPullRequests(orm);
      const actors = buildActors(pullRequests, [viewerLogin]);
      const viewer = ensureActor(actors, viewerLogin);
      const lastSeenAtByPullRequestId = await loadLastSeen(orm, viewerLogin);

      return buildReviewerInbox({
        viewer,
        actors,
        pullRequests,
        now,
        lastSeenAtByPullRequestId
      });
    },

    async getPullRequest(id): Promise<PullRequestDetail | undefined> {
      const orm = await getOrm();
      const pullRequests = await loadPullRequests(orm, id);
      const pullRequest = pullRequests[0];

      if (!pullRequest) {
        return undefined;
      }
      const actors = buildActors(pullRequests, [viewerLogin]);
      const viewer = ensureActor(actors, viewerLogin);
      const lastSeenAtByPullRequestId = await loadLastSeen(orm, viewerLogin);
      const inbox = buildReviewerInbox({
        viewer,
        actors,
        pullRequests,
        now: new Date().toISOString(),
        lastSeenAtByPullRequestId
      });
      const item = inbox.items[0];

      return item ? { viewer, actors, item } : undefined;
    },

    async markSeen(input) {
      const orm = await getOrm();
      const now = new Date().toISOString();

      await orm.em.getConnection().execute(
        `
          insert into local_pull_request_states (
            id,
            pull_request_id,
            viewer_login,
            last_seen_at,
            is_muted,
            is_pinned,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (pull_request_id, viewer_login)
          do update set last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at
        `,
        [
          randomUUID(),
          input.pullRequestId,
          viewerLogin,
          input.lastSeenAt,
          false,
          false,
          now,
          now
        ]
      );

      return input;
    },

    async close() {
      if (ormPromise) {
        const orm = await ormPromise;
        await orm.close(true);
      }
    }
  };
}

async function loadPullRequests(
  orm: Awaited<ReturnType<typeof createOrm>>,
  id?: string
): Promise<PullRequestItem[]> {
  const connection = orm.em.getConnection();
  const pullRequestRows = await connection.execute<PullRequestRow[]>(
    `
      select *
      from pull_requests
      where (?::text is null or id = ?)
        and (?::text is not null or state = 'open')
      order by updated_at desc
      limit 250
    `,
    [id ?? null, id ?? null, id ?? null]
  );

  return Promise.all(
    pullRequestRows.map(async (row) => {
      const [reviewerRows, reviewRows, threadRows, activityRows] =
        await Promise.all([
          connection.execute<ReviewerRow[]>(
            `select reviewer_login from pull_request_reviewers where pull_request_id = ?`,
            [row.id]
          ),
          connection.execute<ReviewRow[]>(
            `select * from review_events where pull_request_id = ? order by submitted_at desc`,
            [row.id]
          ),
          connection.execute<ThreadRow[]>(
            `select * from review_threads where pull_request_id = ? order by last_activity_at desc`,
            [row.id]
          ),
          connection.execute<ActivityRow[]>(
            `select * from activity_events where pull_request_id = ? order by occurred_at asc`,
            [row.id]
          )
        ]);

      return {
        id: row.id,
        repository: row.repository,
        number: row.number,
        title: row.title,
        url: row.url,
        authorId: row.author_login,
        state: row.state as PullRequestItem["state"],
        isDraft: row.is_draft,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        latestCommitSha: row.latest_commit_sha,
        requestedReviewerIds: reviewerRows.map((reviewer) => reviewer.reviewer_login),
        reviews: reviewRows.map(toReview),
        threads: threadRows.map(toThread),
        activity: activityRows.map(toActivity)
      };
    })
  );
}

async function loadLastSeen(
  orm: Awaited<ReturnType<typeof createOrm>>,
  viewerLogin: string
): Promise<Record<string, string | undefined>> {
  const rows = await orm.em.getConnection().execute<LocalStateRow[]>(
    `
      select pull_request_id, last_seen_at
      from local_pull_request_states
      where viewer_login = ?
    `,
    [viewerLogin]
  );

  return Object.fromEntries(
    rows.map((row) => [
      row.pull_request_id,
      row.last_seen_at ? toIso(row.last_seen_at) : undefined
    ])
  );
}

function buildActors(
  pullRequests: PullRequestItem[],
  extraLogins: string[] = ["viewer"]
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

function toReview(row: ReviewRow): ReviewDecisionEvent {
  return {
    id: row.id,
    reviewerId: row.reviewer_login,
    decision: row.decision,
    submittedAt: toIso(row.submitted_at),
    commitSha: row.commit_sha ?? undefined,
    body: row.body ?? undefined
  };
}

function toThread(row: ThreadRow): ReviewThread {
  return {
    id: row.id,
    isResolved: row.is_resolved,
    participantIds: Array.isArray(row.participant_logins)
      ? row.participant_logins
      : (JSON.parse(row.participant_logins) as string[]),
    filePath: row.file_path ?? undefined,
    line: row.line ?? undefined,
    lastActivityAt: toIso(row.last_activity_at)
  };
}

function toActivity(row: ActivityRow): PullRequestActivity {
  return {
    id: row.id,
    type: row.event_type,
    actorId: row.actor_login,
    occurredAt: toIso(row.occurred_at),
    title: row.title,
    body: row.body ?? undefined
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
