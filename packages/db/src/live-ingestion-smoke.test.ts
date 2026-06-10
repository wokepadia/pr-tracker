// Opt-in live smoke test against real GitHub data. Run it with:
//   PR_TRACKER_LIVE_SMOKE=1 GITHUB_TOKEN=$(gh auth token) \
//     pnpm --filter @pr-tracker/db exec vitest run src/live-ingestion-smoke.test.ts
// It is skipped unless PR_TRACKER_LIVE_SMOKE=1 so normal test runs never
// touch the network, even when GITHUB_TOKEN is present in the environment.
import { describe, expect, it } from "vitest";
import { createGithubTokenPullRequestSource } from "@pr-tracker/github";
import {
  listLocalPullRequestRows,
  listLocalReviewThreadParticipantRows,
  listLocalReviewThreadRows,
  openLocalDatabase
} from "./local-sqlite";
import { syncPullRequestsToLocalSqlite } from "./local-github-sync";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_SMOKE_REPO ?? "zulip/zulip";
const liveSmokeEnabled =
  process.env.PR_TRACKER_LIVE_SMOKE === "1" && Boolean(token);

describe("live GraphQL ingestion smoke", () => {
  it.runIf(liveSmokeEnabled)(
    "ingests threads and sizes from real GitHub data",
    async () => {
      const source = createGithubTokenPullRequestSource({
        token: token as string,
        repositories: [repository],
        maxPullRequests: 10
      });
      const local = openLocalDatabase({ path: ":memory:" });

      try {
        const result = await syncPullRequestsToLocalSqlite(local.db, source, {
          viewerLogin: process.env.PR_TRACKER_VIEWER_LOGIN ?? "viewer"
        });
        console.log("sync result:", JSON.stringify(result));

        const rows = listLocalPullRequestRows(local.db);
        expect(rows.length).toBeGreaterThan(0);

        let totalThreads = 0;
        let threadsWithLastActor = 0;
        let outdatedThreads = 0;
        let resolvedThreads = 0;

        for (const row of rows) {
          const threads = listLocalReviewThreadRows(local.db, row.id);
          totalThreads += threads.length;
          for (const thread of threads) {
            if (thread.last_actor_login) threadsWithLastActor += 1;
            if (thread.is_outdated) outdatedThreads += 1;
            if (thread.is_resolved) resolvedThreads += 1;
          }
          const sampleThread = threads[0];
          const participants = sampleThread
            ? listLocalReviewThreadParticipantRows(local.db, [sampleThread.id])
            : [];
          console.log(
            JSON.stringify({
              pr: `#${row.number}`,
              title: row.title.slice(0, 60),
              size: {
                additions: row.additions,
                deletions: row.deletions,
                changed_files: row.changed_files
              },
              threadCount: threads.length,
              firstThread: sampleThread
                ? {
                    file: sampleThread.file_path,
                    isResolved: Boolean(sampleThread.is_resolved),
                    isOutdated: Boolean(sampleThread.is_outdated),
                    lastActor: sampleThread.last_actor_login,
                    participants: participants.map((p) => p.login)
                  }
                : null
            })
          );
        }

        const sized = rows.filter((row) => row.additions !== null).length;
        console.log(
          `totals: threads=${totalThreads} lastActor=${threadsWithLastActor} resolved=${resolvedThreads} outdated=${outdatedThreads} sized=${sized}/${rows.length}`
        );

        expect(sized).toBe(rows.length);
        if (totalThreads > 0) {
          expect(threadsWithLastActor).toBeGreaterThan(0);
        }
      } finally {
        local.close();
      }
    },
    120_000
  );
});
