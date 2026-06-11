import { describe, expect, it } from "vitest"
import { buildReviewerInsights } from "./insights"
import type { ActivityEventView, ReviewQueueItemView } from "./view-model"

const now = Date.parse("2026-06-11T12:00:00.000Z")

function daysAgo(days: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
}

function makeEvent(
  overrides: Partial<ActivityEventView> & { id: string }
): ActivityEventView {
  return {
    type: "comment",
    actor: "maya",
    action: "commented",
    occurredAt: "1d ago",
    occurredAtIso: daysAgo(1),
    isNew: false,
    ...overrides,
  }
}

function makeItem(
  overrides: Partial<ReviewQueueItemView> & { id: string }
): ReviewQueueItemView {
  return {
    repository: "acme/api",
    number: 7,
    title: "Improve webhook handling",
    authorLogin: "maya",
    url: "https://github.com/acme/api/pull/7",
    state: "open",
    workflowState: "needs_review",
    laneId: "needs_review",
    reason: "You are requested as a reviewer.",
    evidence: [],
    waitingOn: "you",
    waitingAge: "2h",
    waitingUrgency: "none",
    updatedAt: "2h ago",
    updatedAtIso: daysAgo(0),
    openedAt: "3d ago",
    lastSeenAt: "1d ago",
    lastSeenAtIso: daysAgo(1),
    userLastReviewDecision: "pending",
    approvalStale: false,
    reviewRounds: 0,
    otherReviewers: [],
    unseenEventCount: 0,
    newCommitCount: 0,
    newReplyCount: 0,
    unresolvedThreadCount: 0,
    totalThreadCount: 0,
    reviewThreads: [],
    activityEvents: [],
    isPinned: false,
    isMuted: false,
    ...overrides,
  }
}

function build(input: {
  items?: ReviewQueueItemView[]
  inactiveItems?: ReviewQueueItemView[]
  localQueueState?: Parameters<typeof buildReviewerInsights>[0]["localQueueState"]
  previousVisitAt?: string
}) {
  return buildReviewerInsights({
    items: input.items ?? [],
    inactiveItems: input.inactiveItems ?? [],
    localQueueState: input.localQueueState ?? {},
    previousVisitAt: input.previousVisitAt,
    now,
  })
}

describe("needs you now insights", () => {
  it("flags overdue reviews on your turn", () => {
    const insights = build({
      items: [
        makeItem({ id: "pr_1", waitingOn: "you", waitingUrgency: "overdue" }),
        makeItem({ id: "pr_2", waitingOn: "you", waitingUrgency: "elevated" }),
        makeItem({ id: "pr_3", waitingOn: "author", waitingUrgency: "overdue" }),
      ],
    })

    expect(insights.needsYouNow.map((row) => row.id)).toEqual(["pr_1"])
    expect(insights.needsYouNow[0]?.kind).toBe("overdue_review")
  })

  it("flags pull requests returned to you after your review", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          workflowState: "updated_since_review",
          newCommitCount: 2,
        }),
        makeItem({
          id: "pr_2",
          workflowState: "needs_thread_attention",
          unresolvedThreadCount: 3,
        }),
      ],
    })

    expect(insights.needsYouNow.map((row) => row.kind)).toEqual([
      "returned_to_you",
      "returned_to_you",
    ])
    expect(insights.needsYouNow[0]?.whyChip).toContain("2 commits")
    expect(insights.needsYouNow[1]?.whyChip).toContain("3 review threads")
  })

  it("flags stale approvals", () => {
    const insights = build({
      items: [makeItem({ id: "pr_1", workflowState: "approved", approvalStale: true })],
    })

    expect(insights.needsYouNow[0]?.kind).toBe("stale_approval")
  })

  it("keeps snoozed and muted items out of needs-you-now", () => {
    const insights = build({
      items: [
        makeItem({ id: "pr_1", waitingOn: "you", waitingUrgency: "overdue" }),
      ],
      localQueueState: { pr_1: { snoozed: true, snoozedAt: daysAgo(2) } },
    })

    expect(insights.needsYouNow).toEqual([])
  })
})

describe("might-be-missing insights", () => {
  it("flags snoozed items that gathered activity since the snooze", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          activityEvents: [
            makeEvent({ id: "e1", occurredAtIso: daysAgo(1) }),
            makeEvent({ id: "e2", occurredAtIso: daysAgo(8) }),
          ],
        }),
      ],
      localQueueState: { pr_1: { snoozed: true, snoozedAt: daysAgo(5) } },
    })

    expect(insights.mightBeMissing[0]?.kind).toBe("snoozed_moved_on")
    expect(insights.mightBeMissing[0]?.whyChip).toContain("1 event")
  })

  it("stays quiet for snoozed items with no activity since the snooze", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          activityEvents: [makeEvent({ id: "e1", occurredAtIso: daysAgo(9) })],
        }),
      ],
      localQueueState: { pr_1: { snoozed: true, snoozedAt: daysAgo(5) } },
    })

    expect(insights.mightBeMissing).toEqual([])
  })

  it("flags muted items whose review was re-requested", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          workflowState: "needs_review",
          activityEvents: [
            makeEvent({
              id: "e1",
              type: "review_request",
              occurredAtIso: daysAgo(1),
            }),
          ],
        }),
      ],
      localQueueState: { pr_1: { muted: true, mutedAt: daysAgo(4) } },
    })

    expect(insights.mightBeMissing[0]?.kind).toBe("muted_rerequested")
  })

  it("flags unseen events piling up on a long-unopened pull request", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          unseenEventCount: 8,
          lastSeenAtIso: daysAgo(12),
          waitingOn: "none",
        }),
        makeItem({
          id: "pr_2",
          unseenEventCount: 8,
          lastSeenAtIso: daysAgo(2),
          waitingOn: "none",
        }),
      ],
    })

    expect(insights.mightBeMissing.map((row) => row.id)).toEqual(["pr_1"])
    expect(insights.mightBeMissing[0]?.kind).toBe("piling_unseen")
  })

  it("flags author-turn pull requests with no movement", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          waitingOn: "author",
          activityEvents: [makeEvent({ id: "e1", occurredAtIso: daysAgo(9) })],
        }),
      ],
    })

    expect(insights.mightBeMissing[0]?.kind).toBe("parked_no_movement")
    expect(insights.mightBeMissing[0]?.whyChip).toContain("9d")
  })
})

describe("while-away insights", () => {
  it("reports merges and closes within the window without your approval", () => {
    const insights = build({
      inactiveItems: [
        makeItem({ id: "pr_merged", state: "merged", updatedAtIso: daysAgo(1) }),
        makeItem({ id: "pr_closed", state: "closed", updatedAtIso: daysAgo(2) }),
        makeItem({
          id: "pr_approved",
          state: "merged",
          updatedAtIso: daysAgo(1),
          userLastReviewDecision: "approved",
        }),
        makeItem({ id: "pr_old", state: "merged", updatedAtIso: daysAgo(9) }),
      ],
      previousVisitAt: daysAgo(3),
    })

    expect(insights.whileAway.map((row) => row.kind)).toEqual([
      "merged_without_you",
      "closed_without_you",
    ])
  })

  it("skips muted pull requests in the away report", () => {
    const insights = build({
      inactiveItems: [
        makeItem({ id: "pr_1", state: "merged", updatedAtIso: daysAgo(1) }),
      ],
      localQueueState: { pr_1: { muted: true, mutedAt: daysAgo(5) } },
      previousVisitAt: daysAgo(3),
    })

    expect(insights.whileAway).toEqual([])
  })
})

describe("hygiene insights", () => {
  it("flags stale pull requests and review ping-pong", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_stale",
          workflowState: "stale",
          waitingOn: "none",
          updatedAtIso: daysAgo(11),
        }),
        makeItem({ id: "pr_rounds", reviewRounds: 4, waitingOn: "none" }),
      ],
    })

    expect(insights.hygiene.map((row) => row.kind)).toEqual([
      "stalled",
      "review_ping_pong",
    ])
    expect(insights.hygiene[0]?.whyChip).toContain("11d")
  })
})

describe("insight assembly", () => {
  it("claims each pull request for a single section only", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          waitingOn: "you",
          waitingUrgency: "overdue",
          reviewRounds: 5,
        }),
      ],
    })

    expect(insights.needsYouNow.map((row) => row.id)).toEqual(["pr_1"])
    expect(insights.hygiene).toEqual([])
    expect(insights.totalCount).toBe(1)
  })

  it("keeps one row per pull request even when several triggers match", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          workflowState: "updated_since_review",
          waitingOn: "you",
          waitingUrgency: "overdue",
          approvalStale: true,
          newCommitCount: 1,
        }),
      ],
    })

    expect(insights.needsYouNow).toHaveLength(1)
    expect(insights.needsYouNow[0]?.kind).toBe("overdue_review")
    expect(insights.totalCount).toBe(1)
  })

  it("aggregates the digest over the away window", () => {
    const insights = build({
      items: [
        makeItem({
          id: "pr_1",
          updatedAtIso: daysAgo(1),
          workflowState: "needs_review",
          waitingOn: "none",
          activityEvents: [
            makeEvent({
              id: "e1",
              type: "review_request",
              occurredAtIso: daysAgo(1),
            }),
          ],
        }),
        makeItem({ id: "pr_2", updatedAtIso: daysAgo(9), waitingOn: "none" }),
      ],
      inactiveItems: [
        makeItem({
          id: "pr_3",
          state: "merged",
          updatedAtIso: daysAgo(2),
          userLastReviewDecision: "approved",
        }),
      ],
      previousVisitAt: daysAgo(3),
    })

    expect(insights.digest).toEqual({
      windowStartAt: daysAgo(3),
      updatedPullRequestCount: 2,
      mergedCount: 1,
      newReviewRequestCount: 1,
    })
  })

  it("omits the digest when nothing happened in the window", () => {
    const insights = build({
      items: [makeItem({ id: "pr_1", updatedAtIso: daysAgo(9), waitingOn: "none" })],
      previousVisitAt: daysAgo(3),
    })

    expect(insights.digest).toBeUndefined()
  })
})
