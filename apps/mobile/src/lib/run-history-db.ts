import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type {
  RunHistoryBatch,
  RunHistoryEntry,
  RunHistoryLineItem,
  RunHistoryMoney,
  RunHistoryMoneyLineItem,
  RunHistorySummary,
} from '@/lib/run-history-types';

// A local-only record of finished runs — see lib/run-history-types.ts for what
// this is and isn't. Its own database file, like expenses.db: nothing here is
// ever written in the same transaction as a ledger entry or a receipt, and it
// has nothing to sync, so it needs none of the sync_state machinery those
// files carry.
//
// One row is written per run, once, when "End the Day" closes it (see
// lib/run-history.ts and context/sync.tsx) — not recomputed live on every
// open. The ledger and receipts it's built from are never deleted, so it
// *could* be recomputed on demand, but summing a growing receipts table for
// every past run every time this list is opened gets slower forever; a
// snapshot taken once, at the one moment the run's numbers are final, stays
// cheap no matter how many runs accumulate.
//
// Native only (iOS/Android) — same split as stock-db.ts/expense-db.ts.
// expo-sqlite's web build statically imports a .wasm asset this app has no
// Metro config for. run-history-db.web.ts is the platform-matched stub Metro
// picks instead when bundling for web — keep the split.

let dbPromise: Promise<SQLiteDatabase> | null = null;

function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabaseAsync('run_history.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS run_history (
          run_id TEXT PRIMARY KEY,
          business_day TEXT NOT NULL,
          area_name TEXT NOT NULL,
          truck_name TEXT NOT NULL,
          agent_group_name TEXT NOT NULL DEFAULT '',
          agent_names TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          closed_at INTEGER NOT NULL,
          receipt_count INTEGER NOT NULL,
          sales_total REAL NOT NULL,
          returns_total REAL NOT NULL,
          cash_total REAL NOT NULL,
          gcash_total REAL NOT NULL,
          other_total REAL NOT NULL,
          cheque_total REAL NOT NULL DEFAULT 0,
          partial_total REAL NOT NULL DEFAULT 0,
          partial_paid_total REAL NOT NULL DEFAULT 0,
          credit_total REAL NOT NULL DEFAULT 0,
          initial_json TEXT NOT NULL,
          initial_created_at INTEGER,
          additions_json TEXT NOT NULL,
          total_inventory_json TEXT NOT NULL,
          sold_json TEXT NOT NULL,
          returned_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_history_closed_at ON run_history(closed_at DESC);
      `);
      const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(run_history)');
      const knownColumns = new Set(columns.map((column) => column.name));
      for (const column of ['cheque_total', 'partial_total', 'partial_paid_total', 'credit_total']) {
        if (!knownColumns.has(column)) await db.execAsync(`ALTER TABLE run_history ADD COLUMN ${column} REAL NOT NULL DEFAULT 0`);
      }
      // Agents used to be picked one at a time; they're now assigned as a crew.
      // A run closed before that has no crew to name, and defaults to '' —
      // which the history screen renders as "No crew recorded" rather than
      // inventing one.
      if (!knownColumns.has('agent_group_name')) {
        await db.execAsync(`ALTER TABLE run_history ADD COLUMN agent_group_name TEXT NOT NULL DEFAULT ''`);
      }
      // When the initial count was written. Nullable, and nothing is
      // backfilled: an older snapshot reads null and the detail loader looks
      // the time up in the ledger instead (context/run-history.tsx).
      if (!knownColumns.has('initial_created_at')) {
        await db.execAsync('ALTER TABLE run_history ADD COLUMN initial_created_at INTEGER');
      }
      // 'Consignment' was renamed to 'Credit'. A table written before the
      // rename holds those figures under the old column, and the new one was
      // just added defaulting to 0 — so carry them across once, or every
      // finished run in the history would read ₱0.00 on that line. The old
      // column is left in place: nothing reads it, and dropping a column is
      // more risk than an unused one is worth.
      if (!knownColumns.has('credit_total') && knownColumns.has('consignment_total')) {
        await db.execAsync('UPDATE run_history SET credit_total = consignment_total');
      }
      return db;
    });
    dbPromise = dbPromise.catch((error: unknown) => {
      // Never leave a *rejected* promise cached — see the same guard in
      // lib/stock-db.ts.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

type RunHistoryRow = {
  run_id: string;
  business_day: string;
  area_name: string;
  truck_name: string;
  agent_group_name: string;
  agent_names: string;
  started_at: number;
  closed_at: number;
  receipt_count: number;
  sales_total: number;
  returns_total: number;
  cash_total: number;
  gcash_total: number;
  other_total: number;
  cheque_total: number;
  partial_total: number;
  partial_paid_total: number;
  credit_total: number;
};

function rowToSummary(row: RunHistoryRow): RunHistorySummary {
  return {
    runId: row.run_id,
    businessDay: row.business_day,
    areaName: row.area_name,
    truckName: row.truck_name,
    agentGroupName: row.agent_group_name ?? '',
    agentNames: JSON.parse(row.agent_names) as string[],
    startedAt: row.started_at,
    closedAt: row.closed_at,
    receiptCount: row.receipt_count,
    salesTotal: row.sales_total,
    returnsTotal: row.returns_total,
    money: {
      cash: row.cash_total,
      gcash: row.gcash_total,
      cheque: row.cheque_total,
      partial: row.partial_total,
      partialPaid: row.partial_paid_total,
      credit: row.credit_total,
    },
  };
}

/**
 * Every finished run on this phone, newest first.
 *
 * Only the summary columns — no JSON blobs — so a truck with months of history
 * still opens the list instantly. Full detail is loaded per run, on demand, by
 * loadRunHistoryDetail.
 */
export async function loadRunHistorySummaries(): Promise<RunHistorySummary[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RunHistoryRow>(
    `SELECT run_id, business_day, area_name, truck_name, agent_group_name, agent_names, started_at, closed_at,
            receipt_count, sales_total, returns_total, cash_total, gcash_total, other_total,
            cheque_total, partial_total, partial_paid_total, credit_total
     FROM run_history ORDER BY closed_at DESC`
  );
  return rows.map(rowToSummary);
}

/** One run's full breakdown — initial count, batches, totals, sold, returned. */
export async function loadRunHistoryDetail(runId: string): Promise<RunHistoryEntry | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<
    RunHistoryRow & {
      initial_json: string;
      initial_created_at: number | null;
      additions_json: string;
      total_inventory_json: string;
      sold_json: string;
      returned_json: string;
    }
  >('SELECT * FROM run_history WHERE run_id = ?', runId);
  if (!row) return null;

  return {
    ...rowToSummary(row),
    initial: JSON.parse(row.initial_json) as RunHistoryLineItem[],
    initialCreatedAt: row.initial_created_at ?? null,
    additions: JSON.parse(row.additions_json) as RunHistoryBatch[],
    totalInventory: JSON.parse(row.total_inventory_json) as RunHistoryLineItem[],
    sold: JSON.parse(row.sold_json) as RunHistoryMoneyLineItem[],
    returned: JSON.parse(row.returned_json) as RunHistoryMoneyLineItem[],
  };
}

/**
 * Writes one run's snapshot. `INSERT OR REPLACE`, keyed by run id, so calling
 * this twice for the same run (which shouldn't happen — a run only closes
 * once — see lib/run-history.ts) overwrites rather than duplicates.
 */
export async function saveRunHistory(entry: RunHistoryEntry): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO run_history (
      run_id, business_day, area_name, truck_name, agent_group_name, agent_names, started_at, closed_at,
      receipt_count, sales_total, returns_total, cash_total, gcash_total, other_total,
      cheque_total, partial_total, partial_paid_total, credit_total,
      initial_json, additions_json, total_inventory_json, sold_json, returned_json, initial_created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entry.runId,
    entry.businessDay,
    entry.areaName,
    entry.truckName,
    entry.agentGroupName,
    JSON.stringify(entry.agentNames),
    entry.startedAt,
    entry.closedAt,
    entry.receiptCount,
    entry.salesTotal,
    entry.returnsTotal,
    entry.money.cash,
    entry.money.gcash,
    0,
    entry.money.cheque,
    entry.money.partial,
    entry.money.partialPaid,
    entry.money.credit,
    JSON.stringify(entry.initial),
    JSON.stringify(entry.additions),
    JSON.stringify(entry.totalInventory),
    JSON.stringify(entry.sold),
    JSON.stringify(entry.returned),
    entry.initialCreatedAt
  );
}

/** Wipes every saved run summary. Settings maintenance action only — the runs themselves are unaffected. */
export async function clearRunHistory(): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM run_history');
}

export type { RunHistoryEntry, RunHistoryMoney, RunHistorySummary };
