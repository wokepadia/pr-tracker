import { describe, expect, it } from "vitest"
import { filterQueueItems, resolveVisibleQueueItem } from "./InboxPage"
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
      changedFilePath: "apps/web/src/reviewer/local-queue-state.ts",
    }),
  ]

  it("matches title, repository, PR number, author, reason, activity, and files", () => {
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
    expect(filterQueueItems(items, "local-queue").map((item) => item.id)).toEqual([
      "pr_2",
    ])
  })

  it("returns all items for blank search and no items for misses", () => {
    expect(filterQueueItems(items, " ")).toEqual(items)
    expect(filterQueueItems(items, "nope")).toEqual([])
  })
})

describe("inbox queue selection", () => {
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

  it("resolves selection only from currently visible rows", () => {
    expect(resolveVisibleQueueItem(items, "pr_2")?.id).toBe("pr_2")
    expect(resolveVisibleQueueItem(items, "missing")?.id).toBe("pr_1")
    expect(resolveVisibleQueueItem([], "pr_1")).toBeUndefined()
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
    changedFilePath?: string
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
    changedFilesSinceLastSeen: overrides.changedFilePath
      ? [{ path: overrides.changedFilePath, additions: 1, deletions: 0 }]
      : [],
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
