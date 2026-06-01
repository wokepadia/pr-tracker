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

    await recordSyncRun(orm, {
      sourceName,
      status: "succeeded",
      startedAt,
      finishedAt: new Date().toISOString(),
      result
    });

    return result;
  } catch (error) {
    await recordSyncRun(orm, {
      sourceName,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      result,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

async function recordSyncRun(
  orm: MikroORM,
  input: {
    sourceName: string;
    status: "succeeded" | "failed";
    startedAt: string;
    finishedAt: string;
    result: GitHubPullRequestSyncResult;
    error?: string;
  }
): Promise<void> {
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
      randomUUID(),
      input.sourceName,
      input.status,
      input.result.scannedPullRequests,
      input.result.ingestedPullRequests,
      input.result.ingestedReviews,
      input.result.ignoredPullRequests,
      input.error ?? null,
      input.startedAt,
      input.finishedAt
    ]
  );
}
