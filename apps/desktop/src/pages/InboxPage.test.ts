import { describe, expect, it } from "vitest"
import {
  bucketDropId,
  filterQueueItems,
  formatSyncStatusLabel,
  moveItemInBucketItemOrder,
  resolveKanbanDropTarget,
  resolveVisibleQueueItem,
} from "./inbox-helpers"
import { createEmptyUserBucketItemOrder } from "@/reviewer/local-queue-state"
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
    expect(resolveVisibleQueueItem(items, "missing")).toBeUndefined()
    expect(resolveVisibleQueueItem(items, "")).toBeUndefined()
    expect(resolveVisibleQueueItem([], "pr_1")).toBeUndefined()
  })
})

describe("inbox kanban ordering", () => {
  const bucketIds = ["inbox", "reviewing", "waiting", "later", "done"] as const
  const bucketItems = {
    inbox: [{ id: "pr_1" }, { id: "pr_2" }],
    reviewing: [{ id: "pr_3" }],
    waiting: [],
    later: [{ id: "pr_4" }],
    done: [],
  }

  it("resolves card and empty-column drop targets", () => {
    expect(resolveKanbanDropTarget("pr_3", [...bucketIds], bucketItems)).toEqual({
      bucketId: "reviewing",
      overItemId: "pr_3",
    })
    expect(
      resolveKanbanDropTarget(bucketDropId("waiting"), [...bucketIds], bucketItems)
    ).toEqual({
      bucketId: "waiting",
    })
    expect(resolveKanbanDropTarget("missing", [...bucketIds], bucketItems)).toBeUndefined()
  })

  it("moves cards across buckets and preserves target position", () => {
    const nextOrder = moveItemInBucketItemOrder({
      current: createEmptyUserBucketItemOrder(),
      itemId: "pr_2",
      sourceBucketId: "inbox",
      targetBucketId: "reviewing",
      bucketItems,
      overItemId: "pr_3",
    })

    expect(nextOrder.inbox).toEqual(["pr_1"])
    expect(nextOrder.reviewing).toEqual(["pr_2", "pr_3"])
  })

  it("moves a card upward within a bucket", () => {
    const nextOrder = moveItemInBucketItemOrder({
      current: createEmptyUserBucketItemOrder(),
      itemId: "pr_2",
      sourceBucketId: "inbox",
      targetBucketId: "inbox",
      bucketItems,
      overItemId: "pr_1",
    })

    expect(nextOrder.inbox).toEqual(["pr_2", "pr_1"])
  })

  it("moves a card downward within a bucket", () => {
    const nextOrder = moveItemInBucketItemOrder({
      current: createEmptyUserBucketItemOrder(),
      itemId: "pr_1",
      sourceBucketId: "inbox",
      targetBucketId: "inbox",
      bucketItems,
      overItemId: "pr_2",
    })

    expect(nextOrder.inbox).toEqual(["pr_2", "pr_1"])
  })

  it("preserves stored IDs that are hidden by the current board filter", () => {
    const current = {
      ...createEmptyUserBucketItemOrder(),
      inbox: ["hidden_pr", "pr_1", "pr_2"],
      reviewing: ["hidden_reviewing", "pr_3"],
    }
    const nextOrder = moveItemInBucketItemOrder({
      current,
      itemId: "pr_2",
      sourceBucketId: "inbox",
      targetBucketId: "reviewing",
      bucketItems,
      overItemId: "pr_3",
    })

    expect(nextOrder.inbox).toEqual(["hidden_pr", "pr_1"])
    expect(nextOrder.reviewing).toEqual([
      "hidden_reviewing",
      "pr_2",
      "pr_3",
    ])
  })
})

describe("inbox sync status label", () => {
  const now = Date.parse("2026-06-11T12:00:00.000Z")

  it("reports an active sync first", () => {
    expect(
      formatSyncStatusLabel({
        isSyncing: true,
        lastSyncedAt: "2026-06-11T11:00:00.000Z",
        tokenConfigured: true,
        now,
      })
    ).toBe("syncing with GitHub…")
  })

  it("labels local-only data when no token is configured", () => {
    expect(
      formatSyncStatusLabel({ isSyncing: false, tokenConfigured: false, now })
    ).toBe("local data only")
  })

  it("reports when a configured inbox has never synced", () => {
    expect(
      formatSyncStatusLabel({ isSyncing: false, tokenConfigured: true, now })
    ).toBe("not synced yet")
  })

  it("formats the elapsed time since the last sync", () => {
    expect(
      formatSyncStatusLabel({
        isSyncing: false,
        lastSyncedAt: "2026-06-11T11:58:00.000Z",
        tokenConfigured: true,
        now,
      })
    ).toBe("synced 2m ago")
    expect(
      formatSyncStatusLabel({
        isSyncing: false,
        lastSyncedAt: "2026-06-11T09:00:00.000Z",
        tokenConfigured: true,
        now,
      })
    ).toBe("synced 3h ago")
    expect(
      formatSyncStatusLabel({
        isSyncing: false,
        lastSyncedAt: "2026-06-08T12:00:00.000Z",
        tokenConfigured: true,
        now,
      })
    ).toBe("synced 3d ago")
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
    labels: [],
    assignees: [],
    url: "https://github.com/acme/repo/pull/1",
    state: "open",
    workflowState: "needs_review",
    laneId: "needs_review",
    reason: overrides.reason,
    evidence: [],
    waitingOn: "you",
    waitingAge: "1h",
    waitingUrgency: "none",
    updatedAt: "1h ago",
    updatedAtIso: "2026-06-01T12:00:00.000Z",
    openedAt: "2h ago",
    lastSeenAt: "3h ago",
    lastSeenAtIso: "2026-06-01T10:00:00.000Z",
    userLastReviewDecision: "pending",
    approvalStale: false,
    reviewRounds: 0,
    otherReviewers: [],
    unseenEventCount: 1,
    newCommitCount: 0,
    newReplyCount: 0,
    unresolvedThreadCount: 0,
    totalThreadCount: 0,
    reviewThreads: [],
    activityEvents: [
      {
        id: `${overrides.id}_event`,
        type: "comment",
        actor: overrides.authorLogin,
        isViewer: false,
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
