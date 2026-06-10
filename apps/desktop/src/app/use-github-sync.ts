import { useEffect } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { getSyncStatus, syncGithubData } from "@/api"

/**
 * Runs the GitHub sync in the background and reports its state.
 *
 * Reads stay local-first: pages render local SQLite data immediately while
 * this hook refreshes it. The data layer dedupes concurrent syncs and skips
 * re-syncing when the settings fingerprint is unchanged, so mounting this
 * hook is cheap; `syncNow` forces a fresh sync.
 */
export function useGithubSync() {
  const queryClient = useQueryClient()
  const syncStatusQuery = useQuery({
    queryKey: ["sync-status"],
    queryFn: getSyncStatus,
  })
  const syncMutation = useMutation({
    mutationFn: syncGithubData,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["pull-request"] }),
        queryClient.invalidateQueries({ queryKey: ["board-state"] }),
        queryClient.invalidateQueries({ queryKey: ["sync-status"] }),
      ])
    },
  })

  const startSync = syncMutation.mutate
  useEffect(() => {
    startSync({})
  }, [startSync])

  return {
    lastSyncedAt: syncStatusQuery.data?.lastSyncedAt,
    isStatusLoading: syncStatusQuery.isLoading,
    isSyncing: syncMutation.isPending,
    syncError: syncMutation.error ?? undefined,
    syncNow: () => startSync({ force: true }),
  }
}
