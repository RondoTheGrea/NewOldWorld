import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { runTransaction } from '@/lib/db-lock';
import { generateId } from '@/lib/id';
import { assertValidReceiptLines, NotADraftError } from '@/lib/receipt-types';
import type {
  PaymentMethod,
  PendingReceipt,
  ProofSyncState,
  ReceiptDetail,
  ReceiptDraftInput,
  ReceiptItem,
  ReceiptPageCursor,
  ReceiptPaymentProof,
  ReceiptReturnItem,
  ReceiptStatus,
  ReceiptSummary,
} from '@/lib/receipt-types';

// Receipts, kept in their own database (like customers.db, stock.db) rather
// than folded into stock.db — finalizing a receipt writes to both this file
// and stock.db as two separate transactions (see context/receipts.tsx for why
// the order between them matters), so there was never a single-connection
// atomicity win to be had from sharing a file.
//
// Native only (iOS/Android) — same split as stock-db.ts/customer-db.ts:
// expo-sqlite's web build statically imports a .wasm asset that needs Metro
// config this app doesn't carry. receipt-db.web.ts is the platform-matched
// stub Metro picks instead when bundling for web — keep the split.
//
// Performance note: receipts are expected to accumulate far beyond inventory
// batches or customers, so the list query (loadReceiptPage) never loads
// items/returns and pages with a keyset cursor (WHERE created_at/id < ...)
// instead of OFFSET, which stays cheap no matter how large the table gets.
// Full line items are only ever fetched for one receipt at a time, on demand,
// via getReceiptDetail.

let dbPromise: Promise<SQLiteDatabase> | null = null;

function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabaseAsync('receipts.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          customer_contact_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('draft','finalized')),
          subtotal REAL NOT NULL,
          returns_total REAL NOT NULL,
          total REAL NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finalized_at INTEGER,
          agent_group_name TEXT,
          agent_names TEXT
        );
        -- Matches loadReceiptPage's ORDER BY exactly, so the keyset cursor is a
        -- range scan rather than a sort of the whole table. See migrateListIndexes.
        CREATE INDEX IF NOT EXISTS idx_receipts_list ON receipts(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_receipts_draft ON receipts(status) WHERE status = 'draft';
        CREATE INDEX IF NOT EXISTS idx_receipts_customer_id ON receipts(customer_id);
        CREATE TABLE IF NOT EXISTS receipt_items (
          receipt_id TEXT NOT NULL REFERENCES receipts(id),
          bread_type_id TEXT NOT NULL,
          name TEXT NOT NULL,
          unit_price REAL NOT NULL,
          quantity INTEGER NOT NULL,
          PRIMARY KEY (receipt_id, bread_type_id)
        );
        CREATE TABLE IF NOT EXISTS receipt_returns (
          receipt_id TEXT NOT NULL REFERENCES receipts(id),
          returned_bread_type_id TEXT NOT NULL,
          name TEXT NOT NULL,
          unit_price REAL NOT NULL,
          quantity INTEGER NOT NULL,
          PRIMARY KEY (receipt_id, returned_bread_type_id)
        );
        -- One row per receipt: a proof can only ever be attached once (see
        -- setPaymentProof). The photo itself stays on this phone at local_uri;
        -- storage_path is filled in once the same bytes have reached Cloud
        -- Storage, and carries the same sync_state machinery as every other
        -- uploadable row here.
        CREATE TABLE IF NOT EXISTS receipt_payment_proofs (
          receipt_id TEXT PRIMARY KEY REFERENCES receipts(id),
          file_name TEXT NOT NULL,
          local_uri TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          storage_path TEXT,
          sync_state TEXT NOT NULL DEFAULT 'pending',
          sync_attempts INTEGER NOT NULL DEFAULT 0
        );
      `);
      await migrateCustomerContactName(db);
      await migratePaymentMethod(db);
      await migrateListIndexes(db);
      await migrateSyncState(db);
      await migrateRunId(db);
      await migrateSyncAttempts(db);
      await migratePaymentProofUpload(db);
      await migrateCreditRename(db);
      await migrateAgentGroupName(db);
      await migrateVoidedAt(db);
      await migrateAgentNames(db);
      return db;
    });
    dbPromise = dbPromise.catch((error: unknown) => {
      // See the same guard in lib/stock-db.ts: a cached *rejected* promise
      // would make one bad open permanent until the app restarted, so it's
      // cleared and the next call reopens from scratch.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/**
 * A receipts table created before customer_contact_name existed is missing
 * the column — CREATE TABLE IF NOT EXISTS above is a no-op once the table
 * already exists. Gated by PRAGMA user_version so it only runs once.
 */
async function migrateCustomerContactName(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 1) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'customer_contact_name')) {
    await db.execAsync("ALTER TABLE receipts ADD COLUMN customer_contact_name TEXT NOT NULL DEFAULT ''");
  }
  await db.execAsync('PRAGMA user_version = 1');
}

/**
 * A receipts table created before payment_method/amount_paid existed is
 * missing them — same gated-migration shape as migrateCustomerContactName.
 */
async function migratePaymentMethod(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 2) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'payment_method')) {
    await db.execAsync('ALTER TABLE receipts ADD COLUMN payment_method TEXT');
  }
  if (!columns.some((column) => column.name === 'amount_paid')) {
    await db.execAsync('ALTER TABLE receipts ADD COLUMN amount_paid REAL');
  }
  await db.execAsync('PRAGMA user_version = 2');
}

/**
 * Indexes matching how the receipts table is actually read. Same reasoning as
 * the migrations above: the CREATE TABLE block is a no-op once the table
 * exists, so an index added there would never appear on an existing install.
 *
 * - `idx_receipts_list` is the composite the list query needs. The old
 *   single-column index on created_at could order the rows but not satisfy the
 *   keyset cursor, so paging fell back to scanning and sorting the whole table
 *   — the opposite of what keyset paging is for.
 * - `idx_receipts_draft` is a *partial* index: it holds only draft rows, of
 *   which there is at most one. findDraftReceipt runs on every "New receipt"
 *   tap, and its usual answer is "no draft" — which previously meant reading
 *   every receipt ever written before it could say so.
 */
async function migrateListIndexes(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 3) return;

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_receipts_list ON receipts(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_receipts_draft ON receipts(status) WHERE status = 'draft';
    DROP INDEX IF EXISTS idx_receipts_created_at;
    PRAGMA user_version = 3;
  `);
}

/**
 * Adds the column tracking whether a receipt has reached Firestore yet — see
 * the matching migration in lib/stock-db.ts for why it's a flag on the row
 * rather than a separate outbox table, and why pre-existing rows become
 * `'legacy'` instead of `'pending'`.
 *
 * Note what is *not* here: nothing flips this flag at finalize time. A draft is
 * created `'pending'` and stays that way; what makes it uploadable is its
 * `status` becoming `'finalized'`, which markFinalized already writes. The
 * drain query below asks for both conditions, so finalizing is still one write.
 *
 * The partial index carries both conditions for the same reason: drafts and
 * already-synced receipts are the overwhelming majority of the table, and
 * neither is ever a candidate to upload.
 */
async function migrateSyncState(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 4) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'sync_state')) {
    await db.execAsync("ALTER TABLE receipts ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending'");
    await db.runAsync("UPDATE receipts SET sync_state = 'legacy'");
  }
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_receipts_pending_sync
      ON receipts(created_at) WHERE sync_state = 'pending' AND status = 'finalized';
    PRAGMA user_version = 4;
  `);
}

/**
 * Records which run a receipt was finalized in.
 *
 * Uploads used to be stamped with whatever run was open at the moment the queue
 * drained, which is wrong as soon as a truck goes out twice in a day: a receipt
 * from the morning run that hadn't found signal yet would be filed under the
 * afternoon one. The run is a fact about the receipt, so it lives on the row.
 *
 * Unlike the ledger, receipts are *not* scoped by run for reading — the
 * Receipts tab is a running history across every day, and should stay one.
 * Only the upload path and the manifest ask which run a receipt belongs to,
 * so no index is added: `idx_receipts_pending_sync` already narrows the drain
 * to the handful of rows still waiting, and the manifest runs once a day.
 *
 * Already-finalized rows waiting to upload become `'legacy'` for the same
 * reason as in migrateSyncState: they belong to no run, and filing them under
 * whichever run opens next would post old test data to today's truck. Drafts
 * are deliberately left `'pending'` — a draft has never been eligible to
 * upload anyway, and it gets its run the normal way when it is finalized.
 */
async function migrateRunId(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 5) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'run_id')) {
    await db.execAsync('ALTER TABLE receipts ADD COLUMN run_id TEXT');
    await db.runAsync(
      "UPDATE receipts SET sync_state = 'legacy' WHERE sync_state = 'pending' AND status = 'finalized'"
    );
  }
  await db.execAsync('PRAGMA user_version = 5');
}

function sumLines(lines: { quantity: number; unitPrice: number }[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}

type ReceiptRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_contact_name: string;
  status: ReceiptStatus;
  subtotal: number;
  returns_total: number;
  total: number;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
  payment_method: PaymentMethod | null;
  amount_paid: number | null;
  run_id: string | null;
  agent_names: string | null;
  voided_at: number | null;
};

function rowToSummary(row: ReceiptRow): ReceiptSummary {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerContactName: row.customer_contact_name,
    status: row.status,
    subtotal: row.subtotal,
    returnsTotal: row.returns_total,
    total: row.total,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    paymentMethod: row.payment_method,
    amountPaid: row.amount_paid,
    runId: row.run_id,
    // Collapsed to null rather than passed straight through: a row written
    // before the column existed reads back null, but an empty string is also
    // possible — a run whose agents could not be named — and "nobody named" is
    // the same answer either way.
    agentNames: row.agent_names || null,
    voidedAt: row.voided_at ?? null,
  };
}

/**
 * Newest first. Pass the last row's {createdAt, id} back in as `cursor` to load
 * the next page.
 *
 * The cursor is written as a row-value comparison — `(created_at, id) < (?, ?)`
 * — not as the equivalent `created_at < ? OR (created_at = ? AND id < ?)`. They
 * select the same rows, but SQLite can seek straight into idx_receipts_list for
 * the first and generally can't for the second: an OR of two ranges usually
 * ends the index's usefulness, leaving a scan and sort of every receipt ever
 * written on each page. Keep it as a row value.
 */
export async function loadReceiptPage(cursor: ReceiptPageCursor | null, limit: number): Promise<ReceiptSummary[]> {
  const db = await getDb();
  const rows = cursor
    ? await db.getAllAsync<ReceiptRow>(
        `SELECT * FROM receipts
         WHERE (created_at, id) < (?, ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        cursor.createdAt,
        cursor.id,
        limit
      )
    : await db.getAllAsync<ReceiptRow>('SELECT * FROM receipts ORDER BY created_at DESC, id DESC LIMIT ?', limit);
  return rows.map(rowToSummary);
}

/** Only one draft is allowed to exist at a time — see context/receipts.tsx's createDraft guard. */
export async function findDraftReceipt(): Promise<ReceiptSummary | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<ReceiptRow>("SELECT * FROM receipts WHERE status = 'draft' LIMIT 1");
  return row ? rowToSummary(row) : null;
}

/** Newest first, matching customer_name or customer_contact_name (case-insensitive substring). */
export async function searchReceipts(query: string, limit: number): Promise<ReceiptSummary[]> {
  const db = await getDb();
  const pattern = `%${query}%`;
  const rows = await db.getAllAsync<ReceiptRow>(
    `SELECT * FROM receipts
     WHERE customer_name LIKE ? COLLATE NOCASE OR customer_contact_name LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    pattern,
    pattern,
    limit
  );
  return rows.map(rowToSummary);
}

/**
 * One store's purchase history: its finalized receipts on this phone, newest
 * first, a page at a time — the same cursor contract as loadReceiptPage.
 *
 * Drafts are left out (nothing has been sold yet); voided receipts are kept, so
 * the history matches the main Receipts list, and the screen marks them.
 * idx_receipts_customer_id narrows the rows to one store before the sort, so
 * this stays cheap however many receipts the phone holds overall.
 */
export async function loadCustomerReceiptPage(
  customerId: string,
  cursor: ReceiptPageCursor | null,
  limit: number
): Promise<ReceiptSummary[]> {
  const db = await getDb();
  const rows = cursor
    ? await db.getAllAsync<ReceiptRow>(
        `SELECT * FROM receipts
         WHERE customer_id = ? AND status = 'finalized' AND (created_at, id) < (?, ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        customerId,
        cursor.createdAt,
        cursor.id,
        limit
      )
    : await db.getAllAsync<ReceiptRow>(
        `SELECT * FROM receipts
         WHERE customer_id = ? AND status = 'finalized'
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        customerId,
        limit
      );
  return rows.map(rowToSummary);
}

// ORDER BY rowid: without it SQLite is free to satisfy the WHERE receipt_id = ?
// via the composite-PK index instead of a table scan, which returns rows in
// bread_type_id/returned_bread_type_id order rather than the order writeLines()
// inserted them in (the same order shown in the order-items list, driven by the
// dashboard's manual `order` field) — pinning to rowid keeps both lists consistent.
async function loadItems(db: SQLiteDatabase, receiptId: string): Promise<ReceiptItem[]> {
  const rows = await db.getAllAsync<{ bread_type_id: string; name: string; unit_price: number; quantity: number }>(
    'SELECT bread_type_id, name, unit_price, quantity FROM receipt_items WHERE receipt_id = ? ORDER BY rowid',
    receiptId
  );
  return rows.map((row) => ({ breadTypeId: row.bread_type_id, name: row.name, unitPrice: row.unit_price, quantity: row.quantity }));
}

async function loadReturns(db: SQLiteDatabase, receiptId: string): Promise<ReceiptReturnItem[]> {
  const rows = await db.getAllAsync<{ returned_bread_type_id: string; name: string; unit_price: number; quantity: number }>(
    'SELECT returned_bread_type_id, name, unit_price, quantity FROM receipt_returns WHERE receipt_id = ? ORDER BY rowid',
    receiptId
  );
  return rows.map((row) => ({ returnedBreadTypeId: row.returned_bread_type_id, name: row.name, unitPrice: row.unit_price, quantity: row.quantity }));
}

export async function getReceiptDetail(id: string): Promise<ReceiptDetail> {
  const db = await getDb();
  const row = await db.getFirstAsync<ReceiptRow>('SELECT * FROM receipts WHERE id = ?', id);
  if (!row) throw new Error(`Receipt ${id} not found`);
  const [items, returns] = await Promise.all([loadItems(db, id), loadReturns(db, id)]);
  return { ...rowToSummary(row), items, returns };
}

/**
 * Refuses unless `id` is a receipt that is still an editable draft.
 *
 * Called *first* inside the transactions below, before a single row is touched.
 * Both of them rewrite a receipt's line items — writeLines deletes them before
 * re-inserting, and deleteDraft removes them outright — while only their header
 * statement carried a `status = 'draft'` guard. On a finalized receipt that
 * combination destroyed the items and left the header, producing totals with no
 * lines behind them, and reported success either way. Checking once up front
 * makes the whole operation all-or-nothing, and makes "this can't be edited" an
 * error the caller can actually show.
 */
/**
 * Counts how many times a receipt's upload has failed for a reason nobody
 * recognised, so the drain can set it aside rather than retry it forever. See
 * the matching migration in lib/stock-db.ts.
 */
async function migrateSyncAttempts(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 6) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'sync_attempts')) {
    await db.execAsync('ALTER TABLE receipts ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0');
  }
  await db.execAsync('PRAGMA user_version = 6');
}

/**
 * Puts proof photos on the upload queue.
 *
 * Before this they were local-only: the photo sat in the app's document
 * directory and the server never saw it, which made a GCash receipt the one
 * record the phone kept something back from.
 *
 * Existing rows become `'pending'` rather than `'legacy'` — the opposite of
 * what the ledger's own sync migration did, and deliberately so. A ledger entry
 * written before runs existed belongs to no run and can't be filed anywhere; a
 * proof photo belongs to a receipt, that receipt has a `run_id`, and the photo
 * is real evidence of a payment the server is still owed a copy of. Uploading
 * them is the desired outcome, so the default on the column does the work.
 *
 * The index is partial, the same trick `idx_receipts_draft` uses: proofs
 * accumulate for the life of the app but the set still waiting to upload stays
 * small, so "what's left to send?" stays cheap.
 */
async function migratePaymentProofUpload(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 7) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipt_payment_proofs)');
  if (!columns.some((column) => column.name === 'storage_path')) {
    await db.execAsync('ALTER TABLE receipt_payment_proofs ADD COLUMN storage_path TEXT');
  }
  if (!columns.some((column) => column.name === 'sync_state')) {
    await db.execAsync(
      "ALTER TABLE receipt_payment_proofs ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending'"
    );
  }
  if (!columns.some((column) => column.name === 'sync_attempts')) {
    await db.execAsync(
      'ALTER TABLE receipt_payment_proofs ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0'
    );
  }
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_receipt_proofs_pending
      ON receipt_payment_proofs(created_at) WHERE sync_state = 'pending';
    PRAGMA user_version = 7;
  `);
}

/**
 * The 'consignment' payment method was renamed to 'credit'.
 *
 * The name is stored on the row as a plain string, so a receipt finalized
 * before the rename still says 'consignment' — and every query that buckets by
 * payment method (summarizeRunHistoryForRun) matches on the literal, so an
 * un-migrated row would silently drop out of the Credit total and show a blank
 * tag in the receipts list. Rewriting them here means only one spelling ever
 * exists on this phone.
 *
 * `sync_state` is deliberately *not* touched: a receipt already uploaded stays
 * 'synced' and keeps the old spelling in Firestore. Re-sending every past
 * receipt to change one word is a lot of traffic on a phone in a truck, and the
 * dashboard reads the old value as Credit anyway (see readReceipt in
 * apps/web/src/lib/runs.ts). Rows still waiting to upload haven't been read
 * yet, so they go up with the new spelling on their first attempt.
 */
async function migrateCreditRename(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 8) return;

  await db.runAsync("UPDATE receipts SET payment_method = 'credit' WHERE payment_method = 'consignment'");
  await db.execAsync('PRAGMA user_version = 8');
}

/**
 * Records which crew was out when a receipt was finalized. Crews have since
 * been removed — `agent_names` (migrateAgentNames) replaced this column, which
 * is kept only because SQLite columns aren't dropped in place.
 *
 * The run id already carries the crew's name as a flattened segment, but a
 * segment is not a name — `Alpha-Crew` is what `safeSegment` made of it, and
 * unflattening it is guesswork. The name is a fact about the receipt and now
 * prints on the customer's copy, so it is stored whole, on the row, exactly as
 * it read when the crew was picked.
 *
 * Nothing is backfilled and no row's `sync_state` is touched, which is what
 * keeps this from disturbing what is already on the phone. Every receipt
 * finalized before this column existed keeps a null crew — the honest answer,
 * since a closed run's crew is not recoverable from a receipt row — and every
 * reader (the detail modal, the printed receipt, the upload) leaves the line
 * out rather than inventing one. Re-sending every past receipt to add one field
 * would be a lot of traffic from a phone in a truck, for a line the server can
 * already read off the run those receipts hang under.
 */
async function migrateAgentGroupName(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 9) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'agent_group_name')) {
    await db.execAsync('ALTER TABLE receipts ADD COLUMN agent_group_name TEXT');
  }
  await db.execAsync('PRAGMA user_version = 9');
}

/**
 * Adds the column that records a receipt being voided — see `voidedAt` on
 * ReceiptSummary for why it is a column and not a new status.
 *
 * Nothing is backfilled and no `sync_state` is touched: every existing receipt
 * simply stands, which is true.
 */
async function migrateVoidedAt(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 10) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'voided_at')) {
    await db.execAsync('ALTER TABLE receipts ADD COLUMN voided_at INTEGER');
  }
  await db.execAsync('PRAGMA user_version = 10');
}

/**
 * Records who was on the truck when a receipt was finalized — the agents'
 * names, replacing the crew name (`agent_group_name`) now that crews are gone.
 *
 * Same shape as migrateAgentGroupName: nothing is backfilled and no row's
 * `sync_state` is touched. Every earlier receipt keeps a null here, and every
 * reader leaves the line out rather than inventing one.
 */
async function migrateAgentNames(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 11) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(receipts)');
  if (!columns.some((column) => column.name === 'agent_names')) {
    await db.execAsync('ALTER TABLE receipts ADD COLUMN agent_names TEXT');
  }
  await db.execAsync('PRAGMA user_version = 11');
}

async function requireDraft(db: SQLiteDatabase, id: string): Promise<void> {
  const row = await db.getFirstAsync<{ status: ReceiptStatus }>('SELECT status FROM receipts WHERE id = ?', id);
  if (!row) throw new NotADraftError('This receipt is no longer on this phone.');
  if (row.status !== 'draft') throw new NotADraftError();
}

async function writeLines(
  db: SQLiteDatabase,
  receiptId: string,
  input: ReceiptDraftInput
): Promise<{ subtotal: number; returnsTotal: number }> {
  await db.runAsync('DELETE FROM receipt_items WHERE receipt_id = ?', receiptId);
  await db.runAsync('DELETE FROM receipt_returns WHERE receipt_id = ?', receiptId);
  for (const item of input.items) {
    await db.runAsync(
      'INSERT INTO receipt_items (receipt_id, bread_type_id, name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)',
      receiptId,
      item.breadTypeId,
      item.name,
      item.unitPrice,
      item.quantity
    );
  }
  for (const line of input.returns) {
    await db.runAsync(
      'INSERT INTO receipt_returns (receipt_id, returned_bread_type_id, name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)',
      receiptId,
      line.returnedBreadTypeId,
      line.name,
      line.unitPrice,
      line.quantity
    );
  }
  return { subtotal: sumLines(input.items), returnsTotal: sumLines(input.returns) };
}

export async function createDraft(input: ReceiptDraftInput): Promise<ReceiptDetail> {
  // Before the database is even opened, so a line that can't be real costs
  // nothing and leaves nothing behind. Whether the order fits on the truck is
  // the other half of this and is checked one level up, in context/receipts.tsx
  // — the ledger lives in a different database, and this file never opens it.
  assertValidReceiptLines(input);

  const db = await getDb();
  const id = generateId();
  const now = Date.now();

  let subtotal = 0;
  let returnsTotal = 0;
  await runTransaction('receipts.db', db, async () => {
    await db.runAsync(
      `INSERT INTO receipts (id, customer_id, customer_name, customer_contact_name, status, subtotal, returns_total, total, created_at, updated_at, finalized_at)
       VALUES (?, ?, ?, ?, 'draft', 0, 0, 0, ?, ?, NULL)`,
      id,
      input.customerId,
      input.customerName,
      input.customerContactName,
      now,
      now
    );
    const totals = await writeLines(db, id, input);
    subtotal = totals.subtotal;
    returnsTotal = totals.returnsTotal;
    await db.runAsync(
      'UPDATE receipts SET subtotal = ?, returns_total = ?, total = ? WHERE id = ?',
      subtotal,
      returnsTotal,
      subtotal - returnsTotal,
      id
    );
  });

  return {
    id,
    customerId: input.customerId,
    customerName: input.customerName,
    customerContactName: input.customerContactName,
    status: 'draft',
    subtotal,
    returnsTotal,
    total: subtotal - returnsTotal,
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
    paymentMethod: null,
    amountPaid: null,
    // A draft belongs to no run yet — markFinalized is what files it under one,
    // and stamps who was on the truck at that moment along with it.
    runId: null,
    agentNames: null,
    voidedAt: null,
    items: input.items,
    returns: input.returns,
  };
}

export async function updateDraft(id: string, input: ReceiptDraftInput): Promise<ReceiptDetail> {
  // Ahead of requireDraft, and well ahead of writeLines' DELETE: an edit is
  // refused whole, never half-applied. See createDraft.
  assertValidReceiptLines(input);

  const db = await getDb();
  const now = Date.now();

  let subtotal = 0;
  let returnsTotal = 0;
  await runTransaction('receipts.db', db, async () => {
    // Throws before writeLines gets to delete anything — see requireDraft.
    await requireDraft(db, id);
    const totals = await writeLines(db, id, input);
    subtotal = totals.subtotal;
    returnsTotal = totals.returnsTotal;
    await db.runAsync(
      `UPDATE receipts
       SET customer_id = ?, customer_name = ?, customer_contact_name = ?, subtotal = ?, returns_total = ?, total = ?, updated_at = ?
       WHERE id = ? AND status = 'draft'`,
      input.customerId,
      input.customerName,
      input.customerContactName,
      subtotal,
      returnsTotal,
      subtotal - returnsTotal,
      now,
      id
    );
  });

  return getReceiptDetail(id);
}

export async function deleteDraft(id: string): Promise<void> {
  const db = await getDb();
  await runTransaction('receipts.db', db, async () => {
    // Before the two deletes below, which are not themselves restricted to
    // drafts — without this they would strip a finalized receipt's lines and
    // leave the receipt behind. See requireDraft.
    await requireDraft(db, id);
    await db.runAsync('DELETE FROM receipt_items WHERE receipt_id = ?', id);
    await db.runAsync('DELETE FROM receipt_returns WHERE receipt_id = ?', id);
    await db.runAsync("DELETE FROM receipts WHERE id = ? AND status = 'draft'", id);
  });
}

/**
 * Flips a draft to finalized, records how it was paid, and files it under the
 * run it was finalized in. Deducting stock is a separate step — see
 * context/receipts.tsx.
 */
export async function markFinalized(
  id: string,
  runId: string,
  paymentMethod: PaymentMethod,
  amountPaid: number | null,
  agentNames: string | null
): Promise<{ finalizedAt: number }> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `UPDATE receipts
     SET status = 'finalized', finalized_at = ?, payment_method = ?, amount_paid = ?, run_id = ?,
         agent_names = ?
     WHERE id = ? AND status = 'draft'`,
    now,
    paymentMethod,
    amountPaid,
    runId,
    agentNames,
    id
  );
  return { finalizedAt: now };
}

/**
 * Voids a finalized receipt from `runId` and resolves with the moment it was
 * voided. Returning the bread to the truck is a separate step in stock.db — see
 * `voidReceipt` in context/receipts.tsx.
 *
 * The `run_id` in the WHERE is the database's half of the owner's rule (only a
 * receipt from the run that is open can be voided); the context checks it first
 * so it can say why, and this makes sure no other caller can get round it.
 *
 * **It re-queues the upload**, because a receipt is normally on the server long
 * before anyone notices a mistake on it, and nothing else would ever send it
 * again. Only a `'synced'` row is moved back to `'pending'` — the same call
 * `markPaymentProofSynced` makes: a pending one is already on its way, and a
 * blocked or legacy one was set aside for a reason this function has no evidence
 * about. A receipt still in the air when it is voided is handled by
 * `markReceiptSynced`'s guard instead.
 *
 * Idempotent: a receipt already voided keeps its original time, and that time is
 * what comes back, so a retry after a write that committed and then reported
 * failure gets the same answer as the first attempt.
 */
/**
 * Every voided receipt filed under one run — what `returnVoidedStock` in
 * context/receipts.tsx checks against the ledger at "End the Day".
 */
export async function listVoidedReceiptIdsForRun(runId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM receipts
     WHERE run_id = ? AND status = 'finalized' AND voided_at IS NOT NULL`,
    runId
  );
  return rows.map((row) => row.id);
}

export async function markVoided(id: string, runId: string): Promise<{ voidedAt: number }> {
  const db = await getDb();
  const now = Date.now();
  // Every SET expression reads the row as it was before this UPDATE, so the two
  // CASEs both see the old sync_state.
  await db.runAsync(
    `UPDATE receipts
     SET voided_at = ?,
         sync_state = CASE WHEN sync_state = 'synced' THEN 'pending' ELSE sync_state END,
         sync_attempts = CASE WHEN sync_state = 'synced' THEN 0 ELSE sync_attempts END
     WHERE id = ? AND status = 'finalized' AND run_id = ? AND voided_at IS NULL`,
    now,
    id,
    runId
  );
  const row = await db.getFirstAsync<{ voided_at: number | null }>(
    'SELECT voided_at FROM receipts WHERE id = ? AND run_id = ?',
    id,
    runId
  );
  if (row?.voided_at == null) throw new Error(`Receipt ${id} could not be voided.`);
  return { voidedAt: row.voided_at };
}

/**
 * Finalized receipts that haven't reached Firestore yet, oldest first, with
 * their full items and returns.
 *
 * Drafts are excluded by the query, not filtered out afterwards: a draft is
 * scratch work that the dashboard must never see, and it may still be edited
 * or deleted. Only finalizing makes a receipt a fact.
 *
 * Unlike loadReceiptPage this *does* load line items — an uploaded receipt is
 * a single document containing its own items, so there is nothing to send
 * without them. The limit is what keeps that affordable.
 */
export async function loadPendingReceipts(limit: number): Promise<PendingReceipt[]> {
  const db = await getDb();
  // The proof photo's `storage_path` is read across in the same query, LEFT
  // JOINed because most receipts have no photo at all. It is null until the
  // photo has actually reached Storage, so a receipt uploaded before its photo
  // went up carries `proofStoragePath: null` and is re-queued later by
  // markPaymentProofSynced — the dashboard therefore never sees a path pointing
  // at an object that isn't there yet.
  const rows = await db.getAllAsync<ReceiptRow & { proof_storage_path: string | null }>(
    `SELECT r.*, p.storage_path AS proof_storage_path
     FROM receipts r
     LEFT JOIN receipt_payment_proofs p ON p.receipt_id = r.id
     WHERE r.sync_state = 'pending' AND r.status = 'finalized'
     ORDER BY r.created_at ASC
     LIMIT ?`,
    limit
  );

  const details: PendingReceipt[] = [];
  for (const row of rows) {
    const [items, returns] = await Promise.all([loadItems(db, row.id), loadReturns(db, row.id)]);
    details.push({ ...rowToSummary(row), items, returns, proofStoragePath: row.proof_storage_path });
  }
  return details;
}

/** How many finalized receipts are still waiting to upload — the number "End the Day" reports. */
export async function countPendingReceipts(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM receipts WHERE sync_state = 'pending' AND status = 'finalized'"
  );
  return row?.count ?? 0;
}

/**
 * Counts unrecognised upload failures for one receipt — the twin of
 * bumpBatchAttempts in lib/stock-db.ts, and see classifyUploadFailure in
 * lib/sync.ts for what does and doesn't get counted.
 */
export async function bumpReceiptAttempts(id: string): Promise<number> {
  const db = await getDb();
  await db.runAsync('UPDATE receipts SET sync_attempts = sync_attempts + 1 WHERE id = ?', id);
  const row = await db.getFirstAsync<{ sync_attempts: number }>(
    'SELECT sync_attempts FROM receipts WHERE id = ?',
    id
  );
  return row?.sync_attempts ?? 0;
}

/**
 * Sets a receipt aside: the server refused it and re-sending cannot change
 * that. It leaves the pending queue so everything behind it can still upload
 * and the day can still be closed — but it stays on the phone, and stays
 * counted by countBlockedReceipts so the user can be told it never arrived.
 */
export async function markReceiptBlocked(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE receipts SET sync_state = 'blocked' WHERE id = ?", id);
}

/** Receipts the server refused. Reported to the user; never retried on its own. */
export async function countBlockedReceipts(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM receipts WHERE sync_state = 'blocked'"
  );
  return row?.count ?? 0;
}

/**
 * The same, but only for one run — what that run's manifest reports.
 *
 * Scoped for the same reason the receipt totals are: the manifest describes one
 * trip out, and a refusal left over from the morning must not be counted again
 * against the afternoon.
 */
export async function countBlockedReceiptsForRun(runId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM receipts WHERE sync_state = 'blocked' AND run_id = ?",
    runId
  );
  return row?.count ?? 0;
}

/** Puts every refused receipt back in the queue — see retryBlockedBatches in lib/stock-db.ts. */
export async function retryBlockedReceipts(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "UPDATE receipts SET sync_state = 'pending', sync_attempts = 0 WHERE sync_state = 'blocked'"
  );
  return result.changes;
}

/**
 * Called only after Firestore has confirmed the write.
 *
 * **Guarded on the `voidedAt` that was uploaded**, the same shape as
 * `markExpenseSynced`'s guard on `updated_at`. A receipt can be voided while its
 * un-voided copy is still in the air; an unguarded mark would then record the
 * *void* as delivered when what actually landed was the version before it, and
 * the server would go on counting a receipt the phone had cancelled. With the
 * guard the row stays `'pending'` and the voided copy goes up on the next pass.
 * `IS` rather than `=` so a null matches a null.
 */
export async function markReceiptSynced(id: string, uploadedVoidedAt: number | null): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE receipts SET sync_state = 'synced' WHERE id = ? AND voided_at IS ?",
    id,
    uploadedVoidedAt
  );
}

/** Receipts the server has confirmed it received — the "verified" half of the Settings tally. */
export async function countSyncedReceipts(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM receipts WHERE sync_state = 'synced'"
  );
  return row?.count ?? 0;
}

/** Retires a receipt whose run is no longer known — see markBatchLegacy in lib/stock-db.ts. */
export async function markReceiptLegacy(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE receipts SET sync_state = 'legacy' WHERE id = ?", id);
}

/**
 * One run's totals, straight from SQL — what the "End the Day" manifest
 * reports so the dashboard can check its own arithmetic against the phone's.
 *
 * Counted by run, not by business day. A day-bounded count was right while a
 * truck could only run once a day; with two runs it reported each run's totals
 * as the other's as well, which is exactly the arithmetic the manifest exists
 * to let the dashboard trust.
 *
 * **Voided receipts count in none of the three figures** — the same rule the
 * dashboard's `totalReceipts` follows, so the Trends tab (which charts these
 * manifest figures) and the run panel (which adds up receipts) agree. They are
 * counted separately in `voidedCount`, so receipts plus voided is still every
 * receipt document the run sent.
 */
export async function summarizeFinalizedForRun(
  runId: string
): Promise<{ receiptCount: number; voidedCount: number; salesTotal: number; returnsTotal: number }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    count: number | null;
    voided: number | null;
    sales: number | null;
    returns: number | null;
  }>(
    `SELECT SUM(CASE WHEN voided_at IS NULL THEN 1 ELSE 0 END) AS count,
            SUM(CASE WHEN voided_at IS NULL THEN 0 ELSE 1 END) AS voided,
            SUM(CASE WHEN voided_at IS NULL THEN subtotal ELSE 0 END) AS sales,
            SUM(CASE WHEN voided_at IS NULL THEN returns_total ELSE 0 END) AS returns
     FROM receipts
     WHERE status = 'finalized' AND run_id = ?`,
    runId
  );
  return {
    receiptCount: row?.count ?? 0,
    voidedCount: row?.voided ?? 0,
    salesTotal: row?.sales ?? 0,
    returnsTotal: row?.returns ?? 0,
  };
}

/**
 * Everything lib/run-history.ts needs about a run's receipts, in one call
 * rather than four — this only ever runs once, at "End the Day", so it isn't
 * on a hot path, but there's no reason to open four separate queries either.
 *
 * - `sold` / `returned` are grouped by bread type across every finalized
 *   receipt in the run — a truck's-eye view of what moved, not a per-receipt
 *   list. Names come from the receipt lines themselves (already a name/price
 *   snapshot — see receipt_items/receipt_returns), not a fresh catalog lookup,
 *   so this still means something if a bread type was renamed or deleted
 *   after the run.
 * - The money split separates what was collected from what is still owed:
 *   cash, GCash and cheque at their full receipt total; 'partial' is split
 *   into the receipt total and the down payment recorded at finalize;
 *   'credit' is the receipt total only — nothing was collected yet.
 * - Voided receipts are left out of all of it: their bread went back on the
 *   truck and their money was never owed.
 */
export async function summarizeRunHistoryForRun(runId: string): Promise<{
  sold: { breadTypeId: string; name: string; quantity: number; amount: number }[];
  returned: { breadTypeId: string; name: string; quantity: number; amount: number }[];
  cashTotal: number;
  gcashTotal: number;
  chequeTotal: number;
  partialTotal: number;
  partialPaidTotal: number;
  creditTotal: number;
}> {
  const db = await getDb();

  const soldRows = await db.getAllAsync<{ bread_type_id: string; name: string; quantity: number; amount: number }>(
    `SELECT ri.bread_type_id, ri.name, SUM(ri.quantity) AS quantity, SUM(ri.quantity * ri.unit_price) AS amount
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE r.run_id = ? AND r.status = 'finalized' AND r.voided_at IS NULL
     GROUP BY ri.bread_type_id, ri.name
     ORDER BY ri.name`,
    runId
  );

  const returnedRows = await db.getAllAsync<{ returned_bread_type_id: string; name: string; quantity: number; amount: number }>(
    `SELECT rr.returned_bread_type_id, rr.name, SUM(rr.quantity) AS quantity, SUM(rr.quantity * rr.unit_price) AS amount
     FROM receipt_returns rr
     JOIN receipts r ON r.id = rr.receipt_id
     WHERE r.run_id = ? AND r.status = 'finalized' AND r.voided_at IS NULL
     GROUP BY rr.returned_bread_type_id, rr.name
     ORDER BY rr.name`,
    runId
  );

  const moneyRow = await db.getFirstAsync<{
    cash: number | null;
    gcash: number | null;
    cheque: number | null;
    partial: number | null;
    partialPaid: number | null;
    credit: number | null;
  }>(
    `SELECT
       SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END) AS cash,
       SUM(CASE WHEN payment_method = 'gcash' THEN total ELSE 0 END) AS gcash,
       SUM(CASE WHEN payment_method = 'cheque' THEN total ELSE 0 END) AS cheque,
       SUM(CASE WHEN payment_method = 'partial' THEN total ELSE 0 END) AS partial,
       SUM(CASE WHEN payment_method = 'partial' THEN COALESCE(amount_paid, 0) ELSE 0 END) AS partialPaid,
       SUM(CASE WHEN payment_method = 'credit' THEN total ELSE 0 END) AS credit
     FROM receipts
     WHERE run_id = ? AND status = 'finalized' AND voided_at IS NULL`,
    runId
  );

  return {
    sold: soldRows.map((row) => ({ breadTypeId: row.bread_type_id, name: row.name, quantity: row.quantity, amount: row.amount })),
    returned: returnedRows.map((row) => ({
      breadTypeId: row.returned_bread_type_id,
      name: row.name,
      quantity: row.quantity,
      amount: row.amount,
    })),
    cashTotal: moneyRow?.cash ?? 0,
    gcashTotal: moneyRow?.gcash ?? 0,
    chequeTotal: moneyRow?.cheque ?? 0,
    partialTotal: moneyRow?.partial ?? 0,
    partialPaidTotal: moneyRow?.partialPaid ?? 0,
    creditTotal: moneyRow?.credit ?? 0,
  };
}

type PaymentProofRow = {
  receipt_id: string;
  file_name: string;
  local_uri: string;
  created_at: number;
  storage_path: string | null;
  sync_state: ProofSyncState;
};

function rowToPaymentProof(row: PaymentProofRow): ReceiptPaymentProof {
  return {
    receiptId: row.receipt_id,
    fileName: row.file_name,
    localUri: row.local_uri,
    createdAt: row.created_at,
    storagePath: row.storage_path,
    syncState: row.sync_state,
  };
}

/** Returns the receipt's proof photo, or null if none has been uploaded yet. */
export async function getPaymentProof(receiptId: string): Promise<ReceiptPaymentProof | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<PaymentProofRow>(
    'SELECT * FROM receipt_payment_proofs WHERE receipt_id = ?',
    receiptId
  );
  return row ? rowToPaymentProof(row) : null;
}

/**
 * Attaches the receipt's proof photo. Throws if one already exists — a receipt
 * can only ever get one.
 *
 * The row lands `'pending'` (the column default), which is what puts it on the
 * upload queue. Nothing here talks to the network: the caller nudges sync once
 * the row is safely on disk, and the photo goes up in the background like every
 * other record.
 */
export async function setPaymentProof(receiptId: string, fileName: string, localUri: string): Promise<ReceiptPaymentProof> {
  const db = await getDb();
  const existing = await getPaymentProof(receiptId);
  if (existing) throw new Error('A proof photo was already attached to this receipt.');

  const createdAt = Date.now();
  await db.runAsync(
    'INSERT INTO receipt_payment_proofs (receipt_id, file_name, local_uri, created_at) VALUES (?, ?, ?, ?)',
    receiptId,
    fileName,
    localUri,
    createdAt
  );
  return { receiptId, fileName, localUri, createdAt, storagePath: null, syncState: 'pending' };
}

// ---------------------------------------------------------------------------
// Proof photo upload queue
// ---------------------------------------------------------------------------

/**
 * A proof photo on its way up, carrying the run of the receipt it belongs to.
 *
 * The run comes from the receipt rather than being stored again here: a photo
 * is only ever attached to a finalized receipt, which already has its `run_id`
 * pinned, and copying it would be a second row to keep in step for nothing.
 */
export type PendingPaymentProof = ReceiptPaymentProof & { runId: string | null };

/**
 * Proof photos that haven't reached Cloud Storage yet, oldest first.
 *
 * Joined to `receipts` for the run id, and inner-joined on purpose: a proof row
 * whose receipt has been deleted has nothing to file itself under, and the join
 * dropping it is the same answer `markPaymentProofLegacy` would give.
 */
export async function loadPendingPaymentProofs(limit: number): Promise<PendingPaymentProof[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PaymentProofRow & { run_id: string | null }>(
    `SELECT p.*, r.run_id AS run_id
     FROM receipt_payment_proofs p
     JOIN receipts r ON r.id = p.receipt_id
     WHERE p.sync_state = 'pending'
     ORDER BY p.created_at ASC
     LIMIT ?`,
    limit
  );
  return rows.map((row) => ({ ...rowToPaymentProof(row), runId: row.run_id }));
}

/** How many proof photos are still waiting to upload. */
export async function countPendingPaymentProofs(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM receipt_payment_proofs WHERE sync_state = 'pending'"
  );
  return row?.count ?? 0;
}

/**
 * How many proof photos one run produced — what that run's manifest reports, so
 * the dashboard can tell a photo that never arrived from one that was never taken.
 */
export async function countPaymentProofsForRun(runId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM receipt_payment_proofs p
     JOIN receipts r ON r.id = p.receipt_id
     WHERE r.run_id = ?`,
    runId
  );
  return row?.count ?? 0;
}

/**
 * Records the upload landing.
 *
 * Two writes, in one transaction, and the second is the whole point:
 *
 * 1. The proof row gets its `storage_path` and leaves the queue.
 * 2. **The receipt goes back to `'pending'`**, so it re-uploads carrying
 *    `proofStoragePath`. That is how the path reaches Firestore at all — the
 *    receipt document was very likely already sent, long before the driver
 *    took the photo, and nothing else would ever queue it again.
 *
 * Re-queueing only a `'synced'` receipt is deliberate. A `'pending'` one is
 * already on its way and will read the path at upload time; a `'blocked'` or
 * `'legacy'` one has been set aside for a reason, and quietly resurrecting it
 * here would undo a decision the drain made on evidence this function doesn't
 * have.
 *
 * The path is only ever written after the bytes are actually in Storage, which
 * is what lets the dashboard treat a non-null `proofStoragePath` as a promise
 * that the object exists rather than a hint that it might.
 */
export async function markPaymentProofSynced(receiptId: string, storagePath: string): Promise<void> {
  const db = await getDb();
  await runTransaction('receipts.db', db, async () => {
    await db.runAsync(
      "UPDATE receipt_payment_proofs SET sync_state = 'synced', storage_path = ? WHERE receipt_id = ?",
      storagePath,
      receiptId
    );
    await db.runAsync(
      "UPDATE receipts SET sync_state = 'pending', sync_attempts = 0 WHERE id = ? AND sync_state = 'synced'",
      receiptId
    );
  });
}

/** Payment photos Storage has confirmed it received — see countSyncedReceipts. */
export async function countSyncedPaymentProofs(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM receipt_payment_proofs WHERE sync_state = 'synced'"
  );
  return row?.count ?? 0;
}

/**
 * Counts one unrecognised upload failure for a proof photo — the twin of
 * bumpBatchAttempts in lib/stock-db.ts.
 */
export async function bumpPaymentProofAttempts(receiptId: string): Promise<number> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE receipt_payment_proofs SET sync_attempts = sync_attempts + 1 WHERE receipt_id = ?',
    receiptId
  );
  const row = await db.getFirstAsync<{ sync_attempts: number }>(
    'SELECT sync_attempts FROM receipt_payment_proofs WHERE receipt_id = ?',
    receiptId
  );
  return row?.sync_attempts ?? 0;
}

/**
 * Sets a proof photo aside after Storage refused it.
 *
 * The photo stays on the phone and stays visible on its receipt — being refused
 * changes where it has got to, not whether the driver can show it to anybody.
 */
export async function markPaymentProofBlocked(receiptId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE receipt_payment_proofs SET sync_state = 'blocked' WHERE receipt_id = ?", receiptId);
}

/** Proof photos the server refused. Reported to the user; never retried on their own. */
export async function countBlockedPaymentProofs(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM receipt_payment_proofs WHERE sync_state = 'blocked'"
  );
  return row?.count ?? 0;
}

/** The same, but only for one run — what that run's manifest reports. */
export async function countBlockedPaymentProofsForRun(runId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM receipt_payment_proofs p
     JOIN receipts r ON r.id = p.receipt_id
     WHERE p.sync_state = 'blocked' AND r.run_id = ?`,
    runId
  );
  return row?.count ?? 0;
}

/** Puts every refused proof photo back in the queue — see retryBlockedBatches in lib/stock-db.ts. */
export async function retryBlockedPaymentProofs(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "UPDATE receipt_payment_proofs SET sync_state = 'pending', sync_attempts = 0 WHERE sync_state = 'blocked'"
  );
  return result.changes;
}

/** Retires a proof whose run is no longer known — see markBatchLegacy in lib/stock-db.ts. */
export async function markPaymentProofLegacy(receiptId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE receipt_payment_proofs SET sync_state = 'legacy' WHERE receipt_id = ?", receiptId);
}

/** Wipes every receipt, draft or finalized, along with their items, returns and payment proofs. Does not touch stock. */
export async function resetReceipts(): Promise<void> {
  const db = await getDb();
  await runTransaction('receipts.db', db, async () => {
    await db.runAsync('DELETE FROM receipt_items');
    await db.runAsync('DELETE FROM receipt_returns');
    await db.runAsync('DELETE FROM receipt_payment_proofs');
    await db.runAsync('DELETE FROM receipts');
  });
}
