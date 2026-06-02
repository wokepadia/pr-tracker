import { describe, expect, it } from "vitest"
import { loadLocalQueueState, saveLocalQueueState } from "./local-queue-state"

describe("local queue state", () => {
  it("loads persisted snoozed pull requests", () => {
    const storage = {
      getItem: () => JSON.stringify({ pr_1: "snoozed" }),
    }

    expect(loadLocalQueueState(storage)).toEqual({ pr_1: "snoozed" })
  })

  it("drops unknown persisted state values", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          pr_1: "snoozed",
          pr_2: "muted",
          pr_3: null,
        }),
    }

    expect(loadLocalQueueState(storage)).toEqual({ pr_1: "snoozed" })
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

    saveLocalQueueState(storage, { pr_1: "snoozed" })

    expect(writes).toEqual([JSON.stringify({ pr_1: "snoozed" })])
  })
})
