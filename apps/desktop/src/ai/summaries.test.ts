import { describe, expect, it } from "vitest"

import {
  buildCatchUpDigestPrompt,
  buildPrSummaryPrompt,
  buildThreadStatePrompt,
  normalizeCatchUpDigestContent,
  normalizePrSummaryContent,
  normalizeThreadStateContent,
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

describe("buildCatchUpDigestPrompt", () => {
  const baseInput = {
    repository: "acme/web",
    number: 42,
    title: "Add webhook retries",
    lastSeenAt: "2026-06-10T08:00:00.000Z",
    events: [
      {
        type: "review",
        actor: "sam",
        title: "sam requested changes",
        body: "Please add a test for the retry path.",
        occurredAt: "2026-06-10T09:00:00.000Z",
      },
      {
        type: "commit",
        actor: "maya",
        title: "Add retry test",
        occurredAt: "2026-06-10T10:00:00.000Z",
      },
    ],
  }

  it("lists the delta with the last-seen anchor", () => {
    const { system, user } = buildCatchUpDigestPrompt(baseInput)

    expect(system).toContain("never invent events")
    expect(user).toContain(
      "The reviewer last caught up at 2026-06-10T08:00:00.000Z."
    )
    expect(user).toContain(
      "- [2026-06-10T09:00:00.000Z] review by sam: sam requested changes"
    )
    expect(user).toContain("  Please add a test for the retry path.")
    expect(user).toContain(
      "- [2026-06-10T10:00:00.000Z] commit by maya: Add retry test"
    )
  })

  it("notes when the reviewer never caught up before", () => {
    const { user } = buildCatchUpDigestPrompt({
      ...baseInput,
      lastSeenAt: undefined,
    })
    expect(user).toContain(
      "The reviewer has not caught up on this pull request before."
    )
  })

  it("keeps only the newest events past the cap and says so", () => {
    const events = Array.from({ length: 60 }, (_value, index) => ({
      type: "comment",
      actor: "ari",
      title: `comment ${index}`,
      occurredAt: `2026-06-10T0${index % 10}:00:00.000Z`,
    }))
    const { user } = buildCatchUpDigestPrompt({ ...baseInput, events })

    expect(user).toContain("(10 earlier events omitted)")
    expect(user).not.toContain("comment 9\n")
    expect(user).toContain("comment 59")
  })
})

describe("normalizeCatchUpDigestContent", () => {
  it("trims bullets and caps them at six", () => {
    expect(
      normalizeCatchUpDigestContent({
        narrative: " Things moved. ",
        bullets: [" a ", "", "b", 3, "c", "d", "e", "f", "g"],
      })
    ).toEqual({
      narrative: "Things moved.",
      bullets: ["a", "b", "c", "d", "e", "f"],
    })
  })

  it("throws when the narrative is missing", () => {
    expect(() => normalizeCatchUpDigestContent({ bullets: [] })).toThrow(
      "The model response was missing the digest narrative."
    )
  })
})

describe("buildThreadStatePrompt", () => {
  it("lists thread facts and discussion excerpts", () => {
    const { system, user } = buildThreadStatePrompt({
      repository: "acme/web",
      number: 42,
      title: "Add webhook retries",
      viewerLogin: "viewer",
      threads: [
        {
          filePath: "src/webhooks.ts",
          line: 44,
          isResolved: false,
          isOutdated: true,
          participants: ["viewer", "sam"],
          lastActorLogin: "sam",
          lastActivityAt: "2026-06-10T09:00:00.000Z",
        },
        {
          isResolved: true,
          isOutdated: false,
          participants: [],
          lastActivityAt: "2026-06-09T09:00:00.000Z",
        },
      ],
      comments: [
        {
          actor: "sam",
          body: "Should this retry on 5xx only?",
          occurredAt: "2026-06-10T09:00:00.000Z",
        },
      ],
    })

    expect(system).toContain("Never invent file paths")
    expect(user).toContain("The reviewer reading this summary is viewer.")
    expect(user).toContain(
      "- src/webhooks.ts:44 — unresolved, outdated by new commits, participants: viewer, sam, last reply by sam at 2026-06-10T09:00:00.000Z"
    )
    expect(user).toContain("- (no file recorded) — resolved")
    expect(user).toContain("Should this retry on 5xx only?")
  })

  it("notes when no comment text is cached", () => {
    const { user } = buildThreadStatePrompt({
      repository: "acme/web",
      number: 42,
      title: "Add webhook retries",
      viewerLogin: "viewer",
      threads: [
        {
          filePath: "src/a.ts",
          isResolved: false,
          isOutdated: false,
          participants: ["sam"],
          lastActivityAt: "2026-06-10T09:00:00.000Z",
        },
      ],
      comments: [],
    })
    expect(user).toContain("(no comment text cached locally)")
  })
})

describe("normalizeThreadStateContent", () => {
  it("drops notes whose file is not a real thread path", () => {
    expect(
      normalizeThreadStateContent(
        {
          overall: "One thread is still open.",
          threadNotes: [
            { file: "src/webhooks.ts", note: "Sam asked about 5xx retries." },
            { file: "invented/path.ts", note: "Hallucinated." },
            { file: "src/webhooks.ts", note: "  " },
          ],
        },
        ["src/webhooks.ts"]
      )
    ).toEqual({
      overall: "One thread is still open.",
      threadNotes: [
        { file: "src/webhooks.ts", note: "Sam asked about 5xx retries." },
      ],
    })
  })

  it("throws when the overall summary is missing", () => {
    expect(() => normalizeThreadStateContent({}, [])).toThrow(
      "The model response was missing the thread overview."
    )
  })
})
