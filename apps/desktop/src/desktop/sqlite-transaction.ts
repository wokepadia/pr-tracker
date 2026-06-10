export function createQueuedTransaction<Db>() {
  let transactionQueue: Promise<void> = Promise.resolve()

  return async function transaction<T>(
    _db: Db,
    callback: () => Promise<T>
  ): Promise<T> {
    const previousTransaction = transactionQueue
    let releaseTransaction: () => void = () => undefined
    transactionQueue = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })

    await previousTransaction
    try {
      return await callback()
    } finally {
      releaseTransaction()
    }
  }
}
