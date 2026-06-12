import { describe, expect, it } from "vitest"
import { getDetailEvidenceLines } from "./PullRequestPage"
import { detailAttentionLabel } from "./pull-request-helpers"
import type { ReviewQueueItemView } from "@/reviewer/view-model"

describe("pull request detail attention label", () => {
  it("describes reviewer attention without merge-state wording", () => {
    expect(detailAttentionLabel(makeItem("you", "needs_review"))).toBe(
      "waiting on you"
    )
    expect(detailAttentionLabel(makeItem("author", "waiting_on_author"))).toBe(
      "waiting on author"
    )
    expect(detailAttentionLabel(makeItem("none", "approved"))).toBe("approved")
    expect(detailAttentionLabel(makeItem("none", "caught_up"))).toBe("caught up")
    expect(detailAttentionLabel(makeItem("none", "watching"))).toBe("watching")
  })
})

describe("pull request detail evidence", () => {
  it("drops evidence lines that repeat the reason or rail state", () => {
    const lines = getDetailEvidenceLines({
      reason: "You requested changes and the author has not pushed since.",
      userLastReviewDecision: "changes_requested",
      waitingOn: "author",
      laneId: "waiting_on_author",
      evidence: [
        {
          id: "your_review",
          label: "You requested changes.",
          occurredAt: "13d ago",
          actorLogin: "you",
        },
        {
          id: "no_push",
          label: "The author has not pushed since your review.",
          occurredAt: undefined,
          actorLogin: "maya",
        },
        {
          id: "replies",
          label: "Sam replied in an unresolved thread.",
          occurredAt: "1h ago",
          actorLogin: "sam",
        },
      ],
    })

    expect(lines.map((line) => line.id)).toEqual(["replies"])
  })
})

function makeItem(
  waitingOn: ReviewQueueItemView["waitingOn"],
  laneId: ReviewQueueItemView["laneId"]
): Pick<ReviewQueueItemView, "waitingOn" | "laneId"> {
  return { waitingOn, laneId }
}
