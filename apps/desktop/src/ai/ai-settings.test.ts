import { describe, expect, it } from "vitest"

import {
  defaultAiModels,
  isAiModeActive,
  normalizeAiModel,
  normalizeStoredAiSettings,
} from "./ai-settings"

describe("normalizeStoredAiSettings", () => {
  it("defaults to disabled OpenRouter with the default model", () => {
    expect(normalizeStoredAiSettings(undefined)).toEqual({
      enabled: false,
      provider: "openrouter",
      model: defaultAiModels.openrouter,
      apiKeyConfigured: false,
    })
  })

  it("keeps stored values when valid", () => {
    expect(
      normalizeStoredAiSettings({
        enabled: true,
        provider: "codex",
        model: "gpt-5.5-mini",
        apiKeyConfigured: true,
      })
    ).toEqual({
      enabled: true,
      provider: "codex",
      model: "gpt-5.5-mini",
      apiKeyConfigured: true,
    })
  })

  it("defaults the model per provider", () => {
    expect(normalizeStoredAiSettings({ provider: "codex" }).model).toBe(
      defaultAiModels.codex
    )
    expect(normalizeStoredAiSettings({ provider: "bogus" }).provider).toBe(
      "openrouter"
    )
  })

  it("treats non-boolean flags as off", () => {
    expect(
      normalizeStoredAiSettings({ enabled: "yes", apiKeyConfigured: 1 })
    ).toEqual({
      enabled: false,
      provider: "openrouter",
      model: defaultAiModels.openrouter,
      apiKeyConfigured: false,
    })
  })
})

describe("normalizeAiModel", () => {
  it("falls back to the provider's default model for blank values", () => {
    expect(normalizeAiModel("", "openrouter")).toBe(defaultAiModels.openrouter)
    expect(normalizeAiModel("   ", "codex")).toBe(defaultAiModels.codex)
    expect(normalizeAiModel(undefined, "openrouter")).toBe(
      defaultAiModels.openrouter
    )
  })

  it("trims a custom model id", () => {
    expect(normalizeAiModel("  qwen/qwen3-coder ", "openrouter")).toBe(
      "qwen/qwen3-coder"
    )
  })
})

describe("isAiModeActive", () => {
  it("requires the toggle plus a key for OpenRouter", () => {
    expect(isAiModeActive(undefined)).toBe(false)
    expect(
      isAiModeActive({
        enabled: true,
        provider: "openrouter",
        apiKeyConfigured: false,
      })
    ).toBe(false)
    expect(
      isAiModeActive({
        enabled: false,
        provider: "openrouter",
        apiKeyConfigured: true,
      })
    ).toBe(false)
    expect(
      isAiModeActive({
        enabled: true,
        provider: "openrouter",
        apiKeyConfigured: true,
      })
    ).toBe(true)
  })

  it("requires only the toggle for Codex", () => {
    expect(
      isAiModeActive({
        enabled: true,
        provider: "codex",
        apiKeyConfigured: false,
      })
    ).toBe(true)
    expect(
      isAiModeActive({
        enabled: false,
        provider: "codex",
        apiKeyConfigured: false,
      })
    ).toBe(false)
  })
})
