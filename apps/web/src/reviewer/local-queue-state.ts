export type LocalQueueState = "snoozed"

export type LocalQueueStateByPullRequestId = Partial<
  Record<string, LocalQueueState>
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
    Object.entries(value).filter(
      (entry): entry is [string, LocalQueueState] =>
        typeof entry[0] === "string" && entry[1] === "snoozed"
    )
  )
}
