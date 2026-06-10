import { describe, expect, it } from "vitest"
import { createQueuedTransaction } from "./sqlite-transaction"

describe("createQueuedTransaction", () => {
  it("serializes overlapping write sections", async () => {
    const db = {}
    const transaction = createQueuedTransaction<typeof db>()
    const events: string[] = []
    let finishFirstTransaction: () => void = () => undefined

    const firstTransaction = transaction(db, async () => {
      events.push("first:start")
      await new Promise<void>((resolve) => {
        finishFirstTransaction = resolve
      })
      events.push("first:end")
      return "first"
    })
    const secondTransaction = transaction(db, async () => {
      events.push("second:start")
      return "second"
    })

    await waitFor(() => events.includes("first:start"))
    expect(events).toEqual(["first:start"])

    finishFirstTransaction()

    await expect(Promise.all([firstTransaction, secondTransaction])).resolves.toEqual([
      "first",
      "second",
    ])
    expect(events).toEqual(["first:start", "first:end", "second:start"])
  })

  it("releases the queue after a failed write section", async () => {
    const db = {}
    const transaction = createQueuedTransaction<typeof db>()

    await expect(
      transaction(db, async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    await expect(transaction(db, async () => "next")).resolves.toBe("next")
  })
})

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition.")
}
