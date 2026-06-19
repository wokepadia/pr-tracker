import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalDatabaseBackup,
  removeLocalSampleData,
  defaultLocalBoardId,
  listLocalActivityEventRows,
  listLocalBoardItemStateRows,
  listLocalIssueCommentRows,
  listLocalPullRequestAssigneeRows,
  listLocalPullRequestLabelRows,
  listLocalPullRequestRows,
  listLocalReviewCommentRows,
  listLocalReviewEventRows,
  listLocalReviewRequestRows,
  listLocalReviewThreadParticipantRows,
  listLocalReviewThreadRows,
  markLocalPullRequestSeen,
  openLocalDatabase,
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
          team_slug: null,
          requested_at: "2026-06-01T11:30:00.000Z"
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
        "pr-brief",
        "hash-a",
        "anthropic/claude-sonnet-4.6",
        '{"overview":"first"}',
        "2026-06-11T10:00:00.000Z"
      );
      insert.run(
        "pr_1",
        "pr-brief",
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
        .all("pr_1", "pr-brief") as Array<{
        cache_key: string;
        content_json: string;
      }>;
      expect(rows).toEqual([
        { cache_key: "hash-b", content_json: '{"overview":"second"}' }
      ]);

      expect(() =>
        insert.run("pr_1", "unknown-kind", "x", "m", "{}", "now")
      ).toThrow();

      // Queue-level summaries use a sentinel id with the ai-dashboard kind.
      insert.run(
        "queue",
        "ai-dashboard",
        "hash-q",
        "anthropic/claude-sonnet-4.6",
        '{"headline":"calm"}',
        "2026-06-11T12:00:00.000Z"
      );
    } finally {
      local.close();
    }
  });

  it("purges seeded sample data without touching real rows", () => {
    const local = openLocalDatabase({ path: ":memory:" });

    try {
      seedLocalSampleData(local.db);
      // A live row alongside the samples must survive the purge.
      local.db
        .prepare(
          `insert into github_repositories (id, github_node_id, full_name, name, html_url)
           values ('repo_live', 'repo_live_node', 'octo/live', 'live', 'https://github.com/octo/live')`
        )
        .run();
      local.db
        .prepare(
          `insert into pull_requests (
             id, repository_id, github_node_id, number, title, url, state
           ) values (
             'github:octo~live:1', 'repo_live', 'live_node_1', 1, 'Real PR',
             'https://github.com/octo/live/pull/1', 'open'
           )`
        )
        .run();

      const { removedPullRequests } = removeLocalSampleData(local.db);
      expect(removedPullRequests).toBe(3);

      const count = (table: string) =>
        (
          local.db
            .prepare(`select count(*) as n from ${table}`)
            .get() as { n: number }
        ).n;
      expect(listLocalPullRequestRows(local.db).map((row) => row.id)).toEqual([
        "github:octo~live:1"
      ]);
      expect(count("board_items")).toBe(0);
      expect(count("activity_events")).toBe(0);
      expect(count("review_threads")).toBe(0);
      expect(count("review_thread_participants")).toBe(0);
      expect(count("review_events")).toBe(0);
      expect(count("pull_request_review_requests")).toBe(0);
      expect(
        (
          local.db
            .prepare(`select full_name from github_repositories order by full_name`)
            .all() as Array<{ full_name: string }>
        ).map((row) => row.full_name)
      ).toEqual(["octo/live"]);

      // Purging again is a no-op.
      expect(removeLocalSampleData(local.db).removedPullRequests).toBe(0);
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
                  labels: [
                    {
                      name: "bug",
                      color: "d73a4a",
                      description: "Something isn't working"
                    },
                    { name: "frontend", color: "a2eeef" }
                  ],
                  assignees: [{ login: "author" }, { login: "triage" }],
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
      expect(
        listLocalPullRequestLabelRows(local.db, "github:acme~web:42")
      ).toEqual([
        {
          pull_request_id: "github:acme~web:42",
          name: "bug",
          color: "d73a4a",
          description: "Something isn't working"
        },
        {
          pull_request_id: "github:acme~web:42",
          name: "frontend",
          color: "a2eeef",
          description: null
        }
      ]);
      expect(
        listLocalPullRequestAssigneeRows(local.db, "github:acme~web:42")
      ).toEqual([
        { pull_request_id: "github:acme~web:42", login: "author" },
        { pull_request_id: "github:acme~web:42", login: "triage" }
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
          pull_request_id: "github:acme~web:42"
        }
      ]);
    } finally {
      local.close();
    }
  });

  it("skips rewriting pull requests when a re-synced snapshot is unchanged", async () => {
    const local = openLocalDatabase({ path: ":memory:" });
    const buildSnapshot = () => ({
      repository: {
        full_name: "acme/web",
        html_url: "https://github.com/acme/web",
        owner: { login: "acme" }
      },
      pull_request: {
        id: 42,
        node_id: "PR_kw_unchanged_42",
        number: 42,
        title: "Ship local cache sync",
        html_url: "https://github.com/acme/web/pull/42",
        state: "open",
        draft: false,
        created_at: "2026-06-01T08:00:00.000Z",
        updated_at: "2026-06-01T09:00:00.000Z",
        user: { login: "author" },
        head: { sha: "head-sha" }
      },
      reviews: [
        {
          id: 9,
          node_id: "PRR_kw_unchanged_9",
          state: "APPROVED",
          submitted_at: "2026-06-01T08:45:00.000Z",
          user: { login: "reviewer" }
        }
      ]
    });

    try {
      const source = {
        async listPullRequests() {
          return [buildSnapshot()];
        }
      };
      await syncPullRequestsToLocalSqlite(local.db, source, {
        viewerLogin: "viewer"
      });

      const second = await syncPullRequestsToLocalSqlite(local.db, source, {
        viewerLogin: "viewer"
      });

      expect(second).toEqual({
        scannedPullRequests: 1,
        ingestedPullRequests: 0,
        ingestedReviews: 0,
        ignoredPullRequests: 1,
        pullRequestIds: ["github:acme~web:42"]
      });

      // A changed payload with the same updated_at must still be written;
      // only byte-identical snapshots skip the rewrite.
      const changedSnapshot = buildSnapshot();
      changedSnapshot.pull_request.title = "Ship local cache sync, take two";
      const third = await syncPullRequestsToLocalSqlite(
        local.db,
        {
          async listPullRequests() {
            return [changedSnapshot];
          }
        },
        { viewerLogin: "viewer" }
      );

      expect(third.ingestedPullRequests).toBe(1);
      expect(listLocalPullRequestRows(local.db)).toMatchObject([
        { title: "Ship local cache sync, take two" }
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

  it("ingests PR comment bodies and preserves them when a later fetch lacks comment data", async () => {
    const local = openLocalDatabase({ path: ":memory:" });
    const basePullRequest = {
      id: 56,
      node_id: "PR_kw_comments_56",
      number: 56,
      title: "Comment body ingestion",
      html_url: "https://github.com/acme/web/pull/56",
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
                  id: "RT_56_1",
                  is_resolved: false,
                  path: "src/comments.ts",
                  line: 22,
                  comments: [
                    {
                      id: "PRRC_kw_1",
                      author: { login: "reviewer" },
                      body: "Could this branch explain the retry state?",
                      path: "src/comments.ts",
                      line: 22,
                      created_at: "2026-06-01T08:30:00.000Z",
                      updated_at: "2026-06-01T08:31:00.000Z",
                      url: "https://github.com/acme/web/pull/56#discussion_r1"
                    }
                  ]
                }
              ],
              issue_comments: [
                {
                  id: "IC_kw_1",
                  author: { login: "author" },
                  body: "I pushed the retry-state follow-up.",
                  created_at: "2026-06-01T08:45:00.000Z",
                  updated_at: "2026-06-01T08:45:30.000Z",
                  url: "https://github.com/acme/web/pull/56#issuecomment-1"
                }
              ]
            }
          ];
        }
      });

      expect(
        listLocalReviewCommentRows(local.db, "github:acme~web:56")
      ).toMatchObject([
        {
          review_thread_id: "RT_56_1",
          author_login: "reviewer",
          body: "Could this branch explain the retry state?",
          file_path: "src/comments.ts",
          line: 22,
          created_at_github: "2026-06-01T08:30:00.000Z",
          updated_at_github: "2026-06-01T08:31:00.000Z",
          url: "https://github.com/acme/web/pull/56#discussion_r1"
        }
      ]);
      expect(
        listLocalIssueCommentRows(local.db, "github:acme~web:56")
      ).toMatchObject([
        {
          author_login: "author",
          body: "I pushed the retry-state follow-up.",
          created_at_github: "2026-06-01T08:45:00.000Z",
          updated_at_github: "2026-06-01T08:45:30.000Z",
          url: "https://github.com/acme/web/pull/56#issuecomment-1"
        }
      ]);

      await syncPullRequestsToLocalSqlite(local.db, {
        async listPullRequests() {
          return [
            {
              repository: { full_name: "acme/web" },
              pull_request: {
                ...basePullRequest,
                updated_at: "2026-06-01T10:00:00.000Z"
              }
              // review_threads and issue_comments intentionally absent.
            }
          ];
        }
      });

      expect(
        listLocalReviewCommentRows(local.db, "github:acme~web:56")
      ).toHaveLength(1);
      expect(
        listLocalIssueCommentRows(local.db, "github:acme~web:56")
      ).toHaveLength(1);
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

  it("keeps the inbox usable when a known pull request refresh times out", async () => {
    const local = openLocalDatabase({ path: ":memory:" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await syncPullRequestsToLocalSqlite(local.db, {
        async listPullRequests() {
          return [
            {
              repository: { full_name: "acme/api" },
              pull_request: {
                id: 8,
                node_id: "PR_kw_sync_8",
                number: 8,
                title: "Slow known PR",
                html_url: "https://github.com/acme/api/pull/8",
                state: "open",
                created_at: "2026-06-01T08:00:00.000Z",
                updated_at: "2026-06-01T09:00:00.000Z",
                user: { login: "author" },
                head: { sha: "cached-sha" }
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
          expect(input).toEqual({ repository: "acme/api", number: 8 });
          throw new Error(
            "GitHub API request timed out for GET /repos/{owner}/{repo}/pulls/{pull_number}"
          );
        }
      });

      expect(result).toMatchObject({
        scannedPullRequests: 0,
        ingestedPullRequests: 0
      });
      expect(
        listLocalPullRequestRows(local.db, { id: "github:acme~api:8" })
      ).toMatchObject([
        {
          state: "open",
          latest_commit_sha: "cached-sha"
        }
      ]);
    } finally {
      warnSpy.mockRestore();
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
