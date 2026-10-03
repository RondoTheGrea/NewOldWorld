// Shared between stock-db.ts (native, real SQLite) and stock-db.web.ts (stub)
// so neither has to import the other — Metro picks whichever one matches the
// build platform, and this file is the only thing both sides depend on.

/**
 * `'void'` is a voided receipt's bread going back on the truck — the mirror of
 * that receipt's `'sale'`, with the same quantities stored positive. Its own kind
 * rather than an `'addition'`, because an addition is a delivery: the dashboard
 * counts it as bread *loaded*, where a void is bread that turned out not to have
 * been *sold*.
 */
export type BatchKind = 'initial' | 'addition' | 'sale' | 'void';

/** `quantity` is always a count of individual pieces, never packaging units (tray/box) — see lib/bread-unit.ts. */
export type BatchItem = { breadTypeId: string; quantity: number };

export type Batch = {
  id: string;
  kind: BatchKind;
  createdAt: number;
  items: BatchItem[];
  /**
   * The receipt whose finalization created this entry — set on `'sale'` and on
   * `'void'` (the receipt that was voided), null for `'initial'` and
   * `'addition'`.
   *
   * Exists so the uploaded ledger can be reconciled against the uploaded
   * receipts: finalizing writes to two databases in two transactions, and this
   * is what lets a dashboard tell "the sale entry for receipt X is missing"
   * apart from "receipt X was never finalized".
   */
  receiptId: string | null;
  /**
   * The run this entry was written during — see context/inventory.tsx.
   *
   * It is what makes "the truck's stock" a per-run number: totals and history
   * are filtered by it, so a second run of the day starts empty without
   * anything being deleted. It is also the run an entry uploads *into*, which
   * is why it is stored on the row rather than read from the current setup when
   * the upload happens — a queued entry from this morning's run must not land
   * in this afternoon's.
   *
   * Null only on entries written before runs existed; those are marked
   * `'legacy'` and never upload.
   */
  runId: string | null;
};

export type StockMeta = {
  draftSavedAt: number | null;
  finalizedAt: number | null;
};

export type StockState = {
  meta: StockMeta;
  draftStock: Record<string, number>;
  /**
   * The ledger summed per bread type — every entry ever written, sales
   * included. Added in SQL rather than by loading the ledger into memory: a
   * 'sale' entry is appended for every finalized receipt, so the ledger grows
   * for the life of the app, while this stays one row per bread type. See
   * loadStockState in stock-db.ts.
   */
  totals: Record<string, number>;
  /**
   * Inventory events worth showing in the history view — the initial count and
   * the batches added since, oldest first. Excludes 'sale' entries (they count
   * toward `totals`, they just aren't inventory events), and only the most
   * recent additions are loaded — see HistoryAdditionLimit in stock-db.ts.
   */
  batches: Batch[];
};
