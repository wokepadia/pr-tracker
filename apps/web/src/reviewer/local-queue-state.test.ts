import { describe, expect, it } from "vitest"
import { loadLocalQueueState, saveLocalQueueState } from "./local-queue-state"

describe("local queue state", () => {
  it("loads persisted snoozed pull requests", () => {
    const storage = {
      getItem: () => JSON.stringify({ pr_1: { snoozed: true } }),
    }

    expect(loadLocalQueueState(storage)).toEqual({ pr_1: { snoozed: true } })
  })

  it("loads old persisted snoozed values", () => {
    const storage = {
      getItem: () => JSON.stringify({ pr_1: "snoozed" }),
    }

    expect(loadLocalQueueState(storage)).toEqual({ pr_1: { snoozed: true } })
  })

  it("loads persisted pin and mute states", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          pr_1: { pinned: true },
          pr_2: { muted: true },
          pr_3: { pinned: true, muted: true },
        }),
    }

    expect(loadLocalQueueState(storage)).toEqual({
      pr_1: { pinned: true },
      pr_2: { muted: true },
      pr_3: { pinned: true, muted: true },
    })
  })

  it("drops unknown or inactive persisted state values", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          pr_1: { snoozed: true },
          pr_2: "muted",
          pr_3: null,
          pr_4: { pinned: false },
          pr_5: { muted: "true" },
        }),
    }

    expect(loadLocalQueueState(storage)).toEqual({ pr_1: { snoozed: true } })
  })

  it("recovers from missing or malformed persisted state", () => {
    expect(loadLocalQueueState({ getItem: () => null })).toEqual({})
    expect(loadLocalQueueState({ getItem: () => "not json" })).toEqual({})
    expect(loadLocalQueueState({ getItem: () => JSON.stringify([]) })).toEqual(
      {}
    )
  })

  it("persists the current local queue state", () => {
    const writes: string[] = []
    const storage = {
      setItem: (_key: string, value: string) => {
        writes.push(value)
      },
    }

    saveLocalQueueState(storage, { pr_1: { snoozed: true, pinned: true } })

    expect(writes).toEqual([
      JSON.stringify({ pr_1: { snoozed: true, pinned: true } }),
    ])
  })
})
