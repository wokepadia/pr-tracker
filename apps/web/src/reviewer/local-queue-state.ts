export interface LocalPullRequestQueueState {
  snoozed?: boolean
  pinned?: boolean
  muted?: boolean
}

export type LocalQueueStateByPullRequestId = Partial<
  Record<string, LocalPullRequestQueueState>
>

const LOCAL_QUEUE_STATE_KEY = "pr-tracker:reviewer-local-queue-state:v1"

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
  }

  const normalizedState = normalizeLocalQueueState(state)

  return hasLocalQueueState(normalizedState) ? normalizedState : undefined
}

export function hasLocalQueueState(
  state: LocalPullRequestQueueState
): boolean {
  return Boolean(state.snoozed || state.pinned || state.muted)
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
    return { snoozed: true }
  }

  if (state.muted) {
    return { muted: true }
  }

  if (state.pinned) {
    return { pinned: true }
  }

  return {}
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
