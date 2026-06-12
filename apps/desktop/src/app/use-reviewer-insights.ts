import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  getAttentionSettings,
  getBoardState,
} from "@/api"
import { useBoardInbox } from "./use-board-inbox"
import { selectBoardScopedItems } from "@/reviewer/board-scope"
import {
  buildReviewerInsights,
  type ReviewerInsightsView,
} from "@/reviewer/insights"
import {
  buildInboxView,
  defaultAttentionThresholds,
  type AttentionThresholds,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import type { LocalQueueStateByPullRequestId } from "@/reviewer/local-queue-state"

/**
 * Computes the insights projection over the board-filtered inbox — like
 * every surface, it sees only the pull requests the applied board filter
 * admits. Callers that only need section counts (the nav badge) can omit
 * the visit anchor; the needs-you-now section does not depend on it.
 *
 * With `scope: "board"` the projection additionally drops items without a
 * live board row — the contract for anything that feeds an AI prompt — and
 * stays undefined until the board rows have loaded.
 */
export function useReviewerInsights(options?: {
  previousVisitAt?: string
  scope?: "all" | "board"
}): {
  insights?: ReviewerInsightsView
  /** Active and recently inactive items, for consumers that need to look
   * up the underlying pull requests behind the insight rows. */
  allItems?: ReviewQueueItemView[]
  attentionSettings?: AttentionThresholds
  localQueueState?: LocalQueueStateByPullRequestId
  isLoading: boolean
} {
  const { inboxQuery } = useBoardInbox()
  const attentionSettingsQuery = useQuery({
    queryKey: ["attention-settings"],
    queryFn: getAttentionSettings,
  })
  const boardStateQuery = useQuery({
    queryKey: ["board-state"],
    queryFn: getBoardState,
  })
  const previousVisitAt = options?.previousVisitAt
  const scope = options?.scope ?? "all"
  const localQueueState = boardStateQuery.data?.localQueueState

  const computed = useMemo(() => {
    if (!inboxQuery.data) return undefined
    if (scope === "board" && !localQueueState) return undefined

    const inboxView = buildInboxView(
      inboxQuery.data,
      attentionSettingsQuery.data ?? defaultAttentionThresholds
    )
    const items =
      scope === "board"
        ? selectBoardScopedItems(inboxView.items, localQueueState ?? {})
        : inboxView.items
    const inactiveItems =
      scope === "board"
        ? selectBoardScopedItems(inboxView.inactiveItems, localQueueState ?? {})
        : inboxView.inactiveItems
    return {
      insights: buildReviewerInsights({
        items,
        inactiveItems,
        localQueueState: localQueueState ?? {},
        previousVisitAt,
      }),
      allItems: [...items, ...inactiveItems],
    }
  }, [
    attentionSettingsQuery.data,
    inboxQuery.data,
    localQueueState,
    previousVisitAt,
    scope,
  ])

  return {
    insights: computed?.insights,
    allItems: computed?.allItems,
    attentionSettings: attentionSettingsQuery.data ?? defaultAttentionThresholds,
    localQueueState,
    isLoading: inboxQuery.isLoading,
  }
}
