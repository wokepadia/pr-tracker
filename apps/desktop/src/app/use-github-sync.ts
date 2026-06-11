import { useEffect } from "react"
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { getSyncStatus, syncGithubData } from "@/api"

const githubSyncMutationKey = ["github-sync"]
const githubSyncIntervalMs = 5 * 60 * 1000

function useGithubSyncMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: githubSyncMutationKey,
    mutationFn: syncGithubData,
    onSuccess: async (result) => {
      // A skipped sync left local data untouched; refetching would only
      // churn the UI. Refresh reads after syncs that actually landed.
      if (result.status !== "synced") return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["pull-request"] }),
        queryClient.invalidateQueries({ queryKey: ["board-state"] }),
        queryClient.invalidateQueries({ queryKey: ["sync-status"] }),
      ])
    },
  })
}

/**
 * Owns when background syncs happen. Mounted once in AppFrame so screen
 * changes never trigger syncs; the data layer's freshness window makes
 * the launch/refocus/interval triggers cheap no-ops while data is fresh.
 */
export function useGithubSyncController() {
  const syncMutation = useGithubSyncMutation()
  const startSync = syncMutation.mutate

  useEffect(() => {
    startSync({})
    const interval = setInterval(() => startSync({}), githubSyncIntervalMs)
    const handleFocus = () => startSync({})
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") startSync({})
    }
    window.addEventListener("focus", handleFocus)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      clearInterval(interval)
      window.removeEventListener("focus", handleFocus)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [startSync])
}

/**
 * Read-and-report side of the sync: pages render local SQLite data
 * immediately and use this hook for the sync label, errors, and the
 * manual "sync now" action. Sync state is shared across all instances
 * via the mutation key, so every header reflects the same run.
 */
export function useGithubSync() {
  const syncStatusQuery = useQuery({
    queryKey: ["sync-status"],
    queryFn: getSyncStatus,
  })
  const syncMutation = useGithubSyncMutation()
  const isSyncing =
    useIsMutating({ mutationKey: githubSyncMutationKey }) > 0
  const syncErrors = useMutationState({
    filters: { mutationKey: githubSyncMutationKey },
    select: (mutation) => mutation.state.error,
  })
  const syncError = syncErrors[syncErrors.length - 1] ?? undefined

  return {
    lastSyncedAt: syncStatusQuery.data?.lastSyncedAt,
    isStatusLoading: syncStatusQuery.isLoading,
    isSyncing,
    syncError,
    syncNow: () => syncMutation.mutate({ force: true }),
  }
}
