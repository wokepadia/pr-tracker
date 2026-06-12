import type { LocalQueueStateByPullRequestId } from "./local-queue-state"

/**
 * Board membership contract for AI input scoping: a pull request is on the
 * board exactly when it has a live (non-archived) board row, which the data
 * layer surfaces as a local queue state entry. Snoozed and muted items stay
 * in scope — those marks are themselves board state. Anything the local
 * database knows about without a board row (a pull request that outlived
 * the queue scope, or one fetched ad hoc) never reaches an AI prompt.
 */
export function selectBoardScopedItems<T extends { id: string }>(
  items: T[],
  localQueueState: LocalQueueStateByPullRequestId
): T[] {
  return items.filter((item) => localQueueState[item.id] !== undefined)
}
