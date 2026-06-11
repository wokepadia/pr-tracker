import { describe, expect, it } from "vitest"

import {
  defaultAiModel,
  isAiModeActive,
  normalizeAiModel,
  normalizeStoredAiSettings,
} from "./ai-settings"

describe("normalizeStoredAiSettings", () => {
  it("defaults to disabled with the default model", () => {
    expect(normalizeStoredAiSettings(undefined)).toEqual({
      enabled: false,
      model: defaultAiModel,
      apiKeyConfigured: false,
    })
  })

  it("keeps stored values when valid", () => {
    expect(
      normalizeStoredAiSettings({
        enabled: true,
        model: "openai/gpt-5.2",
        apiKeyConfigured: true,
      })
    ).toEqual({
      enabled: true,
      model: "openai/gpt-5.2",
      apiKeyConfigured: true,
    })
  })

  it("treats non-boolean flags as off", () => {
    expect(
      normalizeStoredAiSettings({ enabled: "yes", apiKeyConfigured: 1 })
    ).toEqual({
      enabled: false,
      model: defaultAiModel,
      apiKeyConfigured: false,
    })
  })
})

describe("normalizeAiModel", () => {
  it("falls back to the default model for blank values", () => {
    expect(normalizeAiModel("")).toBe(defaultAiModel)
    expect(normalizeAiModel("   ")).toBe(defaultAiModel)
    expect(normalizeAiModel(undefined)).toBe(defaultAiModel)
  })

  it("trims a custom model id", () => {
    expect(normalizeAiModel("  qwen/qwen3-coder ")).toBe("qwen/qwen3-coder")
  })
})

describe("isAiModeActive", () => {
  it("requires both the toggle and a configured key", () => {
    expect(isAiModeActive(undefined)).toBe(false)
    expect(isAiModeActive({ enabled: true, apiKeyConfigured: false })).toBe(
      false
    )
    expect(isAiModeActive({ enabled: false, apiKeyConfigured: true })).toBe(
      false
    )
    expect(isAiModeActive({ enabled: true, apiKeyConfigured: true })).toBe(true)
  })
})
