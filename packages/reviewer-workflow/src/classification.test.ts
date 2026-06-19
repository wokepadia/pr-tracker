import { describe, expect, it } from "vitest";
import { samplePullRequests } from "@pr-tracker/core";
import type { PullRequestItem } from "@pr-tracker/core";
import {
  buildReviewerInbox,
  buildSampleInbox,
  classifyPullRequest
} from "./index";

const baseViewerContext = {
  viewerId: "viewer",
  now: "2026-06-01T12:00:00.000Z",
  staleAfterDays: 7,
  lastSeenAtByPullRequestId: {}
};

describe("reviewer workflow classification", () => {
  it("places directly requested pull requests in needs_review", () => {
    const inbox = buildSampleInbox();
    expect(inbox.sections.needs_review.map((item) => item.pullRequest.id)).toEqual([
      "pr_1"
    ]);
  });

  it("flags an outstanding request the viewer has not answered", () => {
    const item = classifyPullRequest(samplePullRequests[0]!, baseViewerContext);

    expect(item.workflowState).toBe("needs_review");
    expect(item.unansweredReviewRequest).toBe(true);
  });

  it("clears the flag once the viewer comments after the request", () => {
    const item = classifyPullRequest(
      {
        ...samplePullRequests[0]!,
        comments: [
          {
            id: "c1",
            authorId: "viewer",
            createdAt: "2026-06-01T12:00:00.000Z"
          }
        ]
      },
      baseViewerContext
    );

    expect(item.workflowState).toBe("needs_review");
    expect(item.unansweredReviewRequest).toBe(false);
  });

  it("keeps the flag when the viewer's comment predates the request", () => {
    const item = classifyPullRequest(
      {
        ...samplePullRequests[0]!,
        comments: [
          {
            id: "c0",
            authorId: "viewer",
            createdAt: "2026-05-30T09:00:00.000Z"
          }
        ]
      },
      baseViewerContext
    );

    expect(item.unansweredReviewRequest).toBe(true);
  });

  it("re-elevates a re-requested review above a prior changes-requested review", () => {
    // The viewer requested changes, then the author re-requested review. The
    // explicit re-request with no response since must outrank the stale
    // changes-requested state and sort to the very top.
    const reRequested: PullRequestItem = {
      ...samplePullRequests[2]!,
      requestedReviewerIds: ["viewer"],
      reviewRequests: [
        { reviewerId: "viewer", requestedAt: "2026-05-31T09:00:00.000Z" }
      ]
    };
    const inbox = buildReviewerInbox({
      viewer: { id: "viewer", login: "you" },
      actors: [],
      pullRequests: [samplePullRequests[1]!, reRequested],
      now: "2026-06-01T12:00:00.000Z"
    });

    const reClassified = classifyPullRequest(reRequested, baseViewerContext);
    expect(reClassified.workflowState).toBe("needs_review");
    expect(reClassified.unansweredReviewRequest).toBe(true);
    expect(inbox.items[0]!.pullRequest.id).toBe("pr_3");
  });

  it("matches the viewer case-insensitively for requested reviews", () => {
    // GitHub logins are case-insensitive: a viewer stored as "VIEWER" (the
    // casing the user typed) must still match a "viewer" review request synced
    // from GitHub, or the pull request silently drops out of "your move".
    const item = classifyPullRequest(samplePullRequests[0]!, {
      ...baseViewerContext,
      viewerId: "VIEWER"
    });

    expect(item.workflowState).toBe("needs_review");
    expect(item.turn.owner).toBe("viewer");
  });

  it("detects commits pushed after the viewer approval", () => {
    const item = classifyPullRequest(samplePullRequests[1]!, {
      viewerId: "viewer",
      now: "2026-06-01T12:00:00.000Z",
      staleAfterDays: 7,
      lastSeenAtByPullRequestId: {}
    });

    expect(item.workflowState).toBe("updated_since_review");
  });

  it("classifies changed-after-review pull requests as caught up after the latest activity is seen", () => {
    const item = classifyPullRequest(samplePullRequests[1]!, {
      viewerId: "viewer",
      now: "2026-06-01T12:00:00.000Z",
      staleAfterDays: 7,
      lastSeenAtByPullRequestId: {
        pr_2: "2026-06-01T12:00:00.000Z"
      }
    });

    expect(item.workflowState).toBe("caught_up");
    expect(item.unseenActivityCount).toBe(0);
  });

  it("keeps directly requested pull requests in needs_review even after they are seen", () => {
    const item = classifyPullRequest(samplePullRequests[0]!, {
      viewerId: "viewer",
      now: "2026-06-01T12:00:00.000Z",
      staleAfterDays: 7,
      lastSeenAtByPullRequestId: {
        pr_1: "2026-06-01T12:00:00.000Z"
      }
    });

    expect(item.workflowState).toBe("needs_review");
    expect(item.unseenActivityCount).toBe(0);
  });

  it("detects requested changes waiting on the author", () => {
    const item = classifyPullRequest(samplePullRequests[2]!, {
      viewerId: "viewer",
      now: "2026-06-01T12:00:00.000Z",
      staleAfterDays: 7,
      lastSeenAtByPullRequestId: {}
    });

    expect(item.workflowState).toBe("waiting_on_author");
  });

  it("does not claim updates when the reviewed commit is unknown", () => {
    const item = classifyPullRequest(
      {
        ...samplePullRequests[1]!,
        reviews: [
          {
            id: "r_missing_sha",
            reviewerId: "viewer",
            decision: "approved",
            submittedAt: "2026-05-31T15:15:00.000Z"
          }
        ]
      },
      {
        viewerId: "viewer",
        now: "2026-06-01T12:00:00.000Z",
        staleAfterDays: 7,
        lastSeenAtByPullRequestId: {}
      }
    );

    expect(item.workflowState).toBe("approved");
  });
});

describe("turn ownership and evidence", () => {
  it("anchors a review request to the requesting event", () => {
    const item = classifyPullRequest(samplePullRequests[0]!, baseViewerContext);

    expect(item.turn).toEqual({
      owner: "viewer",
      since: "2026-06-01T11:30:00.000Z"
    });
    expect(item.evidence).toEqual([
      {
        id: "requested",
        label: "Your review was requested.",
        occurredAt: "2026-06-01T11:30:00.000Z",
        actorId: "maya"
      }
    ]);
  });

  it("leaves the turn anchor empty when no request event was ingested", () => {
    const item = classifyPullRequest(
      { ...samplePullRequests[0]!, activity: [], reviewRequests: [] },
      baseViewerContext
    );

    expect(item.turn).toEqual({ owner: "viewer", since: undefined });
    expect(item.evidence[0]).toMatchObject({
      id: "requested",
      occurredAt: undefined
    });
  });

  it("passes the turn back to the viewer when the author pushes after a review", () => {
    const item = classifyPullRequest(samplePullRequests[1]!, baseViewerContext);

    expect(item.workflowState).toBe("updated_since_review");
    expect(item.turn).toEqual({
      owner: "viewer",
      since: "2026-06-01T09:12:00.000Z"
    });
    expect(item.evidence).toEqual([
      {
        id: "your_review",
        label: "You approved this pull request.",
        occurredAt: "2026-05-31T15:15:00.000Z",
        actorId: "viewer"
      },
      {
        id: "pushed_after_review",
        label: "The author pushed 1 commit after your review.",
        occurredAt: "2026-06-01T09:12:00.000Z",
        actorId: "ari"
      }
    ]);
  });

  it("hands the turn to the author after the viewer requests changes", () => {
    const item = classifyPullRequest(samplePullRequests[2]!, baseViewerContext);

    expect(item.workflowState).toBe("waiting_on_author");
    expect(item.turn).toEqual({
      owner: "author",
      since: "2026-05-30T10:05:00.000Z"
    });
    expect(item.evidence.map((entry) => entry.id)).toEqual([
      "your_review",
      "no_push"
    ]);
  });

  it("reports pushed commits even when commit events are missing", () => {
    const item = classifyPullRequest(
      { ...samplePullRequests[1]!, activity: [] },
      baseViewerContext
    );

    expect(item.workflowState).toBe("updated_since_review");
    expect(item.turn).toEqual({ owner: "viewer", since: undefined });
    expect(item.evidence[1]).toMatchObject({
      id: "pushed_after_review",
      label: "New commits were pushed after your review.",
      occurredAt: undefined,
      actorId: "ari"
    });
  });

  it("releases the turn once the viewer catches up on pushed changes", () => {
    const item = classifyPullRequest(samplePullRequests[1]!, {
      ...baseViewerContext,
      lastSeenAtByPullRequestId: { pr_2: "2026-06-01T12:00:00.000Z" }
    });

    expect(item.workflowState).toBe("caught_up");
    expect(item.turn).toEqual({
      owner: "none",
      since: "2026-06-01T12:00:00.000Z"
    });
    expect(item.evidence.map((entry) => entry.id)).toEqual([
      "your_review",
      "pushed_after_review",
      "caught_up"
    ]);
  });

  it("anchors unresolved thread attention to the latest thread activity", () => {
    const pullRequest: PullRequestItem = {
      ...samplePullRequests[2]!,
      reviews: [],
      threads: [
        {
          id: "t_old",
          isResolved: false,
          participantIds: ["viewer", "sam"],
          lastActivityAt: "2026-05-29T09:00:00.000Z"
        },
        {
          id: "t_new",
          isResolved: false,
          participantIds: ["viewer", "sam"],
          lastActivityAt: "2026-05-30T10:05:00.000Z"
        }
      ]
    };

    const item = classifyPullRequest(pullRequest, baseViewerContext);

    expect(item.workflowState).toBe("needs_thread_attention");
    expect(item.turn).toEqual({
      owner: "viewer",
      since: "2026-05-30T10:05:00.000Z"
    });
    expect(item.evidence).toEqual([
      {
        id: "open_threads",
        label: "2 unresolved review threads await your reply.",
        occurredAt: "2026-05-30T10:05:00.000Z"
      }
    ]);
  });

  it("does not demand thread attention when the viewer replied last everywhere", () => {
    const pullRequest: PullRequestItem = {
      ...samplePullRequests[2]!,
      reviews: [],
      threads: [
        {
          id: "t_viewer_last",
          isResolved: false,
          participantIds: ["viewer", "sam"],
          lastActorId: "viewer",
          lastActivityAt: "2026-05-30T10:05:00.000Z"
        }
      ]
    };

    const item = classifyPullRequest(pullRequest, baseViewerContext);

    expect(item.workflowState).not.toBe("needs_thread_attention");
    expect(item.turn.owner).not.toBe("viewer");
  });

  it("keeps threads with unknown last actors in the viewer's court", () => {
    const pullRequest: PullRequestItem = {
      ...samplePullRequests[2]!,
      reviews: [],
      threads: [
        {
          id: "t_unknown_last",
          isResolved: false,
          participantIds: ["viewer", "sam"],
          lastActivityAt: "2026-05-30T10:05:00.000Z"
        }
      ]
    };

    const item = classifyPullRequest(pullRequest, baseViewerContext);

    expect(item.workflowState).toBe("needs_thread_attention");
  });

  it("marks approval as releasing the turn at the approval time", () => {
    const item = classifyPullRequest(
      {
        ...samplePullRequests[1]!,
        latestCommitSha: "f2",
        activity: []
      },
      baseViewerContext
    );

    expect(item.workflowState).toBe("approved");
    expect(item.turn).toEqual({
      owner: "none",
      since: "2026-05-31T15:15:00.000Z"
    });
  });

  it("treats drafts as the author's turn", () => {
    const item = classifyPullRequest(
      { ...samplePullRequests[0]!, isDraft: true },
      baseViewerContext
    );

    expect(item.workflowState).toBe("watching");
    expect(item.turn).toEqual({
      owner: "author",
      since: samplePullRequests[0]!.createdAt
    });
    expect(item.evidence[0]).toMatchObject({
      id: "draft",
      actorId: "maya"
    });
  });

  it("assigns no turn owner to closed pull requests", () => {
    const item = classifyPullRequest(
      { ...samplePullRequests[0]!, state: "merged" },
      baseViewerContext
    );

    expect(item.workflowState).toBe("inactive");
    expect(item.turn.owner).toBe("none");
    expect(item.evidence[0]).toMatchObject({
      id: "closed",
      label: "This pull request was merged."
    });
  });

  it("keeps closed pull requests out of the queue but on inactiveItems", () => {
    const viewer = { id: "viewer", login: "viewer", type: "user" as const };
    const inbox = buildReviewerInbox({
      viewer,
      actors: [viewer],
      pullRequests: [
        samplePullRequests[0]!,
        { ...samplePullRequests[1]!, state: "merged" }
      ],
      now: baseViewerContext.now
    });

    expect(inbox.items.map((item) => item.pullRequest.id)).toEqual(["pr_1"]);
    expect(inbox.inactiveItems.map((item) => item.pullRequest.id)).toEqual([
      "pr_2"
    ]);
  });
});
