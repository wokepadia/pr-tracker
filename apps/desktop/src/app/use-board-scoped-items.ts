import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { getAttentionSettings, getBoardState } from "@/api"
import { useBoardInbox } from "./use-board-inbox"
import { selectBoardScopedItems } from "@/reviewer/board-scope"
import {
  buildInboxView,
  defaultAttentionThresholds,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"

/**
 * The board-scoped pull request universe the home dashboard renders over.
 * Like every surface it derives from the applied board filter (via
 * useBoardInbox) and is further narrowed to pull requests with a live board
 * row (selectBoardScopedItems), so nothing the local database happens to hold
 * outside the board can leak into the dashboard or its AI prompt. Active and
 * recently inactive items are returned together; the dashboard decides how to
 * present them.
 */
export function useBoardScopedItems(): {
  items?: ReviewQueueItemView[]
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
  const localQueueState = boardStateQuery.data?.localQueueState

  const items = useMemo(() => {
    if (!inboxQuery.data || !localQueueState) return undefined

    const inboxView = buildInboxView(
      inboxQuery.data,
      attentionSettingsQuery.data ?? defaultAttentionThresholds
    )
    return [
      ...selectBoardScopedItems(inboxView.items, localQueueState),
      ...selectBoardScopedItems(inboxView.inactiveItems, localQueueState),
    ]
  }, [attentionSettingsQuery.data, inboxQuery.data, localQueueState])

  return { items, isLoading: inboxQuery.isLoading }
}
