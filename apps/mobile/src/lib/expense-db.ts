import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { sanitizeCashCountInput, type CashCount, type CashCountInput } from '@/lib/cash-count';
import { sanitizeExpenseInput, type Expense, type ExpenseInput } from '@/lib/expense-types';
import { generateId } from '@/lib/id';

// What the truck spent while it was out, one row per expense, scoped to the run
// it was spent on — see lib/expense-types.ts for what an expense is and isn't.
//
// Its own database file rather than a table inside stock.db or receipts.db:
// nothing here is ever written in the same transaction as a ledger entry or a
// receipt, and a separate file keeps this feature's migrations from colliding
// with theirs (each database carries one PRAGMA user_version).
//
// Native only (iOS/Android) — the same split as lib/stock-db.ts and
// lib/customer-db.ts. expo-sqlite's web build statically imports a .wasm asset
// this app has no Metro config for, so even making `import 'expo-sqlite'`
// reachable from the web bundle graph fails the whole build. expense-db.web.ts
// is the platform-matched stub Metro picks instead — keep the split.

let dbPromise: Promise<SQLiteDatabase> | null = null;

function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabaseAsync('expenses.db').then(async (db) => {
      // Created whole rather than grown by migrations, because this table is
      // new — there is no install anywhere with an older shape of it. Future
      // changes go in a migrate* function gated on PRAGMA user_version, the way
      // the other two databases do it.
      //
      // `deleted` exists from the start for the same reason it does on
      // customers: an uploaded expense cannot be hard-deleted (firestore.rules
      // refuses every delete under /runs), so removing one has to be a *change*
      // the server can receive, not an absence it has to infer.
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          title TEXT NOT NULL,
          amount REAL NOT NULL,
          notes TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0,
          sync_state TEXT NOT NULL DEFAULT 'pending',
          sync_attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_expenses_run_created
          ON expenses(run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_expenses_pending
          ON expenses(created_at) WHERE sync_state = 'pending';
      `);
      // The cash count (lib/cash-count.ts) lives in this file because it is
      // the other half of the same Home card, and like an expense it is scoped
      // to the run. Version 2 adds it. `CREATE TABLE IF NOT EXISTS` is safe to
      // run on every open, on a new install and on a version-1 one alike, so
      // this needs no separate migration step.
      //
      // One row per run, overwritten on save: it is a snapshot of the bag, not
      // a log. One column per bill rather than a JSON blob so it can be summed
      // in SQL if that is ever wanted, and so a typo in a key can't silently
      // lose a denomination.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS cash_counts (
          run_id TEXT PRIMARY KEY,
          bills_1000 INTEGER NOT NULL,
          bills_500 INTEGER NOT NULL,
          bills_200 INTEGER NOT NULL,
          bills_100 INTEGER NOT NULL,
          bills_50 INTEGER NOT NULL,
          bills_20 INTEGER NOT NULL,
          coins REAL NOT NULL,
          updated_at INTEGER NOT NULL,
          sync_state TEXT NOT NULL DEFAULT 'pending',
          sync_attempts INTEGER NOT NULL DEFAULT 0
        );
      `);
      await migrateCashCountSync(db);
      return db;
    });
    dbPromise = dbPromise.catch((error: unknown) => {
      // Never leave a *rejected* promise cached — see the same guard in
      // lib/stock-db.ts. One bad open would otherwise fail every later call for
      // the life of the app, and no "Try again" could recover it.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/**
 * Version 3: the cash count uploads now, so its rows get the same
 * `sync_state` / `sync_attempts` pair every uploadable row has.
 *
 * Version 2 created the table without them, and `CREATE TABLE IF NOT EXISTS`
 * leaves an existing table exactly as it was — so a phone that ran version 2
 * needs the columns added. Checked against the table itself rather than trusted
 * to the version number alone, so a half-finished earlier attempt can't make it
 * add a column twice (which SQLite refuses). Existing counts arrive 'pending'
 * and upload on the next pass, which is what they should do.
 */
async function migrateCashCountSync(db: SQLiteDatabase): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) >= 3) return;
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(cash_counts)');
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has('sync_state')) {
    await db.execAsync("ALTER TABLE cash_counts ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!has('sync_attempts')) {
    await db.execAsync('ALTER TABLE cash_counts ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0');
  }
  await db.execAsync('PRAGMA user_version = 3');
}

type ExpenseRow = {
  id: string;
  run_id: string;
  title: string;
  amount: number;
  notes: string;
  created_at: number;
  updated_at: number;
  /** SQLite has no boolean — 0 or 1. */
  deleted: number;
};

function rowToExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    amount: row.amount,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One run's expenses, newest first — everything the Expenses screen shows.
 *
 * Scoped to the run, and deleted rows are left out. A run holds a handful of
 * these (a tank of fuel, a toll, lunch), so unlike receipts there is no paging:
 * the whole run's list is small enough to hold and small enough to read.
 */
export async function loadExpensesForRun(runId: string): Promise<Expense[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ExpenseRow>(
    'SELECT * FROM expenses WHERE run_id = ? AND deleted = 0 ORDER BY created_at DESC',
    runId
  );
  return rows.map(rowToExpense);
}

/**
 * Records an expense.
 *
 * `expenseId` is what makes a retry safe, and it has to come from the caller for
 * the same reason `addBatch`'s does: two identical expenses are a perfectly
 * ordinary thing (two ₱50 tolls in a day), so nothing in the row itself can tell
 * "the same expense written twice" from "two expenses". The key is the *user's
 * action* — the Add button mints one id per press and hands it to every retry of
 * that press. Two presses, two expenses; one press retried five times, one
 * expense.
 *
 * Every value is bound as a `?` parameter, never spliced into the SQL string,
 * and `sanitizeExpenseInput` runs here rather than only in the form so it holds
 * for any future caller.
 */
export async function insertExpense(
  runId: string,
  input: ExpenseInput,
  expenseId?: string
): Promise<Expense> {
  const db = await getDb();
  const now = Date.now();
  const clean = sanitizeExpenseInput(input);
  const expense: Expense = {
    ...clean,
    id: expenseId ?? generateId(),
    runId,
    createdAt: now,
    updatedAt: now,
  };

  const inserted = await db.runAsync(
    `INSERT OR IGNORE INTO expenses (id, run_id, title, amount, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    expense.id,
    expense.runId,
    expense.title,
    expense.amount,
    expense.notes,
    expense.createdAt,
    expense.updatedAt
  );

  // The id was already taken, so this is a repeat of a write that had actually
  // landed. Report the row really on disk — its values are the ones the list on
  // screen has to agree with.
  if (inserted.changes === 0) {
    const existing = await db.getFirstAsync<ExpenseRow>('SELECT * FROM expenses WHERE id = ?', expense.id);
    if (existing) return rowToExpense(existing);
  }

  return expense;
}

/**
 * Removes an expense — a **soft** delete, like a customer's.
 *
 * A hard delete cannot be synced: `firestore.rules` refuses every delete under
 * `/runs`, so a row simply vanishing here would leave the server holding an
 * expense nothing will ever retract. Flagging the row and bumping `updated_at`
 * makes the removal itself the change that uploads.
 *
 * Naturally idempotent — it sets fixed values on a known row — so a retry of a
 * write that had already committed changes nothing but the timestamp.
 */
export async function deleteExpenseRow(id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  // Back to 'pending', with the attempt counter cleared: those counts are
  // evidence about the version that failed to upload, and this is a different
  // version. See updateCustomerRow in lib/customer-db.ts.
  await db.runAsync(
    "UPDATE expenses SET deleted = 1, updated_at = ?, sync_state = 'pending', sync_attempts = 0 WHERE id = ?",
    now,
    id
  );
}

// ---------------------------------------------------------------------------
// Cash count
// ---------------------------------------------------------------------------

type CashCountRow = {
  run_id: string;
  bills_1000: number;
  bills_500: number;
  bills_200: number;
  bills_100: number;
  bills_50: number;
  bills_20: number;
  coins: number;
  updated_at: number;
};

/** This run's cash count, or null if the driver hasn't saved one yet. */
export async function loadCashCountForRun(runId: string): Promise<CashCount | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CashCountRow>('SELECT * FROM cash_counts WHERE run_id = ?', runId);
  return row ? rowToCashCount(row) : null;
}

function rowToCashCount(row: CashCountRow): CashCount {
  return {
    runId: row.run_id,
    bills: {
      1000: row.bills_1000,
      500: row.bills_500,
      200: row.bills_200,
      100: row.bills_100,
      50: row.bills_50,
      20: row.bills_20,
    },
    coins: row.coins,
    updatedAt: row.updated_at,
  };
}

/**
 * Saves this run's cash count, replacing any earlier one, and queues it to upload.
 *
 * An upsert keyed on the run, so it is naturally idempotent: a retry of a save
 * that had actually committed writes the same numbers again and nothing else.
 * Every save goes back to 'pending' with the attempt counter cleared — those
 * counts were about the version that failed, and this is a new one.
 */
export async function saveCashCountForRun(runId: string, input: CashCountInput): Promise<CashCount> {
  const db = await getDb();
  const clean = sanitizeCashCountInput(input);
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO cash_counts (run_id, bills_1000, bills_500, bills_200, bills_100, bills_50, bills_20, coins, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       bills_1000 = excluded.bills_1000,
       bills_500 = excluded.bills_500,
       bills_200 = excluded.bills_200,
       bills_100 = excluded.bills_100,
       bills_50 = excluded.bills_50,
       bills_20 = excluded.bills_20,
       coins = excluded.coins,
       updated_at = excluded.updated_at,
       sync_state = 'pending',
       sync_attempts = 0`,
    runId,
    clean.bills[1000],
    clean.bills[500],
    clean.bills[200],
    clean.bills[100],
    clean.bills[50],
    clean.bills[20],
    clean.coins,
    now
  );
  return { ...clean, runId, updatedAt: now };
}

/** True when this run has at least one expense still standing — one of the two things "End the Day" asks for. */
export async function runHasExpense(runId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ found: number }>(
    'SELECT EXISTS(SELECT 1 FROM expenses WHERE run_id = ? AND deleted = 0) AS found',
    runId
  );
  return row?.found === 1;
}

// Cash count sync — the same queue shape as expenses below, keyed on the run
// because there is one count per run. See drainCashCounts in context/sync.tsx.

/** Cash counts not yet pushed to Firestore, oldest change first, capped. */
export async function loadPendingCashCounts(limit: number): Promise<CashCount[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CashCountRow>(
    "SELECT * FROM cash_counts WHERE sync_state = 'pending' ORDER BY updated_at ASC LIMIT ?",
    limit
  );
  return rows.map(rowToCashCount);
}

export async function countPendingCashCounts(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM cash_counts WHERE sync_state = 'pending'"
  );
  return row?.count ?? 0;
}

export async function countBlockedCashCounts(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM cash_counts WHERE sync_state = 'blocked'"
  );
  return row?.count ?? 0;
}

export async function countBlockedCashCountsForRun(runId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM cash_counts WHERE sync_state = 'blocked' AND run_id = ?",
    runId
  );
  return row?.count ?? 0;
}

export async function countSyncedCashCounts(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM cash_counts WHERE sync_state = 'synced'"
  );
  return row?.count ?? 0;
}

export async function bumpCashCountAttempts(runId: string): Promise<number> {
  const db = await getDb();
  await db.runAsync('UPDATE cash_counts SET sync_attempts = sync_attempts + 1 WHERE run_id = ?', runId);
  const row = await db.getFirstAsync<{ sync_attempts: number }>(
    'SELECT sync_attempts FROM cash_counts WHERE run_id = ?',
    runId
  );
  return row?.sync_attempts ?? 0;
}

export async function markCashCountBlocked(runId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE cash_counts SET sync_state = 'blocked' WHERE run_id = ?", runId);
}

export async function retryBlockedCashCounts(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "UPDATE cash_counts SET sync_state = 'pending', sync_attempts = 0 WHERE sync_state = 'blocked'"
  );
  return result.changes;
}

/**
 * Marks a count synced, but only if it hasn't been re-saved since the upload
 * started — the same `updated_at` guard as markExpenseSynced. A driver can
 * recount while the previous count is in the air, and an unguarded mark would
 * record the *new* count as uploaded when the server holds the old one.
 */
export async function markCashCountSynced(runId: string, updatedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE cash_counts SET sync_state = 'synced' WHERE run_id = ? AND updated_at = ?",
    runId,
    updatedAt
  );
}

export async function markCashCountLegacy(runId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE cash_counts SET sync_state = 'legacy' WHERE run_id = ?", runId);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** A row on its way up, including the soft-delete flag the server needs to see. */
export type PendingExpense = Expense & { deleted: boolean };

/**
 * Expenses not yet pushed to Firestore, oldest change first, capped.
 *
 * Not filtered to the run that is open now: a run may end with rows still
 * queued, and those keep uploading into the run they were written in. Each
 * carries its own `runId` so the drain can stamp it correctly — see
 * drainExpenses in context/sync.tsx.
 */
export async function loadPendingExpenses(limit: number): Promise<PendingExpense[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ExpenseRow>(
    "SELECT * FROM expenses WHERE sync_state = 'pending' ORDER BY updated_at ASC LIMIT ?",
    limit
  );
  return rows.map((row) => ({ ...rowToExpense(row), deleted: row.deleted === 1 }));
}

/** How many expenses are still waiting to upload — part of the number "End the Day" reports. */
export async function countPendingExpenses(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM expenses WHERE sync_state = 'pending'"
  );
  return row?.count ?? 0;
}

/**
 * One run's expenses as the manifest reports them.
 *
 * The two figures deliberately count different sets, and both are right:
 *
 * - `expenseCount` counts **every row**, deleted ones included, because it is a
 *   count of *documents this phone sent* and the dashboard checks it against the
 *   documents that arrived. A deleted expense is still a document.
 * - `expenseTotal` sums only the live ones, because it is a count of *money the
 *   truck spent*, and a deleted expense wasn't spent.
 */
export async function summarizeExpensesForRun(
  runId: string
): Promise<{ expenseCount: number; expenseTotal: number }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number; total: number | null }>(
    `SELECT COUNT(*) AS count,
            SUM(CASE WHEN deleted = 0 THEN amount ELSE 0 END) AS total
     FROM expenses WHERE run_id = ?`,
    runId
  );
  return { expenseCount: row?.count ?? 0, expenseTotal: row?.total ?? 0 };
}

/**
 * Counts one unrecognised upload failure and reports the running total — the
 * twin of bumpBatchAttempts in lib/stock-db.ts. Only failures the drain can't
 * classify are counted, so a phone with no signal never accumulates these.
 */
export async function bumpExpenseAttempts(id: string): Promise<number> {
  const db = await getDb();
  await db.runAsync('UPDATE expenses SET sync_attempts = sync_attempts + 1 WHERE id = ?', id);
  const row = await db.getFirstAsync<{ sync_attempts: number }>(
    'SELECT sync_attempts FROM expenses WHERE id = ?',
    id
  );
  return row?.sync_attempts ?? 0;
}

/** Sets an expense aside after the server refused it — see markBatchBlocked in lib/stock-db.ts. */
export async function markExpenseBlocked(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE expenses SET sync_state = 'blocked' WHERE id = ?", id);
}

/** Expenses the server refused. Reported to the user; never retried on their own. */
export async function countBlockedExpenses(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM expenses WHERE sync_state = 'blocked'"
  );
  return row?.count ?? 0;
}

/** The same, but only for one run — what that run's manifest reports. */
export async function countBlockedExpensesForRun(runId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM expenses WHERE sync_state = 'blocked' AND run_id = ?",
    runId
  );
  return row?.count ?? 0;
}

/** Puts every refused expense back in the queue — see retryBlockedBatches in lib/stock-db.ts. */
export async function retryBlockedExpenses(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "UPDATE expenses SET sync_state = 'pending', sync_attempts = 0 WHERE sync_state = 'blocked'"
  );
  return result.changes;
}

/**
 * Marks a row synced, but only if it hasn't changed since the upload started.
 *
 * The `updated_at = ?` guard is the point, exactly as it is for customers: an
 * expense can be deleted while its previous version is still in the air, and an
 * unguarded `SET sync_state = 'synced'` would record the *deletion* as uploaded
 * when what actually reached Firestore was the version before it — so the server
 * would keep an expense the driver removed, permanently.
 */
export async function markExpenseSynced(id: string, updatedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE expenses SET sync_state = 'synced' WHERE id = ? AND updated_at = ?",
    id,
    updatedAt
  );
}

/** Expenses the server has confirmed it received — see countSyncedReceipts in lib/receipt-db.ts. */
export async function countSyncedExpenses(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM expenses WHERE sync_state = 'synced'"
  );
  return row?.count ?? 0;
}

/** Retires an expense whose run is no longer known — see markBatchLegacy in lib/stock-db.ts. */
export async function markExpenseLegacy(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE expenses SET sync_state = 'legacy' WHERE id = ?", id);
}
