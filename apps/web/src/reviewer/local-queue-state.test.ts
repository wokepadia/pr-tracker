import { describe, expect, it } from "vitest"
import {
  applyUserBucketItemOrder,
  bucketIdForLocalQueueItem,
  canMuteLocalQueueItem,
  canPinLocalQueueItem,
  canSnoozeLocalQueueItem,
  createEmptyUserBucketItemOrder,
  defaultBucketIdForWorkflowLane,
  loadLocalQueueState,
  loadUserBucketItemOrder,
  loadUserBucketLabels,
  saveLocalQueueState,
  saveUserBucketItemOrder,
  saveUserBucketLabels,
  userBucketLabelFromId,
} from "./local-queue-state"

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
        }),
    }

    expect(loadLocalQueueState(storage)).toEqual({
      pr_1: { pinned: true },
      pr_2: { muted: true },
    })
  })

  it("loads persisted user bucket assignments", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          pr_1: { bucketId: "reviewing" },
          pr_2: { bucketId: "waiting", pinned: true },
        }),
    }

    expect(loadLocalQueueState(storage)).toEqual({
      pr_1: { bucketId: "reviewing" },
      pr_2: { bucketId: "waiting", pinned: true },
    })
  })

  it("normalizes conflicting persisted local states", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          pr_1: { snoozed: true, pinned: true, muted: true },
          pr_2: { pinned: true, muted: true },
          pr_3: { pinned: true },
        }),
    }

    expect(loadLocalQueueState(storage)).toEqual({
      pr_1: { snoozed: true },
      pr_2: { muted: true },
      pr_3: { pinned: true },
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

  it("maps workflow lanes to default user buckets", () => {
    expect(defaultBucketIdForWorkflowLane("needs_review")).toBe("inbox")
    expect(defaultBucketIdForWorkflowLane("updated_since_review")).toBe("inbox")
    expect(defaultBucketIdForWorkflowLane("waiting_on_author")).toBe("waiting")
    expect(defaultBucketIdForWorkflowLane("approved")).toBe("done")
    expect(defaultBucketIdForWorkflowLane("caught_up")).toBe("done")
    expect(defaultBucketIdForWorkflowLane("watching")).toBe("later")

    expect(bucketIdForLocalQueueItem({ bucketId: "reviewing" }, "watching")).toBe(
      "reviewing"
    )
  })

  it("loads and saves editable bucket labels", () => {
    const labels = loadUserBucketLabels({
      getItem: () =>
        JSON.stringify({
          inbox: "Review now",
          reviewing: "",
          waiting: "Blocked",
          later: "  Later-ish  ",
          done: "Done",
          unknown: "Nope",
        }),
    })

    expect(labels).toEqual({
      inbox: "Review now",
      reviewing: "Reviewing",
      waiting: "Blocked",
      later: "Later-ish",
      done: "Done",
    })
    expect(userBucketLabelFromId(labels, "waiting")).toBe("Blocked")

    const writes: string[] = []
    saveUserBucketLabels(
      {
        setItem: (_key, value) => {
          writes.push(value)
        },
      },
      labels
    )

    expect(writes).toEqual([JSON.stringify(labels)])
  })

  it("loads and saves user bucket item order", () => {
    const order = loadUserBucketItemOrder({
      getItem: () =>
        JSON.stringify({
          inbox: ["pr_2", "pr_1", "pr_2", "", 42],
          reviewing: ["pr_3"],
          waiting: "not an array",
          later: ["pr_4"],
          done: [],
          unknown: ["pr_5"],
        }),
    })

    expect(order).toEqual({
      inbox: ["pr_2", "pr_1"],
      reviewing: ["pr_3"],
      waiting: [],
      later: ["pr_4"],
      done: [],
    })

    const writes: string[] = []
    saveUserBucketItemOrder(
      {
        setItem: (_key, value) => {
          writes.push(value)
        },
      },
      order
    )

    expect(writes).toEqual([JSON.stringify(order)])
  })

  it("recovers from missing or malformed user bucket item order", () => {
    expect(loadUserBucketItemOrder({ getItem: () => null })).toEqual(
      createEmptyUserBucketItemOrder()
    )
    expect(loadUserBucketItemOrder({ getItem: () => "not json" })).toEqual(
      createEmptyUserBucketItemOrder()
    )
    expect(loadUserBucketItemOrder({ getItem: () => JSON.stringify([]) })).toEqual(
      createEmptyUserBucketItemOrder()
    )
  })

  it("applies user bucket item order and appends new items", () => {
    const items = [{ id: "pr_1" }, { id: "pr_2" }, { id: "pr_3" }]
    const order = {
      ...createEmptyUserBucketItemOrder(),
      inbox: ["missing", "pr_2", "pr_1"],
    }

    expect(applyUserBucketItemOrder(items, "inbox", order)).toEqual([
      { id: "pr_2" },
      { id: "pr_1" },
      { id: "pr_3" },
    ])
  })

  it("allows only one hiding state to control local triage", () => {
    expect(canSnoozeLocalQueueItem(undefined)).toBe(true)
    expect(canPinLocalQueueItem({ pinned: true })).toBe(true)
    expect(canMuteLocalQueueItem(undefined)).toBe(true)

    expect(canSnoozeLocalQueueItem({ snoozed: true })).toBe(false)
    expect(canPinLocalQueueItem({ snoozed: true })).toBe(false)
    expect(canMuteLocalQueueItem({ snoozed: true })).toBe(false)

    expect(canSnoozeLocalQueueItem({ muted: true })).toBe(false)
    expect(canPinLocalQueueItem({ muted: true })).toBe(false)
    expect(canMuteLocalQueueItem({ muted: true })).toBe(false)
  })
})
