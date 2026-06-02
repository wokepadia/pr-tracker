import { describe, expect, it } from "vitest"
import { filterQueueItems } from "./InboxPage"
import type { ReviewQueueItemView } from "@/reviewer/view-model"

describe("inbox queue search", () => {
  const items = [
    makeQueueItem({
      id: "pr_1",
      title: "Normalize review request webhook payloads",
      repository: "acme/api",
      number: 142,
      authorLogin: "maya",
      reason: "You are requested as a reviewer.",
      activityAction: "requested your review",
    }),
    makeQueueItem({
      id: "pr_2",
      title: "Add persisted reviewer inbox filters",
      repository: "acme/web",
      number: 87,
      authorLogin: "ari",
      reason: "New commits were pushed after your last review.",
      activityAction: "pushed 1 commit",
    }),
  ]

  it("matches title, repository, PR number, author, reason, and activity", () => {
    expect(filterQueueItems(items, "filters").map((item) => item.id)).toEqual([
      "pr_2",
    ])
    expect(filterQueueItems(items, "acme/api").map((item) => item.id)).toEqual([
      "pr_1",
    ])
    expect(filterQueueItems(items, "#87").map((item) => item.id)).toEqual([
      "pr_2",
    ])
    expect(filterQueueItems(items, "maya").map((item) => item.id)).toEqual([
      "pr_1",
    ])
    expect(filterQueueItems(items, "new commits").map((item) => item.id)).toEqual([
      "pr_2",
    ])
    expect(filterQueueItems(items, "pushed").map((item) => item.id)).toEqual([
      "pr_2",
    ])
  })

  it("returns all items for blank search and no items for misses", () => {
    expect(filterQueueItems(items, " ")).toEqual(items)
    expect(filterQueueItems(items, "nope")).toEqual([])
  })
})

function makeQueueItem(
  overrides: {
    id: string
    title: string
    repository: string
    number: number
    authorLogin: string
    reason: string
    activityAction: string
  }
): ReviewQueueItemView {
  return {
    id: overrides.id,
    repository: overrides.repository,
    number: overrides.number,
    title: overrides.title,
    authorLogin: overrides.authorLogin,
    url: "https://github.com/acme/repo/pull/1",
    workflowState: "needs_review",
    laneId: "needs_review",
    reason: overrides.reason,
    waitingOn: "you",
    waitingAge: "1h",
    updatedAt: "1h ago",
    openedAt: "2h ago",
    lastSeenAt: "3h ago",
    userLastReviewDecision: "pending",
    otherReviewers: [],
    unseenEventCount: 1,
    newCommitCount: 0,
    newReplyCount: 0,
    unresolvedThreadCount: 0,
    totalThreadCount: 0,
    changedFilesSinceLastSeen: [],
    reviewThreads: [],
    activityEvents: [
      {
        id: `${overrides.id}_event`,
        actor: overrides.authorLogin,
        action: overrides.activityAction,
        occurredAt: "1h ago",
        occurredAtIso: "2026-06-01T12:00:00.000Z",
        isNew: true,
      },
    ],
    isPinned: false,
    isMuted: false,
  }
}
