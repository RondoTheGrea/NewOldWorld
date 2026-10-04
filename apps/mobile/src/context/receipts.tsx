import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';

import { logError } from '@/lib/errors';
import { deleteAllPaymentProofs } from '@/lib/payment-proof';
import * as receiptDb from '@/lib/receipt-db';
import { CannotVoidReceiptError, findStockShortfalls, InsufficientStockError } from '@/lib/receipt-types';
import type { PaymentMethod, ReceiptDetail, ReceiptDraftInput, ReceiptPaymentProof, ReceiptSummary } from '@/lib/receipt-types';
import { runWithRetry } from '@/lib/retry';
// Read directly rather than through useStock: this is a question about what is
// on disk ("was this receipt ever deducted?"), not about what the Inventory
// tab is currently showing, and the answer has to be right even for a receipt
// finalized before this app launch. stock-db.web.ts answers null on web.
import * as stockDb from '@/lib/stock-db';
import { requestSync } from '@/lib/sync';
// CustomersProvider sits above this one in app/(app)/_layout.tsx, so the store
// list is always mounted here. Only used to drop a store's "New" tag once a
// receipt has been finalized for it — see applyFinalizedToList.
import { useCustomers } from '@/context/customers';
import { NoOpenRunError, useInventory } from '@/context/inventory';
import { useStock } from '@/context/stock';

export {
  CannotVoidReceiptError,
  InsufficientStockError,
  InvalidReceiptLineError,
  NotADraftError,
  PAYMENT_METHOD_LABELS,
} from '@/lib/receipt-types';
export type {
  PaymentMethod,
  ReceiptDetail,
  ReceiptDraftInput,
  ReceiptItem,
  ReceiptPaymentProof,
  ReceiptReturnItem,
  ReceiptStatus,
  ReceiptSummary,
} from '@/lib/receipt-types';

// Receipts are expected to pile up far beyond inventory batches or customers,
// so unlike those two contexts this one never holds the whole table in
// memory: it keeps a page of lightweight summaries (see loadMore) and only
// fetches one receipt's line items at a time, on demand, via
// getReceiptDetail — see lib/receipt-db.ts for the matching query shapes.
const PAGE_SIZE = 30;
const SEARCH_LIMIT = 50;

/**
 * How the stock half of finalizing went. The receipt itself is saved in all
 * three cases — this only ever describes the truck count.
 *
 * - `'settled'` — the items are off the count (or already were).
 * - `'skipped'` — the deduction kept failing and the user stopped retrying.
 * - `'run-closed'` — the receipt belongs to a run that has since ended, so
 *   deducting would have taken the bread off a truck that never carried it.
 */
export type StockSettlement = 'settled' | 'skipped' | 'run-closed';

/**
 * The one wording for "this receipt's items are still on the truck count".
 *
 * Shared rather than written twice because the two unsettled cases are
 * reported from two places — the retry prompt inside `settleStock`, and the
 * notice the receipt detail modal shows afterwards — and two phrasings of one
 * fault read as two different problems (see CLAUDE.md on the "No bread types
 * downloaded" wording). Each case is alerted exactly once: `'skipped'` by the
 * prompt the user answered, `'run-closed'` by the modal, since nothing else
 * says anything on that path.
 *
 * Both are blunt about there being no fix in the app, because there isn't one.
 * "Add batch" only ever adds (`addBatch` keeps positive deltas only, and the
 * stepper stops at zero), and a missing deduction leaves the count too *high* —
 * so the obvious-looking advice would push it further the wrong way. Only a
 * sale entry lowers stock, and a finalized receipt can't be finalized again.
 */
export function stockUnsettledMessage(reason: 'skipped' | 'run-closed'): string {
  if (reason === 'run-closed') {
    return 'This receipt belongs to a day that has already ended, so its items were left where they were — today’s truck count is correct and untouched, but the finished day still shows this bread as on board. Report the difference for that day.';
  }
  return 'The receipt is saved and marked paid, but its items could not be taken off the truck count. Skip and the Inventory tab will read higher than what’s really on the truck, with no way to correct it in the app — go by the physical count and report the difference at the end of the day.';
}

/**
 * The one wording for "the receipt is voided but its bread isn't back on the
 * count" — the mirror of the skipped case above, and blunt for the same reason.
 * The count now reads *lower* than the truck, so bread that is physically aboard
 * can't be put on a receipt. "Add batch" would raise it, but it would record a
 * delivery that never happened, so it isn't offered as the fix.
 */
export const voidStockUnsettledMessage =
  'The receipt is voided, but its bread could not be put back on the truck count. Skip and the Inventory tab will read lower than what’s really on the truck — go by the physical count and report the difference at the end of the day.';

type ReceiptsContextValue = {
  receipts: ReceiptSummary[];
  /** True until the first page has been read from disk on app start. */
  receiptsLoading: boolean;
  /** Set when SQLite is unavailable (currently: web) or failed to load. */
  receiptsError: string | null;
  /** Re-runs the failed first page load — what the "Try again" button on the error screen calls. */
  reloadReceipts: () => void;
  /** True while a loadMore() call is in flight. */
  loadingMore: boolean;
  /** False once a page comes back shorter than PAGE_SIZE — nothing further to fetch. */
  hasMore: boolean;
  loadMore: () => void;
  /**
   * True when the last loadMore() failed and nothing has been retried since.
   *
   * The list is left exactly as it was, so this isn't an error state — it is
   * the difference between "that's every receipt" and "there are more, this
   * phone just couldn't reach them". Without it a failed page looks identical
   * to the end of the list, and `onEndReached` doesn't fire again until the
   * user scrolls away and back, so the list would appear to simply stop.
   */
  loadMoreFailed: boolean;
  /**
   * Bumped every time a receipt is created, edited, deleted or finalized.
   *
   * The receipts *list* is kept in step by the writers themselves, but the
   * search results on the Receipts tab are a second list built by a separate
   * SQLite query, and nothing here can reach into it. Rather than duplicating
   * every merge, the screen re-runs its search whenever this changes — the
   * database is the one thing guaranteed to agree with itself.
   *
   * Load-bearing rather than cosmetic: without it, finalizing a receipt found
   * through search leaves its row tagged "Draft", which is what puts the
   * draft-only Delete and Edit buttons back on screen for a receipt that is
   * already finalized and already uploading.
   */
  receiptsRevision: number;
  /** Only one draft may exist at a time — checked directly against SQLite so it's accurate even beyond the loaded page. */
  findDraftReceipt: () => Promise<ReceiptSummary | null>;
  /** Throws `DraftExistsError` if a draft already exists — call findDraftReceipt first to show a friendly error instead of a thrown one. */
  createDraft: (input: ReceiptDraftInput) => Promise<ReceiptDetail>;
  updateDraft: (id: string, input: ReceiptDraftInput) => Promise<ReceiptDetail>;
  deleteDraft: (id: string) => Promise<void>;
  /** Fetches one receipt's full items/returns — not cached in `receipts`. */
  getReceiptDetail: (id: string) => Promise<ReceiptDetail>;
  /** Matches customer name or store name (case-insensitive substring), queried straight from SQLite so it stays fast no matter how many receipts have piled up. */
  searchReceipts: (query: string) => Promise<ReceiptSummary[]>;
  /**
   * Locks a draft in, records how it was paid, and deducts its items from
   * truck stock. No-ops if the receipt isn't (or is no longer) a draft — see
   * the ordering note above the implementation for why that guard matters.
   * `amountPaid` is only meaningful (and required) for 'partial'.
   *
   * Resolves with *how the stock half went*, not with whether the receipt was
   * saved: past `markFinalized` the receipt is saved either way. Anything but
   * `'settled'` means the truck count is now higher than what is really on
   * board — see `StockSettlement`, and the implementation for why that is
   * reported rather than thrown.
   */
  finalize: (id: string, paymentMethod: PaymentMethod, amountPaid?: number) => Promise<StockSettlement>;
  /**
   * Voids a finalized receipt from the run that is open, and puts its bread back
   * on the truck count. The receipt stays on record, marked voided, and uploads
   * again so the server sees it.
   *
   * Throws `CannotVoidReceiptError` — before writing anything — for a draft, when
   * no run is open, or for a receipt from any other run. Resolves `'settled'`
   * once the bread is back (or there was none to give back), `'skipped'` if the
   * driver gave up on that step; the receipt is voided either way.
   */
  voidReceipt: (id: string) => Promise<'settled' | 'skipped'>;
  /**
   * Puts back the bread of every voided receipt in the open run whose return
   * was skipped — see the function for why. Resolves how many it put back;
   * throws if one couldn't be. Called by "End the Day" before it closes.
   */
  returnVoidedStock: () => Promise<number>;
  /** The receipt's proof-of-payment photo, or null if none uploaded yet. */
  getPaymentProof: (receiptId: string) => Promise<ReceiptPaymentProof | null>;
  /** Uploads the receipt's proof photo. Throws if one already exists. */
  setPaymentProof: (receiptId: string, fileName: string, localUri: string) => Promise<ReceiptPaymentProof>;
  /** Wipes every receipt, draft or finalized. Does not touch stock. */
  clearReceipts: () => Promise<void>;
};

/**
 * createDraft refusing because a draft is already open. Its own class so the
 * UI can tell it apart from a genuine failure: retrying this would fail
 * identically every time — the user has to finish or delete that draft first.
 */
export class DraftExistsError extends Error {
  constructor(customerName: string) {
    super(`Finish or delete the draft for ${customerName} before creating a new receipt.`);
    this.name = 'DraftExistsError';
  }
}

const ReceiptsContext = createContext<ReceiptsContextValue | null>(null);

export function useReceipts() {
  const value = use(ReceiptsContext);
  if (!value) {
    throw new Error('useReceipts must be used inside a <ReceiptsProvider>');
  }
  return value;
}

/**
 * Refuses an order that asks for more bread than the truck is carrying.
 *
 * The counterpart to assertValidReceiptLines in lib/receipt-types.ts: that one
 * rules out a number that can't be real, this one rules out a number that can't
 * be *supplied*. It lives here rather than in lib/receipt-db.ts because the
 * answer is in the other database — receipts.db knows nothing about the ledger.
 *
 * Always ahead of the write it guards, so a refusal costs nothing: the draft is
 * untouched, the ledger is untouched, and the driver still has every quantity
 * they typed (see InsufficientStockError, and the callers' `retryable`).
 */
function assertOrderFitsStock(items: ReceiptDetail['items'], available: Record<string, number>): void {
  const shortfalls = findStockShortfalls(items, available);
  if (shortfalls.length > 0) throw new InsufficientStockError(shortfalls);
}

function toDeltas(items: ReceiptDetail['items']): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const item of items) deltas[item.breadTypeId] = (deltas[item.breadTypeId] ?? 0) + item.quantity;
  return deltas;
}

export function ReceiptsProvider({ children }: PropsWithChildren) {
  const { runId, currentRun } = useInventory();
  const stock = useStock();
  const { clearNewCustomer } = useCustomers();
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // Bumped by reloadReceipts to re-run the first-page load below.
  const [loadToken, setLoadToken] = useState(0);
  // Bumped by every writer below, so the Receipts tab knows to re-run an active
  // search against the database — see receiptsRevision on the context type.
  const [revision, setRevision] = useState(0);
  const bumpRevision = () => setRevision((current) => current + 1);

  useEffect(() => {
    let cancelled = false;

    // On web, receipt-db.web.ts (the platform-matched stub Metro loads
    // there) rejects every call — this is the one place that surfaces as an
    // error message instead of a crash.
    receiptDb
      .loadReceiptPage(null, PAGE_SIZE)
      .then((page) => {
        if (cancelled) return;
        setReceipts(page);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((error: unknown) => {
        logError('receipts.load', error);
        if (cancelled) return;
        setError(
          Platform.OS === 'web'
            ? 'Receipts aren’t available on web yet — use the app on a phone.'
            : 'Could not load receipts from this phone’s storage.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadToken]);

  // Back to the loading state here rather than inside the effect: React's lint
  // rules out calling setState straight from an effect body, and this is a
  // button press, which is exactly where it belongs.
  function reloadReceipts() {
    setLoading(true);
    setError(null);
    setLoadToken((token) => token + 1);
  }

  function loadMore() {
    if (loadingMore || !hasMore || receipts.length === 0) return;
    const last = receipts[receipts.length - 1];
    setLoadingMore(true);
    setLoadMoreFailed(false);
    receiptDb
      .loadReceiptPage({ createdAt: last.createdAt, id: last.id }, PAGE_SIZE)
      .then((page) => {
        setReceipts((current) => [...current, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      })
      // No alert: the user asked for nothing here, they just scrolled, and the
      // receipts already on screen stay usable. But not silent either —
      // `hasMore` is left alone and the failure is flagged, so the list footer
      // can offer a tap to try again. `onEndReached` won't fire a second time
      // until the user scrolls away and back, so without that the list would
      // look exactly as if it had ended.
      .catch((error: unknown) => {
        logError('receipts.loadMore', error);
        setLoadMoreFailed(true);
      })
      .finally(() => setLoadingMore(false));
  }

  function findDraftReceipt() {
    return receiptDb.findDraftReceipt();
  }

  async function createDraft(input: ReceiptDraftInput) {
    // Re-checked here (not just in the UI) so a double-tap or a stale screen
    // can't slip past the one-draft-at-a-time rule.
    const existingDraft = await receiptDb.findDraftReceipt();
    if (existingDraft) {
      throw new DraftExistsError(existingDraft.customerName);
    }

    // Against the count the form was showing, which is the count the driver
    // just worked from. Skipped when no run is open: there is no truck to
    // measure the order against, and a receipt with no run can't be finalized
    // anyway (finalize throws NoOpenRunError).
    if (runId) assertOrderFitsStock(input.items, stock.displayStock);

    const detail = await receiptDb.createDraft(input);
    setReceipts((current) => [detail, ...current]);
    bumpRevision();
    return detail;
  }

  async function updateDraft(id: string, input: ReceiptDraftInput) {
    // The edit that matters most: a draft outlives the run it was written in,
    // so one saved yesterday against a full truck can be re-opened today
    // against an empty one. See createDraft for the `runId` guard.
    if (runId) assertOrderFitsStock(input.items, stock.displayStock);

    const detail = await receiptDb.updateDraft(id, input);
    setReceipts((current) => current.map((r) => (r.id === id ? detail : r)));
    bumpRevision();
    return detail;
  }

  async function deleteDraft(id: string) {
    await receiptDb.deleteDraft(id);
    setReceipts((current) => current.filter((r) => r.id !== id));
    bumpRevision();
  }

  async function getReceiptDetail(id: string) {
    return receiptDb.getReceiptDetail(id);
  }

  function searchReceipts(query: string) {
    return receiptDb.searchReceipts(query, SEARCH_LIMIT);
  }

  // Order matters here. Marking the receipt finalized happens FIRST and is
  // the durable point of no return; deducting stock happens second. If the
  // app is killed between the two, the receipt is left finalized with stock
  // that hasn't caught up yet — a count that reads high, against a receipt
  // that says why. Not fixable in the app (nothing here lowers stock but a
  // sale entry, and this receipt can no longer be finalized), but it is
  // visible and it reconciles against the receipt at the end of the day. The
  // other order is worse: a receipt that's still flagged "draft" but has
  // already been deducted would double-deduct silently if finalize is tapped
  // again after restart — a wrong number with nothing on record explaining it.
  async function finalize(
    id: string,
    paymentMethod: PaymentMethod,
    amountPaid?: number
  ): Promise<StockSettlement> {
    // Read from disk, not from the in-memory list. The list can say "finalized"
    // without knowing whether the second half — the stock deduction — ever ran,
    // and answering that honestly is the whole job of the block below.
    const detail = await receiptDb.getReceiptDetail(id);

    // Already finalized, so this is a second pass over a receipt that got part
    // way through. Reachable: markFinalized can commit and still report a
    // failure, and the caller's "Try again" then re-runs this whole function.
    // Reporting success here because the receipt is no longer a draft is
    // exactly the bug this branch exists to prevent — it would hide a truck
    // carrying bread it has already sold.
    //
    // The list and the sync nudge are repeated here, not just on the fresh
    // path below: on the way through that first, failed attempt they never
    // ran. See applyFinalizedToList for what a row left saying "Draft" then
    // lets the user do to a receipt that is finalized on disk.
    if (detail.status !== 'draft') {
      applyFinalizedToList(detail);
      requestSync();
      return settleStock(detail);
    }

    // Finalizing is what files the receipt under a run, so there has to be one.
    // Reachable: "End the Day" clears the setup while the Receipts tab stays
    // open behind it, so a leftover draft can be opened afterwards. A receipt
    // with no run is a receipt that could never upload.
    if (!runId) throw new NoOpenRunError();

    // The last gate before the bread comes off the truck, and the only one that
    // asks the ledger itself rather than what the Inventory tab has in memory.
    // It has to be re-asked here even though the draft was checked when it was
    // saved: a draft is not scoped to a run, so one written yesterday against a
    // full truck reaches this line today against whatever is actually on board.
    //
    // Refusing keeps the receipt a draft — which is the recoverable state, and
    // the only one from which the quantities can still be lowered. Letting it
    // through would drive the run's totals negative, and nothing in the app can
    // raise a count back except a real delivery (see stockUnsettledMessage).
    assertOrderFitsStock(detail.items, await stockDb.loadRunTotals(runId));

    // Everything up to here is safe to retry: nothing has been written yet, so
    // a failure throws and the caller can simply run the whole thing again.
    const resolvedAmountPaid = paymentMethod === 'partial' ? (amountPaid ?? null) : null;

    // Who was on the truck, copied onto the receipt rather than looked up from
    // the run later — the same snapshot rule the store name and every item's
    // name follow. An agent renamed next week must not rewrite a receipt
    // someone is holding a printed copy of. Null when nobody can be named (a
    // run log that failed to load): every reader leaves the line out rather
    // than printing a blank.
    const agentNames =
      currentRun?.agents
        .map((agent) => agent.name)
        .filter((name) => name.length > 0)
        .join(', ') || null;
    const { finalizedAt } = await receiptDb.markFinalized(
      id,
      runId,
      paymentMethod,
      resolvedAmountPaid,
      agentNames
    );

    // Exactly the row markFinalized just wrote — `updated_at` included, which
    // that UPDATE deliberately leaves alone. Built once and used for both the
    // list and the deduction below so neither can describe the receipt
    // differently from the other, or from the database.
    const finalized: ReceiptDetail = {
      ...detail,
      status: 'finalized',
      finalizedAt,
      paymentMethod,
      amountPaid: resolvedAmountPaid,
      runId,
      agentNames,
    };

    // Past this line the receipt is finalized on disk, so the in-memory list
    // is updated immediately — before the stock step, which can fail. Leaving
    // it until after would show a row still tagged "Draft" that the database
    // already considers finalized, and tapping it again would do nothing.
    applyFinalizedToList(finalized);

    // Finalizing is what makes a receipt eligible to upload — drafts never
    // leave the phone. Nudged here rather than after the stock step below, so
    // the receipt still uploads even if that step fails or the user skips it.
    requestSync();

    return settleStock(finalized);
  }

  /**
   * Copies a receipt's finalized state from disk onto its row in the list.
   *
   * Both routes through finalize() need it, and the one that used to skip it
   * was the one that mattered: markFinalized can commit and still report a
   * failure, so on the retry that follows, the row is still tagged "Draft"
   * while the database considers the receipt finalized and queued to upload.
   * Nothing else refreshes the list from disk — the first page loads once on
   * mount, and reloadReceipts is only reachable from the error screen — so a
   * row left wrong here stays wrong for the life of the app.
   *
   * That badge is not cosmetic. The detail modal's Delete and Edit buttons are
   * draft-only, so a stale "Draft" keeps both on screen for a receipt that is
   * no longer one, and each half-works: deleteDraft's SQL is guarded by
   * `status = 'draft'`, so the row survives on disk while vanishing from the
   * list, and updateDraft's guard covers the header row but not writeLines, so
   * the items would be rewritten under totals that no longer match them — on a
   * receipt the server may already have.
   *
   * The store's "New" tag is dropped from here too, for the one reason that
   * matters: this is the only function *both* routes through finalize() call.
   * Written into each branch separately it would be one more thing the
   * already-finalized branch could be left out of, which is the exact bug the
   * paragraph above exists about. It is fire-and-forget — `clearNewCustomer`
   * swallows its own failures, so a badge that won't clear can never turn a
   * saved receipt into a reported one.
   */
  function applyFinalizedToList(detail: ReceiptDetail) {
    void clearNewCustomer(detail.customerId);
    // The search results on the Receipts tab are a separate list this can't
    // reach, and a row left saying "Draft" there is the same hazard this
    // function exists to prevent on the main list — see receiptsRevision.
    bumpRevision();
    setReceipts((current) =>
      current.map((r) =>
        r.id === detail.id
          ? {
              ...r,
              status: detail.status,
              finalizedAt: detail.finalizedAt,
              updatedAt: detail.updatedAt,
              paymentMethod: detail.paymentMethod,
              amountPaid: detail.amountPaid,
              runId: detail.runId,
              agentNames: detail.agentNames,
            }
          : r
      )
    );
  }

  /**
   * Takes a finalized receipt's items off truck stock, unless that already
   * happened.
   *
   * Split out of finalize() because it is reached twice within one attempt:
   * straight after a receipt is marked finalized, and again if the caller's
   * "Try again" re-runs finalize over a receipt that got part way through.
   *
   * There is no *later* attempt, and the wording depends on knowing that: the
   * detail modal's payment button is draft-only, so once this returns and the
   * modal closes, nothing in the app can reach the deduction for that receipt
   * again. Whatever it reports is final.
   *
   * **Never throws.** It runs after the receipt is already written, so a throw
   * here would surface as "could not finalize the receipt" — and if the user
   * then backed out, the caller would return without ever showing the "stock
   * not updated" notice. A stock shortfall would go unmentioned, which is the
   * one outcome this whole path exists to rule out.
   */
  async function settleStock(detail: ReceiptDetail): Promise<StockSettlement> {
    // Already deducted — nothing owed. This is what makes a repeat honest in
    // both directions: it can't double-deduct, and it can't claim a deduction
    // that never happened.
    //
    // A failed *lookup* is not treated as "not deducted" and not as a failure
    // either: it falls through and attempts the deduction anyway. That is only
    // safe because recordSale is idempotent per receipt — writing it a second
    // time lands on the same ledger row — so "ask again later" beats both
    // guessing and giving up.
    try {
      if (await stockDb.findSaleBatchForReceipt(detail.id)) return 'settled';
    } catch (error) {
      logError('receipts.finalize.findSale', error);
    }

    // The deduction has to land on the truck that sold the bread. A receipt
    // finalized under a run that has since been closed can no longer be
    // settled — taking its items off today's truck would move a real shortfall
    // onto a load that never carried them. Report it as unsettled instead, so
    // the user is told rather than quietly given a wrong count.
    //
    // Its own answer rather than sharing the 'skipped' one: nothing failed
    // here and today's count is right, which is the opposite of what the
    // skipped wording tells the driver to go and check.
    if (!runId || detail.runId !== runId) return 'run-closed';

    // The stock deduction is a second, separate transaction in a second
    // database (see the ordering note above), so it gets its own retry prompt
    // rather than letting the caller re-run finalize: a re-run would find the
    // receipt already finalized and take the branch above. Retrying is safe —
    // recordSale writes the deduction under an id derived from the receipt, so
    // a repeat lands on the same ledger row instead of appending a second one.
    //
    // This prompt is also the only notice the user gets if they stop, which is
    // why it carries the full consequence rather than a short "that failed":
    // the caller stays quiet on 'skipped' instead of repeating it in a second
    // alert. The button says "Skip", not "Skip for now" — there is no later
    // attempt to defer to (see the note above this function).
    const deducted = await runWithRetry(() => stock.recordSale(toDeltas(detail.items), detail.id), {
      scope: 'receipts.finalize.recordSale',
      title: 'Truck stock not updated',
      message: stockUnsettledMessage('skipped'),
      cancelLabel: 'Skip',
    });

    return deducted.completed ? 'settled' : 'skipped';
  }

  /**
   * Voids a receipt: the same two-database shape as finalize(), in the same
   * order, for the same reason.
   *
   * The receipt is marked voided in receipts.db **first**, and the bread goes back
   * on the truck in stock.db second. A crash between the two leaves a voided
   * receipt whose bread isn't back yet — a count that reads low, with a record on
   * screen saying why. The other order leaves bread back on the truck against a
   * receipt that still says it was sold, which nothing on the phone would ever
   * explain.
   *
   * **The owner's rule is checked first, from disk:** finalized, a run open, and
   * the receipt filed under *that* run. See CannotVoidReceiptError for why. The
   * detail modal hides the button in every other case; this is what makes the
   * rule hold for anything else that calls it.
   *
   * Safe to repeat as a whole. A receipt already voided skips straight to
   * redoing the list update, the sync nudge and the stock step — the same
   * reasoning as finalize()'s already-finalized branch: markVoided can commit and
   * still report a failure, and the retry has to finish what the first attempt
   * didn't reach. recordVoid lands on the same ledger row however many times it
   * runs.
   */
  async function voidReceipt(id: string): Promise<'settled' | 'skipped'> {
    const detail = await receiptDb.getReceiptDetail(id);
    if (detail.status !== 'finalized') throw new CannotVoidReceiptError('not-finalized');
    if (!runId) throw new CannotVoidReceiptError('no-open-run');
    if (detail.runId !== runId) throw new CannotVoidReceiptError('other-run');

    const voidedAt = detail.voidedAt ?? (await receiptDb.markVoided(id, runId)).voidedAt;
    applyVoidedToList(id, voidedAt);
    // Voiding re-queues the receipt, so the server hears about it on this pass.
    requestSync();

    // Its own prompt, like the deduction in settleStock: re-running the whole
    // void would take the already-voided path above anyway, and the driver is
    // owed the specific consequence of stopping here.
    const returned = await runWithRetry(() => stock.recordVoid(id), {
      scope: 'receipts.void.recordVoid',
      title: 'Truck stock not updated',
      message: voidStockUnsettledMessage,
      cancelLabel: 'Skip',
    });
    return returned.completed ? 'settled' : 'skipped';
  }

  /**
   * The second chance a skipped void never had.
   *
   * "Skip" on a void's stock step leaves a voided receipt whose bread still
   * counts as sold, and the Void button is gone once a receipt is voided, so
   * nothing on the phone could finish it — the dashboard and both exports would
   * go on counting those loaves as sold for good. "End the Day" is the last
   * moment the run is open, so it calls this first: every voided receipt in the
   * run that has a sale entry and no void entry gets `recordVoid`, the same
   * idempotent call the void itself makes. The new entries are queued like any
   * other, so the close that follows uploads them before it lets the day end.
   *
   * Runs through the stock context rather than straight at the database, so the
   * Inventory tab's count moves too — this sits in front of a close that can
   * still be refused for want of signal, leaving the day open.
   */
  async function returnVoidedStock(): Promise<number> {
    if (!runId) return 0;
    const voided = await receiptDb.listVoidedReceiptIdsForRun(runId);
    const missing = await stockDb.findVoidsNotReturned(voided);
    for (const receiptId of missing) {
      await stock.recordVoid(receiptId);
    }
    return missing.length;
  }

  /**
   * Marks a row voided in the list, and re-runs any open search — the same two
   * things applyFinalizedToList does, for the same reason: nothing else
   * refreshes either list from disk, and a row left looking live would keep its
   * Void and Preview buttons.
   */
  function applyVoidedToList(id: string, voidedAt: number) {
    bumpRevision();
    setReceipts((current) => current.map((r) => (r.id === id ? { ...r, voidedAt } : r)));
  }

  function getPaymentProof(receiptId: string) {
    return receiptDb.getPaymentProof(receiptId);
  }

  // Nudges sync once the row is safely on disk, exactly like the ledger's
  // writers do. requestSync() never throws and never waits, so attaching a
  // photo is not gated on the network — a failed upload leaves the row pending
  // and the loop tries again later.
  async function setPaymentProof(receiptId: string, fileName: string, localUri: string) {
    const saved = await receiptDb.setPaymentProof(receiptId, fileName, localUri);
    requestSync();
    return saved;
  }

  // The proof photos go with the rows that point at them. Deleting only the
  // rows would leave the files on disk with nothing in the app able to reach
  // or remove them — storage that fills up and never comes back.
  async function clearReceipts() {
    await receiptDb.resetReceipts();
    await deleteAllPaymentProofs();
    setReceipts([]);
    setHasMore(false);
    setLoadMoreFailed(false);
    bumpRevision();
  }

  const value: ReceiptsContextValue = {
    receipts,
    receiptsLoading: loading,
    receiptsError: error,
    reloadReceipts,
    loadingMore,
    hasMore,
    loadMore,
    loadMoreFailed,
    receiptsRevision: revision,
    findDraftReceipt,
    createDraft,
    updateDraft,
    deleteDraft,
    getReceiptDetail,
    searchReceipts,
    finalize,
    voidReceipt,
    returnVoidedStock,
    getPaymentProof,
    setPaymentProof,
    clearReceipts,
  };

  return <ReceiptsContext value={value}>{children}</ReceiptsContext>;
}
