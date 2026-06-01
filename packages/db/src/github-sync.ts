import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import type {
  GitHubPullRequestSnapshot,
  GitHubPullRequestSource
} from "@pr-tracker/github";
import {
  upsertPullRequestSnapshot,
  upsertReviewSnapshot
} from "./github-ingestion";

interface KnownOpenPullRequest {
  installation_id: number | null;
  repository: string;
  number: number;
}

export interface GitHubPullRequestSyncResult {
  scannedPullRequests: number;
  ingestedPullRequests: number;
  ingestedReviews: number;
  ignoredPullRequests: number;
}

export async function syncPullRequestsFromGithub(
  orm: MikroORM,
  source: GitHubPullRequestSource,
  options: { sourceName?: string } = {}
): Promise<GitHubPullRequestSyncResult> {
  const startedAt = new Date().toISOString();
  const sourceName = options.sourceName ?? "github-app";
  const syncRunId = await startSyncRun(orm, { sourceName, startedAt });
  const result: GitHubPullRequestSyncResult = {
    scannedPullRequests: 0,
    ingestedPullRequests: 0,
    ingestedReviews: 0,
    ignoredPullRequests: 0
  };

  try {
    const snapshots = await listPullRequestSnapshots(source);
    const reconciledSnapshots = await listKnownOpenPullRequestSnapshots(
      orm,
      source,
      snapshots
    );
    const snapshotsToIngest = [...snapshots, ...reconciledSnapshots];
    result.scannedPullRequests = snapshotsToIngest.length;

    for (const snapshot of snapshotsToIngest) {
      await orm.em.getConnection().transactional(async (trx) => {
        const upsertResult = await upsertPullRequestSnapshot(orm, snapshot, trx);
        if (upsertResult.isFreshEnough) {
          result.ingestedPullRequests += 1;
        } else {
          result.ignoredPullRequests += 1;
        }

        for (const review of snapshot.reviews ?? []) {
          await upsertReviewSnapshot(orm, upsertResult.pullRequestId, review, trx);
          result.ingestedReviews += 1;
        }
      });
    }

    await finishSyncRun(orm, {
      syncRunId,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      result
    });

    return result;
  } catch (error) {
    try {
      await finishSyncRun(orm, {
        syncRunId,
        status: "failed",
        finishedAt: new Date().toISOString(),
        result,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch (bookkeepingError) {
      console.error("Failed to record failed GitHub sync run.", bookkeepingError);
    }

    throw error;
  }
}

export const syncOpenPullRequestsFromGithub = syncPullRequestsFromGithub;

async function listPullRequestSnapshots(
  source: GitHubPullRequestSource
): Promise<GitHubPullRequestSnapshot[]> {
  if (source.listPullRequests) {
    return source.listPullRequests();
  }

  if (source.listOpenPullRequests) {
    return source.listOpenPullRequests();
  }

  throw new Error("GitHub pull request source does not provide a list method.");
}

async function listKnownOpenPullRequestSnapshots(
  orm: MikroORM,
  source: GitHubPullRequestSource,
  listedSnapshots: GitHubPullRequestSnapshot[]
): Promise<GitHubPullRequestSnapshot[]> {
  if (!source.getPullRequest) {
    return [];
  }

  const listedPullRequestKeys = new Set(
    listedSnapshots
      .map((snapshot) =>
        pullRequestKey(snapshot.repository.full_name, snapshot.pull_request.number)
      )
      .filter((key) => key !== undefined)
  );
  const knownOpenPullRequests = await listKnownOpenPullRequests(orm);
  const snapshots: GitHubPullRequestSnapshot[] = [];

  for (const pullRequest of knownOpenPullRequests) {
    const key = pullRequestKey(pullRequest.repository, pullRequest.number);
    if (!key || listedPullRequestKeys.has(key)) {
      continue;
    }

    const snapshot = await source.getPullRequest({
      installationId: pullRequest.installation_id ?? undefined,
      repository: pullRequest.repository,
      number: pullRequest.number
    });

    if (snapshot) {
      snapshots.push(snapshot);
      listedPullRequestKeys.add(key);
    }
  }

  return snapshots;
}

async function listKnownOpenPullRequests(
  orm: MikroORM
): Promise<KnownOpenPullRequest[]> {
  return orm.em.getConnection().execute<KnownOpenPullRequest[]>(
    `
      select
        gi.github_installation_id as installation_id,
        pr.repository,
        pr.number
      from pull_requests pr
      left join github_installations gi on gi.id = pr.installation_id
      where pr.state = 'open'
      order by pr.updated_at desc
    `
  );
}

function pullRequestKey(
  repository: string | undefined,
  number: number | undefined
): string | undefined {
  if (!repository || number === undefined) {
    return undefined;
  }

  return `${repository}#${number}`;
}

async function startSyncRun(
  orm: MikroORM,
  input: {
    sourceName: string;
    startedAt: string;
  }
): Promise<string> {
  const syncRunId = randomUUID();

  await orm.em.getConnection().execute(
    `
      insert into sync_runs (
        id,
        source,
        status,
        scanned_pull_requests,
        ingested_pull_requests,
        ingested_reviews,
        ignored_pull_requests,
        error,
        started_at,
        finished_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      syncRunId,
      input.sourceName,
      "in_progress",
      0,
      0,
      0,
      0,
      null,
      input.startedAt,
      null
    ]
  );

  return syncRunId;
}

async function finishSyncRun(
  orm: MikroORM,
  input: {
    syncRunId: string;
    status: "succeeded" | "failed";
    finishedAt: string;
    result: GitHubPullRequestSyncResult;
    error?: string;
  }
): Promise<void> {
  await orm.em.getConnection().execute(
    `
      update sync_runs
      set
        status = ?,
        scanned_pull_requests = ?,
        ingested_pull_requests = ?,
        ingested_reviews = ?,
        ignored_pull_requests = ?,
        error = ?,
        finished_at = ?
      where id = ?
    `,
    [
      input.status,
      input.result.scannedPullRequests,
      input.result.ingestedPullRequests,
      input.result.ingestedReviews,
      input.result.ignoredPullRequests,
      input.error ?? null,
      input.finishedAt,
      input.syncRunId
    ]
  );
}
