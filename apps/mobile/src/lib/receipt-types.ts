// Shared between receipt-db.ts (native, real SQLite) and receipt-db.web.ts
// (stub) so neither has to import the other — same split as stock-types.ts.

export type ReceiptStatus = 'draft' | 'finalized';

export type PaymentMethod = 'cash' | 'gcash' | 'cheque' | 'partial' | 'credit';

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  cheque: 'Cheque',
  partial: 'Partial',
  credit: 'Credit',
};

/** `quantity` is always pieces, never packaging units — see lib/bread-unit.ts. */
export type ReceiptItem = {
  breadTypeId: string;
  /** Name/price snapshot at the time it was added to the receipt, so a later
   *  price or name change on the bread type never changes an existing receipt. */
  name: string;
  unitPrice: number;
  quantity: number;
};

export type ReceiptReturnItem = {
  returnedBreadTypeId: string;
  name: string;
  unitPrice: number;
  quantity: number;
};

export type ReceiptDraftInput = {
  customerId: string;
  /** Snapshot of the store name, so the receipts list never needs to join against customers. */
  customerName: string;
  /** Snapshot of the customer's contact name, shown under the store name — same no-join reasoning as customerName. */
  customerContactName: string;
  items: ReceiptItem[];
  returns: ReceiptReturnItem[];
};

/**
 * The lightweight row shown in the receipts list — no items/returns. Kept
 * separate from ReceiptDetail on purpose: receipts can accumulate in the
 * thousands, so the list screen never loads line items for receipts that
 * aren't open.
 */
export type ReceiptSummary = {
  id: string;
  customerId: string;
  customerName: string;
  customerContactName: string;
  status: ReceiptStatus;
  subtotal: number;
  returnsTotal: number;
  total: number;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
  /** Set only once finalized. */
  paymentMethod: PaymentMethod | null;
  /** Only meaningful when paymentMethod is 'partial' — how much was paid at finalize time. */
  amountPaid: number | null;
  /**
   * The run this receipt was finalized in — see context/inventory.tsx. Null
   * while it is still a draft, and on receipts written before runs existed.
   *
   * Stamped at finalize rather than at creation, because finalizing is the
   * moment a receipt becomes a fact and joins the upload queue. It is stored on
   * the row so a receipt still waiting for signal uploads into the run it was
   * written in, even if the truck has since started another one.
   */
  runId: string | null;
  /**
   * The crew that was out when this receipt was finalized, as their name read
   * at that moment — the same snapshot rule `customerName` and an item's `name`
   * follow. Renaming a crew next week must not rewrite a receipt the customer
   * is holding a printed copy of.
   *
   * Null on a draft (no crew is settled until a receipt is filed under a run)
   * and on every receipt finalized before this column existed, which is why
   * every reader treats it as optional rather than expecting a name.
   */
  agentGroupName: string | null;
  /**
   * When the receipt was voided, or null while it stands.
   *
   * A void is not a third `status`: the receipt is still a finalized receipt
   * that was later cancelled, so it keeps every column it had, stays in the list
   * and uploads like any other — the upload is how the server learns about the
   * void. What changes is what it counts for. A voided receipt is left out of
   * every money figure on the phone and the dashboard, can't be printed, and its
   * bread was put back on the truck count when it was voided (see `voidReceipt`
   * in context/receipts.tsx).
   *
   * A separate column rather than `status = 'voided'` because the table's CHECK
   * constraint only allows draft/finalized, and SQLite can't widen one without
   * rebuilding the table — on the one table that holds every receipt ever
   * written.
   */
  voidedAt: number | null;
};

export type ReceiptDetail = ReceiptSummary & {
  items: ReceiptItem[];
  returns: ReceiptReturnItem[];
};

/**
 * Editing or deleting a receipt that is no longer an editable draft — it has
 * been finalized, or it isn't on this phone at all.
 *
 * Its own class so the UI can tell it apart from a genuine glitch: retrying
 * would fail identically every time, so it is reported once with an OK rather
 * than offered as "Try again" (the same treatment DraftExistsError gets).
 *
 * It exists because the alternative is worse than an error. updateDraft and
 * deleteDraft rewrite a receipt's line items, and only the header write carried
 * a `status = 'draft'` guard — so on a finalized receipt the items were
 * destroyed while the header survived, leaving totals that no longer matched
 * any line, and the call reported success. Failing loudly is the fix; the
 * guard is now checked once, before anything is written.
 */
export class NotADraftError extends Error {
  constructor(message = 'This receipt is no longer a draft, so it can’t be edited or deleted.') {
    super(message);
    this.name = 'NotADraftError';
  }
}

/**
 * Voiding a receipt this phone is not allowed to void.
 *
 * **Only a finalized receipt from the run that is open right now can be voided**
 * — the owner's rule. A void puts the receipt's bread back on the truck count,
 * and that only means something on the truck that sold it, today: once a day is
 * ended its numbers have been handed to the server in the manifest, and a count
 * changed afterwards would be a correction nobody at the depot sees happen. It
 * also keeps a phone from quietly cancelling a sale from last week.
 *
 * Its own class so it is reported once with an OK rather than offered as "Try
 * again" — the answer can't change on a second attempt. Nothing is written
 * before it is raised.
 */
export class CannotVoidReceiptError extends Error {
  constructor(reason: 'not-finalized' | 'no-open-run' | 'other-run') {
    super(
      reason === 'not-finalized'
        ? 'Only a finalized receipt can be voided. A draft can simply be deleted.'
        : reason === 'no-open-run'
          ? 'Receipts can only be voided while a day is running. Start the day first.'
          : 'This receipt belongs to a day that has already ended, so it can’t be voided on the phone. It has to be corrected on the server.'
    );
    this.name = 'CannotVoidReceiptError';
  }
}

/** Keyset pagination cursor for loadReceiptPage — the last loaded row's (createdAt, id). */
export type ReceiptPageCursor = { createdAt: number; id: string };

/**
 * Where a proof photo has got to on its way to the server.
 *
 * The same four states every other uploadable row in this app carries (see
 * lib/stock-db.ts) — but this one is surfaced in the UI, because the driver is
 * the only person who can do anything about a photo that hasn't gone. A receipt
 * or a ledger entry is reported in aggregate on the Home card; a photo is tied
 * to the one receipt someone is looking at.
 */
export type ProofSyncState = 'pending' | 'synced' | 'blocked' | 'legacy';

/** A GCash/Cheque proof-of-payment photo — at most one per receipt (see receipt-db.ts). */
export type ReceiptPaymentProof = {
  receiptId: string;
  fileName: string;
  /** Where the photo lives on this phone. The copy the driver looks at is always this one. */
  localUri: string;
  createdAt: number;
  /**
   * Where it lives in Cloud Storage, or null until the bytes have actually
   * landed there.
   *
   * Only ever written *after* a successful upload, which is what lets the
   * dashboard treat a non-null path as a promise that the object exists. See
   * markPaymentProofSynced in lib/receipt-db.ts.
   */
  storagePath: string | null;
  syncState: ProofSyncState;
};

/**
 * A finalized receipt on its way up, plus the one field that isn't on the
 * receipt row itself.
 *
 * `proofStoragePath` is read across from `receipt_payment_proofs` at load time
 * rather than being denormalised onto `receipts`: the photo uploads on its own
 * schedule, and duplicating the path would mean two rows to keep in step.
 */
export type PendingReceipt = ReceiptDetail & { proofStoragePath: string | null };

// ---------------------------------------------------------------------------
// Quantity rules
//
// A receipt line may never be negative, fractional or absurd, and an order line
// may never ask for more bread than the truck is actually carrying. The
// QuantityStepper enforces both on screen (it strips everything but digits and
// caps at what's available), but a stepper is a convenience, not a guarantee:
// a draft outlives the run it was written in, so a receipt saved yesterday
// against 50 loaves can be re-opened today on a truck holding 10. The rules
// below are therefore checked again where the numbers are actually written —
// see createDraft/updateDraft in lib/receipt-db.ts and finalize in
// context/receipts.tsx.
//
// Both refusals happen *before* anything is written, so "nothing was saved" is
// always true when one is raised. Both are also unretryable in the
// lib/retry.ts sense: a second identical attempt fails identically, so they are
// reported once with an OK rather than offered as "Try again".
// ---------------------------------------------------------------------------

/**
 * The most any single line may carry.
 *
 * Not a business rule — a real order is a handful of dozens — but a backstop
 * against a value that came from somewhere other than the stepper. An
 * unbounded quantity multiplies into a total that overflows the receipt paper's
 * amount column (see lib/receipt-print.ts, which widens rather than truncates)
 * and into a stock deduction nothing in the app can undo.
 */
export const MaxLineQuantity = 100_000;

/**
 * A line asking for more than the truck holds — one entry per bread type.
 * `name` is the snapshot on the receipt line, which is what the driver sees.
 */
export type StockShortfall = {
  breadTypeId: string;
  name: string;
  requested: number;
  available: number;
};

/**
 * A quantity or price that could never have come from the form: negative,
 * fractional, not a number at all, or past MaxLineQuantity.
 *
 * Its own class so it is reported once rather than retried — the value is
 * already in hand, so trying again submits exactly the same thing.
 */
export class InvalidReceiptLineError extends Error {
  constructor(detail: string) {
    super(`This receipt has a line that can’t be saved (${detail}). Nothing was saved.`);
    this.name = 'InvalidReceiptLineError';
  }
}

/**
 * An order asking for bread the truck isn't carrying.
 *
 * Raised before the draft is written and again before a draft is finalized, so
 * in both cases nothing has changed when the driver reads it — the receipt is
 * still a draft and the truck count is untouched. It carries the shortfalls so
 * a caller can do more than show the message if it ever needs to.
 */
export class InsufficientStockError extends Error {
  readonly shortfalls: readonly StockShortfall[];

  constructor(shortfalls: readonly StockShortfall[]) {
    super(describeShortfalls(shortfalls));
    this.name = 'InsufficientStockError';
    this.shortfalls = shortfalls;
  }
}

function describeShortfalls(shortfalls: readonly StockShortfall[]): string {
  const lines = shortfalls
    .map((short) => `• ${short.name} — ${short.requested} asked for, ${short.available} on the truck`)
    .join('\n');
  return `This receipt asks for more bread than the truck is carrying:\n\n${lines}\n\nLower those lines to what is on board and try again. Nothing was saved, and the truck count is unchanged.`;
}

/** True for a count of loaves: a whole number, above zero, within MaxLineQuantity. */
function isValidQuantity(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity > 0 && quantity <= MaxLineQuantity;
}

/**
 * Refuses a draft whose lines hold a quantity or price that can't be real.
 *
 * Zero is rejected along with the negatives: the form drops a line the moment
 * its stepper reaches zero, so a zero that reaches here is a line nobody meant
 * to add, and storing it would print an empty row on the receipt and upload a
 * meaningless item to the server.
 *
 * Prices are checked too. They are snapshots taken from the dashboard's
 * catalog rather than typed here, but a negative one turns an order line into a
 * discount and a return line into a charge — the same "negative in the field"
 * hazard from the other side of the multiplication.
 */
export function assertValidReceiptLines(input: ReceiptDraftInput): void {
  for (const item of input.items) {
    if (!isValidQuantity(item.quantity)) {
      throw new InvalidReceiptLineError(`${item.name}: quantity ${item.quantity}`);
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      throw new InvalidReceiptLineError(`${item.name}: price ${item.unitPrice}`);
    }
  }
  for (const line of input.returns) {
    if (!isValidQuantity(line.quantity)) {
      throw new InvalidReceiptLineError(`${line.name}: return quantity ${line.quantity}`);
    }
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      throw new InvalidReceiptLineError(`${line.name}: return price ${line.unitPrice}`);
    }
  }
}

/**
 * Which order lines ask for more than `available` holds — empty when the whole
 * order fits on the truck.
 *
 * Returns lines are deliberately not checked. A return is a write-off against
 * what the store owes and never puts bread back on the truck (see CLAUDE.md),
 * so there is no stock for it to exceed.
 *
 * `available` is keyed by bread type id; a bread type missing from it counts as
 * zero, which is the honest reading — the ledger has no entry for it under this
 * run, so this truck was never loaded with any.
 */
export function findStockShortfalls(
  items: readonly ReceiptItem[],
  available: Readonly<Record<string, number>>
): StockShortfall[] {
  const shortfalls: StockShortfall[] = [];
  for (const item of items) {
    const onTruck = Math.max(0, Math.floor(available[item.breadTypeId] ?? 0));
    if (item.quantity > onTruck) {
      shortfalls.push({
        breadTypeId: item.breadTypeId,
        name: item.name,
        requested: item.quantity,
        available: onTruck,
      });
    }
  }
  return shortfalls;
}
