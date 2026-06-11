import { describe, expect, it } from "vitest"

import {
  buildPrSummaryPrompt,
  normalizePrSummaryContent,
  type PrSummaryPromptInput,
} from "./summaries"

function promptInput(
  overrides: Partial<PrSummaryPromptInput> = {}
): PrSummaryPromptInput {
  return {
    repository: "acme/web",
    number: 42,
    title: "Add webhook retries",
    body: "Retries webhook deliveries with backoff.",
    authorLogin: "maya",
    state: "open",
    isDraft: false,
    additions: 120,
    deletions: 30,
    changedFiles: 2,
    files: [
      {
        path: "src/webhooks.ts",
        status: "modified",
        additions: 100,
        deletions: 20,
        patch: "@@ -1 +1 @@\n-send()\n+sendWithRetry()",
      },
      {
        path: "assets/logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
      },
    ],
    ...overrides,
  }
}

describe("buildPrSummaryPrompt", () => {
  it("includes metadata, description, and per-file patches", () => {
    const { system, user } = buildPrSummaryPrompt(promptInput())

    expect(system).toContain("never invent files")
    expect(user).toContain("Repository: acme/web")
    expect(user).toContain("Pull request #42: Add webhook retries")
    expect(user).toContain("Size: +120 / -30 across 2 files")
    expect(user).toContain("Retries webhook deliveries with backoff.")
    expect(user).toContain("--- src/webhooks.ts (modified, +100 / -20)")
    expect(user).toContain("+sendWithRetry()")
    expect(user).toContain("--- assets/logo.png (added, +0 / -0)")
    expect(user).toContain("(no text patch available)")
  })

  it("is deterministic for identical input", () => {
    expect(buildPrSummaryPrompt(promptInput())).toEqual(
      buildPrSummaryPrompt(promptInput())
    )
  })

  it("truncates oversized patches and stops past the diff budget", () => {
    const bigPatch = "x".repeat(20_000)
    const manyFiles = Array.from({ length: 20 }, (_value, index) => ({
      path: `src/big-${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: bigPatch,
    }))

    const { user } = buildPrSummaryPrompt(promptInput({ files: manyFiles }))

    expect(user).toContain("(truncated)")
    expect(user).toContain("(patch omitted: diff budget reached)")
    // Per-file cap (3.5k) times the total budget (48k) keeps the prompt
    // bounded well under the raw 400k input.
    expect(user.length).toBeLessThan(80_000)
    // Every file still appears by name even when its patch is omitted.
    expect(user).toContain("--- src/big-19.ts")
  })

  it("handles a missing description", () => {
    const { user } = buildPrSummaryPrompt(promptInput({ body: undefined }))
    expect(user).toContain("Description:\n(none)")
  })
})

describe("normalizePrSummaryContent", () => {
  it("trims and keeps valid key changes", () => {
    expect(
      normalizePrSummaryContent({
        overview: " Adds retries. ",
        keyChanges: [
          { file: " src/webhooks.ts ", description: " Retry loop. " },
          { file: "", description: "dropped" },
          { file: "x.ts" },
          "garbage",
        ],
      })
    ).toEqual({
      overview: "Adds retries.",
      keyChanges: [{ file: "src/webhooks.ts", description: "Retry loop." }],
    })
  })

  it("throws when the overview is missing", () => {
    expect(() => normalizePrSummaryContent({ keyChanges: [] })).toThrow(
      "The model response was missing the summary overview."
    )
    expect(() => normalizePrSummaryContent({ overview: "  " })).toThrow()
  })
})
