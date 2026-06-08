export interface QueuedTransactionDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>
}

export function createQueuedTransaction<Db extends QueuedTransactionDatabase>() {
  let transactionQueue: Promise<void> = Promise.resolve()

  return async function transaction<T>(
    db: Db,
    callback: () => Promise<T>
  ): Promise<T> {
    const previousTransaction = transactionQueue
    let releaseTransaction: () => void = () => undefined
    transactionQueue = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })

    await previousTransaction
    try {
      await db.execute("begin")
      try {
        const result = await callback()
        await db.execute("commit")
        return result
      } catch (error) {
        await db.execute("rollback").catch(() => undefined)
        throw error
      }
    } finally {
      releaseTransaction()
    }
  }
}
