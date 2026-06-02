import { describe, expect, it } from "vitest"
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

function makeItem(
  waitingOn: ReviewQueueItemView["waitingOn"],
  laneId: ReviewQueueItemView["laneId"]
): Pick<ReviewQueueItemView, "waitingOn" | "laneId"> {
  return { waitingOn, laneId }
}
