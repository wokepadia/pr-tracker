import { useEffect } from "react"
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { getSyncStatus, syncGithubData } from "@/api"
import { useBoardFilterQuery } from "./use-board-filter"

const githubSyncMutationKey = ["github-sync"]
const githubSyncIntervalMs = 5 * 60 * 1000
const githubSyncIntervalJitterMs = 30 * 1000

function nextGithubSyncDelayMs(): number {
  return (
    githubSyncIntervalMs + Math.floor(Math.random() * githubSyncIntervalJitterMs)
  )
}

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
  const boardFilterQuery = useBoardFilterQuery()
  const syncMutation = useGithubSyncMutation()
  const startSync = syncMutation.mutate
  const syncInput = {
    githubSearchQuery: boardFilterQuery || undefined,
  }

  useEffect(() => {
    startSync(syncInput)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const scheduleIntervalSync = () => {
      timeout = setTimeout(() => {
        if (document.visibilityState === "visible") {
          startSync(syncInput)
        }
        scheduleIntervalSync()
      }, nextGithubSyncDelayMs())
    }
    const handleFocus = () => startSync(syncInput)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") startSync(syncInput)
    }
    scheduleIntervalSync()
    window.addEventListener("focus", handleFocus)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      if (timeout) clearTimeout(timeout)
      window.removeEventListener("focus", handleFocus)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [boardFilterQuery, startSync])
}

/**
 * Read-and-report side of the sync: pages render local SQLite data
 * immediately and use this hook for the sync label, errors, and the
 * manual "sync now" action. Sync state is shared across all instances
 * via the mutation key, so every header reflects the same run.
 */
export function useGithubSync() {
  const boardFilterQuery = useBoardFilterQuery()
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
    syncNow: () =>
      syncMutation.mutate({
        githubSearchQuery: boardFilterQuery || undefined,
        force: true,
      }),
    syncQuery: (githubSearchQuery: string) =>
      syncMutation.mutateAsync({
        githubSearchQuery: githubSearchQuery || undefined,
        force: true,
      }),
  }
}
