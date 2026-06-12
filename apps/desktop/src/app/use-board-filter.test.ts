import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

function stubWindowStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const writes: string[] = []
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
        writes.push(value)
      },
    },
  })
  return { store, writes }
}

async function loadStore() {
  vi.resetModules()
  return import("./use-board-filter")
}

describe("board filter store", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads the persisted query on first access", async () => {
    stubWindowStorage({
      "pr-tracker:github-review-query:v1": "is:open user-review-requested:@me",
    })
    const { getBoardFilterQuery } = await loadStore()

    expect(getBoardFilterQuery()).toBe("is:open user-review-requested:@me")
  })

  it("trims and persists the applied query", async () => {
    const { store } = stubWindowStorage()
    const { getBoardFilterQuery, setBoardFilterQuery } = await loadStore()
    expect(getBoardFilterQuery()).toBe("")

    setBoardFilterQuery("  repo:acme/api  ")

    expect(getBoardFilterQuery()).toBe("repo:acme/api")
    expect(store.get("pr-tracker:github-review-query:v1")).toBe(
      "repo:acme/api"
    )
  })

  it("ignores applies that do not change the query", async () => {
    const { writes } = stubWindowStorage({
      "pr-tracker:github-review-query:v1": "repo:acme/api",
    })
    const { setBoardFilterQuery } = await loadStore()

    setBoardFilterQuery("repo:acme/api")

    expect(writes).toEqual([])
  })
})
