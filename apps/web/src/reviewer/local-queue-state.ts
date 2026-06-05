export interface LocalPullRequestQueueState {
  snoozed?: boolean
  pinned?: boolean
  muted?: boolean
  bucketId?: UserBucketId
}

export type LocalQueueStateByPullRequestId = Partial<
  Record<string, LocalPullRequestQueueState>
>

export type UserBucketId = "inbox" | "reviewing" | "waiting" | "later" | "done"

export interface UserBucketDefinition {
  id: UserBucketId
  label: string
}

export type UserBucketLabels = Record<UserBucketId, string>
export type UserBucketItemOrder = Record<UserBucketId, string[]>

const LOCAL_QUEUE_STATE_KEY = "pr-tracker:reviewer-local-queue-state:v1"
const USER_BUCKET_LABELS_KEY = "pr-tracker:user-bucket-labels:v1"
const USER_BUCKET_ITEM_ORDER_KEY = "pr-tracker:user-bucket-item-order:v1"

export const defaultUserBuckets: UserBucketDefinition[] = [
  { id: "inbox", label: "Inbox" },
  { id: "reviewing", label: "Reviewing" },
  { id: "waiting", label: "Waiting" },
  { id: "later", label: "Later" },
  { id: "done", label: "Done" },
]

export const userBucketIds = defaultUserBuckets.map((bucket) => bucket.id)

export const defaultUserBucketLabels = Object.fromEntries(
  defaultUserBuckets.map((bucket) => [bucket.id, bucket.label])
) as UserBucketLabels

export function createEmptyUserBucketItemOrder(): UserBucketItemOrder {
  return Object.fromEntries(
    userBucketIds.map((bucketId) => [bucketId, []])
  ) as unknown as UserBucketItemOrder
}

export function loadLocalQueueState(
  storage: Pick<Storage, "getItem">
): LocalQueueStateByPullRequestId {
  const rawValue = storage.getItem(LOCAL_QUEUE_STATE_KEY)
  if (!rawValue) return {}

  try {
    return parseLocalQueueState(JSON.parse(rawValue))
  } catch {
    return {}
  }
}

export function saveLocalQueueState(
  storage: Pick<Storage, "setItem">,
  state: LocalQueueStateByPullRequestId
): void {
  storage.setItem(LOCAL_QUEUE_STATE_KEY, JSON.stringify(state))
}

export function loadUserBucketLabels(
  storage: Pick<Storage, "getItem">
): UserBucketLabels {
  const rawValue = storage.getItem(USER_BUCKET_LABELS_KEY)
  if (!rawValue) return defaultUserBucketLabels

  try {
    return parseUserBucketLabels(JSON.parse(rawValue))
  } catch {
    return defaultUserBucketLabels
  }
}

export function saveUserBucketLabels(
  storage: Pick<Storage, "setItem">,
  labels: UserBucketLabels
): void {
  storage.setItem(USER_BUCKET_LABELS_KEY, JSON.stringify(labels))
}

export function loadUserBucketItemOrder(
  storage: Pick<Storage, "getItem">
): UserBucketItemOrder {
  const rawValue = storage.getItem(USER_BUCKET_ITEM_ORDER_KEY)
  if (!rawValue) return createEmptyUserBucketItemOrder()

  try {
    return parseUserBucketItemOrder(JSON.parse(rawValue))
  } catch {
    return createEmptyUserBucketItemOrder()
  }
}

export function saveUserBucketItemOrder(
  storage: Pick<Storage, "setItem">,
  itemOrder: UserBucketItemOrder
): void {
  storage.setItem(USER_BUCKET_ITEM_ORDER_KEY, JSON.stringify(itemOrder))
}

export function applyUserBucketItemOrder<T extends { id: string }>(
  items: T[],
  bucketId: UserBucketId,
  itemOrder: UserBucketItemOrder
): T[] {
  const itemById = new Map(items.map((item) => [item.id, item]))
  const orderedItems = itemOrder[bucketId].flatMap((itemId) => {
    const item = itemById.get(itemId)
    return item ? [item] : []
  })
  const orderedIds = new Set(orderedItems.map((item) => item.id))
  const unorderedItems = items.filter((item) => !orderedIds.has(item.id))

  return [...orderedItems, ...unorderedItems]
}

export function userBucketLabelFromId(
  labels: UserBucketLabels,
  bucketId: UserBucketId
): string {
  return labels[bucketId] || defaultUserBucketLabels[bucketId]
}

export function defaultBucketIdForWorkflowLane(
  laneId: string
): UserBucketId {
  if (laneId === "waiting_on_author") return "waiting"
  if (laneId === "approved" || laneId === "caught_up") return "done"
  if (laneId === "stale" || laneId === "watching") return "later"
  return "inbox"
}

export function bucketIdForLocalQueueItem(
  state: LocalPullRequestQueueState | undefined,
  workflowLaneId: string
): UserBucketId {
  return state?.bucketId ?? defaultBucketIdForWorkflowLane(workflowLaneId)
}

function parseLocalQueueState(value: unknown): LocalQueueStateByPullRequestId {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, state]) => [id, parsePullRequestQueueState(state)] as const)
      .filter(
        (entry): entry is [string, LocalPullRequestQueueState] =>
          entry[1] !== undefined
      )
  )
}

function parsePullRequestQueueState(
  value: unknown
): LocalPullRequestQueueState | undefined {
  if (value === "snoozed") {
    return { snoozed: true }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const state = {
    snoozed: readBooleanProperty(value, "snoozed"),
    pinned: readBooleanProperty(value, "pinned"),
    muted: readBooleanProperty(value, "muted"),
    bucketId: readBucketIdProperty(value, "bucketId"),
  }

  const normalizedState = normalizeLocalQueueState(state)

  return hasLocalQueueState(normalizedState) ? normalizedState : undefined
}

export function hasLocalQueueState(
  state: LocalPullRequestQueueState
): boolean {
  return Boolean(state.snoozed || state.pinned || state.muted || state.bucketId)
}

export function canSnoozeLocalQueueItem(
  state: LocalPullRequestQueueState | undefined
): boolean {
  return !state?.snoozed && !state?.muted
}

export function canPinLocalQueueItem(
  state: LocalPullRequestQueueState | undefined
): boolean {
  return !state?.snoozed && !state?.muted
}

export function canMuteLocalQueueItem(
  state: LocalPullRequestQueueState | undefined
): boolean {
  return !state?.snoozed && !state?.muted
}

function normalizeLocalQueueState(
  state: LocalPullRequestQueueState
): LocalPullRequestQueueState {
  if (state.snoozed) {
    return { snoozed: true, bucketId: state.bucketId }
  }

  if (state.muted) {
    return { muted: true, bucketId: state.bucketId }
  }

  if (state.pinned) {
    return { pinned: true, bucketId: state.bucketId }
  }

  return state.bucketId ? { bucketId: state.bucketId } : {}
}

function readBooleanProperty(
  value: object,
  property: keyof LocalPullRequestQueueState
): boolean | undefined {
  return Object.prototype.hasOwnProperty.call(value, property) &&
    (value as Record<string, unknown>)[property] === true
    ? true
    : undefined
}

function readBucketIdProperty(
  value: object,
  property: keyof LocalPullRequestQueueState
): UserBucketId | undefined {
  const propertyValue = (value as Record<string, unknown>)[property]
  return isUserBucketId(propertyValue) ? propertyValue : undefined
}

function parseUserBucketLabels(value: unknown): UserBucketLabels {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultUserBucketLabels
  }

  return Object.fromEntries(
    userBucketIds.map((bucketId) => {
      const label = (value as Record<string, unknown>)[bucketId]
      const trimmedLabel = typeof label === "string" ? label.trim() : ""
      return [
        bucketId,
        trimmedLabel || defaultUserBucketLabels[bucketId],
      ] as const
    })
  ) as UserBucketLabels
}

function parseUserBucketItemOrder(value: unknown): UserBucketItemOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyUserBucketItemOrder()
  }

  return Object.fromEntries(
    userBucketIds.map((bucketId) => {
      const rawOrder = (value as Record<string, unknown>)[bucketId]
      const seenItemIds = new Set<string>()
      const itemIds = Array.isArray(rawOrder)
        ? rawOrder.filter((itemId): itemId is string => {
            if (typeof itemId !== "string" || itemId.length === 0) return false
            if (seenItemIds.has(itemId)) return false
            seenItemIds.add(itemId)
            return true
          })
        : []

      return [bucketId, itemIds] as const
    })
  ) as UserBucketItemOrder
}

function isUserBucketId(value: unknown): value is UserBucketId {
  return typeof value === "string" && userBucketIds.includes(value as UserBucketId)
}
