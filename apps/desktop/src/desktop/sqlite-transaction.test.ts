import { describe, expect, it } from "vitest"
import { createQueuedTransaction } from "./sqlite-transaction"

class FakeDatabase {
  inTransaction = false
  queries: string[] = []

  async execute(query: string): Promise<{ rowsAffected: number }> {
    this.queries.push(query)

    if (query === "begin") {
      if (this.inTransaction) {
        throw new Error("cannot start a transaction within a transaction")
      }
      this.inTransaction = true
    }

    if (query === "commit" || query === "rollback") {
      this.inTransaction = false
    }

    return { rowsAffected: 0 }
  }
}

describe("createQueuedTransaction", () => {
  it("serializes overlapping transactions on the same database connection", async () => {
    const db = new FakeDatabase()
    const transaction = createQueuedTransaction<FakeDatabase>()
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
    expect(db.queries).toEqual(["begin", "commit", "begin", "commit"])
  })

  it("releases the queue after rolling back a failed transaction", async () => {
    const db = new FakeDatabase()
    const transaction = createQueuedTransaction<FakeDatabase>()

    await expect(
      transaction(db, async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    await expect(transaction(db, async () => "next")).resolves.toBe("next")
    expect(db.queries).toEqual(["begin", "rollback", "begin", "commit"])
  })
})

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition.")
}
