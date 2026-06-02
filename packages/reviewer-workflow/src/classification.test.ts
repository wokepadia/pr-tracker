import { describe, expect, it } from "vitest";
import { samplePullRequests } from "@pr-tracker/core";
import { buildSampleInbox, classifyPullRequest } from "./index";

describe("reviewer workflow classification", () => {
  it("places directly requested pull requests in needs_review", () => {
    const inbox = buildSampleInbox();
    expect(inbox.sections.needs_review.map((item) => item.pullRequest.id)).toEqual([
      "pr_1"
    ]);
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
