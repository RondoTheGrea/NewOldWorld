import type {
  PaymentMethod,
  PendingReceipt,
  ReceiptDetail,
  ReceiptDraftInput,
  ReceiptPageCursor,
  ReceiptPaymentProof,
  ReceiptSummary,
} from '@/lib/receipt-types';

// Metro's web-platform stand-in for receipt-db.ts — see the comment there for
// why this split exists. Every export throws; context/receipts.tsx's load
// effect catches that and shows a "not available on web" message instead of
// crashing.

const UNAVAILABLE_MESSAGE = 'Receipts aren’t available on web yet — use the app on a phone.';

export async function loadReceiptPage(_cursor: ReceiptPageCursor | null, _limit: number): Promise<ReceiptSummary[]> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function getReceiptDetail(_id: string): Promise<ReceiptDetail> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function searchReceipts(_query: string, _limit: number): Promise<ReceiptSummary[]> {
  return [];
}

export async function loadCustomerReceiptPage(
  _customerId: string,
  _cursor: ReceiptPageCursor | null,
  _limit: number
): Promise<ReceiptSummary[]> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function findDraftReceipt(): Promise<ReceiptSummary | null> {
  return null;
}

export async function createDraft(_input: ReceiptDraftInput): Promise<ReceiptDetail> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function updateDraft(_id: string, _input: ReceiptDraftInput): Promise<ReceiptDetail> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function deleteDraft(_id: string): Promise<void> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function markFinalized(
  _id: string,
  _runId: string,
  _paymentMethod: PaymentMethod,
  _amountPaid: number | null,
  _agentNames: string | null
): Promise<{ finalizedAt: number }> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function markVoided(_id: string, _runId: string): Promise<{ voidedAt: number }> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

// Sync's reads answer "nothing to do" rather than throwing — see the matching
// note in stock-db.web.ts.
export async function loadPendingReceipts(_limit: number): Promise<PendingReceipt[]> {
  return [];
}

export async function countPendingReceipts(): Promise<number> {
  return 0;
}

export async function markReceiptSynced(_id: string, _uploadedVoidedAt: number | null): Promise<void> {}

export async function countSyncedReceipts(): Promise<number> {
  return 0;
}

export async function bumpReceiptAttempts(_id: string): Promise<number> {
  return 0;
}

export async function markReceiptBlocked(_id: string): Promise<void> {}

export async function countBlockedReceiptsForRun(_runId: string): Promise<number> {
  return 0;
}

export async function retryBlockedReceipts(): Promise<number> {
  return 0;
}

export async function countBlockedReceipts(): Promise<number> {
  return 0;
}

export async function markReceiptLegacy(_id: string): Promise<void> {}

export async function summarizeFinalizedForRun(
  _runId: string
): Promise<{ receiptCount: number; voidedCount: number; salesTotal: number; returnsTotal: number }> {
  return { receiptCount: 0, voidedCount: 0, salesTotal: 0, returnsTotal: 0 };
}

export async function summarizeRunHistoryForRun(_runId: string): Promise<{
  sold: { breadTypeId: string; name: string; quantity: number; amount: number }[];
  returned: { breadTypeId: string; name: string; quantity: number; amount: number }[];
  cashTotal: number;
  gcashTotal: number;
  chequeTotal: number;
  partialTotal: number;
  partialPaidTotal: number;
  creditTotal: number;
}> {
  return {
    sold: [],
    returned: [],
    cashTotal: 0,
    gcashTotal: 0,
    chequeTotal: 0,
    partialTotal: 0,
    partialPaidTotal: 0,
    creditTotal: 0,
  };
}

export async function getPaymentProof(_receiptId: string): Promise<ReceiptPaymentProof | null> {
  return null;
}

export async function setPaymentProof(_receiptId: string, _fileName: string, _localUri: string): Promise<ReceiptPaymentProof> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

// The proof photo upload queue, matching lib/receipt-db.ts. Present so the sync
// pass doesn't call an undefined export on web: there are no photos here, so
// every read answers "nothing to do" rather than throwing — see the same choice
// in stock-db.web.ts.
export type PendingPaymentProof = ReceiptPaymentProof & { runId: string | null };

export async function loadPendingPaymentProofs(_limit: number): Promise<PendingPaymentProof[]> {
  return [];
}

export async function countPendingPaymentProofs(): Promise<number> {
  return 0;
}

export async function countPaymentProofsForRun(_runId: string): Promise<number> {
  return 0;
}

export async function markPaymentProofSynced(_receiptId: string, _storagePath: string): Promise<void> {}

export async function countSyncedPaymentProofs(): Promise<number> {
  return 0;
}

export async function bumpPaymentProofAttempts(_receiptId: string): Promise<number> {
  return 0;
}

export async function markPaymentProofBlocked(_receiptId: string): Promise<void> {}

export async function countBlockedPaymentProofs(): Promise<number> {
  return 0;
}

export async function countBlockedPaymentProofsForRun(_runId: string): Promise<number> {
  return 0;
}

export async function retryBlockedPaymentProofs(): Promise<number> {
  return 0;
}

export async function markPaymentProofLegacy(_receiptId: string): Promise<void> {}

export async function resetReceipts(): Promise<void> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function listVoidedReceiptIdsForRun(_runId: string): Promise<string[]> {
  return [];
}
