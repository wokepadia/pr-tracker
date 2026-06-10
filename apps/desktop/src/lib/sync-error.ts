export interface SyncErrorView {
  kind: "auth" | "forbidden" | "network" | "unknown"
  message: string
  showSettingsLink: boolean
}

export function describeGithubSyncError(error: unknown): SyncErrorView {
  const status =
    error instanceof Error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status?: number }).status
      : undefined
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""

  if (status === 401 || /bad credentials/i.test(raw)) {
    return {
      kind: "auth",
      message:
        "GitHub rejected the saved token. Update the token in Settings.",
      showSettingsLink: true,
    }
  }

  if (status === 403 || status === 429 || /rate limit/i.test(raw)) {
    return {
      kind: "forbidden",
      message:
        "GitHub denied the sync request. This is usually a rate limit (it resets within an hour) or missing token permissions.",
      showSettingsLink: true,
    }
  }

  if (/timed out|failed to fetch|load failed|network/i.test(raw)) {
    return {
      kind: "network",
      message: "Could not reach GitHub. Check your connection, then retry.",
      showSettingsLink: false,
    }
  }

  return {
    kind: "unknown",
    message: raw || "Syncing with GitHub failed for an unknown reason.",
    showSettingsLink: /token/i.test(raw),
  }
}
