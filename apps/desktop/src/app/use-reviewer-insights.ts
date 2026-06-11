import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  getAttentionSettings,
  getBoardState,
  getReviewerInbox,
} from "@/api"
import {
  buildReviewerInsights,
  type ReviewerInsightsView,
} from "@/reviewer/insights"
import {
  buildInboxView,
  defaultAttentionThresholds,
} from "@/reviewer/view-model"

/**
 * Computes the insights projection from the shared local-read queries.
 * Callers that only need section counts (the nav badge) can omit the
 * visit anchor; the needs-you-now section does not depend on it.
 */
export function useReviewerInsights(options?: { previousVisitAt?: string }): {
  insights?: ReviewerInsightsView
  isLoading: boolean
} {
  const inboxQuery = useQuery({
    queryKey: ["reviewer-inbox", ""],
    queryFn: () => getReviewerInbox({}),
  })
  const attentionSettingsQuery = useQuery({
    queryKey: ["attention-settings"],
    queryFn: getAttentionSettings,
  })
  const boardStateQuery = useQuery({
    queryKey: ["board-state"],
    queryFn: getBoardState,
  })
  const previousVisitAt = options?.previousVisitAt

  const insights = useMemo(() => {
    if (!inboxQuery.data) return undefined

    const inboxView = buildInboxView(
      inboxQuery.data,
      attentionSettingsQuery.data ?? defaultAttentionThresholds
    )
    return buildReviewerInsights({
      items: inboxView.items,
      inactiveItems: inboxView.inactiveItems,
      localQueueState: boardStateQuery.data?.localQueueState ?? {},
      previousVisitAt,
    })
  }, [
    attentionSettingsQuery.data,
    boardStateQuery.data,
    inboxQuery.data,
    previousVisitAt,
  ])

  return { insights, isLoading: inboxQuery.isLoading }
}
