import { afterEach, describe, expect, it, vi } from "vitest"
import { buildSampleInbox } from "@pr-tracker/reviewer-workflow"
import { buildInboxView, toReviewQueueItemView } from "./view-model"

afterEach(() => {
  vi.useRealTimers()
})

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

  it("uses the newest unseen activity when calculating waiting age", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"))

    const actorById = new Map([
      ["viewer", { id: "viewer", login: "you" }],
      ["maya", { id: "maya", login: "maya" }],
    ])
    const view = toReviewQueueItemView(
      {
        workflowState: "needs_review",
        reason: "You are requested as a reviewer.",
        lastSeenAt: "2026-06-01T08:00:00.000Z",
        unseenActivityCount: 2,
        pullRequest: {
          id: "pr_unsorted",
          repository: "acme/api",
          number: 143,
          title: "Use newest activity for queue age",
          url: "https://github.com/acme/api/pull/143",
          authorId: "maya",
          state: "open",
          isDraft: false,
          createdAt: "2026-05-30T08:00:00.000Z",
          updatedAt: "2026-06-02T11:00:00.000Z",
          latestCommitSha: "c3",
          requestedReviewerIds: ["viewer"],
          reviews: [],
          threads: [],
          activity: [
            {
              id: "old-new",
              type: "comment",
              actorId: "maya",
              occurredAt: "2026-06-01T09:00:00.000Z",
              title: "Maya replied yesterday",
            },
            {
              id: "latest-new",
              type: "commit",
              actorId: "maya",
              occurredAt: "2026-06-02T11:00:00.000Z",
              title: "Maya pushed 1 commit",
            },
          ],
        },
      },
      actorById,
      "viewer"
    )

    expect(view.waitingAge).toBe("1h")
  })

  it("keeps the latest review decision for other reviewers", () => {
    const actorById = new Map([
      ["viewer", { id: "viewer", login: "you" }],
      ["maya", { id: "maya", login: "maya" }],
      ["sam", { id: "sam", login: "sam" }],
    ])
    const view = toReviewQueueItemView(
      {
        workflowState: "needs_review",
        reason: "You are requested as a reviewer.",
        lastSeenAt: "2026-06-01T08:00:00.000Z",
        unseenActivityCount: 0,
        pullRequest: {
          id: "pr_reviewers",
          repository: "acme/api",
          number: 144,
          title: "Track reviewer state by latest review",
          url: "https://github.com/acme/api/pull/144",
          authorId: "maya",
          state: "open",
          isDraft: false,
          createdAt: "2026-05-30T08:00:00.000Z",
          updatedAt: "2026-06-02T11:00:00.000Z",
          latestCommitSha: "c3",
          requestedReviewerIds: ["viewer"],
          reviews: [
            {
              id: "sam-new",
              reviewerId: "sam",
              decision: "approved",
              submittedAt: "2026-06-02T10:00:00.000Z",
            },
            {
              id: "sam-old",
              reviewerId: "sam",
              decision: "changes_requested",
              submittedAt: "2026-06-01T10:00:00.000Z",
            },
          ],
          threads: [],
          activity: [],
        },
      },
      actorById,
      "viewer"
    )

    expect(view.otherReviewers).toEqual([{ login: "sam", decision: "approved" }])
  })
})
