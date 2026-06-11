import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createLocalDatabaseBackup,
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
          is_outdated: 0,
          last_actor_login: "sam",
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

  it("caches one AI summary per pull request and kind", () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      const insert = local.db.prepare(`
        insert into ai_summaries
          (pull_request_id, kind, cache_key, model, content_json, generated_at)
        values (?, ?, ?, ?, ?, ?)
        on conflict(pull_request_id, kind)
        do update set
          cache_key = excluded.cache_key,
          model = excluded.model,
          content_json = excluded.content_json,
          generated_at = excluded.generated_at
      `);
      insert.run(
        "pr_1",
        "pr-summary",
        "hash-a",
        "anthropic/claude-sonnet-4.6",
        '{"overview":"first"}',
        "2026-06-11T10:00:00.000Z"
      );
      insert.run(
        "pr_1",
        "pr-summary",
        "hash-b",
        "anthropic/claude-sonnet-4.6",
        '{"overview":"second"}',
        "2026-06-11T11:00:00.000Z"
      );

      const rows = local.db
        .prepare(
          `select cache_key, content_json from ai_summaries
           where pull_request_id = ? and kind = ?`
        )
        .all("pr_1", "pr-summary") as Array<{
        cache_key: string;
        content_json: string;
      }>;
      expect(rows).toEqual([
        { cache_key: "hash-b", content_json: '{"overview":"second"}' }
      ]);

      expect(() =>
        insert.run("pr_1", "unknown-kind", "x", "m", "{}", "now")
      ).toThrow();

      // Queue-level summaries use a sentinel id with the insights-brief kind.
      insert.run(
        "queue",
        "insights-brief",
        "hash-q",
        "anthropic/claude-sonnet-4.6",
        '{"headline":"calm"}',
        "2026-06-11T12:00:00.000Z"
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

  it("creates an unencrypted backup of the local SQLite file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-tracker-db-backup-"));
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const local = openLocalDatabase({ path: sourcePath });

    try {
      seedLocalSampleData(local.db);
    } finally {
      local.close();
    }

    createLocalDatabaseBackup({
      sourcePath,
      destinationPath: backupPath
    });

    const backup = openLocalDatabase({
      path: backupPath,
      initialize: false
    });
    try {
      expect(listLocalPullRequestRows(backup.db).map((row) => row.id)).toEqual([
        "pr_1",
        "pr_2",
        "pr_3"
      ]);
    } finally {
      backup.close();
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
                  additions: 120,
                  deletions: 30,
                  changed_files: 7,
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
        ignoredPullRequests: 0,
        pullRequestIds: ["github:acme~web:42"]
      });
      expect(listLocalPullRequestRows(local.db)).toMatchObject([
        {
          id: "github:acme~web:42",
          repository_full_name: "acme/web",
          title: "Ship local cache sync",
          author_login: "author",
          state: "open",
          latest_commit_sha: "head-sha",
          additions: 120,
          deletions: 30,
          changed_files: 7
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

  it("ingests review threads and keeps them when a later sync lacks thread data", async () => {
    const local = openLocalDatabase({ path: ":memory:" });
    const basePullRequest = {
      id: 55,
      node_id: "PR_kw_threads_55",
      number: 55,
      title: "Thread ledger ingestion",
      html_url: "https://github.com/acme/web/pull/55",
      state: "open",
      created_at: "2026-06-01T08:00:00.000Z",
      user: { login: "author" }
    };

    try {
      await syncPullRequestsToLocalSqlite(local.db, {
        async listPullRequests() {
          return [
            {
              repository: { full_name: "acme/web" },
              pull_request: {
                ...basePullRequest,
                updated_at: "2026-06-01T09:00:00.000Z"
              },
              review_threads: [
                {
                  id: "RT_55_1",
                  is_resolved: false,
                  is_outdated: true,
                  path: "src/sync.ts",
                  line: 12,
                  comments: [
                    {
                      author: { login: "viewer" },
                      created_at: "2026-06-01T08:30:00.000Z"
                    },
                    {
                      author: { login: "author" },
                      created_at: "2026-06-01T08:45:00.000Z"
                    }
                  ]
                }
              ]
            }
          ];
        }
      });

      const threads = listLocalReviewThreadRows(local.db, "github:acme~web:55");
      expect(threads).toMatchObject([
        {
          id: "RT_55_1",
          is_resolved: 0,
          is_outdated: 1,
          last_actor_login: "author",
          file_path: "src/sync.ts",
          line: 12,
          last_activity_at: "2026-06-01T08:45:00.000Z"
        }
      ]);
      expect(
        listLocalReviewThreadParticipantRows(
          local.db,
          threads.map((thread) => thread.id)
        ).map((row) => row.login)
      ).toEqual(["viewer", "author"]);

      await syncPullRequestsToLocalSqlite(local.db, {
        async listPullRequests() {
          return [
            {
              repository: { full_name: "acme/web" },
              pull_request: {
                ...basePullRequest,
                updated_at: "2026-06-01T10:00:00.000Z"
              }
              // review_threads intentionally absent: fetch unavailable.
            }
          ];
        }
      });

      expect(
        listLocalReviewThreadRows(local.db, "github:acme~web:55")
      ).toMatchObject([{ id: "RT_55_1", last_actor_login: "author" }]);
    } finally {
      local.close();
    }
  });

  it("uses the stored pull request id when a GitHub node id already exists", async () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      await syncPullRequestsToLocalSqlite(local.db, {
        async listPullRequests() {
          return [
            {
              repository: { full_name: "zulip/zulip" },
              pull_request: {
                id: 91,
                node_id: "PR_kw_case_91",
                number: 91,
                title: "Normalize repository identity",
                html_url: "https://github.com/zulip/zulip/pull/91",
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
          return [
            {
              repository: { full_name: "Zulip/zulip" },
              pull_request: {
                id: 91,
                node_id: "PR_kw_case_91",
                number: 91,
                title: "Normalize repository identity",
                html_url: "https://github.com/Zulip/zulip/pull/91",
                state: "open",
                created_at: "2026-06-01T08:00:00.000Z",
                updated_at: "2026-06-01T10:00:00.000Z",
                user: { login: "author" },
                head: { sha: "new-sha" },
                requested_reviewers: [{ login: "viewer" }]
              },
              reviews: [
                {
                  id: 11,
                  node_id: "PRR_kw_case_11",
                  state: "COMMENTED",
                  submitted_at: "2026-06-01T09:30:00.000Z",
                  user: { login: "reviewer" }
                }
              ]
            }
          ];
        }
      });

      expect(result.pullRequestIds).toEqual(["github:zulip~zulip:91"]);
      expect(listLocalPullRequestRows(local.db, { id: "github:zulip~zulip:91" }))
        .toMatchObject([
          {
            latest_commit_sha: "new-sha",
            repository_full_name: "Zulip/zulip"
          }
        ]);
      expect(
        listLocalReviewRequestRows(local.db, "github:zulip~zulip:91")
      ).toMatchObject([{ login: "viewer" }]);
      expect(
        listLocalReviewEventRows(local.db, "github:zulip~zulip:91")
      ).toMatchObject([{ id: "PRR_kw_case_11", reviewer_login: "reviewer" }]);
      expect(
        listLocalBoardItemStateRows(local.db).map((row) => row.pull_request_id)
      ).toEqual(["github:zulip~zulip:91"]);
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
