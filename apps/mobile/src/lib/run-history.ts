import { loadInventoryBatchesForRun } from '@/lib/stock-db';
import { saveRunHistory } from '@/lib/run-history-db';
import type { RunHistoryBatch, RunHistoryEntry, RunHistoryLineItem } from '@/lib/run-history-types';
import { summarizeFinalizedForRun, summarizeRunHistoryForRun } from '@/lib/receipt-db';
import type { RunContext } from '@/lib/sync-types';

/**
 * Builds and saves one run's local-only history snapshot — see
 * lib/run-history-types.ts for what this is for and why it's never uploaded.
 *
 * Called exactly once, from context/sync.tsx's endTheDay, right after the run
 * is confirmed closed. Deliberately **not** part of the manifest upload or the
 * sync queue: everything it reads (the ledger, receipts) has already uploaded
 * on its own, so a failure here costs nothing but this one convenience view —
 * the caller logs and moves on rather than treating it as a reason to fail
 * "End the Day".
 *
 * `breadTypeNames` resolves the ledger's bare bread-type ids to a display
 * name at the one moment they're all still meaningful. Receipt lines already
 * carry their own name/price snapshot and don't need this map — only the
 * initial count and additions do, since stock_batch_items stores nothing but
 * an id and a quantity.
 */
export async function recordRunHistory(
  run: RunContext,
  closedAt: number,
  breadTypeNames: Map<string, string>
): Promise<void> {
  const [batches, receiptTotals, receiptSummary] = await Promise.all([
    loadInventoryBatchesForRun(run.runId),
    summarizeFinalizedForRun(run.runId),
    summarizeRunHistoryForRun(run.runId),
  ]);

  function resolveName(breadTypeId: string): string {
    return breadTypeNames.get(breadTypeId) ?? 'Unknown bread type';
  }

  function toLineItems(quantities: Map<string, number>): RunHistoryLineItem[] {
    return Array.from(quantities.entries())
      .map(([breadTypeId, quantity]) => ({ breadTypeId, name: resolveName(breadTypeId), quantity }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const initialQuantities = new Map<string, number>();
  const totalQuantities = new Map<string, number>();
  const additions: RunHistoryBatch[] = [];
  let initialCreatedAt: number | null = null;

  for (const batch of batches) {
    if (batch.kind === 'initial') {
      // Batches arrive oldest first, so the first initial entry is the count.
      if (initialCreatedAt === null) initialCreatedAt = batch.createdAt;
      for (const item of batch.items) {
        initialQuantities.set(item.breadTypeId, (initialQuantities.get(item.breadTypeId) ?? 0) + item.quantity);
        totalQuantities.set(item.breadTypeId, (totalQuantities.get(item.breadTypeId) ?? 0) + item.quantity);
      }
    } else {
      additions.push({
        id: batch.id,
        createdAt: batch.createdAt,
        items: batch.items
          .map((item) => ({ breadTypeId: item.breadTypeId, name: resolveName(item.breadTypeId), quantity: item.quantity }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      for (const item of batch.items) {
        totalQuantities.set(item.breadTypeId, (totalQuantities.get(item.breadTypeId) ?? 0) + item.quantity);
      }
    }
  }
  // Oldest first for reading like a log, but the most recent addition is what
  // a trucker checking "did that last batch get counted" wants on top.
  additions.reverse();

  const entry: RunHistoryEntry = {
    runId: run.runId,
    businessDay: run.businessDay,
    truckName: run.truckName,
    agentNames: run.agents.map((agent) => agent.name),
    startedAt: run.startedAt,
    closedAt,
    receiptCount: receiptTotals.receiptCount,
    salesTotal: receiptTotals.salesTotal,
    returnsTotal: receiptTotals.returnsTotal,
    money: {
      cash: receiptSummary.cashTotal,
      gcash: receiptSummary.gcashTotal,
      cheque: receiptSummary.chequeTotal,
      partial: receiptSummary.partialTotal,
      partialPaid: receiptSummary.partialPaidTotal,
      credit: receiptSummary.creditTotal,
    },
    initial: toLineItems(initialQuantities),
    initialCreatedAt,
    additions,
    totalInventory: toLineItems(totalQuantities),
    sold: receiptSummary.sold.sort((a, b) => a.name.localeCompare(b.name)),
    returned: receiptSummary.returned.sort((a, b) => a.name.localeCompare(b.name)),
  };

  await saveRunHistory(entry);
}
