export interface LocalPullRequestQueueState {
  snoozed?: boolean
  pinned?: boolean
  muted?: boolean
  bucketId?: UserBucketId
  notes?: string
}

export type LocalQueueStateByPullRequestId = Partial<
  Record<string, LocalPullRequestQueueState>
>

export type UserBucketId = string

export interface UserBucketDefinition {
  id: UserBucketId
  label: string
}

export type UserBucketLabels = Record<UserBucketId, string>
export type UserBucketItemOrder = Record<UserBucketId, string[]>

const LOCAL_QUEUE_STATE_KEY = "pr-tracker:reviewer-local-queue-state:v1"
const USER_BUCKET_LABELS_KEY = "pr-tracker:user-bucket-labels:v1"
const USER_BUCKETS_KEY = "pr-tracker:user-buckets:v1"
const USER_BUCKET_ITEM_ORDER_KEY = "pr-tracker:user-bucket-item-order:v1"
const CUSTOM_BUCKET_ID_PREFIX = "bucket"

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

export function createEmptyUserBucketItemOrder(
  buckets: UserBucketDefinition[] = defaultUserBuckets
): UserBucketItemOrder {
  return Object.fromEntries(
    buckets.map((bucket) => [bucket.id, []])
  ) as unknown as UserBucketItemOrder
}

export function loadUserBuckets(
  storage: Pick<Storage, "getItem">
): UserBucketDefinition[] {
  const rawValue = storage.getItem(USER_BUCKETS_KEY)
  if (!rawValue) return defaultUserBucketsFromLegacyLabels(storage)

  try {
    return parseUserBuckets(JSON.parse(rawValue))
  } catch {
    return defaultUserBucketsFromLegacyLabels(storage)
  }
}

export function saveUserBuckets(
  storage: Pick<Storage, "setItem">,
  buckets: UserBucketDefinition[]
): void {
  storage.setItem(USER_BUCKETS_KEY, JSON.stringify(normalizeUserBuckets(buckets)))
}

export function createUserBucket(
  label: string,
  existingBuckets: UserBucketDefinition[]
): UserBucketDefinition {
  const trimmedLabel = label.trim()
  const safeLabel = trimmedLabel || "New label"
  const baseId = toBucketIdBase(safeLabel)
  const existingIds = new Set(existingBuckets.map((bucket) => bucket.id))
  let id = baseId
  let suffix = 2

  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`
    suffix += 1
  }

  return {
    id,
    label: safeLabel,
  }
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
  storage: Pick<Storage, "getItem">,
  buckets: UserBucketDefinition[] = defaultUserBuckets
): UserBucketItemOrder {
  const rawValue = storage.getItem(USER_BUCKET_ITEM_ORDER_KEY)
  if (!rawValue) return createEmptyUserBucketItemOrder(buckets)

  try {
    return parseUserBucketItemOrder(JSON.parse(rawValue), buckets)
  } catch {
    return createEmptyUserBucketItemOrder(buckets)
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
  const orderedItems = (itemOrder[bucketId] ?? []).flatMap((itemId) => {
    const item = itemById.get(itemId)
    return item ? [item] : []
  })
  const orderedIds = new Set(orderedItems.map((item) => item.id))
  const unorderedItems = items.filter((item) => !orderedIds.has(item.id))

  return [...orderedItems, ...unorderedItems]
}

export function userBucketLabelFromId(
  buckets: UserBucketDefinition[] | UserBucketLabels,
  bucketId: UserBucketId
): string {
  if (Array.isArray(buckets)) {
    return (
      buckets.find((bucket) => bucket.id === bucketId)?.label ||
      defaultUserBucketLabels[bucketId] ||
      bucketId
    )
  }

  return buckets[bucketId] || defaultUserBucketLabels[bucketId] || bucketId
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
    notes: readNotesProperty(value, "notes"),
  }

  const normalizedState = normalizeLocalQueueState(state)

  return hasLocalQueueState(normalizedState) ? normalizedState : undefined
}

export function hasLocalQueueState(
  state: LocalPullRequestQueueState
): boolean {
  return Boolean(
    state.snoozed || state.pinned || state.muted || state.bucketId || state.notes
  )
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
  const notes = state.notes?.trim() ? state.notes : undefined

  if (state.snoozed) {
    return { snoozed: true, bucketId: state.bucketId, notes }
  }

  if (state.muted) {
    return { muted: true, bucketId: state.bucketId, notes }
  }

  if (state.pinned) {
    return { pinned: true, bucketId: state.bucketId, notes }
  }

  return {
    ...(state.bucketId ? { bucketId: state.bucketId } : {}),
    ...(notes ? { notes } : {}),
  }
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
  return readUserBucketId(propertyValue)
}

function readNotesProperty(
  value: object,
  property: keyof LocalPullRequestQueueState
): string | undefined {
  const propertyValue = (value as Record<string, unknown>)[property]
  if (typeof propertyValue !== "string") return undefined

  const notes = propertyValue.replace(/\r\n?/g, "\n")
  return notes.trim() ? notes : undefined
}

function defaultUserBucketsFromLegacyLabels(
  storage: Pick<Storage, "getItem">
): UserBucketDefinition[] {
  const labels = loadUserBucketLabels(storage)
  return defaultUserBuckets.map((bucket) => ({
    id: bucket.id,
    label: userBucketLabelFromId(labels, bucket.id),
  }))
}

function parseUserBuckets(value: unknown): UserBucketDefinition[] {
  if (!Array.isArray(value)) return defaultUserBuckets

  return normalizeUserBuckets(
    value.flatMap((bucket) => {
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
        return []
      }

      const id = readUserBucketId((bucket as Record<string, unknown>).id)
      const label = (bucket as Record<string, unknown>).label
      if (!id || typeof label !== "string") return []

      return [
        {
          id,
          label,
        },
      ]
    })
  )
}

function normalizeUserBuckets(
  buckets: UserBucketDefinition[]
): UserBucketDefinition[] {
  const seenIds = new Set<string>()
  const normalizedBuckets = buckets.flatMap((bucket) => {
    const id = readUserBucketId(bucket.id)
    const label = bucket.label.trim()
    if (!id || !label || seenIds.has(id)) return []

    seenIds.add(id)
    return [{ id, label }]
  })

  return normalizedBuckets.length > 0 ? normalizedBuckets : defaultUserBuckets
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

function parseUserBucketItemOrder(
  value: unknown,
  buckets: UserBucketDefinition[]
): UserBucketItemOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyUserBucketItemOrder(buckets)
  }

  return Object.fromEntries(
    buckets.map(({ id: bucketId }) => {
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

function readUserBucketId(value: unknown): UserBucketId | undefined {
  const trimmedValue = typeof value === "string" ? value.trim() : ""
  return trimmedValue ? trimmedValue : undefined
}

function toBucketIdBase(label: string): UserBucketId {
  const normalizedLabel = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return normalizedLabel || CUSTOM_BUCKET_ID_PREFIX
}
