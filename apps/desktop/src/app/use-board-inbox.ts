import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { getReviewerInbox } from "@/api"
import { useBoardFilterQuery } from "./use-board-filter"

/**
 * The one query every surface reads the reviewer inbox through. Keying by
 * the applied board filter keeps all surfaces on the same filtered
 * universe and the same cache entry; a surface that called
 * getReviewerInbox directly without the filter would silently widen its
 * scope past the board, which the scope contract in CLAUDE.md forbids.
 */
export function useBoardInbox() {
  const boardFilterQuery = useBoardFilterQuery()
  const inboxQuery = useQuery({
    queryKey: ["reviewer-inbox", boardFilterQuery],
    queryFn: () =>
      getReviewerInbox({ githubSearchQuery: boardFilterQuery || undefined }),
    placeholderData: keepPreviousData,
  })

  return { inboxQuery, boardFilterQuery }
}
