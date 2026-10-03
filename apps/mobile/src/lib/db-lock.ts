/**
 * One transaction at a time, per database file.
 *
 * `expo-sqlite`'s `withTransactionAsync` is a bare `BEGIN` / `COMMIT` on the
 * *shared* connection — its own documentation says so, and points at
 * `withExclusiveTransactionAsync` "if you worry about the order of execution".
 * Nothing in it prevents a second caller from issuing `BEGIN` while the first
 * transaction is still open, and SQLite answers that with "cannot start a
 * transaction within a transaction". The damage is not the error message:
 *
 *  1. The second call's own `catch` runs `ROLLBACK`, which aborts the **first**
 *     caller's transaction, discarding rows it had already written.
 *  2. The first caller's remaining statements then run in autocommit mode, so
 *     they land on disk anyway — outside the transaction that was supposed to
 *     make them all-or-nothing.
 *  3. Its final `COMMIT` fails ("no transaction is active") and it reports a
 *     failure, having half-written the data.
 *
 * On `receipts.db` that is genuinely reachable rather than theoretical, because
 * one of the transactional writers runs in the **background**:
 * `markPaymentProofSynced` is called from the sync pass, which fires on a
 * 60-second heartbeat and after every write. A driver who photographs a GCash
 * payment and then starts the next receipt is doing exactly the two things that
 * collide, and the wreckage — `receipt_items` rows whose receipt header was
 * rolled out from under them — is invisible until someone reads the receipt
 * back.
 *
 * So every transaction goes through here instead, and waits for the previous
 * one on the same database to finish. `withExclusiveTransactionAsync` was the
 * other candidate and was not used: it opens a *second* connection, which under
 * WAL means every ordinary write on the main connection gets `SQLITE_BUSY` for
 * the duration — trading a rare collision for a common one, and requiring every
 * statement inside a transaction to be rewritten against the `Transaction`
 * object it hands back.
 *
 * Statements issued *outside* a transaction can still interleave into an open
 * one; that is harmless here and deliberately not serialised. The only writes
 * that do it are the sync pass's `sync_state` marks, and the worst case is that
 * one is rolled back with a user transaction that failed — the row stays
 * `'pending'` and uploads again, which costs nothing, because every upload is a
 * `setDoc` at an id the phone chose.
 */

/** The slice of `SQLiteDatabase` this needs, so the helper stays import-free. */
type TransactionalDatabase = {
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
};

/**
 * The tail of each database's queue, keyed by database name. At most one entry
 * per `*-db.ts` module, and each is replaced rather than appended to, so this
 * doesn't grow.
 *
 * Every stored promise is a *settled-either-way* one — see below.
 */
const queues = new Map<string, Promise<void>>();

/**
 * Runs `task` inside a transaction, once every transaction queued before it on
 * the same `key` has finished.
 *
 * `key` is the database file's name (`'receipts.db'`, `'stock.db'`) — queues are
 * per file, so a receipt being saved never waits on the ledger.
 *
 * Rejects exactly as `withTransactionAsync` would, so callers keep their
 * existing error handling: a failure still rolls the transaction back and still
 * reaches the caller's retry prompt.
 */
export function runTransaction(
  key: string,
  db: TransactionalDatabase,
  task: () => Promise<void>
): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve();

  // `previous` is always a promise that resolves, never one that rejects (see
  // the `.catch` below), so this `.then` is guaranteed to run. A transaction
  // that fails must not stop the ones queued behind it — those are usually a
  // different user action entirely, and the failure has already been reported
  // to whoever asked for it.
  const result = previous.then(() => db.withTransactionAsync(task));

  // What is *stored* swallows the rejection; what is *returned* keeps it. Both
  // are needed: without the swallow, one failed save would leave a rejected
  // promise as the queue's tail and every later transaction would inherit it.
  queues.set(
    key,
    result.then(
      () => {},
      () => {}
    )
  );

  return result;
}
