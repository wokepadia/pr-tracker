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
            pinned: true
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
});
