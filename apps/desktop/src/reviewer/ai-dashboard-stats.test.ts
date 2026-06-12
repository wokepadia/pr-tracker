import { describe, expect, it } from "vitest"
import { buildAiDashboardStats } from "./ai-dashboard-stats"
import type { ActivityEventView, ReviewQueueItemView } from "./view-model"

const now = Date.parse("2026-06-11T12:00:00.000Z")

function hoursAgo(hours: number): string {
  return new Date(now - hours * 60 * 60 * 1000).toISOString()
}

function daysAgo(days: number): string {
  return hoursAgo(days * 24)
}

function makeEvent(
  overrides: Partial<ActivityEventView> & { id: string }
): ActivityEventView {
  return {
    type: "comment",
    actor: "maya",
    isViewer: false,
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
    labels: [],
    assignees: [],
    url: "https://github.com/acme/api/pull/7",
    state: "open",
    workflowState: "needs_review",
    laneId: "needs_review",
    reason: "You are requested as a reviewer.",
    evidence: [],
    waitingOn: "you",
    waitingAge: "2h",
    waitingSinceAtIso: hoursAgo(2),
    waitingUrgency: "none",
    updatedAt: "2h ago",
    updatedAtIso: hoursAgo(2),
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

function build(
  input: Partial<Parameters<typeof buildAiDashboardStats>[0]> & {
    items: ReviewQueueItemView[]
  }
) {
  return buildAiDashboardStats({
    now,
    ...input,
  })
}

describe("buildAiDashboardStats", () => {
  it("builds repository, discussion, and author tables", () => {
    const stats = build({
      items: [
        makeItem({
          id: "pr_maya_old",
          repository: "acme/api",
          authorLogin: "maya",
          waitingAge: "5d",
          waitingSinceAtIso: daysAgo(5),
          unresolvedThreadCount: 3,
          reviewThreads: [
            {
              id: "thread_1",
              author: "sam",
              status: "unresolved",
              authorReplied: true,
              excerpt: "src/api.ts:4",
              awaitingYourReply: true,
              isOutdated: false,
              lastActorLogin: "sam",
              lastActivityAtIso: hoursAgo(6),
            },
          ],
        }),
        makeItem({
          id: "pr_ari",
          repository: "acme/web",
          authorLogin: "ari",
          authorAvatarUrl: "https://example.com/ari.png",
          waitingAge: "2d",
          waitingSinceAtIso: daysAgo(2),
          unresolvedThreadCount: 1,
          reviewThreads: [
            {
              id: "thread_2",
              author: "ari",
              status: "unresolved",
              authorReplied: true,
              excerpt: "src/ui.ts:8",
              awaitingYourReply: true,
              isOutdated: false,
              lastActorLogin: "ari",
              lastActivityAtIso: hoursAgo(3),
            },
          ],
        }),
        makeItem({
          id: "pr_maya_new",
          repository: "acme/api",
          authorLogin: "maya",
          waitingAge: "6h",
          waitingSinceAtIso: hoursAgo(6),
        }),
      ],
    })

    expect(stats.repositoryBreakdown.isHidden).toBe(false)
    expect(stats.repositoryBreakdown.rows.map((row) => row.repository)).toEqual([
      "acme/api",
      "acme/web",
    ])
    expect(stats.discussionHotspots.map((row) => row.item.id)).toEqual([
      "pr_maya_old",
      "pr_ari",
    ])
    expect(stats.discussionHotspots[0]?.lastReplyLogin).toBe("sam")
    expect(stats.authorsWaiting.isHidden).toBe(false)
    expect(stats.authorsWaiting.rows.map((row) => row.login)).toEqual([
      "maya",
      "ari",
    ])
  })

  it("hides zero-information breakdowns", () => {
    const stats = build({
      items: [
        makeItem({
          id: "pr_one",
          repository: "acme/api",
          authorLogin: "maya",
        }),
      ],
    })

    expect(stats.repositoryBreakdown.isHidden).toBe(true)
    expect(stats.authorsWaiting.isHidden).toBe(true)
  })
})
