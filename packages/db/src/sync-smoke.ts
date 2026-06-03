import { createOrm } from "./client";
import { seedSampleData } from "./sample-data";
import { syncPullRequestsFromGithub } from "./github-sync";
import { upsertPullRequestSnapshot } from "./github-ingestion";

const orm = await createOrm();
const runId = Date.now();
const openNumber = 900_000 + (runId % 10_000);
const closedNumber = openNumber + 1;
const mergedNumber = openNumber + 2;
const staleOpenNumber = openNumber + 3;
const openNodeId = `PR_sync_${runId}_open`;
const closedNodeId = `PR_sync_${runId}_closed`;
const mergedNodeId = `PR_sync_${runId}_merged`;
const staleOpenNodeId = `PR_sync_${runId}_stale_open`;
const reviewNodeId = `PRR_sync_${runId}`;

try {
  await seedSampleData(orm);
  await upsertPullRequestSnapshot(orm, {
    repository: {
      full_name: "acme/api",
      html_url: "https://github.com/acme/api",
      owner: { login: "acme" }
    },
    pull_request: {
      id: staleOpenNumber,
      node_id: staleOpenNodeId,
      number: staleOpenNumber,
      title: "Known open PR should be reconciled",
      html_url: `https://github.com/acme/api/pull/${staleOpenNumber}`,
      state: "open",
      draft: false,
      created_at: "2026-05-01T13:00:00.000Z",
      updated_at: "2026-05-01T14:00:00.000Z",
      user: { login: "ari" },
      head: { sha: "sync-sha-known-open" },
      requested_reviewers: [{ login: "viewer" }]
    }
  });

  const result = await syncPullRequestsFromGithub(
    orm,
    {
      async listPullRequests() {
        return [
          {
            repository: {
              full_name: "acme/api",
              html_url: "https://github.com/acme/api",
              owner: { login: "acme" }
            },
            pull_request: {
              id: openNumber,
              node_id: openNodeId,
              number: openNumber,
              title: "Backfill reviewer inbox from GitHub token",
              html_url: `https://github.com/acme/api/pull/${openNumber}`,
              state: "open",
              draft: false,
              created_at: "2026-06-01T14:00:00.000Z",
              updated_at: "2026-06-01T14:05:00.000Z",
              user: { login: "ari" },
              head: { sha: "sync-sha-1" },
              requested_reviewers: [{ login: "viewer" }]
            },
            reviews: [
              {
                id: runId,
                node_id: reviewNodeId,
                state: "commented",
                body: "Taking a look.",
                submitted_at: "2026-06-01T14:04:00.000Z",
                commit_id: "sync-sha-1",
                user: { login: "viewer" }
              }
            ]
          },
          {
            repository: {
              full_name: "acme/api",
              html_url: "https://github.com/acme/api",
              owner: { login: "acme" }
            },
            pull_request: {
              id: closedNumber,
              node_id: closedNodeId,
              number: closedNumber,
              title: "Closed PR should not stay active",
              html_url: `https://github.com/acme/api/pull/${closedNumber}`,
              state: "closed",
              draft: false,
              created_at: "2026-06-01T13:00:00.000Z",
              updated_at: "2026-06-01T14:07:00.000Z",
              user: { login: "ari" },
              head: { sha: "sync-sha-closed" },
              requested_reviewers: [{ login: "viewer" }]
            }
          },
          {
            repository: {
              full_name: "acme/api",
              html_url: "https://github.com/acme/api",
              owner: { login: "acme" }
            },
            pull_request: {
              id: mergedNumber,
              node_id: mergedNodeId,
              number: mergedNumber,
              title: "Merged PR should not stay active",
              html_url: `https://github.com/acme/api/pull/${mergedNumber}`,
              state: "closed",
              merged: true,
              draft: false,
              created_at: "2026-06-01T13:00:00.000Z",
              updated_at: "2026-06-01T14:08:00.000Z",
              user: { login: "ari" },
              head: { sha: "sync-sha-merged" },
              requested_reviewers: [{ login: "viewer" }]
            }
          }
        ];
      },
      async getPullRequest(input) {
        if (input.repository !== "acme/api" || input.number !== staleOpenNumber) {
          return undefined;
        }

        return {
          repository: {
            full_name: "acme/api",
            html_url: "https://github.com/acme/api",
            owner: { login: "acme" }
          },
          pull_request: {
            id: staleOpenNumber,
            node_id: staleOpenNodeId,
            number: staleOpenNumber,
            title: "Known open PR should be reconciled",
            html_url: `https://github.com/acme/api/pull/${staleOpenNumber}`,
            state: "closed",
            merged: true,
            draft: false,
            created_at: "2026-05-01T13:00:00.000Z",
            updated_at: "2026-06-01T14:09:00.000Z",
            user: { login: "ari" },
            head: { sha: "sync-sha-known-merged" },
            requested_reviewers: [{ login: "viewer" }]
          }
        };
      }
    }
  );

  const rows = await orm.em.getConnection().execute<
    Array<{
      title: string;
      reviewer_count: string;
      review_count: string;
      activity_count: string;
      closed_state: string;
      merged_state: string;
      reconciled_state: string;
    }>
  >(
    `
      select
        pr.title,
        (select count(*) from pull_request_reviewers rr where rr.pull_request_id = pr.id) as reviewer_count,
        (select count(*) from review_events re where re.pull_request_id = pr.id) as review_count,
        (select count(*) from activity_events ae where ae.pull_request_id = pr.id) as activity_count,
        (select state from pull_requests closed_pr where closed_pr.github_node_id = ?) as closed_state,
        (select state from pull_requests merged_pr where merged_pr.github_node_id = ?) as merged_state,
        (select state from pull_requests reconciled_pr where reconciled_pr.github_node_id = ?) as reconciled_state
      from pull_requests pr
      where pr.github_node_id = ?
    `,
    [closedNodeId, mergedNodeId, staleOpenNodeId, openNodeId]
  );
  const syncRunRows = await orm.em.getConnection().execute<
    Array<{
      status: string;
      scanned_pull_requests: number;
      ingested_pull_requests: number;
      ingested_reviews: number;
    }>
  >(
    `
      select status, scanned_pull_requests, ingested_pull_requests, ingested_reviews
      from sync_runs
      order by started_at desc
      limit 1
    `
  );

  const row = rows[0];
  if (!row) {
    throw new Error("Synced PR was not ingested.");
  }

  console.log(
    JSON.stringify(
      {
        ...result,
        title: row.title,
        reviewerCount: Number(row.reviewer_count),
        reviewCount: Number(row.review_count),
        activityCount: Number(row.activity_count),
        closedState: row.closed_state,
        mergedState: row.merged_state,
        reconciledState: row.reconciled_state,
        latestSyncRun: syncRunRows[0]
      },
      null,
      2
    )
  );

  if (result.scannedPullRequests !== 4 || result.ingestedPullRequests !== 4) {
    throw new Error(`Expected four ingested pull requests, got ${JSON.stringify(result)}.`);
  }

  if (result.ingestedReviews !== 1) {
    throw new Error(`Expected one ingested review, got ${result.ingestedReviews}.`);
  }

  if (Number(row.reviewer_count) !== 1) {
    throw new Error(`Expected one requested reviewer, got ${row.reviewer_count}.`);
  }

  if (Number(row.review_count) !== 1) {
    throw new Error(`Expected one review event, got ${row.review_count}.`);
  }

  if (Number(row.activity_count) !== 0) {
    throw new Error(`Expected sync not to fabricate activity events, got ${row.activity_count}.`);
  }

  if (row.closed_state !== "closed") {
    throw new Error(`Expected closed PR state to sync, got ${row.closed_state}.`);
  }

  if (row.merged_state !== "merged") {
    throw new Error(`Expected merged PR state to sync, got ${row.merged_state}.`);
  }

  if (row.reconciled_state !== "merged") {
    throw new Error(
      `Expected known open PR to reconcile as merged, got ${row.reconciled_state}.`
    );
  }

  const syncRun = syncRunRows[0];
  if (!syncRun || syncRun.status !== "succeeded") {
    throw new Error("Expected sync run bookkeeping to record success.");
  }

  if (
    syncRun.scanned_pull_requests !== 4 ||
    syncRun.ingested_pull_requests !== 4 ||
    syncRun.ingested_reviews !== 1
  ) {
    throw new Error(`Unexpected sync run counts: ${JSON.stringify(syncRun)}.`);
  }

  await syncPullRequestsFromGithub(orm, {
    async listPullRequests() {
      const inProgressRows = await orm.em.getConnection().execute<
        Array<{ status: string; finished_at: Date | string | null }>
      >(
        `
          select status, finished_at
          from sync_runs
          order by started_at desc
          limit 1
        `
      );
      const inProgress = inProgressRows[0];

      if (
        !inProgress ||
        inProgress.status !== "in_progress" ||
        inProgress.finished_at
      ) {
        throw new Error(
          `Expected observable in-progress sync run, got ${JSON.stringify(
            inProgress
          )}.`
        );
      }

      throw new Error("Synthetic sync failure");
    }
  }).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== "Synthetic sync failure") {
      throw error;
    }
  });

  const failureRows = await orm.em.getConnection().execute<
    Array<{
      status: string;
      error: string | null;
      finished_at: Date | string | null;
    }>
  >(
    `
      select status, error, finished_at
      from sync_runs
      order by started_at desc
      limit 1
    `
  );
  const failure = failureRows[0];

  if (
    !failure ||
    failure.status !== "failed" ||
    failure.error !== "Synthetic sync failure" ||
    !failure.finished_at
  ) {
    throw new Error(
      `Expected failed sync run bookkeeping, got ${JSON.stringify(failure)}.`
    );
  }
} finally {
  await orm.close(true);
}
