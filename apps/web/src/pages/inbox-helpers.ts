import type { ReviewQueueItemView } from "@/reviewer/view-model"

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
  storage: Pick<Storage, "removeItem" | "setItem">,
  selectedId: string
): void {
  if (selectedId) {
    storage.setItem(SELECTED_QUEUE_ITEM_KEY, selectedId)
  } else {
    storage.removeItem(SELECTED_QUEUE_ITEM_KEY)
  }
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
      ...item.changedFilesSinceLastSeen.map((file) => file.path),
    ].join(" ")
  )
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}
