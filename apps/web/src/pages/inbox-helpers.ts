import type { ReviewQueueItemView } from "@/reviewer/view-model"
import type {
  UserBucketId,
  UserBucketItemOrder,
} from "@/reviewer/local-queue-state"

const SELECTED_QUEUE_ITEM_KEY = "pr-tracker:selected-review-queue-item:v1"

export type QueueGroupMode =
  | "action"
  | "repository"
  | "pinned"
  | "snoozed"
  | "muted"

export function filterQueueItems(
  items: ReviewQueueItemView[],
  query: string
): ReviewQueueItemView[] {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return items

  return items.filter((item) =>
    buildSearchTextForItem(item).includes(normalizedQuery)
  )
}

export function resolveVisibleQueueItem(
  visibleItems: ReviewQueueItemView[],
  selectedId: string
): ReviewQueueItemView | undefined {
  return visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0]
}

export function loadStoredSelectedQueueItemId(
  storage: Pick<Storage, "getItem">
): string {
  const value = storage.getItem(SELECTED_QUEUE_ITEM_KEY)
  return value ?? ""
}

export function saveStoredSelectedQueueItemId(
  storage: Pick<Storage, "setItem">,
  selectedId: string
): void {
  if (!selectedId) return
  storage.setItem(SELECTED_QUEUE_ITEM_KEY, selectedId)
}

export function bucketDropId(bucketId: UserBucketId): string {
  return `bucket:${bucketId}`
}

export function resolveKanbanDropTarget(
  overId: string | number | undefined,
  bucketIds: UserBucketId[],
  bucketItems: Record<UserBucketId, Array<{ id: string }>>
): { bucketId: UserBucketId; overItemId?: string } | undefined {
  const overBucketId = parseBucketDropId(overId, bucketIds)
  if (overBucketId) return { bucketId: overBucketId }
  if (typeof overId !== "string") return undefined

  for (const bucketId of bucketIds) {
    if (bucketItems[bucketId].some((item) => item.id === overId)) {
      return { bucketId, overItemId: overId }
    }
  }

  return undefined
}

export function moveItemInBucketItemOrder({
  current,
  itemId,
  sourceBucketId,
  targetBucketId,
  bucketItems,
  overItemId,
}: {
  current: UserBucketItemOrder
  itemId: string
  sourceBucketId: UserBucketId
  targetBucketId: UserBucketId
  bucketItems: Record<UserBucketId, Array<{ id: string }>>
  overItemId?: string
}): UserBucketItemOrder {
  const sourceItemIds = bucketItems[sourceBucketId].map((item) => item.id)
  const targetItemIds = bucketItems[targetBucketId].map((item) => item.id)
  const next = { ...current }

  if (sourceBucketId !== targetBucketId) {
    next[sourceBucketId] = mergeStoredAndVisibleItemIds(
      current[sourceBucketId],
      sourceItemIds
    ).filter((id) => id !== itemId)
  }

  const targetOrder = mergeStoredAndVisibleItemIds(
    current[targetBucketId],
    targetItemIds
  ).filter((id) => id !== itemId)
  const targetIndex = overItemId ? targetOrder.indexOf(overItemId) : -1
  targetOrder.splice(targetIndex >= 0 ? targetIndex : targetOrder.length, 0, itemId)
  next[targetBucketId] = targetOrder

  return next
}

export function getEmptyPeekCopy(
  groupMode: QueueGroupMode,
  searchQuery: string
): { title: string; detail: string } {
  if (searchQuery.trim().length > 0) {
    return {
      title: "No matching review items",
      detail: "No items match the current search in this view.",
    }
  }

  if (groupMode === "pinned") {
    return {
      title: "No pinned PRs",
      detail: "Nothing is pinned right now.",
    }
  }

  if (groupMode === "snoozed") {
    return {
      title: "No snoozed PRs",
      detail: "Nothing is snoozed right now.",
    }
  }

  if (groupMode === "muted") {
    return {
      title: "No muted PRs",
      detail: "Nothing is muted right now.",
    }
  }

  if (groupMode === "repository") {
    return {
      title: "No repository groups",
      detail: "No repository groups are visible in this view.",
    }
  }

  return {
    title: "No active review items",
    detail: "There are no active review items in the current view.",
  }
}

function buildSearchTextForItem(item: ReviewQueueItemView): string {
  return normalizeSearchText(
    [
      item.title,
      item.description ?? "",
      item.repository,
      `#${item.number}`,
      String(item.number),
      item.authorLogin,
      item.reason,
      item.workflowState,
      item.userLastReviewDecision,
      ...item.activityEvents.flatMap((event) => [
        event.actor,
        event.action,
        event.detail ?? "",
      ]),
      ...item.reviewThreads.map((thread) => thread.excerpt),
    ].join(" ")
  )
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}

function mergeStoredAndVisibleItemIds(
  storedItemIds: string[],
  visibleItemIds: string[]
): string[] {
  const storedItemIdSet = new Set(storedItemIds)
  return [
    ...storedItemIds,
    ...visibleItemIds.filter((itemId) => !storedItemIdSet.has(itemId)),
  ]
}

function parseBucketDropId(
  id: string | number | undefined,
  bucketIds: UserBucketId[]
): UserBucketId | undefined {
  if (typeof id !== "string") return undefined
  if (!id.startsWith("bucket:")) return undefined

  const bucketId = id.slice("bucket:".length)
  return bucketIds.includes(bucketId as UserBucketId)
    ? (bucketId as UserBucketId)
    : undefined
}
