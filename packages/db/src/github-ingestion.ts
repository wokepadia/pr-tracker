import type { Transaction } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { NormalizedWebhookEvent } from "@pr-tracker/github";
import { deterministicUuid } from "./ids";

interface GitHubPullRequestPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  sender?: { login?: string };
  repository?: {
    full_name?: string;
    html_url?: string;
    owner?: { login?: string };
  };
  pull_request?: {
    id?: number;
    node_id?: string;
    number?: number;
    title?: string;
    html_url?: string;
    state?: string;
    draft?: boolean;
    created_at?: string;
    updated_at?: string;
    user?: { login?: string };
    head?: { sha?: string };
    merged?: boolean;
    requested_reviewers?: Array<{ login?: string }>;
  };
}

interface GitHubReviewPayload extends GitHubPullRequestPayload {
  review?: {
    id?: number;
    node_id?: string;
    state?: string;
    body?: string | null;
    submitted_at?: string;
    commit_id?: string;
    user?: { login?: string };
  };
}

export async function ingestWebhookEvent(
  orm: MikroORM,
  event: NormalizedWebhookEvent,
  ctx?: Transaction
): Promise<"ignored" | "ingested"> {
  if (event.eventName === "pull_request") {
    await ingestPullRequestEvent(orm, event, ctx);
    return "ingested";
  }

  if (event.eventName === "pull_request_review") {
    await ingestPullRequestReviewEvent(orm, event, ctx);
    return "ingested";
  }

  return "ignored";
}

async function ingestPullRequestEvent(
  orm: MikroORM,
  event: NormalizedWebhookEvent,
  ctx?: Transaction
): Promise<void> {
  const payload = event.rawPayload as GitHubPullRequestPayload;
  const pullRequest = payload.pull_request;

  if (!pullRequest) {
    return;
  }

  const result = await upsertPullRequestFromPayload(orm, payload, ctx);
  if (result.isFreshEnough) {
    await replaceRequestedReviewers(orm, result.pullRequestId, pullRequest, ctx);
  }

  await recordActivityFromWebhook(orm, event, result.pullRequestId, {
    actorLogin: payload.sender?.login ?? pullRequest.user?.login ?? "unknown",
    title: pullRequestActivityTitle(event.action, pullRequest.title)
  }, ctx);
}

async function ingestPullRequestReviewEvent(
  orm: MikroORM,
  event: NormalizedWebhookEvent,
  ctx?: Transaction
): Promise<void> {
  const payload = event.rawPayload as GitHubReviewPayload;
  const pullRequest = payload.pull_request;
  const review = payload.review;

  if (!pullRequest || !review) {
    return;
  }

  const result = await upsertPullRequestFromPayload(orm, payload, ctx);
  if (result.isFreshEnough) {
    await replaceRequestedReviewers(orm, result.pullRequestId, pullRequest, ctx);
  }

  const reviewNodeId = requiredGithubNodeId(
    review.node_id,
    review.id,
    "pull_request_review"
  );
  const submittedAt =
    review.submitted_at ?? pullRequest.updated_at ?? event.receivedAt;
  const reviewerLogin = review.user?.login ?? "unknown";
  const decision = mapReviewState(review.state);

  await orm.em.getConnection().execute(
    `
      insert into review_events (
        id,
        pull_request_id,
        github_node_id,
        reviewer_login,
        decision,
        commit_sha,
        body,
        submitted_at,
        raw_payload
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
      on conflict (github_node_id)
      do update set
        reviewer_login = excluded.reviewer_login,
        decision = excluded.decision,
        commit_sha = excluded.commit_sha,
        body = excluded.body,
        submitted_at = excluded.submitted_at,
        raw_payload = excluded.raw_payload
    `,
    [
      deterministicUuid(`review:${reviewNodeId}`),
      result.pullRequestId,
      reviewNodeId,
      reviewerLogin,
      decision,
      review.commit_id ?? null,
      review.body ?? null,
      submittedAt,
      JSON.stringify(review)
    ],
    undefined,
    ctx
  );

  await recordActivityFromWebhook(orm, event, result.pullRequestId, {
    actorLogin: reviewerLogin,
    title: `${reviewerLogin} ${decision.replace("_", " ")}`
  }, ctx);
}

async function upsertPullRequestFromPayload(
  orm: MikroORM,
  payload: GitHubPullRequestPayload,
  ctx?: Transaction
): Promise<{ pullRequestId: string; isFreshEnough: boolean }> {
  const pullRequest = payload.pull_request;
  const repository = payload.repository;

  if (!pullRequest) {
    throw new Error("Missing pull_request payload.");
  }

  const githubNodeId = requiredGithubNodeId(
    pullRequest.node_id,
    pullRequest.id,
    "pull_request"
  );
  const installationId = await upsertInstallation(orm, payload, ctx);
  const pullRequestId = deterministicUuid(`pull-request:${githubNodeId}`);
  const now = new Date().toISOString();
  const incomingUpdatedAt = pullRequest.updated_at ?? now;
  const isFreshEnough = await isFreshEnoughPullRequestPayload(
    orm,
    githubNodeId,
    incomingUpdatedAt,
    ctx
  );

  await orm.em.getConnection().execute(
    `
      insert into pull_requests (
        id,
        installation_id,
        github_node_id,
        repository,
        number,
        title,
        url,
        author_login,
        state,
        is_draft,
        latest_commit_sha,
        raw_payload,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
      on conflict (github_node_id)
      do update set
        title = excluded.title,
        url = excluded.url,
        state = excluded.state,
        is_draft = excluded.is_draft,
        latest_commit_sha = excluded.latest_commit_sha,
        raw_payload = excluded.raw_payload,
        updated_at = excluded.updated_at
      where pull_requests.updated_at <= excluded.updated_at
    `,
    [
      pullRequestId,
      installationId,
      githubNodeId,
      repository?.full_name ?? "unknown/unknown",
      pullRequest.number ?? 0,
      pullRequest.title ?? "Untitled pull request",
      pullRequest.html_url ?? repository?.html_url ?? "",
      pullRequest.user?.login ?? "unknown",
      pullRequest.merged ? "merged" : normalizePullRequestState(pullRequest.state),
      pullRequest.draft ?? false,
      pullRequest.head?.sha ?? "",
      JSON.stringify(payload),
      pullRequest.created_at ?? now,
      incomingUpdatedAt
    ],
    undefined,
    ctx
  );

  return { pullRequestId, isFreshEnough };
}

async function upsertInstallation(
  orm: MikroORM,
  payload: GitHubPullRequestPayload,
  ctx?: Transaction
): Promise<string> {
  const githubInstallationId = payload.installation?.id;
  if (!githubInstallationId || githubInstallationId <= 0) {
    throw new Error("Missing installation.id in GitHub webhook payload.");
  }

  const installationId = deterministicUuid(`installation:${githubInstallationId}`);
  const accountLogin =
    payload.installation?.account?.login ??
    payload.repository?.owner?.login ??
    "unknown";
  const now = new Date().toISOString();

  await orm.em.getConnection().execute(
    `
      insert into github_installations (
        id,
        github_installation_id,
        account_login,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?)
      on conflict (github_installation_id)
      do update set account_login = excluded.account_login, updated_at = excluded.updated_at
    `,
    [installationId, githubInstallationId, accountLogin, now, now],
    undefined,
    ctx
  );

  return installationId;
}

async function replaceRequestedReviewers(
  orm: MikroORM,
  pullRequestId: string,
  pullRequest: NonNullable<GitHubPullRequestPayload["pull_request"]>,
  ctx?: Transaction
): Promise<void> {
  const connection = orm.em.getConnection();
  await connection.execute(
    `delete from pull_request_reviewers where pull_request_id = ?`,
    [pullRequestId],
    undefined,
    ctx
  );

  for (const reviewer of pullRequest.requested_reviewers ?? []) {
    if (!reviewer.login) {
      continue;
    }

    await connection.execute(
      `
        insert into pull_request_reviewers (
          id,
          pull_request_id,
          reviewer_login,
          created_at
        )
        values (?, ?, ?, ?)
        on conflict (pull_request_id, reviewer_login) do nothing
      `,
      [
        deterministicUuid(`reviewer:${pullRequestId}:${reviewer.login}`),
        pullRequestId,
        reviewer.login,
        new Date().toISOString()
      ],
      undefined,
      ctx
    );
  }
}

async function recordActivityFromWebhook(
  orm: MikroORM,
  event: NormalizedWebhookEvent,
  pullRequestId: string,
  input: {
    actorLogin: string;
    title: string;
  },
  ctx?: Transaction
): Promise<void> {
  await orm.em.getConnection().execute(
    `
      insert into activity_events (
        id,
        pull_request_id,
        github_delivery_id,
        event_type,
        actor_login,
        occurred_at,
        title,
        body,
        raw_payload
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
      on conflict (id) do nothing
    `,
    [
      deterministicUuid(`activity:${event.deliveryId}`),
      pullRequestId,
      event.deliveryId,
      webhookActivityType(event),
      input.actorLogin,
      event.receivedAt,
      input.title,
      null,
      JSON.stringify(event.rawPayload)
    ],
    undefined,
    ctx
  );
}

function normalizePullRequestState(state: string | undefined): string {
  if (state === "merged") {
    return "merged";
  }

  if (state === "closed") {
    return "closed";
  }

  return "open";
}

function mapReviewState(state: string | undefined): string {
  if (state === "approved") {
    return "approved";
  }

  if (state === "changes_requested") {
    return "changes_requested";
  }

  return "commented";
}

interface CurrentPullRequestRow {
  updated_at: Date | string;
}

async function isFreshEnoughPullRequestPayload(
  orm: MikroORM,
  githubNodeId: string,
  incomingUpdatedAt: string,
  ctx?: Transaction
): Promise<boolean> {
  const rows = await orm.em.getConnection().execute<CurrentPullRequestRow[]>(
    `select updated_at from pull_requests where github_node_id = ?`,
    [githubNodeId],
    "all",
    ctx
  );
  const current = rows[0];

  if (!current) {
    return true;
  }

  return (
    new Date(incomingUpdatedAt).getTime() >=
    new Date(current.updated_at).getTime()
  );
}

function requiredGithubNodeId(
  nodeId: string | undefined,
  numericId: number | undefined,
  payloadName: string
): string {
  if (nodeId) {
    return nodeId;
  }

  if (typeof numericId === "number" && numericId > 0) {
    return String(numericId);
  }

  throw new Error(`Missing ${payloadName}.node_id/id in GitHub webhook payload.`);
}

function webhookActivityType(event: NormalizedWebhookEvent): string {
  if (event.eventName === "pull_request_review") {
    return "review";
  }

  if (
    event.action === "review_requested" ||
    event.action === "review_request_removed"
  ) {
    return "review_request";
  }

  if (event.action === "synchronize") {
    return "commit";
  }

  if (event.action === "ready_for_review") {
    return "ready_for_review";
  }

  if (event.action === "converted_to_draft") {
    return "converted_to_draft";
  }

  return "pull_request";
}

function pullRequestActivityTitle(
  action: string | undefined,
  title: string | undefined
): string {
  return `Pull request ${action ?? "updated"}: ${title ?? "Untitled"}`;
}
