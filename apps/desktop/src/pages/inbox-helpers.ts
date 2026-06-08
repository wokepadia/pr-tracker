import type { ReviewQueueItemView } from "@/reviewer/view-model"
import type {
  UserBucketId,
  UserBucketItemOrder,
} from "@/reviewer/local-queue-state"

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
  if (!selectedId) return undefined
  return visibleItems.find((item) => item.id === selectedId)
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
    if ((bucketItems[bucketId] ?? []).some((item) => item.id === overId)) {
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
  const sourceItemIds = (bucketItems[sourceBucketId] ?? []).map((item) => item.id)
  const targetItemIds = (bucketItems[targetBucketId] ?? []).map((item) => item.id)
  const next = { ...current }

  if (sourceBucketId !== targetBucketId) {
    next[sourceBucketId] = mergeStoredAndVisibleItemIds(
      current[sourceBucketId] ?? [],
      sourceItemIds
    ).filter((id) => id !== itemId)
  }

  const targetOrder = mergeStoredAndVisibleItemIds(
    current[targetBucketId] ?? [],
    targetItemIds
  )
  const sourceIndex = targetOrder.indexOf(itemId)
  const overIndex = overItemId ? targetOrder.indexOf(overItemId) : -1
  const targetOrderWithoutItem = targetOrder.filter((id) => id !== itemId)
  const insertAfterOverItem =
    sourceBucketId === targetBucketId &&
    sourceIndex >= 0 &&
    overIndex >= 0 &&
    sourceIndex < overIndex
  const targetIndex = overItemId
    ? targetOrderWithoutItem.indexOf(overItemId)
    : -1
  const insertionIndex =
    targetIndex >= 0
      ? targetIndex + (insertAfterOverItem ? 1 : 0)
      : targetOrderWithoutItem.length
  targetOrderWithoutItem.splice(insertionIndex, 0, itemId)
  next[targetBucketId] = targetOrderWithoutItem

  return next
}

export function getEmptyPeekCopy(
  groupMode: QueueGroupMode,
  searchQuery: string,
  hasVisibleItems = false
): { title: string; detail: string } {
  if (hasVisibleItems) {
    return {
      title: "Choose a PR to sneak peek",
      detail: "Use the sneak peek button on a card to load the right panel.",
    }
  }

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
