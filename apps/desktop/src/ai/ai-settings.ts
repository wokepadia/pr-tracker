/**
 * Pure helpers for AI mode settings. AI mode is strictly additive: every AI
 * surface in the app must check `isAiModeActive` and render nothing when it
 * is false, so the app is unchanged until the user saves an OpenRouter key
 * and enables the mode.
 */

export const defaultAiModel = "anthropic/claude-sonnet-4.6"

export interface StoredAiSettings {
  enabled: boolean
  model: string
  apiKeyConfigured: boolean
}

export function normalizeStoredAiSettings(value: unknown): StoredAiSettings {
  const parsed = (value ?? {}) as {
    enabled?: unknown
    model?: unknown
    apiKeyConfigured?: unknown
  }
  return {
    enabled: parsed.enabled === true,
    model: normalizeAiModel(parsed.model),
    apiKeyConfigured: parsed.apiKeyConfigured === true,
  }
}

export function normalizeAiModel(value: unknown): string {
  if (typeof value !== "string") return defaultAiModel
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : defaultAiModel
}

export function isAiModeActive(
  status: { enabled: boolean; apiKeyConfigured: boolean } | undefined
): boolean {
  return status?.enabled === true && status.apiKeyConfigured
}
