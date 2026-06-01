import { createOrm } from "./client";
import { seedSampleData } from "./sample-data";
import { syncOpenPullRequestsFromGithub } from "./github-sync";

const orm = await createOrm();

try {
  await seedSampleData(orm);

  const result = await syncOpenPullRequestsFromGithub(
    orm,
    {
      async listOpenPullRequests() {
        return [
          {
            installationId: 44,
            repository: {
              full_name: "acme/api",
              html_url: "https://github.com/acme/api",
              owner: { login: "acme" }
            },
            pull_request: {
              id: 321,
              node_id: "PR_sync_321",
              number: 321,
              title: "Backfill reviewer inbox from GitHub App",
              html_url: "https://github.com/acme/api/pull/321",
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
                id: 9001,
                node_id: "PRR_sync_9001",
                state: "commented",
                body: "Taking a look.",
                submitted_at: "2026-06-01T14:04:00.000Z",
                commit_id: "sync-sha-1",
                user: { login: "viewer" }
              }
            ]
          }
        ];
      }
    }
  );

  const rows = await orm.em.getConnection().execute<
    Array<{
      title: string;
      reviewer_count: string;
      review_count: string;
      activity_count: string;
    }>
  >(
    `
      select
        pr.title,
        (select count(*) from pull_request_reviewers rr where rr.pull_request_id = pr.id) as reviewer_count,
        (select count(*) from review_events re where re.pull_request_id = pr.id) as review_count,
        (select count(*) from activity_events ae where ae.pull_request_id = pr.id) as activity_count
      from pull_requests pr
      where pr.github_node_id = ?
    `,
    ["PR_sync_321"]
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
        latestSyncRun: syncRunRows[0]
      },
      null,
      2
    )
  );

  if (result.scannedPullRequests !== 1 || result.ingestedPullRequests !== 1) {
    throw new Error(`Expected one ingested pull request, got ${JSON.stringify(result)}.`);
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

  const syncRun = syncRunRows[0];
  if (!syncRun || syncRun.status !== "succeeded") {
    throw new Error("Expected sync run bookkeeping to record success.");
  }

  if (
    syncRun.scanned_pull_requests !== 1 ||
    syncRun.ingested_pull_requests !== 1 ||
    syncRun.ingested_reviews !== 1
  ) {
    throw new Error(`Unexpected sync run counts: ${JSON.stringify(syncRun)}.`);
  }
} finally {
  await orm.close(true);
}
