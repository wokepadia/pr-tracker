import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { GitHubPullRequestSource } from "@pr-tracker/github";
import {
  upsertPullRequestSnapshot,
  upsertReviewSnapshot
} from "./github-ingestion";

export interface GitHubPullRequestSyncResult {
  scannedPullRequests: number;
  ingestedPullRequests: number;
  ingestedReviews: number;
  ignoredPullRequests: number;
}

export async function syncOpenPullRequestsFromGithub(
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
    const snapshots = await source.listOpenPullRequests();
    result.scannedPullRequests = snapshots.length;

    for (const snapshot of snapshots) {
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
