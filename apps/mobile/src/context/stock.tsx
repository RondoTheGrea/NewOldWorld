import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';

import { NoOpenRunError, useInventory } from '@/context/inventory';
import { logError } from '@/lib/errors';
import * as stockDb from '@/lib/stock-db';
import type { Batch } from '@/lib/stock-types';
import { requestSync } from '@/lib/sync';

export type { Batch, BatchItem, BatchKind } from '@/lib/stock-types';

/**
 * `'empty'` — nothing saved yet, show the first "Edit Inventory Draft" prompt.
 * `'draft'` — saved at least once, freely re-editable, not locked in yet.
 * `'finalized'` — locked in; stock now only grows via addBatch.
 */
export type StockPhase = 'empty' | 'draft' | 'finalized';

type StockContextValue = {
  phase: StockPhase;
  /** True until the persisted ledger has been read from disk on app start. */
  stockLoading: boolean;
  /** Set when SQLite is unavailable (currently: web) or failed to load. */
  stockError: string | null;
  /** Re-runs the failed load — what the "Try again" button on the error screen calls. */
  reloadStock: () => void;
  /** The quantities to render: the draft while editing, the summed ledger once finalized. */
  displayStock: Record<string, number>;
  /**
   * The finalized "initial" record plus the batches added since, oldest
   * first — for the history view. Excludes `'sale'` entries (receipt
   * finalizations): those still count toward `displayStock`, they just
   * aren't inventory events worth showing here. Filtered and capped by the
   * database query, not here — see loadHistoryBatches in lib/stock-db.ts.
   */
  batches: Batch[];
  /** Overwrites the whole draft. Repeatable — only meaningful before finalize. */
  saveDraft: (quantities: Record<string, number>) => Promise<void>;
  /** Locks the current draft in as the permanent initial-inventory record. */
  finalize: () => Promise<void>;
  /**
   * Records a new delivery as a ledger entry. Only positive deltas are kept.
   *
   * `entryId` marks which user action this is, so a retry of a failed save
   * rewrites the same entry rather than adding a second delivery. Callers that
   * sit inside a retry prompt must mint one per attempt-group and reuse it.
   */
  addBatch: (deltas: Record<string, number>, entryId?: string) => Promise<void>;
  /**
   * Records a finalized receipt's sold quantities, deducting them from stock.
   * Only positive quantities are kept. `receiptId` links the entry back to the
   * receipt that caused it — see the note on `Batch.receiptId`.
   */
  recordSale: (quantities: Record<string, number>, receiptId: string) => Promise<void>;
  /**
   * Puts a voided receipt's bread back on the truck count — exactly what its sale
   * entry took off, or nothing if the sale was never deducted. Safe to repeat.
   */
  recordVoid: (receiptId: string) => Promise<void>;
  /** Wipes the draft, every batch, and the finalize flag — back to `'empty'`. Testing/reset only. */
  resetStock: () => Promise<void>;
};

const StockContext = createContext<StockContextValue | null>(null);

export function useStock() {
  const value = use(StockContext);
  if (!value) {
    throw new Error('useStock must be used inside a <StockProvider>');
  }
  return value;
}

/**
 * Folds one new ledger entry into the running totals.
 *
 * The totals arrive already summed from SQLite (see loadStockState) — the
 * whole ledger is never held in memory, so a new batch is applied to the
 * total here rather than re-summing a list. `recordSale` stores its
 * quantities negative, so the same addition covers a sale.
 */
function applyBatch(totals: Record<string, number>, batch: Batch): Record<string, number> {
  const next = { ...totals };
  for (const item of batch.items) {
    next[item.breadTypeId] = (next[item.breadTypeId] ?? 0) + item.quantity;
  }
  return next;
}

/**
 * Adds one entry to the history list unless it is already in it.
 *
 * The companion to applyBatch for the `applied: false` path: an entry that is
 * on disk but absent from this list belongs on screen, and one that is already
 * here must not appear twice. Matching on id is exact — finalizeStock and
 * addBatch both write under an id derived from the run or minted by the Save
 * press, so the row a repeat lands on is the row that is already here.
 */
function mergeBatch(history: Batch[], batch: Batch): Batch[] {
  if (history.some((entry) => entry.id === batch.id)) return history;
  return [...history, batch];
}

/**
 * Thrown if a ledger write is attempted with no run open.
 *
 * It shouldn't be reachable — every screen that writes stock sits behind the
 * setup wizard — but the ledger is scoped by run, so a write with no run would
 * land in a row nothing can ever read back. Better to fail loudly.
 */
function requireRun(runId: string | null): string {
  if (!runId) throw new NoOpenRunError();
  return runId;
}

export function StockProvider({ children }: PropsWithChildren) {
  // The ledger is per run: what the truck is carrying is what *this* run put on
  // it. That is what lets "End the Day" hand back an empty truck without
  // deleting a thing — the next run simply has no entries yet, while the
  // previous run's are still there and still queued to upload.
  const { runId } = useInventory();
  const [error, setError] = useState<string | null>(null);
  const [draftStock, setDraftStock] = useState<Record<string, number>>({});
  // The ledger summed per bread type, not the ledger itself. A 'sale' entry is
  // appended for every finalized receipt, so the ledger grows without bound —
  // it is summed in SQL and only this result is kept.
  const [totals, setTotals] = useState<Record<string, number>>({});
  // Inventory events for the history view only: initial + additions, already
  // filtered and capped by the query.
  const [historyBatches, setHistoryBatches] = useState<Batch[]>([]);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<number | null>(null);
  // Which run the numbers in state actually belong to. Without it, the moment a
  // new run opens the previous run's stock is still in state and would be shown
  // as the new truck's until the load lands — a wrong number on screen, which
  // is worse than a spinner.
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null);
  // Bumped by reloadStock to re-run the load effect below. A counter rather
  // than a standalone async function so there's exactly one code path that
  // reads the ledger, and the same cancellation guard covers both.
  const [loadToken, setLoadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // No run open — before setup, and again straight after "End the Day".
    // Nothing to read: the Inventory tab is showing the setup wizard, not an
    // empty ledger. What is already in state is masked below rather than
    // cleared here, so this effect never sets state on its own.
    if (!runId) return;

    // On web, stock-db.web.ts (the platform-matched stub Metro loads there)
    // rejects every call — this is the one place that surfaces as an error
    // message instead of a crash.
    stockDb
      .loadStockState(runId)
      .then((state) => {
        if (cancelled) return;
        setDraftStock(state.draftStock);
        setTotals(state.totals);
        setHistoryBatches(state.batches);
        setDraftSavedAt(state.meta.draftSavedAt);
        setFinalizedAt(state.meta.finalizedAt);
        setLoadedRunId(runId);
      })
      .catch((error: unknown) => {
        logError('stock.load', error);
        if (cancelled) return;
        setError(
          Platform.OS === 'web'
            ? 'Inventory isn’t available on web yet — use the app on a phone.'
            : 'Could not load inventory from this phone’s storage.'
        );
      });
    // No `finally` clearing a loading flag: "loading" is derived from whether
    // this run's numbers have arrived yet (see `ready` below), so the failure
    // path can't leave a spinner running — the error message replaces it.

    return () => {
      cancelled = true;
    };
  }, [loadToken, runId]);

  // Back to the loading state here rather than inside the effect: React's
  // lint (and the React Compiler) rule out calling setState straight from an
  // effect body, and this is a button press, which is exactly where it belongs.
  function reloadStock() {
    setError(null);
    setLoadedRunId(null);
    setLoadToken((token) => token + 1);
  }

  // Nothing is shown until the numbers in state belong to the run that is
  // actually open — which covers both "no run" (the setup wizard is up) and
  // "a new run just opened and its load hasn't landed". Masking here rather
  // than clearing in the effect keeps every state change on a user action,
  // which is what React and the compiler's lint want.
  const ready = runId !== null && loadedRunId === runId;
  const phase: StockPhase = !ready ? 'empty' : finalizedAt ? 'finalized' : draftSavedAt ? 'draft' : 'empty';
  const displayStock = !ready ? {} : phase === 'finalized' ? totals : draftStock;

  async function saveDraft(quantities: Record<string, number>) {
    // State takes the counts the database wrote, not the ones passed in:
    // saveDraft floors and clamps them (see sanitizeCounts), and a screen
    // showing a count the disk disagrees with is the number receipts are
    // checked against.
    const { savedAt, counts } = await stockDb.saveDraft(requireRun(runId), quantities);
    setDraftStock(counts);
    setDraftSavedAt(savedAt);
  }

  /**
   * Re-reads the run's totals from SQLite, for the one case the caller can't
   * work out on its own.
   *
   * Used whenever a write comes back `applied: false`. That means the entry is
   * on disk but *this* call didn't put it there — and there are two ways that
   * happens, which need opposite handling. Either an earlier session wrote it
   * (so it is already inside the totals, which arrived summed from SQL at
   * load), or an attempt moments ago committed and then reported failure (so
   * it is missing from them, because only the success path folds a batch in).
   * Nothing in the returned value distinguishes the two. Re-reading is right
   * for both, and it is one covered index scan — see loadRunTotals.
   *
   * Failure is logged, not thrown: the write it follows already succeeded, so
   * failing here would tell the user their save didn't happen when it did. The
   * screen stays as it was and the next app start reads the true numbers.
   */
  async function refreshTotals(forRunId: string) {
    try {
      const fresh = await stockDb.loadRunTotals(forRunId);
      setTotals(fresh);
    } catch (error) {
      logError('stock.refreshTotals', error);
    }
  }

  // Each of the three writers nudges sync after the entry is safely on disk.
  // requestSync() never throws and never waits — a failed upload leaves the
  // row marked pending and the loop tries again later, so nothing here is
  // gated on the network.
  async function finalize() {
    const openRunId = requireRun(runId);
    const { batch, applied } = await stockDb.finalizeStock(openRunId, draftStock);
    if (applied) {
      setTotals((current) => applyBatch(current, batch));
      setHistoryBatches((current) => [...current, batch]);
    } else {
      await refreshTotals(openRunId);
      setHistoryBatches((current) => mergeBatch(current, batch));
    }
    setFinalizedAt(batch.createdAt);
    requestSync();
  }

  // `entryId` identifies one press of Save, so every retry of that press writes
  // the same batch instead of stacking another delivery onto the truck — see
  // addBatch in lib/stock-db.ts for why this key has to come from the caller.
  async function addBatch(deltas: Record<string, number>, entryId?: string) {
    const openRunId = requireRun(runId);
    const { batch, applied } = await stockDb.addBatch(openRunId, deltas, entryId);
    if (applied) {
      setTotals((current) => applyBatch(current, batch));
      setHistoryBatches((current) => [...current, batch]);
    } else {
      await refreshTotals(openRunId);
      setHistoryBatches((current) => mergeBatch(current, batch));
    }
    requestSync();
  }

  // Totals only: a sale moves the count on the truck but isn't an inventory
  // event the history view shows.
  //
  // `applied` is false when this receipt had already been deducted — a repeat
  // is a real path, because finalize() offers the user "Try again" on a failed
  // deduction and can also resume one that was skipped earlier (see
  // context/receipts.tsx). Folding the batch in regardless would subtract the
  // same bread from the on-screen count a second time; re-reading instead is
  // right whether the earlier deduction is already in the totals or not.
  async function recordSale(quantities: Record<string, number>, receiptId: string) {
    const openRunId = requireRun(runId);
    const { batch, applied } = await stockDb.recordSale(openRunId, quantities, receiptId);
    if (applied) setTotals((current) => applyBatch(current, batch));
    else await refreshTotals(openRunId);
    requestSync();
  }

  // The same applied / re-read split as recordSale. `null` means the sale was
  // never deducted, so there is nothing to give back and nothing to upload.
  async function recordVoid(receiptId: string) {
    const openRunId = requireRun(runId);
    const { batch, applied } = await stockDb.recordVoid(receiptId);
    if (!batch) return;
    if (applied && batch.runId === openRunId) setTotals((current) => applyBatch(current, batch));
    else await refreshTotals(openRunId);
    requestSync();
  }

  async function resetStock() {
    await stockDb.resetStock();
    setDraftStock({});
    setTotals({});
    setHistoryBatches([]);
    setDraftSavedAt(null);
    setFinalizedAt(null);
  }

  const value: StockContextValue = {
    phase,
    // Only ever "loading" when there is a run whose numbers haven't arrived.
    // With no run open the Inventory tab is showing the setup wizard, which
    // must not sit behind a spinner.
    stockLoading: runId !== null && !ready && error === null,
    stockError: error,
    reloadStock,
    displayStock,
    batches: ready ? historyBatches : [],
    saveDraft,
    finalize,
    addBatch,
    recordSale,
    recordVoid,
    resetStock,
  };

  return <StockContext value={value}>{children}</StockContext>;
}
