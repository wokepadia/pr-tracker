import { createOrm } from "./client";
import { ingestWebhookEvent } from "./github-ingestion";
import { seedSampleData } from "./sample-data";

const orm = await createOrm();

try {
  await seedSampleData(orm);

  await ingestWebhookEvent(orm, {
    deliveryId: "smoke-pr-opened",
    eventName: "pull_request",
    action: "opened",
    installationId: 44,
    receivedAt: "2026-06-01T13:00:00.000Z",
    rawPayload: {
      action: "opened",
      sender: { login: "maya" },
      installation: {
        id: 44,
        account: { login: "acme" }
      },
      repository: {
        full_name: "acme/api",
        html_url: "https://github.com/acme/api",
        owner: { login: "acme" }
      },
      pull_request: {
        id: 199,
        node_id: "PR_smoke_199",
        number: 199,
        title: "Smoke-test webhook ingestion",
        html_url: "https://github.com/acme/api/pull/199",
        state: "open",
        draft: false,
        created_at: "2026-06-01T13:00:00.000Z",
        updated_at: "2026-06-01T13:00:00.000Z",
        user: { login: "maya" },
        head: { sha: "smoke-sha-1" },
        requested_reviewers: [{ login: "viewer" }]
      }
    }
  });

  await ingestWebhookEvent(orm, {
    deliveryId: "smoke-review-approved",
    eventName: "pull_request_review",
    action: "submitted",
    installationId: 44,
    receivedAt: "2026-06-01T13:10:00.000Z",
    rawPayload: {
      action: "submitted",
      sender: { login: "viewer" },
      installation: {
        id: 44,
        account: { login: "acme" }
      },
      repository: {
        full_name: "acme/api",
        html_url: "https://github.com/acme/api",
        owner: { login: "acme" }
      },
      pull_request: {
        id: 199,
        node_id: "PR_smoke_199",
        number: 199,
        title: "Smoke-test webhook ingestion",
        html_url: "https://github.com/acme/api/pull/199",
        state: "open",
        draft: false,
        created_at: "2026-06-01T13:00:00.000Z",
        updated_at: "2026-06-01T13:10:00.000Z",
        user: { login: "maya" },
        head: { sha: "smoke-sha-1" },
        requested_reviewers: []
      },
      review: {
        id: 7001,
        node_id: "PRR_smoke_7001",
        state: "approved",
        body: "Looks good.",
        submitted_at: "2026-06-01T13:10:00.000Z",
        commit_id: "smoke-sha-1",
        user: { login: "viewer" }
      }
    }
  });

  await ingestWebhookEvent(orm, {
    deliveryId: "smoke-pr-stale",
    eventName: "pull_request",
    action: "synchronize",
    installationId: 44,
    receivedAt: "2026-06-01T13:11:00.000Z",
    rawPayload: {
      action: "synchronize",
      sender: { login: "maya" },
      installation: {
        id: 44,
        account: { login: "acme" }
      },
      repository: {
        full_name: "acme/api",
        html_url: "https://github.com/acme/api",
        owner: { login: "acme" }
      },
      pull_request: {
        id: 199,
        node_id: "PR_smoke_199",
        number: 199,
        title: "Stale smoke payload should not win",
        html_url: "https://github.com/acme/api/pull/199",
        state: "open",
        draft: false,
        created_at: "2026-06-01T13:00:00.000Z",
        updated_at: "2026-06-01T13:00:00.000Z",
        user: { login: "maya" },
        head: { sha: "stale-smoke-sha" },
        requested_reviewers: [{ login: "viewer" }]
      }
    }
  });

  const rows = await orm.em.getConnection().execute<
    Array<{
      title: string;
      review_count: string;
      activity_count: string;
      latest_commit_sha: string;
      reviewer_count: string;
    }>
  >(
    `
      select
        pr.title,
        pr.latest_commit_sha,
        (select count(*) from review_events re where re.pull_request_id = pr.id) as review_count,
        (select count(*) from activity_events ae where ae.pull_request_id = pr.id) as activity_count,
        (select count(*) from pull_request_reviewers rr where rr.pull_request_id = pr.id) as reviewer_count
      from pull_requests pr
      where pr.github_node_id = ?
    `,
    ["PR_smoke_199"]
  );

  const row = rows[0];
  if (!row) {
    throw new Error("Smoke PR was not ingested.");
  }

  console.log(
    JSON.stringify(
      {
        title: row.title,
        latestCommitSha: row.latest_commit_sha,
        reviewCount: Number(row.review_count),
        activityCount: Number(row.activity_count),
        reviewerCount: Number(row.reviewer_count)
      },
      null,
      2
    )
  );

  if (Number(row.review_count) !== 1) {
    throw new Error(`Expected one review event, got ${row.review_count}.`);
  }

  if (Number(row.activity_count) !== 3) {
    throw new Error(`Expected three activity events, got ${row.activity_count}.`);
  }

  if (Number(row.reviewer_count) !== 0) {
    throw new Error(
      `Expected review submission to refresh requested reviewers, got ${row.reviewer_count}.`
    );
  }

  if (row.title !== "Smoke-test webhook ingestion") {
    throw new Error(`Expected stale payload not to overwrite title, got ${row.title}.`);
  }

  if (row.latest_commit_sha !== "smoke-sha-1") {
    throw new Error(
      `Expected stale payload not to overwrite commit sha, got ${row.latest_commit_sha}.`
    );
  }
} finally {
  await orm.close(true);
}
