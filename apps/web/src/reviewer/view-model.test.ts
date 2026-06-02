import { describe, expect, it } from "vitest"
import { buildSampleInbox } from "@pr-tracker/reviewer-workflow"
import { buildInboxView } from "./view-model"

describe("reviewer view model", () => {
  it("maps workflow classifications into reviewer queue lanes", () => {
    const view = buildInboxView(buildSampleInbox())

    expect(view.laneItems.needs_review.map((item) => item.id)).toEqual(["pr_1"])
    expect(view.laneItems.updated_since_review.map((item) => item.id)).toEqual([
      "pr_2",
    ])
    expect(view.laneItems.waiting_on_author.map((item) => item.id)).toEqual([
      "pr_3",
    ])
  })

  it("counts only unseen deterministic activity facts", () => {
    const view = buildInboxView(buildSampleInbox())

    const requestedReview = view.items.find((item) => item.id === "pr_1")
    const updatedAfterApproval = view.items.find((item) => item.id === "pr_2")
    const waitingOnAuthor = view.items.find((item) => item.id === "pr_3")

    expect(requestedReview).toMatchObject({
      newCommitCount: 0,
      newReplyCount: 0,
      totalThreadCount: 0,
      unseenEventCount: 1,
      userLastReviewDecision: "pending",
    })
    expect(updatedAfterApproval).toMatchObject({
      newCommitCount: 1,
      newReplyCount: 0,
      totalThreadCount: 0,
      unseenEventCount: 1,
      userLastReviewDecision: "approved",
    })
    expect(waitingOnAuthor).toMatchObject({
      newCommitCount: 0,
      newReplyCount: 0,
      unresolvedThreadCount: 1,
      totalThreadCount: 1,
      unseenEventCount: 0,
      userLastReviewDecision: "changes_requested",
    })
  })

  it("normalizes activity text without duplicating the actor", () => {
    const view = buildInboxView(buildSampleInbox())

    const requestedReview = view.items.find((item) => item.id === "pr_1")
    const reviewRequestEvent = requestedReview?.activityEvents[0]

    expect(reviewRequestEvent).toMatchObject({
      actor: "maya",
      action: "requested your review",
      isNew: true,
    })
  })
})
