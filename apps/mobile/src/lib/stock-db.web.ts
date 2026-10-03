import type { Batch, StockState } from '@/lib/stock-types';

// Metro's web-platform stand-in for stock-db.ts — see the comment there for
// why this split exists. Every export throws; context/stock.tsx's load
// effect catches that and shows a "not available on web" message instead of
// crashing.

const UNAVAILABLE_MESSAGE = 'Inventory isn’t available on web yet — use the app on a phone.';

export async function loadStockState(_runId: string): Promise<StockState> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function loadRunTotals(_runId: string): Promise<Record<string, number>> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function saveDraft(
  _runId: string,
  _quantities: Record<string, number>
): Promise<{ savedAt: number; counts: Record<string, number> }> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function finalizeStock(
  _runId: string,
  _quantities: Record<string, number>
): Promise<{ batch: Batch; applied: boolean }> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function addBatch(
  _runId: string,
  _deltas: Record<string, number>,
  _entryId?: string
): Promise<{ batch: Batch; applied: boolean }> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function recordSale(
  _runId: string,
  _quantities: Record<string, number>,
  _receiptId: string | null
): Promise<{ batch: Batch; applied: boolean }> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function recordVoid(_receiptId: string): Promise<{ batch: Batch | null; applied: boolean }> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

// Null is the truthful answer, not a throw: there is no ledger on web, so no
// receipt has ever been deducted here. finalize() reads this to decide whether
// stock still owes a deduction, and a throw would turn "web has no inventory"
// into "could not finalize the receipt".
export async function findSaleBatchForReceipt(_receiptId: string): Promise<Batch | null> {
  return null;
}

// The sync loop's reads answer "nothing to do" rather than throwing. There is
// genuinely no ledger on web, so an empty queue is the truthful answer — and
// context/sync.tsx runs on a timer, where a throw every minute would be noise
// in the console rather than information.
export async function loadPendingBatches(_limit: number): Promise<Batch[]> {
  return [];
}

export async function countPendingBatches(): Promise<number> {
  return 0;
}

export async function countBatchesForRun(_runId: string): Promise<number> {
  return 0;
}

export async function loadInventoryBatchesForRun(_runId: string): Promise<Batch[]> {
  return [];
}

export async function markBatchSynced(_id: string): Promise<void> {}

export async function countSyncedBatches(): Promise<number> {
  return 0;
}

export async function bumpBatchAttempts(_id: string): Promise<number> {
  return 0;
}

export async function markBatchBlocked(_id: string): Promise<void> {}

export async function countBlockedBatchesForRun(_runId: string): Promise<number> {
  return 0;
}

export async function retryBlockedBatches(): Promise<number> {
  return 0;
}

export async function countBlockedBatches(): Promise<number> {
  return 0;
}

export async function markBatchLegacy(_id: string): Promise<void> {}

// Reset is a no-op here rather than throwing — there's never anything to
// clear on web (the ledger never loaded in the first place), and Settings'
// reset action shouldn't fail just because it's running on web.
export async function resetStock(): Promise<void> {}

export async function findVoidsNotReturned(_receiptIds: string[]): Promise<string[]> {
  return [];
}
