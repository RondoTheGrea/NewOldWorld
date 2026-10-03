import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { runTransaction } from '@/lib/db-lock';
import { generateId } from '@/lib/id';
import type { Batch, BatchItem, BatchKind, StockState } from '@/lib/stock-types';

// The truck's inventory ledger: an append-only log (initial count + batches
// added since), never a single mutable number. That's what makes it safe to
// trust once receipts start subtracting from it — nothing can quietly
// overwrite a past entry, and a half-written batch can't happen because every
// multi-row write goes through runTransaction (lib/db-lock.ts) below, which
// wraps it in a transaction *and* keeps two of them from overlapping.
//
// Native only (iOS/Android) — this file is deliberately never imported into
// the web bundle. expo-sqlite's web build statically imports a .wasm asset
// that needs Metro config this app doesn't carry, so even having `import
// 'expo-sqlite'` reachable from the web bundle graph fails the whole build,
// not just this feature. stock-db.web.ts is the platform-matched stub Metro
// picks instead when bundling for web — keep the split.

let dbPromise: Promise<SQLiteDatabase> | null = null;

function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabaseAsync('stock.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS draft_stock (
          bread_type_id TEXT PRIMARY KEY,
          quantity INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_batches (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('initial','addition','sale')),
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_batch_items (
          batch_id TEXT NOT NULL REFERENCES stock_batches(id),
          bread_type_id TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          PRIMARY KEY (batch_id, bread_type_id)
        );
        CREATE TABLE IF NOT EXISTS stock_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          draft_saved_at INTEGER,
          finalized_at INTEGER
        );
        INSERT OR IGNORE INTO stock_meta (id) VALUES (1);
      `);
      await migrateSaleBatchKind(db);
      await migrateLedgerIndexes(db);
      await migrateSyncState(db);
      await migrateSaleReceiptLink(db);
      await migrateRunScope(db);
      await migrateSaleReceiptIndex(db);
      await migrateSyncAttempts(db);
      await migrateVoidBatchKind(db);
      return db;
    });
    dbPromise = dbPromise.catch((error: unknown) => {
      // Never leave a *rejected* promise cached here. It would be handed to
      // every later call, so a single failed open (storage full, database
      // locked at a bad moment) would keep failing for the whole life of the
      // app and no "Try again" button could ever recover it. Clearing the
      // cache means the next call genuinely reopens the database.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/**
 * A stock_batches table created before the 'sale' kind existed still carries
 * the old CHECK('initial','addition') constraint — CREATE TABLE IF NOT EXISTS
 * above is a no-op once the table already exists, and SQLite can't ALTER a
 * CHECK constraint in place. So on first run after this update, rebuild the
 * table under the wider constraint instead of forcing a manual reset on
 * existing dev/emulator installs. Gated by PRAGMA user_version so it only
 * runs once.
 */
async function migrateSaleBatchKind(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 1) return;

  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE TABLE stock_batches_v2 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('initial','addition','sale')),
        created_at INTEGER NOT NULL
      );
      INSERT INTO stock_batches_v2 SELECT id, kind, created_at FROM stock_batches;
      DROP TABLE stock_batches;
      ALTER TABLE stock_batches_v2 RENAME TO stock_batches;
      PRAGMA user_version = 1;
    `);
  });
}

/**
 * Indexes the ledger's read patterns need. Not in the CREATE TABLE block
 * above, because that block is a no-op on a database that already exists —
 * every install created before this update would have kept scanning.
 *
 * - `idx_stock_batch_items_totals` covers the SUM/GROUP BY in loadStockState.
 *   Both columns are in the index, so SQLite answers the whole query from the
 *   index without touching the table.
 * - `idx_stock_batches_kind_created` turns the history query (initial +
 *   additions, sales excluded) into a range scan instead of a full scan of a
 *   table that gains a row per finalized receipt.
 */
async function migrateLedgerIndexes(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 2) return;

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_stock_batch_items_totals
      ON stock_batch_items(bread_type_id, quantity);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_kind_created
      ON stock_batches(kind, created_at);
    PRAGMA user_version = 2;
  `);
}

/**
 * Adds the column that tracks whether an entry has reached Firestore yet.
 *
 * A flag on the row itself, rather than a separate outbox table holding a copy
 * of what to upload: a copy can drift from the row it describes, and the row is
 * always the current truth. See lib/sync.ts for the drain loop that reads it.
 *
 * Entries written *before* this column existed are marked `'legacy'`, not
 * `'pending'`. They are genuinely un-uploaded, but they belong to no run — the
 * run concept didn't exist when they were written — so sweeping them into
 * whichever run happens to be open now would file old test data under today's
 * truck. `'legacy'` says that plainly instead of pretending they synced.
 *
 * The index is partial (`WHERE sync_state = 'pending'`), the same trick
 * idx_receipts_draft uses: the ledger gains a row per finalized receipt
 * forever, but the set still waiting to upload is small, so "what's left to
 * send?" stays cheap no matter how long the truck has been running.
 */
async function migrateSyncState(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 3) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(stock_batches)');
  if (!columns.some((column) => column.name === 'sync_state')) {
    await db.execAsync("ALTER TABLE stock_batches ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending'");
    await db.runAsync("UPDATE stock_batches SET sync_state = 'legacy'");
  }
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_stock_batches_pending
      ON stock_batches(created_at) WHERE sync_state = 'pending';
    PRAGMA user_version = 3;
  `);
}

/**
 * Links a `'sale'` entry back to the receipt that produced it.
 *
 * Nullable and only ever set on sales. Without it the uploaded ledger and the
 * uploaded receipts can be compared only in aggregate — "the totals don't
 * match" — where with it the dashboard can name the receipt whose stock
 * deduction went missing, which is the failure finalize() is documented to
 * allow (see context/receipts.tsx).
 */
async function migrateSaleReceiptLink(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 4) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(stock_batches)');
  if (!columns.some((column) => column.name === 'receipt_id')) {
    await db.execAsync('ALTER TABLE stock_batches ADD COLUMN receipt_id TEXT');
  }
  await db.execAsync('PRAGMA user_version = 4');
}

/**
 * Ties every ledger entry to the run it was written in.
 *
 * This is what lets a truck go out twice in one day. Before it, "the stock on
 * the truck" was the sum of the whole table, so a second run could only start
 * clean by *deleting* the first run's entries — which would have thrown away
 * anything not yet uploaded. Scoping the sum instead means the second run
 * starts empty because it genuinely has no entries yet, and the first run's
 * are still there, still counted in its own totals, still queued to upload.
 *
 * `run_id` is repeated on `stock_batch_items` rather than reached through a
 * join to `stock_batches`. The totals query is a SUM/GROUP BY over the items
 * table and the whole point of `idx_stock_batch_items_totals` is that SQLite
 * answers it from the index without touching the table; a join to fetch the run
 * would give that up on the one query that has to stay cheap as the ledger
 * grows for the life of the app.
 *
 * Rows that predate this belong to no run. Any that were still `'pending'`
 * become `'legacy'` for the same reason that migration used the word: they
 * cannot be filed under a run that never existed, and sweeping them into
 * whichever run opens next would post old test data to today's truck.
 */
async function migrateRunScope(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 5) return;

  const batchColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(stock_batches)');
  if (!batchColumns.some((column) => column.name === 'run_id')) {
    await db.execAsync('ALTER TABLE stock_batches ADD COLUMN run_id TEXT');
    await db.runAsync("UPDATE stock_batches SET sync_state = 'legacy' WHERE sync_state = 'pending'");
  }

  const itemColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(stock_batch_items)');
  if (!itemColumns.some((column) => column.name === 'run_id')) {
    await db.execAsync('ALTER TABLE stock_batch_items ADD COLUMN run_id TEXT');
  }

  const metaColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(stock_meta)');
  if (!metaColumns.some((column) => column.name === 'run_id')) {
    await db.execAsync('ALTER TABLE stock_meta ADD COLUMN run_id TEXT');
  }

  // Both indexes gain run_id as their leading column, since every read is now
  // "within this run" first. Dropped and recreated rather than added alongside:
  // the old shapes can no longer serve any query this file issues.
  await db.execAsync(`
    DROP INDEX IF EXISTS idx_stock_batch_items_totals;
    DROP INDEX IF EXISTS idx_stock_batches_kind_created;
    CREATE INDEX IF NOT EXISTS idx_stock_batch_items_run_totals
      ON stock_batch_items(run_id, bread_type_id, quantity);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_run_kind_created
      ON stock_batches(run_id, kind, created_at);
    PRAGMA user_version = 5;
  `);
}

/**
 * Lets the ledger answer "has receipt X already been deducted?".
 *
 * That question is what makes finalizing safe to repeat. Finalizing writes two
 * databases in two transactions, so a receipt can end up finalized with its
 * stock never taken off the truck — and the only honest way to tell that apart
 * from "already deducted" is to look for the entry. Without this index the
 * lookup would scan a table that gains a row per receipt forever.
 *
 * Partial (`WHERE receipt_id IS NOT NULL`) for the same reason
 * idx_stock_batches_pending is: only 'sale' entries carry a receipt, and the
 * index only ever has to serve them.
 */
async function migrateSaleReceiptIndex(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 6) return;

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_stock_batches_receipt
      ON stock_batches(receipt_id) WHERE receipt_id IS NOT NULL;
    PRAGMA user_version = 6;
  `);
}

/**
 * Counts how many times an entry's upload has failed for a reason nobody
 * recognised, so the drain can give up on it rather than retry it forever.
 *
 * No index: the column is only ever read and written by id, for the one row the
 * drain is currently on. `'blocked'` rows drop out of
 * `idx_stock_batches_pending` on their own, since it is partial on
 * `sync_state = 'pending'`.
 */
async function migrateSyncAttempts(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 7) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(stock_batches)');
  if (!columns.some((column) => column.name === 'sync_attempts')) {
    await db.execAsync('ALTER TABLE stock_batches ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0');
  }
  await db.execAsync('PRAGMA user_version = 7');
}

/**
 * Widens the kind CHECK to allow `'void'` — a voided receipt's bread going back
 * on the truck (see recordVoid).
 *
 * The same rebuild migrateSaleBatchKind did for `'sale'`, and for the same
 * reason: SQLite can't alter a CHECK constraint in place. The table has gained
 * four columns and three indexes since then, so every column is copied by name
 * and every index is recreated — DROP TABLE takes a table's indexes with it.
 * The new table is created with the columns in the order the ALTERs left them,
 * so nothing reading `SELECT *` sees a difference.
 *
 * Foreign-key enforcement is switched off around it if it happens to be on.
 * `stock_batch_items.batch_id REFERENCES stock_batches(id)`, and with
 * enforcement on, DROP TABLE is an implicit DELETE of every batch that items
 * still point at — the migration would fail and take every later app start with
 * it. expo-sqlite leaves enforcement off, so this is a guard rather than a fix;
 * it has to be outside the transaction because the pragma is a no-op inside one.
 */
async function migrateVoidBatchKind(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 8) return;

  const fkRow = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
  const enforcing = (fkRow?.foreign_keys ?? 0) === 1;
  if (enforcing) await db.execAsync('PRAGMA foreign_keys = OFF');
  try {
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        CREATE TABLE stock_batches_v3 (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('initial','addition','sale','void')),
          created_at INTEGER NOT NULL,
          sync_state TEXT NOT NULL DEFAULT 'pending',
          receipt_id TEXT,
          run_id TEXT,
          sync_attempts INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO stock_batches_v3 (id, kind, created_at, sync_state, receipt_id, run_id, sync_attempts)
          SELECT id, kind, created_at, sync_state, receipt_id, run_id, sync_attempts FROM stock_batches;
        DROP TABLE stock_batches;
        ALTER TABLE stock_batches_v3 RENAME TO stock_batches;
        CREATE INDEX IF NOT EXISTS idx_stock_batches_pending
          ON stock_batches(created_at) WHERE sync_state = 'pending';
        CREATE INDEX IF NOT EXISTS idx_stock_batches_run_kind_created
          ON stock_batches(run_id, kind, created_at);
        CREATE INDEX IF NOT EXISTS idx_stock_batches_receipt
          ON stock_batches(receipt_id) WHERE receipt_id IS NOT NULL;
        PRAGMA user_version = 8;
      `);
    });
  } finally {
    if (enforcing) await db.execAsync('PRAGMA foreign_keys = ON');
  }
}

/**
 * How many 'addition' batches the history view loads. The initial count is
 * always included on top of this, so the history always opens on "Initial
 * inventory" however long the truck has been running.
 *
 * A cap exists because history is the one part of the ledger read as whole
 * rows rather than a total, and a truck restocks a few times a day forever.
 * At a few per day this is months of history; older additions are still in the
 * database and still counted in the totals, they just aren't paged through.
 */
const HistoryAdditionLimit = 200;

/**
 * Everything the Inventory tab shows, for one run.
 *
 * Every part of it is scoped to `runId`: the draft being typed, the finalize
 * flag, the summed totals and the history. A run that has just opened therefore
 * reads back empty even though the previous run's entries are still in the
 * table — which is how "End the Day" clears the truck without deleting
 * anything that might not have uploaded yet.
 */
export async function loadStockState(runId: string): Promise<StockState> {
  const db = await getDb();

  // The draft and the finalize flag belong to whichever run last wrote them,
  // so a stale row from the previous run reads as "nothing here" rather than
  // as this run's draft.
  const metaRow = await db.getFirstAsync<{
    draft_saved_at: number | null;
    finalized_at: number | null;
  }>('SELECT draft_saved_at, finalized_at FROM stock_meta WHERE id = 1 AND run_id = ?', runId);

  const draftRows = metaRow
    ? await db.getAllAsync<{ bread_type_id: string; quantity: number }>(
        'SELECT bread_type_id, quantity FROM draft_stock'
      )
    : [];
  const draftStock: Record<string, number> = {};
  for (const row of draftRows) draftStock[row.bread_type_id] = row.quantity;

  return {
    meta: {
      draftSavedAt: metaRow?.draft_saved_at ?? null,
      finalizedAt: metaRow?.finalized_at ?? null,
    },
    draftStock,
    totals: await readRunTotals(db, runId),
    batches: await loadHistoryBatches(db, runId),
  };
}

/**
 * What the run is carrying, per bread type — the ledger summed in SQL.
 *
 * Summed here, not by loading the ledger. This used to read every batch and
 * every batch item into memory and add them up in JS — and since recordSale
 * appends an entry per finalized receipt, that was a table which grew by
 * hundreds of rows a day and was re-read in full on every app start. This
 * returns one row per bread type no matter how long the truck has run.
 * idx_stock_batch_items_run_totals covers the filter, the grouping and the
 * summed column, so it is still answered without touching the table.
 */
async function readRunTotals(db: SQLiteDatabase, runId: string): Promise<Record<string, number>> {
  const totalRows = await db.getAllAsync<{ bread_type_id: string; total: number }>(
    'SELECT bread_type_id, SUM(quantity) AS total FROM stock_batch_items WHERE run_id = ? GROUP BY bread_type_id',
    runId
  );
  const totals: Record<string, number> = {};
  for (const row of totalRows) totals[row.bread_type_id] = row.total;
  return totals;
}

/**
 * The same totals on their own, without the draft, the meta row or the history
 * — for re-reading the count after a write whose outcome the caller can't fold
 * in by hand.
 *
 * That happens whenever finalizeStock / addBatch / recordSale come back with
 * `applied: false`. The entry is on disk, but the caller doesn't know whether
 * it was already in the running totals it holds (written in an earlier session,
 * so it arrived with loadStockState) or is missing from them (written by an
 * attempt that committed and *then* reported failure, so the retry found the
 * row already there and folded nothing in). Adding it blindly double-counts;
 * skipping it leaves the Inventory tab reading wrong until the app restarts.
 * Asking the database is the only answer that is right in both cases, and it
 * is one covered index scan — see readRunTotals.
 */
export async function loadRunTotals(runId: string): Promise<Record<string, number>> {
  const db = await getDb();
  return readRunTotals(db, runId);
}

/**
 * The initial count plus the most recent additions, oldest first — what the
 * history view shows. 'sale' entries are filtered out in SQL rather than in
 * JS: they're the bulk of the table and none of them is ever displayed.
 */
async function loadHistoryBatches(db: SQLiteDatabase, runId: string): Promise<Batch[]> {
  const batchRows = await db.getAllAsync<{ id: string; kind: BatchKind; created_at: number }>(
    `SELECT id, kind, created_at FROM stock_batches
     WHERE run_id = ?
       AND (kind = 'initial'
            OR id IN (SELECT id FROM stock_batches
                      WHERE run_id = ? AND kind = 'addition'
                      ORDER BY created_at DESC LIMIT ?))
     ORDER BY created_at ASC`,
    runId,
    runId,
    HistoryAdditionLimit
  );
  if (batchRows.length === 0) return [];

  // Items for exactly those batches, bound as one '?' per id — never spliced
  // into the SQL string. The ids are app-generated, but the rule in this
  // codebase is that no value reaches a query except as a parameter.
  const placeholders = batchRows.map(() => '?').join(', ');
  const itemRows = await db.getAllAsync<{ batch_id: string; bread_type_id: string; quantity: number }>(
    `SELECT batch_id, bread_type_id, quantity FROM stock_batch_items WHERE batch_id IN (${placeholders})`,
    ...batchRows.map((row) => row.id)
  );

  const itemsByBatch = new Map<string, BatchItem[]>();
  for (const row of itemRows) {
    const list = itemsByBatch.get(row.batch_id) ?? [];
    list.push({ breadTypeId: row.bread_type_id, quantity: row.quantity });
    itemsByBatch.set(row.batch_id, list);
  }

  return batchRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    items: itemsByBatch.get(row.id) ?? [],
    receiptId: null,
    runId,
  }));
}

/**
 * Every 'initial' and 'addition' entry for one run, oldest first — the whole
 * inventory story of a finished run, not just the most recent additions.
 *
 * Unlike loadHistoryBatches (which caps additions at HistoryAdditionLimit for
 * a live, repeatedly-opened view) this has no cap: it's read exactly once, by
 * lib/run-history.ts, at the moment a run closes, to snapshot into
 * run-history.db. A run's additions are a handful a day, so an uncapped read
 * here costs nothing.
 */
export async function loadInventoryBatchesForRun(runId: string): Promise<Batch[]> {
  const db = await getDb();
  const batchRows = await db.getAllAsync<{ id: string; kind: BatchKind; created_at: number }>(
    `SELECT id, kind, created_at FROM stock_batches
     WHERE run_id = ? AND kind IN ('initial', 'addition')
     ORDER BY created_at ASC`,
    runId
  );
  if (batchRows.length === 0) return [];

  const placeholders = batchRows.map(() => '?').join(', ');
  const itemRows = await db.getAllAsync<{ batch_id: string; bread_type_id: string; quantity: number }>(
    `SELECT batch_id, bread_type_id, quantity FROM stock_batch_items WHERE batch_id IN (${placeholders})`,
    ...batchRows.map((row) => row.id)
  );

  const itemsByBatch = new Map<string, BatchItem[]>();
  for (const row of itemRows) {
    const list = itemsByBatch.get(row.batch_id) ?? [];
    list.push({ breadTypeId: row.bread_type_id, quantity: row.quantity });
    itemsByBatch.set(row.batch_id, list);
  }

  return batchRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    items: itemsByBatch.get(row.id) ?? [],
    receiptId: null,
    runId,
  }));
}

/**
 * A draft count with every value forced to a whole number of loaves, never
 * below zero. Rounds *down* and clamps rather than rejecting: a count that is
 * too low can be corrected by adding a batch, while one that is too high lets
 * bread be sold off a truck that isn't carrying it.
 */
function sanitizeCounts(quantities: Record<string, number>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [breadTypeId, quantity] of Object.entries(quantities)) {
    counts[breadTypeId] = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
  }
  return counts;
}

/**
 * Overwrites the run's draft count.
 *
 * The draft table holds one run's worth at a time, so a draft left behind by
 * the previous run is dropped the first time this run saves rather than being
 * added to. There is nothing to preserve: a draft that was never finalized is
 * scratch work that never left the phone.
 *
 * Returns the counts it actually wrote alongside the timestamp — see
 * sanitizeCounts, and the note on the return statement.
 */
export async function saveDraft(
  runId: string,
  quantities: Record<string, number>
): Promise<{ savedAt: number; counts: Record<string, number> }> {
  const db = await getDb();
  const now = Date.now();
  // The draft count is the number every receipt is measured against — it is
  // what "over inventory" means — so a negative or fractional value here would
  // let a receipt oversell the truck no matter how carefully the receipt side
  // is checked. addBatch and recordSale already drop anything that isn't a
  // positive count; this is the same rule for the initial count.
  const counts = sanitizeCounts(quantities);
  await runTransaction('stock.db', db, async () => {
    const meta = await db.getFirstAsync<{ run_id: string | null }>('SELECT run_id FROM stock_meta WHERE id = 1');
    if (meta?.run_id !== runId) {
      await db.runAsync('DELETE FROM draft_stock');
      await db.runAsync('UPDATE stock_meta SET run_id = ?, draft_saved_at = NULL, finalized_at = NULL WHERE id = 1', runId);
    }
    const breadTypeIds = Object.keys(counts);
    for (const breadTypeId of breadTypeIds) {
      await db.runAsync(
        `INSERT INTO draft_stock (bread_type_id, quantity, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(bread_type_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
        breadTypeId,
        counts[breadTypeId],
        now
      );
    }

    // Rows the payload didn't mention are dropped, so the table ends up
    // matching what was passed rather than accumulating. Upserting alone made
    // this an *add*, not the overwrite the name promises: a bread type that
    // dropped out of the draft (removed from the dashboard's catalog between
    // two saves) kept its old row, invisible on screen — the screen renders
    // from the catalog — but still read back by loadStockState on the next
    // launch and still carried into the initial count at finalize.
    if (breadTypeIds.length === 0) {
      await db.runAsync('DELETE FROM draft_stock');
    } else {
      const placeholders = breadTypeIds.map(() => '?').join(', ');
      await db.runAsync(`DELETE FROM draft_stock WHERE bread_type_id NOT IN (${placeholders})`, ...breadTypeIds);
    }

    await db.runAsync('UPDATE stock_meta SET draft_saved_at = ? WHERE id = 1', now);
  });
  // The sanitized counts, not the ones passed in — the same rule
  // updateCustomerRow follows for the value it cleaned. Handing back the input
  // would let the Inventory tab show a number the database doesn't hold, and
  // that number is what every receipt is measured against.
  return { savedAt: now, counts };
}

/**
 * Locks the draft in as this run's initial count.
 *
 * **A run can only have one.** The id is derived from the run rather than drawn
 * from generateId(), for exactly the reason saleBatchId is: finalizing sits
 * inside a retry prompt, so a write that committed and *then* reported failure
 * would, on "Try again", insert a second `'initial'` entry — and since the
 * truck's stock is the sum of its run's entries, the whole starting count would
 * silently double. A derived id makes the repeat land on the same row.
 *
 * `applied` is false when the run was already finalized; nothing is written in
 * that case, so callers must not add the returned batch to their totals again.
 */
export async function finalizeStock(
  runId: string,
  quantities: Record<string, number>
): Promise<{ batch: Batch; applied: boolean }> {
  const db = await getDb();
  const id = initialBatchId(runId);
  const now = Date.now();

  let applied = false;
  await runTransaction('stock.db', db, async () => {
    // OR IGNORE plus the changes check: the items are written only by the call
    // that created the header, so the entry is either wholly new or untouched.
    const inserted = await db.runAsync(
      'INSERT OR IGNORE INTO stock_batches (id, kind, created_at, run_id) VALUES (?, ?, ?, ?)',
      id,
      'initial',
      now,
      runId
    );
    if (inserted.changes === 0) return;
    applied = true;

    for (const [breadTypeId, quantity] of Object.entries(quantities)) {
      await db.runAsync(
        'INSERT INTO stock_batch_items (batch_id, bread_type_id, quantity, run_id) VALUES (?, ?, ?, ?)',
        id,
        breadTypeId,
        quantity,
        runId
      );
    }
    await db.runAsync('UPDATE stock_meta SET run_id = ?, finalized_at = ? WHERE id = 1', runId, now);
  });

  if (applied) {
    return {
      batch: {
        id,
        kind: 'initial',
        createdAt: now,
        items: Object.entries(quantities).map(([breadTypeId, quantity]) => ({ breadTypeId, quantity })),
        receiptId: null,
        runId,
      },
      applied: true,
    };
  }

  // Already finalized: report what is on disk, never the quantities this call
  // would have written — they may differ from what was actually locked in.
  const stored = await readBatchById(db, id);
  return {
    batch: stored ?? { id, kind: 'initial', createdAt: now, items: [], receiptId: null, runId },
    applied: false,
  };
}

/** The one `'initial'` entry a run is allowed — see finalizeStock. */
function initialBatchId(runId: string): string {
  return `initial_${runId}`;
}

/**
 * Records a delivery on top of the run's current stock.
 *
 * `entryId` is what makes a retry safe, and unlike finalizeStock and recordSale
 * it has to come from the caller. Those two have a natural key — a run has one
 * initial count, a receipt has one deduction — but two identical additions are a
 * completely ordinary thing: the same delivery of 20 loaves can genuinely happen
 * twice in a day, and nothing in the row itself distinguishes "the same batch
 * written twice" from "two batches". So the key is the *user's action*: the Save
 * button mints one id per press and hands it to every retry of that press (see
 * components/inventory-stock-modal.tsx). Two presses, two ids, two batches; one
 * press retried five times, one batch.
 *
 * Omitting it falls back to a fresh id — safe for a caller with nothing to
 * retry, but a caller inside a retry prompt must pass one.
 */
export async function addBatch(
  runId: string,
  deltas: Record<string, number>,
  entryId?: string
): Promise<{ batch: Batch; applied: boolean }> {
  const db = await getDb();
  const id = entryId ?? generateId();
  const now = Date.now();
  const items = Object.entries(deltas)
    .filter(([, quantity]) => quantity > 0)
    .map(([breadTypeId, quantity]) => ({ breadTypeId, quantity }));

  let applied = false;
  await runTransaction('stock.db', db, async () => {
    const inserted = await db.runAsync(
      'INSERT OR IGNORE INTO stock_batches (id, kind, created_at, run_id) VALUES (?, ?, ?, ?)',
      id,
      'addition',
      now,
      runId
    );
    if (inserted.changes === 0) return;
    applied = true;

    for (const item of items) {
      await db.runAsync(
        'INSERT INTO stock_batch_items (batch_id, bread_type_id, quantity, run_id) VALUES (?, ?, ?, ?)',
        id,
        item.breadTypeId,
        item.quantity,
        runId
      );
    }
  });

  if (applied) return { batch: { id, kind: 'addition', createdAt: now, items, receiptId: null, runId }, applied: true };

  const stored = await readBatchById(db, id);
  return { batch: stored ?? { id, kind: 'addition', createdAt: now, items, receiptId: null, runId }, applied: false };
}

/**
 * Records a receipt's sold quantities as a ledger entry — deliberately the
 * mirror image of addBatch: quantities come in positive (pieces sold) but are
 * stored negative, so sumBatches in context/stock.tsx subtracts them from the
 * running total for free, no special-casing needed there.
 */
/**
 * The ledger id a receipt's deduction is written under.
 *
 * Derived from the receipt rather than drawn from generateId(), and that is the
 * whole point: it makes the deduction **the same row every time it is
 * attempted**. Finalizing offers the user "Try again" when the deduction fails
 * (see context/receipts.tsx), and a retry re-runs this function from the top —
 * with a fresh random id, a write that had actually committed before failing
 * would append a *second* sale entry and take the same bread off the truck
 * twice. It is the same reasoning that makes the Firestore uploads use setDoc
 * at a minted id instead of addDoc, and it matters here for the same reason:
 * the id doubles as the uploaded document's id.
 *
 * Receipt ids are already lowercase alphanumerics and dashes (see lib/id.ts),
 * so this stays a legal Firestore document id.
 */
function saleBatchId(receiptId: string): string {
  return `sale_${receiptId}`;
}

/** One 'sale' entry with its items, or null — the shared read behind the two lookups below. */
async function readBatchById(db: SQLiteDatabase, id: string): Promise<Batch | null> {
  const row = await db.getFirstAsync<{
    id: string;
    kind: BatchKind;
    created_at: number;
    receipt_id: string | null;
    run_id: string | null;
  }>('SELECT id, kind, created_at, receipt_id, run_id FROM stock_batches WHERE id = ?', id);
  if (!row) return null;

  const itemRows = await db.getAllAsync<{ bread_type_id: string; quantity: number }>(
    'SELECT bread_type_id, quantity FROM stock_batch_items WHERE batch_id = ?',
    id
  );

  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    items: itemRows.map((item) => ({ breadTypeId: item.bread_type_id, quantity: item.quantity })),
    receiptId: row.receipt_id,
    runId: row.run_id,
  };
}

/**
 * The ledger entry that deducted this receipt, or null if it never happened.
 *
 * Queried on `receipt_id` rather than by rebuilding saleBatchId(), so entries
 * written before ids were derived from the receipt are still found. Answering
 * "null" is the load-bearing case: it is how finalize() can tell a receipt
 * whose stock was never taken off the truck from one that is fully done, rather
 * than assuming the deduction happened because the receipt is no longer a
 * draft.
 */
export async function findSaleBatchForReceipt(receiptId: string): Promise<Batch | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM stock_batches WHERE receipt_id = ? AND kind = 'sale' LIMIT 1",
    receiptId
  );
  return row ? readBatchById(db, row.id) : null;
}

/**
 * Deducts a finalized receipt's items from truck stock.
 *
 * **Safe to call twice.** `applied` is false when this receipt had already been
 * deducted, and nothing is written in that case — callers must not fold the
 * returned batch into their totals again. See saleBatchId above for why a
 * repeat is a real path rather than a hypothetical one.
 */
export async function recordSale(
  runId: string,
  quantities: Record<string, number>,
  receiptId: string | null
): Promise<{ batch: Batch; applied: boolean }> {
  const db = await getDb();
  const id = receiptId ? saleBatchId(receiptId) : generateId();
  const now = Date.now();
  const items = Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([breadTypeId, quantity]) => ({ breadTypeId, quantity: -quantity }));

  // Catches a deduction written under a random id before saleBatchId existed —
  // the INSERT OR IGNORE below only recognises a repeat by the derived id.
  if (receiptId) {
    const existing = await findSaleBatchForReceipt(receiptId);
    if (existing) return { batch: existing, applied: false };
  }

  let applied = false;
  await runTransaction('stock.db', db, async () => {
    // OR IGNORE, and the items are written only if this INSERT was the one that
    // created the row. That makes the whole entry — header and items — either
    // wholly new or wholly untouched, even if two attempts overlap.
    const inserted = await db.runAsync(
      'INSERT OR IGNORE INTO stock_batches (id, kind, created_at, receipt_id, run_id) VALUES (?, ?, ?, ?, ?)',
      id,
      'sale',
      now,
      receiptId,
      runId
    );
    if (inserted.changes === 0) return;
    applied = true;

    for (const item of items) {
      await db.runAsync(
        'INSERT INTO stock_batch_items (batch_id, bread_type_id, quantity, run_id) VALUES (?, ?, ?, ?)',
        id,
        item.breadTypeId,
        item.quantity,
        runId
      );
    }
  });

  if (applied) return { batch: { id, kind: 'sale', createdAt: now, items, receiptId, runId }, applied: true };

  // Lost the race (or the id was already taken): report what is actually on
  // disk, never the quantities this call would have written.
  const stored = await readBatchById(db, id);
  return { batch: stored ?? { id, kind: 'sale', createdAt: now, items, receiptId, runId }, applied: false };
}

/** The ledger id a voided receipt's bread goes back under — derived, for saleBatchId's reason. */
function voidBatchId(receiptId: string): string {
  return `void_${receiptId}`;
}

/**
 * Puts a voided receipt's bread back on the truck.
 *
 * **It returns exactly what the receipt's sale entry took off, read from the
 * ledger — not what the receipt lists.** Those are normally the same, but a
 * finalize whose deduction was skipped never took anything off, and giving that
 * bread "back" would push the count above what is really aboard. So: no sale
 * entry, nothing to return, `batch: null`.
 *
 * The entry goes into the run the sale was recorded in, which is where the bread
 * came off. The caller only voids receipts from the open run, so in practice
 * that is the open run.
 *
 * **Safe to call twice**, like recordSale: the id is derived from the receipt,
 * so a retry lands on the same row, and `applied: false` tells the caller not
 * to fold the entry into its totals again. Reading the sale and writing the
 * return happen in one transaction, so the quantities can't be read from one
 * state of the ledger and written into another.
 */
export async function recordVoid(receiptId: string): Promise<{ batch: Batch | null; applied: boolean }> {
  const db = await getDb();
  const id = voidBatchId(receiptId);
  const now = Date.now();

  let applied = false;
  let found = false;
  let runId: string | null = null;
  let items: BatchItem[] = [];
  await runTransaction('stock.db', db, async () => {
    const sale = await db.getFirstAsync<{ id: string; run_id: string | null }>(
      "SELECT id, run_id FROM stock_batches WHERE receipt_id = ? AND kind = 'sale' LIMIT 1",
      receiptId
    );
    if (!sale) return;
    found = true;
    runId = sale.run_id;

    const saleItems = await db.getAllAsync<{ bread_type_id: string; quantity: number }>(
      'SELECT bread_type_id, quantity FROM stock_batch_items WHERE batch_id = ?',
      sale.id
    );
    // A sale is stored negative; its return is the same loaves, positive.
    items = saleItems
      .filter((item) => item.quantity < 0)
      .map((item) => ({ breadTypeId: item.bread_type_id, quantity: -item.quantity }));

    const inserted = await db.runAsync(
      'INSERT OR IGNORE INTO stock_batches (id, kind, created_at, receipt_id, run_id) VALUES (?, ?, ?, ?, ?)',
      id,
      'void',
      now,
      receiptId,
      sale.run_id
    );
    if (inserted.changes === 0) return;
    applied = true;

    for (const item of items) {
      await db.runAsync(
        'INSERT INTO stock_batch_items (batch_id, bread_type_id, quantity, run_id) VALUES (?, ?, ?, ?)',
        id,
        item.breadTypeId,
        item.quantity,
        sale.run_id
      );
    }
  });

  if (!found) return { batch: null, applied: false };
  if (applied) return { batch: { id, kind: 'void', createdAt: now, items, receiptId, runId }, applied: true };

  // Already returned by an earlier attempt: report what is on disk.
  const stored = await readBatchById(db, id);
  return { batch: stored, applied: false };
}

/**
 * Of the given voided receipts, the ones whose bread was taken off the truck
 * and never put back: a sale entry exists, a void entry doesn't.
 *
 * That is the state a void's "Skip" leaves behind, and nothing else produces it.
 * A receipt with no sale entry is left out on purpose — its deduction was
 * skipped at finalize, so there is nothing to return (see recordVoid), and
 * listing it would have "End the Day" retry a no-op for ever.
 */
export async function findVoidsNotReturned(receiptIds: string[]): Promise<string[]> {
  if (receiptIds.length === 0) return [];
  const db = await getDb();
  const placeholders = receiptIds.map(() => '?').join(', ');
  const rows = await db.getAllAsync<{ receipt_id: string }>(
    `SELECT DISTINCT sale.receipt_id FROM stock_batches AS sale
     WHERE sale.kind = 'sale' AND sale.receipt_id IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM stock_batches AS returned
         WHERE returned.kind = 'void' AND returned.receipt_id = sale.receipt_id
       )`,
    ...receiptIds
  );
  return rows.map((row) => row.receipt_id);
}

/**
 * Ledger entries that haven't reached Firestore yet, oldest first, with their
 * items — everything lib/sync.ts needs to build one document.
 *
 * Oldest first so the cloud fills in the order the day actually happened, and
 * capped so a phone that has been offline for a long stretch uploads in
 * batches rather than trying to build one enormous list in memory.
 *
 * Not filtered to the run that is open now: a run is allowed to end with rows
 * still queued, and those rows have to keep uploading afterwards. Each carries
 * the run it belongs to so the caller can stamp it correctly — see drainStock
 * in context/sync.tsx.
 */
export async function loadPendingBatches(limit: number): Promise<Batch[]> {
  const db = await getDb();
  const batchRows = await db.getAllAsync<{
    id: string;
    kind: BatchKind;
    created_at: number;
    receipt_id: string | null;
    run_id: string | null;
  }>(
    `SELECT id, kind, created_at, receipt_id, run_id FROM stock_batches
     WHERE sync_state = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
    limit
  );
  if (batchRows.length === 0) return [];

  const placeholders = batchRows.map(() => '?').join(', ');
  const itemRows = await db.getAllAsync<{ batch_id: string; bread_type_id: string; quantity: number }>(
    `SELECT batch_id, bread_type_id, quantity FROM stock_batch_items WHERE batch_id IN (${placeholders})`,
    ...batchRows.map((row) => row.id)
  );

  const itemsByBatch = new Map<string, BatchItem[]>();
  for (const row of itemRows) {
    const list = itemsByBatch.get(row.batch_id) ?? [];
    list.push({ breadTypeId: row.bread_type_id, quantity: row.quantity });
    itemsByBatch.set(row.batch_id, list);
  }

  return batchRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    items: itemsByBatch.get(row.id) ?? [],
    receiptId: row.receipt_id,
    runId: row.run_id,
  }));
}

/**
 * How many ledger entries one run holds — for the "End the Day" manifest.
 *
 * Counted by run rather than by business day: two runs by the same truck on the
 * same day would otherwise each report the other's entries as their own, and
 * the manifest exists precisely so the dashboard can compare a count against
 * the documents that actually arrived in that run.
 */
export async function countBatchesForRun(runId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM stock_batches WHERE run_id = ?',
    runId
  );
  return row?.count ?? 0;
}

/** How many ledger entries are still waiting to upload — the number "End the Day" reports. */
export async function countPendingBatches(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM stock_batches WHERE sync_state = 'pending'"
  );
  return row?.count ?? 0;
}

/**
 * Records one unrecognised upload failure and reports the running total.
 *
 * Only failures the drain can't classify are counted — see
 * classifyUploadFailure in lib/sync.ts. A phone with no signal must never
 * accumulate these, or a day in a dead zone would quarantine work that was
 * perfectly fine.
 */
export async function bumpBatchAttempts(id: string): Promise<number> {
  const db = await getDb();
  await db.runAsync('UPDATE stock_batches SET sync_attempts = sync_attempts + 1 WHERE id = ?', id);
  const row = await db.getFirstAsync<{ sync_attempts: number }>(
    'SELECT sync_attempts FROM stock_batches WHERE id = ?',
    id
  );
  return row?.sync_attempts ?? 0;
}

/**
 * Sets an entry aside: the server refused it, and re-sending cannot change
 * that.
 *
 * It leaves the pending queue, which is the point — everything behind it can
 * upload, and the day can be closed. It is *not* deleted and not marked synced:
 * the row is still on the phone and still counted in the truck's stock, and it
 * is counted separately (countBlockedBatches) so the app can say plainly that
 * some records never reached the server rather than pretending they did.
 */
export async function markBatchBlocked(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE stock_batches SET sync_state = 'blocked' WHERE id = ?", id);
}

/** Entries the server refused. Reported to the user; never retried on its own. */
export async function countBlockedBatches(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM stock_batches WHERE sync_state = 'blocked'"
  );
  return row?.count ?? 0;
}

/**
 * The same, but only for one run — what that run's manifest reports.
 *
 * Scoped, because the manifest describes one trip out: a refusal left over from
 * this morning's run must not be reported again in the afternoon run's numbers,
 * which is the arithmetic the server is meant to be able to trust.
 */
export async function countBlockedBatchesForRun(runId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM stock_batches WHERE sync_state = 'blocked' AND run_id = ?",
    runId
  );
  return row?.count ?? 0;
}

/**
 * Puts every refused entry back in the queue. Resolves with how many moved.
 *
 * Being set aside has to be a resting state rather than a grave, because the
 * refusals this app actually produces are usually fixable *on the phone*:
 * `firestore.rules` requires `createdByUid` to equal the signed-in uid, so rows
 * left behind by a run abandoned in Settings are rejected for as long as
 * somebody else is logged in — and accepted the moment the right agent signs
 * back in. With no way to ask again, that work could never leave the device
 * however obvious the fix.
 *
 * The attempt counter is cleared with it: those counts are evidence about the
 * attempt that failed, and this is a deliberate fresh start.
 */
export async function retryBlockedBatches(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "UPDATE stock_batches SET sync_state = 'pending', sync_attempts = 0 WHERE sync_state = 'blocked'"
  );
  return result.changes;
}

/** Called only after Firestore has confirmed the write. */
export async function markBatchSynced(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE stock_batches SET sync_state = 'synced' WHERE id = ?", id);
}

/** Ledger entries the server has confirmed it received — see countSyncedReceipts in lib/receipt-db.ts. */
export async function countSyncedBatches(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM stock_batches WHERE sync_state = 'synced'"
  );
  return row?.count ?? 0;
}

/**
 * Retires an entry that can never be filed: its run is no longer known, so
 * there is no path in Firestore to write it to. Leaving it `'pending'` would
 * keep it in the "still waiting to upload" count for the life of the app,
 * reporting work that is never going to happen.
 */
export async function markBatchLegacy(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE stock_batches SET sync_state = 'legacy' WHERE id = ?", id);
}

/** Wipes the entire ledger — draft, every batch, and the finalize flag. Testing/reset only. */
export async function resetStock(): Promise<void> {
  const db = await getDb();
  await runTransaction('stock.db', db, async () => {
    await db.runAsync('DELETE FROM draft_stock');
    await db.runAsync('DELETE FROM stock_batch_items');
    await db.runAsync('DELETE FROM stock_batches');
    await db.runAsync('UPDATE stock_meta SET run_id = NULL, draft_saved_at = NULL, finalized_at = NULL WHERE id = 1');
  });
}
