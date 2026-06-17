/**
 * Human-readable label for the background GitHub sync state, shown in the
 * home dashboard header.
 */
export function formatSyncStatusLabel({
  isSyncing,
  lastSyncedAt,
  tokenConfigured,
  now = Date.now(),
}: {
  isSyncing: boolean
  lastSyncedAt?: string
  tokenConfigured: boolean
  now?: number
}): string {
  if (isSyncing) return "syncing with GitHub…"
  if (!tokenConfigured) return "local data only"
  if (!lastSyncedAt) return "not synced yet"

  const elapsedMs = Math.max(0, now - Date.parse(lastSyncedAt))
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return "synced just now"
  if (minutes < 60) return `synced ${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `synced ${hours}h ago`

  return `synced ${Math.floor(hours / 24)}d ago`
}
