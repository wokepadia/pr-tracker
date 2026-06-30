import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  GitHubPullRequestSnapshot,
  GitHubPullRequestSource
} from "@pr-tracker/github";
import { mapConcurrent } from "@pr-tracker/github";
import { upsertLocalPullRequestSnapshot } from "./local-sqlite";

interface KnownOpenPullRequest {
  repository: string;
  number: number;
}

export interface LocalGitHubPullRequestSyncResult {
  scannedPullRequests: number;
  ingestedPullRequests: number;
  ingestedReviews: number;
  ignoredPullRequests: number;
  pullRequestIds: string[];
}

export async function syncPullRequestsToLocalSqlite(
  db: DatabaseSync,
  source: GitHubPullRequestSource,
  options: {
    sourceName?: string;
    profileId?: string;
    viewerLogin?: string;
    searchQuery?: string;
  } = {}
): Promise<LocalGitHubPullRequestSyncResult> {
  const startedAt = new Date().toISOString();
  const syncRunId = startLocalSyncRun(db, {
    sourceName: options.sourceName ?? "github-token",
    startedAt
  });
  const result: LocalGitHubPullRequestSyncResult = {
    scannedPullRequests: 0,
    ingestedPullRequests: 0,
    ingestedReviews: 0,
    ignoredPullRequests: 0,
    pullRequestIds: []
  };

  try {
    const snapshots = await listPullRequestSnapshots(source, {
      searchQuery: options.searchQuery
    });
    const reconciledSnapshots = options.searchQuery
      ? []
      : await listKnownOpenPullRequestSnapshots(db, source, snapshots);
    const snapshotsToIngest = [...snapshots, ...reconciledSnapshots];
    result.scannedPullRequests = snapshotsToIngest.length;

    for (const snapshot of snapshotsToIngest) {
      const upsertResult = upsertLocalPullRequestSnapshot(db, snapshot, {
        profileId: options.profileId,
        viewerLogin: options.viewerLogin
      });
      result.pullRequestIds.push(upsertResult.pullRequestId);

      if (upsertResult.isFreshEnough) {
        result.ingestedPullRequests += 1;
        result.ingestedReviews += snapshot.reviews?.length ?? 0;
      } else {
        result.ignoredPullRequests += 1;
      }
    }

    finishLocalSyncRun(db, {
      syncRunId,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      result
    });

    return result;
  } catch (error) {
    try {
      finishLocalSyncRun(db, {
        syncRunId,
        status: "failed",
        finishedAt: new Date().toISOString(),
        result,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch (bookkeepingError) {
      console.error("Failed to record failed local GitHub sync run.", bookkeepingError);
    }

    throw error;
  }
}

async function listPullRequestSnapshots(
  source: GitHubPullRequestSource,
  options: { searchQuery?: string } = {}
): Promise<GitHubPullRequestSnapshot[]> {
  if (source.listPullRequests) {
    return source.listPullRequests({ searchQuery: options.searchQuery });
  }

  if (source.listOpenPullRequests) {
    return source.listOpenPullRequests({ searchQuery: options.searchQuery });
  }

  throw new Error("GitHub pull request source does not provide a list method.");
}

async function listKnownOpenPullRequestSnapshots(
  db: DatabaseSync,
  source: GitHubPullRequestSource,
  listedSnapshots: GitHubPullRequestSnapshot[]
): Promise<GitHubPullRequestSnapshot[]> {
  if (!source.getPullRequest) {
    return [];
  }

  const getPullRequest = source.getPullRequest;
  const listedPullRequestKeys = new Set(
    listedSnapshots
      .map((snapshot) =>
        pullRequestKey(snapshot.repository.full_name, snapshot.pull_request.number)
      )
      .filter((key) => key !== undefined)
  );

  const pullRequestsToRefresh = listKnownOpenPullRequests(db).filter(
    (pullRequest) => {
      const key = pullRequestKey(pullRequest.repository, pullRequest.number);
      return key !== undefined && !listedPullRequestKeys.has(key);
    }
  );

  const refreshedSnapshots = await mapConcurrent(
    pullRequestsToRefresh,
    8,
    (pullRequest) =>
      getPullRequest({
        repository: pullRequest.repository,
        number: pullRequest.number
      }).catch((error: unknown) => {
        if (isTransientGithubDetailRefreshError(error)) {
          console.warn(
            `Skipping refresh for known pull request ${pullRequest.repository}#${pullRequest.number}:`,
            error
          );
          return undefined;
        }

        throw error;
      })
  );

  return refreshedSnapshots.filter(
    (snapshot): snapshot is GitHubPullRequestSnapshot => snapshot !== undefined
  );
}

function listKnownOpenPullRequests(db: DatabaseSync): KnownOpenPullRequest[] {
  return db
    .prepare(
      `
        select
          repo.full_name as repository,
          pr.number
        from pull_requests pr
        join github_repositories repo on repo.id = pr.repository_id
        where pr.state = 'open'
        order by pr.github_updated_at desc
      `
    )
    .all() as unknown as KnownOpenPullRequest[];
}

function isTransientGithubDetailRefreshError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|aborted|failed to fetch|load failed|network/i.test(
    message
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

function startLocalSyncRun(
  db: DatabaseSync,
  input: {
    sourceName: string;
    startedAt: string;
  }
): string {
  const syncRunId = randomUUID();

  db.prepare(
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
    `
  ).run(syncRunId, input.sourceName, "running", 0, 0, 0, 0, null, input.startedAt, null);

  return syncRunId;
}

function finishLocalSyncRun(
  db: DatabaseSync,
  input: {
    syncRunId: string;
    status: "succeeded" | "failed";
    finishedAt: string;
    result: LocalGitHubPullRequestSyncResult;
    error?: string;
  }
): void {
  db.prepare(
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
    `
  ).run(
    input.status,
    input.result.scannedPullRequests,
    input.result.ingestedPullRequests,
    input.result.ingestedReviews,
    input.result.ignoredPullRequests,
    input.error ?? null,
    input.finishedAt,
    input.syncRunId
  );
}
