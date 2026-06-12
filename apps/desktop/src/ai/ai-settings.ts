/**
 * Pure helpers for AI mode settings. AI mode is strictly additive: every AI
 * surface in the app must check `isAiModeActive` and render nothing when it
 * is false, so the app is unchanged until the user opts in.
 *
 * Two providers are supported. OpenRouter calls the user's own API key
 * directly; Codex shells out to the locally installed Codex CLI, which owns
 * its own ChatGPT-plan sign-in, so no key is stored for it.
 */

export type AiProvider = "openrouter" | "codex"

export const defaultAiModels: Record<AiProvider, string> = {
  openrouter: "anthropic/claude-sonnet-4.6",
  // The Codex CLI's built-in default model is rejected on ChatGPT-plan
  // auth, so the app always passes a plan-supported model explicitly.
  codex: "gpt-5.5",
}

export interface StoredAiSettings {
  enabled: boolean
  provider: AiProvider
  model: string
  apiKeyConfigured: boolean
}

export function normalizeStoredAiSettings(value: unknown): StoredAiSettings {
  const parsed = (value ?? {}) as {
    enabled?: unknown
    provider?: unknown
    model?: unknown
    apiKeyConfigured?: unknown
  }
  const provider = normalizeAiProvider(parsed.provider)
  return {
    enabled: parsed.enabled === true,
    provider,
    model: normalizeAiModel(parsed.model, provider),
    apiKeyConfigured: parsed.apiKeyConfigured === true,
  }
}

export function normalizeAiProvider(value: unknown): AiProvider {
  return value === "codex" ? "codex" : "openrouter"
}

export function normalizeAiModel(value: unknown, provider: AiProvider): string {
  if (typeof value !== "string") return defaultAiModels[provider]
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : defaultAiModels[provider]
}

/**
 * OpenRouter needs a stored key; Codex authenticates through the CLI's own
 * login, so enabling it is enough.
 */
export function isAiModeActive(
  status:
    | { enabled: boolean; provider: AiProvider; apiKeyConfigured: boolean }
    | undefined
): boolean {
  if (status?.enabled !== true) return false
  return status.provider === "codex" || status.apiKeyConfigured
}
