import { describe, expect, it } from "vitest";
import {
  defaultLocalBoardId,
  listLocalActivityEventRows,
  listLocalBoardItemStateRows,
  listLocalBoardColumnRows,
  listLocalPullRequestRows,
  listLocalReviewEventRows,
  listLocalReviewRequestRows,
  listLocalReviewThreadParticipantRows,
  listLocalReviewThreadRows,
  markLocalPullRequestSeen,
  openLocalDatabase,
  saveLocalBoardState,
  seedLocalSampleData
} from "./local-sqlite";
import { syncPullRequestsToLocalSqlite } from "./local-github-sync";

describe("local SQLite storage", () => {
  it("initializes the local schema and seeds sample reviewer data", () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      seedLocalSampleData(local.db);

      const pullRequests = listLocalPullRequestRows(local.db);
      expect(pullRequests.map((row) => row.id)).toEqual(["pr_1", "pr_2", "pr_3"]);
      expect(pullRequests[0]).toMatchObject({
        id: "pr_1",
        repository_full_name: "acme/api",
        author_login: "maya",
        state: "open"
      });

      expect(listLocalReviewRequestRows(local.db, "pr_1")).toEqual([
        {
          pull_request_id: "pr_1",
          reviewer_kind: "user",
          login: "viewer",
          team_slug: null
        }
      ]);
      expect(listLocalReviewEventRows(local.db, "pr_2")).toMatchObject([
        {
          id: "r1",
          reviewer_login: "viewer",
          decision: "approved"
        }
      ]);

      const threads = listLocalReviewThreadRows(local.db, "pr_3");
      expect(threads).toMatchObject([
        {
          id: "t1",
          is_resolved: 0,
          file_path: "src/webhooks.ts"
        }
      ]);
      expect(
        listLocalReviewThreadParticipantRows(
          local.db,
          threads.map((thread) => thread.id)
        ).map((row) => row.login)
      ).toEqual(["viewer", "sam"]);

      expect(listLocalActivityEventRows(local.db, "pr_2")).toMatchObject([
        { id: "a2", actor_login: "viewer" },
        { id: "a3", actor_login: "ari" }
      ]);
      expect(listLocalBoardItemStateRows(local.db, defaultLocalBoardId)).toHaveLength(
        3
      );
    } finally {
      local.close();
    }
  });

  it("persists local board seen state", () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      seedLocalSampleData(local.db);

      expect(
        markLocalPullRequestSeen(local.db, {
          pullRequestId: "pr_1",
          lastSeenAt: "2026-06-01T12:00:00.000Z"
        })
      ).toBe(true);
      expect(
        markLocalPullRequestSeen(local.db, {
          pullRequestId: "missing",
          lastSeenAt: "2026-06-01T12:00:00.000Z"
        })
      ).toBe(false);

      const state = listLocalBoardItemStateRows(local.db).find(
        (row) => row.pull_request_id === "pr_1"
      );
      expect(state?.last_seen_at).toBe("2026-06-01T12:00:00.000Z");
    } finally {
      local.close();
    }
  });

  it("persists local board columns and item state", () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      seedLocalSampleData(local.db);
      saveLocalBoardState(local.db, {
        columns: [
          { id: "inbox", name: "Inbox", sortOrder: 0, widthPx: 260 },
          { id: "custom", name: "Custom", sortOrder: 1, widthPx: 310 }
        ],
        items: [
          {
            pullRequestId: "pr_1",
            columnId: "custom",
            sortOrder: 0,
            pinned: true,
            notes: "Ask Maya about the migration window."
          },
          {
            pullRequestId: "pr_2",
            columnId: "inbox",
            sortOrder: 0,
            muted: true
          },
          {
            pullRequestId: "pr_3",
            columnId: "inbox",
            sortOrder: 1,
            snoozed: true
          }
        ]
      });

      expect(listLocalBoardColumnRows(local.db)).toEqual([
        { id: "inbox", name: "Inbox", sort_order: 0, width_px: 260 },
        { id: "custom", name: "Custom", sort_order: 1, width_px: 310 }
      ]);
      expect(listLocalBoardItemStateRows(local.db)).toMatchObject([
        {
          pull_request_id: "pr_1",
          column_id: "custom",
          sort_order: 0,
          notes: "Ask Maya about the migration window.",
          is_pinned: 1
        },
        {
          pull_request_id: "pr_2",
          column_id: "inbox",
          sort_order: 0,
          is_muted: 1
        },
        {
          pull_request_id: "pr_3",
          column_id: "inbox",
          sort_order: 1,
          is_snoozed: 1
        }
      ]);
    } finally {
      local.close();
    }
  });

  it("syncs GitHub snapshots into local SQLite cache tables", async () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      const result = await syncPullRequestsToLocalSqlite(
        local.db,
        {
          async listPullRequests() {
            return [
              {
                repository: {
                  full_name: "acme/web",
                  html_url: "https://github.com/acme/web",
                  owner: { login: "acme" }
                },
                pull_request: {
                  id: 42,
                  node_id: "PR_kw_sync_42",
                  number: 42,
                  title: "Ship local cache sync",
                  body: "Persist fetched GitHub facts locally.",
                  html_url: "https://github.com/acme/web/pull/42",
                  state: "open",
                  draft: false,
                  created_at: "2026-06-01T08:00:00.000Z",
                  updated_at: "2026-06-01T09:00:00.000Z",
                  user: { login: "author" },
                  head: { sha: "head-sha" },
                  requested_reviewers: [{ login: "viewer" }]
                },
                reviews: [
                  {
                    id: 9,
                    node_id: "PRR_kw_sync_9",
                    state: "APPROVED",
                    submitted_at: "2026-06-01T08:45:00.000Z",
                    commit_id: "head-sha",
                    user: { login: "reviewer" }
                  }
                ]
              }
            ];
          }
        },
        { viewerLogin: "viewer" }
      );

      expect(result).toEqual({
        scannedPullRequests: 1,
        ingestedPullRequests: 1,
        ingestedReviews: 1,
        ignoredPullRequests: 0
      });
      expect(listLocalPullRequestRows(local.db)).toMatchObject([
        {
          id: "github:acme~web:42",
          repository_full_name: "acme/web",
          title: "Ship local cache sync",
          author_login: "author",
          state: "open",
          latest_commit_sha: "head-sha"
        }
      ]);
      expect(
        listLocalReviewRequestRows(local.db, "github:acme~web:42")
      ).toMatchObject([
        {
          reviewer_kind: "user",
          login: "viewer"
        }
      ]);
      expect(listLocalReviewEventRows(local.db, "github:acme~web:42")).toMatchObject([
        {
          id: "PRR_kw_sync_9",
          reviewer_login: "reviewer",
          decision: "approved"
        }
      ]);
      expect(listLocalActivityEventRows(local.db, "github:acme~web:42")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "pull_request",
            actor_login: "author"
          }),
          expect.objectContaining({
            event_type: "review_request",
            actor_login: "author"
          }),
          expect.objectContaining({
            event_type: "review",
            actor_login: "reviewer"
          })
        ])
      );
      expect(listLocalBoardItemStateRows(local.db)).toMatchObject([
        {
          pull_request_id: "github:acme~web:42",
          column_id: "inbox"
        }
      ]);
    } finally {
      local.close();
    }
  });

  it("reconciles known open pull requests through the local sync path", async () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      await syncPullRequestsToLocalSqlite(local.db, {
        async listPullRequests() {
          return [
            {
              repository: { full_name: "acme/api" },
              pull_request: {
                id: 7,
                node_id: "PR_kw_sync_7",
                number: 7,
                title: "Known open PR",
                html_url: "https://github.com/acme/api/pull/7",
                state: "open",
                created_at: "2026-06-01T08:00:00.000Z",
                updated_at: "2026-06-01T09:00:00.000Z",
                user: { login: "author" },
                head: { sha: "old-sha" }
              }
            }
          ];
        }
      });

      const result = await syncPullRequestsToLocalSqlite(local.db, {
        async listPullRequests() {
          return [];
        },
        async getPullRequest(input) {
          expect(input).toEqual({ repository: "acme/api", number: 7 });
          return {
            repository: { full_name: "acme/api" },
            pull_request: {
              id: 7,
              node_id: "PR_kw_sync_7",
              number: 7,
              title: "Known open PR",
              html_url: "https://github.com/acme/api/pull/7",
              state: "closed",
              merged: true,
              created_at: "2026-06-01T08:00:00.000Z",
              updated_at: "2026-06-01T10:00:00.000Z",
              user: { login: "author" },
              head: { sha: "merged-sha" }
            }
          };
        }
      });

      expect(result).toMatchObject({
        scannedPullRequests: 1,
        ingestedPullRequests: 1
      });
      expect(
        listLocalPullRequestRows(local.db, { id: "github:acme~api:7" })
      ).toMatchObject([
        {
          state: "closed",
          latest_commit_sha: "merged-sha"
        }
      ]);
    } finally {
      local.close();
    }
  });

  it("records failed local GitHub sync runs", async () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      await expect(
        syncPullRequestsToLocalSqlite(local.db, {
          async listPullRequests() {
            throw new Error("Synthetic local sync failure");
          }
        })
      ).rejects.toThrow("Synthetic local sync failure");

      const rows = local.db
        .prepare(
          `
            select status, error
            from sync_runs
            order by started_at desc
            limit 1
          `
        )
        .all() as Array<{ status: string; error: string | null }>;

      expect(rows).toEqual([
        {
          status: "failed",
          error: "Synthetic local sync failure"
        }
      ]);
    } finally {
      local.close();
    }
  });
});
