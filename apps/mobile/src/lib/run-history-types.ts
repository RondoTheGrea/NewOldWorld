// Shared between run-history-db.ts (native, real SQLite) and
// run-history-db.web.ts (stub) — same split as stock-types.ts.

/**
 * A local-only record of one finished run, for the trucker's own reference.
 *
 * **This never leaves the phone.** Everything it's built from (the ledger,
 * receipts) already uploads on its own; this is a second, read-only copy kept
 * only so a trucker can look back at "how much bread moved" without hunting
 * through the Inventory and Receipts tabs. See lib/run-history.ts for how it's
 * assembled and lib/run-history-db.ts for why it's snapshotted once at close
 * rather than recomputed live.
 */

/** One bread type's quantity, name resolved at snapshot time. */
export type RunHistoryLineItem = {
  breadTypeId: string;
  name: string;
  quantity: number;
};

/** Same, plus the peso value of that quantity — for sold and returned lines. */
export type RunHistoryMoneyLineItem = RunHistoryLineItem & {
  amount: number;
};

/** One addition to the truck during the run — the initial count is kept separately. */
export type RunHistoryBatch = {
  id: string;
  createdAt: number;
  items: RunHistoryLineItem[];
};

/** Money actually recorded for the run, bucketed the way a trucker thinks about it. */
export type RunHistoryMoney = {
  cash: number;
  gcash: number;
  /** Cheque receipts, paid in full at finalize. */
  cheque: number;
  /** Sum of receipt totals for every 'partial' payment — the full amount owed. */
  partial: number;
  /** Down payments collected on 'partial' receipts at finalize. */
  partialPaid: number;
  credit: number;
};

/** What the runs list shows without opening a run — cheap to load many of. */
export type RunHistorySummary = {
  runId: string;
  businessDay: string;
  truckName: string;
  /** Who was on the truck when the run started — as their names read then. */
  agentNames: string[];
  startedAt: number;
  closedAt: number;
  receiptCount: number;
  /** Sum of receipt subtotals, before returns — matches RunManifest.salesTotal. */
  salesTotal: number;
  /** Peso value written off as returns — matches RunManifest.returnsTotal. */
  returnsTotal: number;
  money: RunHistoryMoney;
};

/** The full breakdown, loaded only when a trucker opens one run. */
export type RunHistoryEntry = RunHistorySummary & {
  initial: RunHistoryLineItem[];
  /**
   * When the initial count was written. Null on a snapshot saved before this
   * was recorded — context/run-history.tsx then reads it off the ledger — or on
   * a run with no initial count at all.
   */
  initialCreatedAt: number | null;
  additions: RunHistoryBatch[];
  /** initial + every addition, summed per bread type — "what went out on the truck". */
  totalInventory: RunHistoryLineItem[];
  sold: RunHistoryMoneyLineItem[];
  returned: RunHistoryMoneyLineItem[];
};
