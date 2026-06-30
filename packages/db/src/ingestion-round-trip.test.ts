import { describe, expect, it } from "vitest";
import type {
  GitHubPullRequestSnapshot,
  GitHubPullRequestSource,
} from "@pr-tracker/github";
import { syncPullRequestsToLocalSqlite } from "./local-github-sync";
import {
  listLocalActivityEventRows,
  listLocalBoardItemStateRows,
  listLocalCheckRunRows,
  listLocalIssueCommentRows,
  listLocalPullRequestAssigneeRows,
  listLocalPullRequestLabelRows,
  listLocalPullRequestRows,
  listLocalReviewCommentRows,
  listLocalReviewEventRows,
  listLocalReviewRequestRows,
  listLocalReviewThreadParticipantRows,
  listLocalReviewThreadRows,
  openLocalDatabase,
} from "./local-sqlite";

/**
 * A single snapshot with every fetched fact populated, used to prove the full
 * fetch -> store -> read round trip: that the data the GitHub layer produces
 * lands in the right tables and columns, unchanged.
 */
const fullSnapshot: GitHubPullRequestSnapshot = {
  repository: {
    full_name: "acme/web",
    html_url: "https://github.com/acme/web",
    owner: { login: "acme" },
  },
  pull_request: {
    id: 4242,
    node_id: "PR_full_4242",
    number: 4242,
    title: "Persist every fetched pull-request fact",
    body: "Round-trip coverage for the local store.",
    html_url: "https://github.com/acme/web/pull/4242",
    state: "open",
    draft: false,
    created_at: "2026-06-10T08:00:00.000Z",
    updated_at: "2026-06-12T09:00:00.000Z",
    closed_at: null,
    merged_at: null,
    user: { login: "author", avatar_url: "https://avatars/author.png" },
    head: { sha: "head-sha-abc", ref: "feature/persist-everything" },
    base: { ref: "main" },
    mergeable_state: "blocked",
    additions: 321,
    deletions: 45,
    changed_files: 12,
    labels: [
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "frontend", color: "a2eeef" },
    ],
    assignees: [{ login: "author" }, { login: "triage" }],
    requested_reviewers: [{ login: "viewer" }],
  },
  reviews: [
    {
      id: 9001,
      node_id: "PRR_full_9001",
      state: "CHANGES_REQUESTED",
      body: "Please guard the retry path.",
      submitted_at: "2026-06-11T10:00:00.000Z",
      commit_id: "head-sha-abc",
      user: { login: "viewer" },
    },
  ],
  review_requests: [
    { reviewer_login: "viewer", requested_at: "2026-06-10T12:00:00.000Z" },
  ],
  review_threads: [
    {
      id: "RT_full_1",
      is_resolved: false,
      is_outdated: true,
      path: "src/retry.ts",
      line: 88,
      comments: [
        {
          id: "PRRC_full_1",
          author: { login: "viewer" },
          body: "Could this branch loop forever?",
          path: "src/retry.ts",
          line: 88,
          created_at: "2026-06-11T10:01:00.000Z",
          updated_at: "2026-06-11T10:02:00.000Z",
          url: "https://github.com/acme/web/pull/4242#discussion_r1",
        },
        {
          id: "PRRC_full_2",
          author: { login: "author" },
          body: "Added a max-attempts guard.",
          created_at: "2026-06-11T11:00:00.000Z",
        },
      ],
    },
  ],
  issue_comments: [
    {
      id: "IC_full_1",
      author: { login: "author" },
      body: "Pushed the retry-guard follow-up.",
      created_at: "2026-06-11T11:05:00.000Z",
      updated_at: "2026-06-11T11:06:00.000Z",
      url: "https://github.com/acme/web/pull/4242#issuecomment-1",
    },
  ],
  status_check_rollup: { state: "failure", total_count: 3 },
  review_decision: "changes_requested",
  check_runs: [
    {
      id: "CR_full_lint",
      name: "lint",
      app_slug: "github-actions",
      head_sha: "head-sha-abc",
      status: "completed",
      conclusion: "success",
      started_at: "2026-06-12T08:50:00.000Z",
      completed_at: "2026-06-12T08:52:00.000Z",
      details_url: "https://github.com/acme/web/runs/lint",
    },
    {
      id: "CR_full_test",
      name: "test",
      app_slug: "github-actions",
      head_sha: "head-sha-abc",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-06-12T08:50:00.000Z",
      completed_at: "2026-06-12T08:58:00.000Z",
      details_url: "https://github.com/acme/web/runs/test",
    },
    {
      id: "SC_full_legacy",
      name: "ci/legacy",
      head_sha: "head-sha-abc",
      status: "completed",
      conclusion: "success",
      completed_at: "2026-06-12T08:40:00.000Z",
      details_url: "https://legacy.example/status",
    },
  ],
};

function singleSnapshotSource(
  snapshot: GitHubPullRequestSnapshot
): GitHubPullRequestSource {
  return {
    async listPullRequests() {
      return [snapshot];
    },
  };
}

describe("pull request ingestion round trip", () => {
  const pullRequestId = "github:acme~web:4242";

  it("stores every fetched fact in the right table and column", async () => {
    const local = openLocalDatabase({ path: ":memory:" });
    try {
      const result = await syncPullRequestsToLocalSqlite(
        local.db,
        singleSnapshotSource(fullSnapshot),
        { viewerLogin: "viewer" }
      );
      expect(result).toMatchObject({
        scannedPullRequests: 1,
        ingestedPullRequests: 1,
        ingestedReviews: 1,
        pullRequestIds: [pullRequestId],
      });

      const row = listLocalPullRequestRows(local.db, { id: pullRequestId })[0];
      if (!row) throw new Error("Expected the ingested pull request row.");
      expect(row).toMatchObject({
        id: pullRequestId,
        repository_full_name: "acme/web",
        number: 4242,
        title: "Persist every fetched pull-request fact",
        body: "Round-trip coverage for the local store.",
        author_login: "author",
        state: "open",
        is_draft: 0,
        mergeable_state: "blocked",
        review_decision: "changes_requested",
        base_ref: "main",
        head_ref: "feature/persist-everything",
        latest_commit_sha: "head-sha-abc",
        additions: 321,
        deletions: 45,
        changed_files: 12,
        github_created_at: "2026-06-10T08:00:00.000Z",
        github_updated_at: "2026-06-12T09:00:00.000Z",
        closed_at: null,
        merged_at: null,
      });
      expect(JSON.parse(row.status_check_summary_json ?? "{}")).toEqual({
        state: "failure",
        totalCount: 3,
      });

      expect(listLocalPullRequestLabelRows(local.db, pullRequestId)).toEqual([
        {
          pull_request_id: pullRequestId,
          name: "bug",
          color: "d73a4a",
          description: "Something isn't working",
        },
        {
          pull_request_id: pullRequestId,
          name: "frontend",
          color: "a2eeef",
          description: null,
        },
      ]);

      expect(
        listLocalPullRequestAssigneeRows(local.db, pullRequestId).map(
          (assignee) => assignee.login
        )
      ).toEqual(["author", "triage"]);

      expect(listLocalReviewRequestRows(local.db, pullRequestId)).toMatchObject([
        {
          reviewer_kind: "user",
          login: "viewer",
          requested_at: "2026-06-10T12:00:00.000Z",
        },
      ]);

      expect(listLocalReviewEventRows(local.db, pullRequestId)).toMatchObject([
        {
          id: "PRR_full_9001",
          reviewer_login: "viewer",
          decision: "changes_requested",
          commit_sha: "head-sha-abc",
          body: "Please guard the retry path.",
          submitted_at: "2026-06-11T10:00:00.000Z",
        },
      ]);

      const threads = listLocalReviewThreadRows(local.db, pullRequestId);
      expect(threads).toMatchObject([
        {
          id: "RT_full_1",
          is_resolved: 0,
          is_outdated: 1,
          last_actor_login: "author",
          file_path: "src/retry.ts",
          line: 88,
          last_activity_at: "2026-06-11T11:00:00.000Z",
        },
      ]);
      expect(
        listLocalReviewThreadParticipantRows(
          local.db,
          threads.map((thread) => thread.id)
        )
          .map((participant) => participant.login)
          .sort()
      ).toEqual(["author", "viewer"]);

      expect(listLocalReviewCommentRows(local.db, pullRequestId)).toMatchObject([
        {
          review_thread_id: "RT_full_1",
          author_login: "viewer",
          body: "Could this branch loop forever?",
          file_path: "src/retry.ts",
          line: 88,
        },
        {
          review_thread_id: "RT_full_1",
          author_login: "author",
          body: "Added a max-attempts guard.",
        },
      ]);

      expect(listLocalIssueCommentRows(local.db, pullRequestId)).toMatchObject([
        {
          author_login: "author",
          body: "Pushed the retry-guard follow-up.",
          created_at_github: "2026-06-11T11:05:00.000Z",
          url: "https://github.com/acme/web/pull/4242#issuecomment-1",
        },
      ]);

      // Both CheckRun and StatusContext shapes land in the same table,
      // ordered by name.
      expect(listLocalCheckRunRows(local.db, pullRequestId)).toEqual([
        {
          id: expect.any(String),
          pull_request_id: pullRequestId,
          name: "ci/legacy",
          app_slug: "",
          head_sha: "head-sha-abc",
          status: "completed",
          conclusion: "success",
          started_at: null,
          completed_at: "2026-06-12T08:40:00.000Z",
          details_url: "https://legacy.example/status",
        },
        {
          id: expect.any(String),
          pull_request_id: pullRequestId,
          name: "lint",
          app_slug: "github-actions",
          head_sha: "head-sha-abc",
          status: "completed",
          conclusion: "success",
          started_at: "2026-06-12T08:50:00.000Z",
          completed_at: "2026-06-12T08:52:00.000Z",
          details_url: "https://github.com/acme/web/runs/lint",
        },
        {
          id: expect.any(String),
          pull_request_id: pullRequestId,
          name: "test",
          app_slug: "github-actions",
          head_sha: "head-sha-abc",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-06-12T08:50:00.000Z",
          completed_at: "2026-06-12T08:58:00.000Z",
          details_url: "https://github.com/acme/web/runs/test",
        },
      ]);

      expect(
        listLocalActivityEventRows(local.db, pullRequestId).map(
          (event) => event.event_type
        )
      ).toEqual(expect.arrayContaining(["pull_request", "review_request", "review"]));

      expect(
        listLocalBoardItemStateRows(local.db).map((item) => item.pull_request_id)
      ).toEqual([pullRequestId]);
    } finally {
      local.close();
    }
  });

  it("leaves the existing row intact for an unchanged pull request", async () => {
    const local = openLocalDatabase({ path: ":memory:" });
    try {
      // First sync hydrates the PR with reviews + threads.
      await syncPullRequestsToLocalSqlite(
        local.db,
        singleSnapshotSource(fullSnapshot),
        { viewerLogin: "viewer" }
      );
      expect(listLocalReviewEventRows(local.db, pullRequestId)).toHaveLength(1);
      expect(listLocalReviewThreadRows(local.db, pullRequestId)).toHaveLength(1);

      // Second sync returns the same PR as unchanged: identity fields only,
      // no reviews/threads. The driver must skip the upsert so it cannot wipe
      // the existing related rows.
      const unchangedSource: GitHubPullRequestSource = {
        async listPullRequests() {
          return [
            {
              repository: fullSnapshot.repository,
              pull_request: {
                number: fullSnapshot.pull_request.number,
                updated_at: fullSnapshot.pull_request.updated_at,
              },
              unchanged: true,
            },
          ];
        },
      };
      const result = await syncPullRequestsToLocalSqlite(
        local.db,
        unchangedSource,
        { viewerLogin: "viewer" }
      );

      expect(result).toMatchObject({
        scannedPullRequests: 1,
        ingestedPullRequests: 0,
        ignoredPullRequests: 1,
        pullRequestIds: [pullRequestId],
      });

      // The stored reviews and threads survive untouched.
      expect(listLocalReviewEventRows(local.db, pullRequestId)).toMatchObject([
        { id: "PRR_full_9001", reviewer_login: "viewer" },
      ]);
      expect(listLocalReviewThreadRows(local.db, pullRequestId)).toMatchObject([
        { id: "RT_full_1" },
      ]);
      expect(listLocalIssueCommentRows(local.db, pullRequestId)).toHaveLength(1);
    } finally {
      local.close();
    }
  });

  it("records a merged pull request's merge facts", async () => {
    const local = openLocalDatabase({ path: ":memory:" });
    try {
      const merged: GitHubPullRequestSnapshot = {
        ...fullSnapshot,
        pull_request: {
          ...fullSnapshot.pull_request,
          id: 4243,
          node_id: "PR_full_4243",
          number: 4243,
          state: "closed",
          merged: true,
          closed_at: "2026-06-13T10:00:00.000Z",
          merged_at: "2026-06-13T10:00:00.000Z",
        },
        review_decision: "approved",
      };
      await syncPullRequestsToLocalSqlite(local.db, singleSnapshotSource(merged), {
        viewerLogin: "viewer",
      });

      const row = listLocalPullRequestRows(local.db, {
        id: "github:acme~web:4243",
      })[0];
      if (!row) throw new Error("Expected the ingested pull request row.");
      expect(row).toMatchObject({
        // The schema stores open/closed; merged survives via merged_at.
        state: "closed",
        review_decision: "approved",
        closed_at: "2026-06-13T10:00:00.000Z",
        merged_at: "2026-06-13T10:00:00.000Z",
      });
    } finally {
      local.close();
    }
  });
});
