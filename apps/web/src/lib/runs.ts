import {
  collection,
  collectionGroup,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';

import {
  businessDayKey,
  currentBusinessDayKey,
  formatBusinessDayShort,
  formatBusinessTime,
  startOfBusinessDay,
} from '@/lib/business-day';
import { db } from '@/lib/firebase';

/**
 * Reading the day back off the trucks.
 *
 * Everything here is **read-only**, and that is a rule rather than an
 * accident: `firestore.rules` refuses every delete under `/runs`, and refuses
 * any write whose `createdByUid` isn't the signed-in account — so a dashboard
 * account cannot write a run at all. A run is one phone's account of its own
 * trip out; the dashboard's job is to show it and check its arithmetic, never
 * to correct it. If a number is wrong, it is wrong on the truck.
 *
 * The document shapes are produced by apps/mobile/src/lib/sync.ts and described
 * in docs/sync-design.md. Every reader here is defensive about missing fields
 * for one specific reason: uploads land in whatever order the signal allows, so
 * a receipt can arrive **before** its parent run document exists, and a run
 * header can sit on screen for hours before its manifest is written.
 */

export type RunStatus = 'open' | 'closed';

/**
 * What the phone said it produced, written once when the day is closed.
 * Absent while the run is still open — that is the normal case, not an error.
 */
export type RunManifest = {
  /** Receipts that stand. Voided ones are left out here and in both totals below. */
  receiptCount: number;
  /** Receipts voided on the phone. 0 on a run closed before voiding existed. */
  voidedReceiptCount: number;
  stockEntryCount: number;
  customerCount: number;
  salesTotal: number;
  returnsTotal: number;
  /**
   * Expense documents the run produced, **deleted ones included** — it is a
   * count of what was sent, and a deleted expense is still a document. 0 on a
   * run closed before expenses existed, which reads as a clean match because no
   * expense documents arrived for it either.
   */
  expenseCount: number;
  /**
   * What the truck spent, deleted expenses excluded.
   *
   * Reported next to the takings and **never subtracted from them**, here or
   * anywhere else on this dashboard. Expenses are informational: they do not
   * touch sales, net, the area metrics or the Trends charts.
   */
  expenseTotal: number;
  /**
   * Proof-of-payment photos the run produced, as the phone counted them.
   *
   * Checked against the receipts that arrived carrying a `proofStoragePath`,
   * which is the only way to tell "this GCash receipt had no photo taken" from
   * "the photo is missing". 0 on a run closed before photos were uploaded at
   * all, which reads as a clean match because no paths arrived either.
   */
  paymentProofCount: number;
  /** Always 0 now: closing requires an empty queue. Kept because a 0 is what says the rule was in force. */
  pendingUploadCount: number;
  /** Records the server refused and the phone stopped retrying. The one count allowed to be non-zero. */
  blockedUploadCount: number;
};

export type Run = {
  id: string;
  businessDay: string;
  /** Which trip of the day this is for this truck — 1, then 2 if it went back out. */
  sequence: number;
  truckId: string;
  truckName: string;
  /**
   * Who was on the truck — the agents the driver ticked when the run started,
   * with their names as they read then. A snapshot: renaming an agent since
   * doesn't change who was out that day. Read it through `runAgentNames`.
   *
   * (Runs from before crews and areas were removed also carry `agentGroupId`,
   * `agentGroupName`, `areaId` and `areaName` in Firestore. Nothing reads them
   * any more — the agents list was recorded on those runs too.)
   */
  agents: { id: string; name: string }[];
  createdByEmail: string;
  createdByUid: string;
  startedAt: number;
  status: RunStatus;
  closedAt: number | null;
  /**
   * The Manila business day the run **ended** on, as the phone computed it.
   *
   * `businessDay` above is the day the run *started*, and it is still the day
   * the run is filed under — a run appears on the board on its start date and
   * nowhere else. But a run is no longer confined to that day: the truck may
   * stay out across midnight and come back two days later, so "when did this
   * end" is a separate question and needs its own answer.
   *
   * Null on a run closed before the phone recorded it, and on every open run.
   * `runEndDay` is the one place that falls back for the former — never read
   * this field raw.
   */
  closedBusinessDay: string | null;
  manifest: RunManifest | null;
};

export type RunReceipt = {
  id: string;
  /**
   * The run's identity, repeated on every child document by design — uploads
   * land in whatever order the signal allows, so a receipt has to make sense
   * before its parent run exists. It is also what lets the store history, which
   * reads receipts across every run at once, say which truck and which day a
   * sale came from without loading anything else.
   *
   * Note there is no `truckName` here: the phone stamps ids, not names. The
   * dashboard resolves it through the Trucks reference list.
   */
  runId: string;
  businessDay: string;
  truckId: string;
  /**
   * Who was on the truck when the run opened — ids only, like `truckId`, and
   * resolved through the Agents reference list.
   */
  agentIds: string[];
  /**
   * Who delivered it, **as the phone printed it** on the customer's copy —
   * copied onto the receipt when it was finalized.
   *
   * The exception to the "ids only, resolved through the reference lists" rule
   * above, and deliberately so: this one is not an id to look up, it is what the
   * paper in the store's hand says. Resolving `agentIds` answers a different
   * question — what those people are called *now*.
   *
   * The agents' names, comma-separated. A receipt printed while crews existed
   * carried the crew's name instead (`agentGroupName`), and that is read in
   * here as the fallback, because it is what that paper says. Null on every
   * receipt finalized before either was recorded (nothing was backfilled), which
   * is why readers fall back to resolved names rather than expecting this.
   */
  agentNames: string | null;
  customerId: string;
  customerName: string;
  customerContactName: string;
  items: { breadTypeId: string; name: string; unitPrice: number; quantity: number }[];
  returns: { name: string; unitPrice: number; quantity: number }[];
  /** Gross, before the returns credit — the same figure the manifest's `salesTotal` sums. */
  subtotal: number;
  returnsTotal: number;
  /** subtotal − returnsTotal. Negative on a receipt that is only a return. */
  total: number;
  paymentMethod: string | null;
  amountPaid: number | null;
  createdAt: number;
  finalizedAt: number | null;
  /**
   * Where the GCash/cheque proof photo lives in Cloud Storage, or null.
   *
   * Null means one of two things and the panel says which: the receipt was paid
   * another way (so no photo was ever expected), or the photo hasn't uploaded
   * yet. The phone only ever writes this **after** the bytes have landed, so a
   * non-null path is a promise that the object is really there — never a guess
   * assembled from the receipt id.
   */
  proofStoragePath: string | null;
  /**
   * When the driver voided this receipt on the phone, or null while it stands.
   *
   * **A voided receipt is listed everywhere and counted nowhere.** It stays in
   * every feed and every export, marked, because the server has to be able to
   * see that a sale was cancelled and when. But none of its money, its stores or
   * its returns reach a total: `totalReceipts`, `receiptCollected`,
   * `totalCollected` and `buildOutcomeRows` all skip it, and so does every fold
   * that walks receipts by hand. Its loaves take care of themselves — the phone
   * writes a `'void'` ledger entry putting them back on the truck.
   *
   * The phone only lets a receipt be voided during the run it belongs to, so a
   * run's receipts stop changing when the run is ended.
   */
  voidedAt: number | null;
};

/** True for a receipt the driver voided — see `RunReceipt.voidedAt`. */
export function isVoided(receipt: RunReceipt): boolean {
  return receipt.voidedAt !== null;
}

/**
 * Something the truck spent while it was out — fuel, a toll, the agents' lunch.
 *
 * Read and shown, and that is all. **No total on this dashboard nets an expense
 * off anything**: not the day's sales, not the net, not an area's metrics, not
 * the Trends charts. It is a record of the trip, kept beside the takings rather
 * than inside them. If that is ever to change it has to be a decision somebody
 * makes, not a subtraction that appears because it looked obvious.
 */
export type RunExpense = {
  id: string;
  title: string;
  /** Pesos. Always positive — there is no signed form of this figure. */
  amount: number;
  notes: string;
  createdAt: number;
  /**
   * Removed on the phone. The document stays because `firestore.rules` refuses
   * every delete under `/runs`, so a removal has to travel as a flag — the same
   * shape a deleted store uses. Filtered out of everything shown.
   */
  deleted: boolean;
};

/**
 * `'void'` is a voided receipt's bread going back on the truck: that receipt's
 * sale, with the same quantities stored positive. It is not a delivery, so it
 * never counts as loaded — see `totalStock`.
 */
export type StockEntryKind = 'initial' | 'addition' | 'sale' | 'void';

export type RunStockEntry = {
  id: string;
  kind: StockEntryKind;
  /** Quantities arrive already signed — negative on a sale — so the ledger sums the way it does on the phone. */
  items: { breadTypeId: string; quantity: number }[];
  receiptId: string | null;
  createdAt: number;
};

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readManifest(value: unknown): RunManifest | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  return {
    receiptCount: asNumber(m.receiptCount),
    voidedReceiptCount: asNumber(m.voidedReceiptCount),
    stockEntryCount: asNumber(m.stockEntryCount),
    customerCount: asNumber(m.customerCount),
    salesTotal: asNumber(m.salesTotal),
    returnsTotal: asNumber(m.returnsTotal),
    expenseCount: asNumber(m.expenseCount),
    expenseTotal: asNumber(m.expenseTotal),
    paymentProofCount: asNumber(m.paymentProofCount),
    pendingUploadCount: asNumber(m.pendingUploadCount),
    blockedUploadCount: asNumber(m.blockedUploadCount),
  };
}

function readRun(id: string, data: Record<string, unknown>): Run {
  return {
    id,
    businessDay: asString(data.businessDay),
    sequence: asNumber(data.sequence, 1),
    truckId: asString(data.truckId),
    truckName: asString(data.truckName),
    agents: Array.isArray(data.agents) ? (data.agents as { id: string; name: string }[]) : [],
    createdByEmail: asString(data.createdByEmail),
    createdByUid: asString(data.createdByUid),
    startedAt: asNumber(data.startedAt),
    status: data.status === 'closed' ? 'closed' : 'open',
    closedAt: typeof data.closedAt === 'number' ? data.closedAt : null,
    closedBusinessDay: typeof data.closedBusinessDay === 'string' && data.closedBusinessDay
      ? data.closedBusinessDay
      : null,
    manifest: readManifest(data.manifest),
  };
}

/**
 * The one place the dashboard has to know that 'consignment' was renamed to
 * 'credit'.
 *
 * The phone rewrites its own rows on the next app start, but a receipt that had
 * already uploaded keeps the old spelling in Firestore forever — nothing on the
 * truck re-sends a receipt just to change one word. Normalising on the way in
 * means every screen downstream (the Collected table, the receipt card's label)
 * only ever sees 'credit', instead of each having to remember both.
 */
function readPaymentMethod(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value === 'consignment' ? 'credit' : value;
}

function readReceipt(id: string, data: Record<string, unknown>): RunReceipt {
  return {
    id,
    runId: asString(data.runId),
    businessDay: asString(data.businessDay),
    truckId: asString(data.truckId),
    agentIds: Array.isArray(data.agentIds) ? data.agentIds.filter((id): id is string => typeof id === 'string') : [],
    // Not `asString`: an older receipt has nobody recorded at all, and "" would
    // be indistinguishable from a blank name. Null is the answer that routes
    // callers into their fallback. The crew name is the fallback for a receipt
    // printed while crews existed — see `agentNames` on RunReceipt.
    agentNames:
      typeof data.agentNames === 'string' && data.agentNames
        ? data.agentNames
        : typeof data.agentGroupName === 'string' && data.agentGroupName
          ? data.agentGroupName
          : null,
    customerId: asString(data.customerId),
    customerName: asString(data.customerName),
    customerContactName: asString(data.customerContactName),
    items: Array.isArray(data.items) ? (data.items as RunReceipt['items']) : [],
    returns: Array.isArray(data.returns) ? (data.returns as RunReceipt['returns']) : [],
    subtotal: asNumber(data.subtotal),
    returnsTotal: asNumber(data.returnsTotal),
    total: asNumber(data.total),
    paymentMethod: readPaymentMethod(data.paymentMethod),
    amountPaid: typeof data.amountPaid === 'number' ? data.amountPaid : null,
    createdAt: asNumber(data.createdAt),
    finalizedAt: typeof data.finalizedAt === 'number' ? data.finalizedAt : null,
    proofStoragePath: typeof data.proofStoragePath === 'string' ? data.proofStoragePath : null,
    voidedAt: typeof data.voidedAt === 'number' ? data.voidedAt : null,
  };
}

function readExpense(id: string, data: Record<string, unknown>): RunExpense {
  return {
    id,
    title: asString(data.title),
    amount: asNumber(data.amount),
    notes: asString(data.notes),
    createdAt: asNumber(data.createdAt),
    deleted: data.deleted === true,
  };
}

function readStockEntry(id: string, data: Record<string, unknown>): RunStockEntry {
  const kind = data.kind;
  return {
    id,
    kind: kind === 'initial' || kind === 'addition' || kind === 'sale' || kind === 'void' ? kind : 'addition',
    items: Array.isArray(data.items) ? (data.items as RunStockEntry['items']) : [],
    receiptId: typeof data.receiptId === 'string' ? data.receiptId : null,
    createdAt: asNumber(data.createdAt),
  };
}

/**
 * Which business day a run ended on, or null while it is still out.
 *
 * Prefers `closedBusinessDay` — the string the *phone* computed — for the same
 * reason every other day on this page is a stored string: only the phone is
 * reliably in Manila. The fallback derives it from `closedAt`, and is allowed
 * here for one narrow reason: `businessDayKey` is pinned to `Asia/Manila`
 * (lib/business-day.ts), so it is not reading the browser's clock, it is doing
 * on the desktop what the phone would have done. It exists only for runs closed
 * before the phone started stamping the field — including the ones already in
 * production — and a run with neither is simply undated.
 */
export function runEndDay(run: Run): string | null {
  if (run.status !== 'closed') return null;
  if (run.closedBusinessDay) return run.closedBusinessDay;
  return run.closedAt ? businessDayKey(run.closedAt) : null;
}

/**
 * Did this run outlive the day it started on?
 *
 * The question every "when did it end" label on the board turns on. For a
 * finished run that is start day vs. end day; for one still out it is start day
 * vs. *today*, because a truck that went out yesterday and is still going is
 * exactly as much a multi-day run as one that has come back.
 *
 * Note what this deliberately does not do: it does not move the run onto
 * another day. A run belongs to the day it started, and that is where the board
 * shows it — this only decides whether the end has to be spelled out with a
 * date on it rather than just a time.
 */
export function runSpansDays(run: Run): boolean {
  const end = run.status === 'closed' ? runEndDay(run) : currentBusinessDayKey();
  return end !== null && end !== run.businessDay;
}

/**
 * When a finished run ended, worded for a reader who is looking at its **start**
 * day.
 *
 * A time alone for a same-day run ("6:42 PM"), the date as well for one that
 * outlived its start ("18 Aug, 6:42 PM"). That asymmetry is the whole function:
 * under a Monday heading a bare time can only be read as Monday, so a run that
 * came back on Wednesday has to carry its date or the board quietly misreports
 * it. Adding the date to every row instead would be the other kind of wrong —
 * noise on the ninety-nine rows that are exactly what they look like.
 *
 * Lives here rather than in each component so the board row and the run panel
 * cannot drift into two phrasings of one fact.
 */
export function describeRunEnd(run: Run): string {
  if (run.closedAt === null) return '—';
  const time = formatBusinessTime(run.closedAt);
  const endDay = runEndDay(run);
  return endDay && endDay !== run.businessDay ? `${formatBusinessDayShort(endDay)}, ${time}` : time;
}

/**
 * How many business days a run touched, counting both ends — 1 for an ordinary
 * run, 3 for one that went out Monday and came back Wednesday.
 *
 * A null end means the run is still out, so it is counted up to today: a truck
 * that left yesterday and has not come back has been out for two days, and
 * saying "1" until it closes would be the least useful moment to be accurate.
 */
export function countBusinessDays(startDay: string, endDay: string | null): number {
  const end = endDay ?? currentBusinessDayKey();
  if (!startDay || end < startDay) return 1;
  const span = startOfBusinessDay(end) - startOfBusinessDay(startDay);
  // A run whose stored day is malformed is still a run: 1 is the honest answer,
  // where NaN would render as "NaN days out" on an operations board.
  if (!Number.isFinite(span)) return 1;
  return Math.round(span / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Live-subscribes to every run filed under one business day, newest start
 * first. Returns the unsubscribe fn.
 *
 * The day is matched on the **string the phone stored**, never re-derived from
 * `startedAt` here — see lib/business-day.ts for why that distinction is the
 * whole point.
 *
 * Sorted in JS rather than with `orderBy`. A day holds one row per truck per
 * trip (a handful, not thousands), and an equality filter plus an unrelated
 * `orderBy` would need a composite index that doesn't exist yet — the emulator
 * would invent it and production would reject the query.
 */
export function watchRunsForDay(
  businessDay: string,
  callback: (runs: Run[]) => void,
  onError: (error: Error) => void,
) {
  const q = query(collection(db, 'runs'), where('businessDay', '==', businessDay));
  return onSnapshot(
    q,
    (snapshot) => {
      const runs = snapshot.docs.map((snap) => readRun(snap.id, snap.data()));
      callback(runs.sort((a, b) => b.startedAt - a.startedAt));
    },
    onError,
  );
}

/**
 * Every run between two business days, inclusive — what the Trends tab charts.
 *
 * A one-shot read, not a listener: this can span ninety days, and a page of
 * history doesn't change while you look at it. The range is over the stored
 * `businessDay` **string**, which sorts correctly because the key is
 * `YYYY-MM-DD`; a range on one field needs only the automatic index.
 */
export async function fetchRunsForRange(fromDay: string, toDay: string): Promise<Run[]> {
  const snapshot = await getDocs(
    query(collection(db, 'runs'), where('businessDay', '>=', fromDay), where('businessDay', '<=', toDay)),
  );
  return snapshot.docs.map((snap) => readRun(snap.id, snap.data())).sort((a, b) => a.startedAt - b.startedAt);
}

/** One run's receipts, read once. Used for runs that have no manifest to read instead. */
export async function fetchRunReceipts(runId: string): Promise<RunReceipt[]> {
  const snapshot = await getDocs(collection(db, 'runs', runId, 'receipts'));
  return snapshot.docs.map((snap) => readReceipt(snap.id, snap.data()));
}

/**
 * Every receipt ever written for one store, newest first, across every truck
 * and every day.
 *
 * A **collection-group** query — the receipts live under
 * `runs/{runId}/receipts`, so answering this run by run would mean opening
 * every run ever recorded. Two things have to line up for it to work, and both
 * already do: the composite index `(customerId, createdAt DESC)` in
 * `firestore.indexes.json`, and a rule written with a recursive-wildcard prefix
 * in `firestore.rules` — a rule nested under `/runs/{runId}` does **not**
 * authorise a collection-group query, however much it looks like it should.
 *
 * **Uncapped**, on the owner's call (September 2026): it used to stop at the
 * newest 60, which left the store panel's totals and chart describing only
 * part of a store's history. One store's receipts are a small read even over
 * years; the panel pages the *list*, not the read.
 */
export async function fetchReceiptsForCustomer(customerId: string): Promise<RunReceipt[]> {
  const snapshot = await getDocs(
    query(collectionGroup(db, 'receipts'), where('customerId', '==', customerId), orderBy('createdAt', 'desc')),
  );
  return snapshot.docs.map((snap) => readReceipt(snap.id, snap.data()));
}

/** Live-subscribes to one run's finalized receipts, newest first. */
export function watchRunReceipts(
  runId: string,
  callback: (receipts: RunReceipt[]) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    collection(db, 'runs', runId, 'receipts'),
    (snapshot) => {
      const receipts = snapshot.docs.map((snap) => readReceipt(snap.id, snap.data()));
      callback(receipts.sort((a, b) => b.createdAt - a.createdAt));
    },
    onError,
  );
}

/**
 * Live-subscribes to one run's expenses, newest first.
 *
 * Read under `runs/{runId}/expenses` like the other two child collections, for
 * the same reason: membership of a run is a matter of where the document lives,
 * which nothing can disagree about — a day-filtered query would lose the late
 * expenses of a run that crossed midnight.
 *
 * Soft-deleted rows come back too and are filtered by the caller, not here.
 */
export function watchRunExpenses(
  runId: string,
  callback: (expenses: RunExpense[]) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    collection(db, 'runs', runId, 'expenses'),
    (snapshot) => {
      const expenses = snapshot.docs.map((snap) => readExpense(snap.id, snap.data()));
      callback(expenses.sort((a, b) => b.createdAt - a.createdAt));
    },
    onError,
  );
}

/**
 * One run's expenses, read once — the period export's counterpart to the
 * listener above.
 *
 * Soft-deleted rows come back here too, exactly as they do from the watcher.
 * Filtering them is the caller's job (`totalExpenses` does it); doing it here
 * instead would make the two readers disagree about what a run holds.
 */
export async function fetchRunExpenses(runId: string): Promise<RunExpense[]> {
  const snapshot = await getDocs(collection(db, 'runs', runId, 'expenses'));
  return snapshot.docs.map((snap) => readExpense(snap.id, snap.data())).sort((a, b) => a.createdAt - b.createdAt);
}

/** Live-subscribes to one run's inventory ledger, oldest first — it reads as a running story. */
export function watchRunStockEntries(
  runId: string,
  callback: (entries: RunStockEntry[]) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    collection(db, 'runs', runId, 'stockEntries'),
    (snapshot) => {
      const entries = snapshot.docs.map((snap) => readStockEntry(snap.id, snap.data()));
      callback(entries.sort((a, b) => a.createdAt - b.createdAt));
    },
    onError,
  );
}

/** One run's inventory ledger, read once. Oldest first, like the listener. */
export async function fetchRunStockEntries(runId: string): Promise<RunStockEntry[]> {
  const snapshot = await getDocs(collection(db, 'runs', runId, 'stockEntries'));
  return snapshot.docs.map((snap) => readStockEntry(snap.id, snap.data())).sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export type ReceiptTotals = {
  /** Receipts that stand — voided ones are in `voidedCount`, not here. */
  receiptCount: number;
  /** Receipts voided on the phone. Listed, never counted in anything above or below. */
  voidedCount: number;
  /** Gross sales, matching the manifest's `salesTotal` (a sum of `subtotal`). */
  salesTotal: number;
  returnsTotal: number;
  /** salesTotal − returnsTotal: what the stores actually owe. */
  netTotal: number;
  /** Distinct stores billed. Two receipts for one store count once. */
  storeCount: number;
};

export function totalReceipts(receipts: RunReceipt[]): ReceiptTotals {
  const stores = new Set<string>();
  let salesTotal = 0;
  let returnsTotal = 0;
  let voidedCount = 0;

  for (const receipt of receipts) {
    // A voided receipt bills nobody, so it doesn't make its store "served"
    // either. See RunReceipt.voidedAt.
    if (isVoided(receipt)) {
      voidedCount += 1;
      continue;
    }
    if (receipt.customerId) stores.add(receipt.customerId);
    salesTotal += receipt.subtotal;
    returnsTotal += receipt.returnsTotal;
  }

  return {
    receiptCount: receipts.length - voidedCount,
    voidedCount,
    salesTotal,
    returnsTotal,
    netTotal: salesTotal - returnsTotal,
    storeCount: stores.size,
  };
}

/**
 * An area's totals, or the whole day's, are `totalReceipts` over the runs'
 * receipts *concatenated* — never the per-run totals added up. Adding would
 * count a store twice when two trucks both billed it, and "stores served" is
 * the one figure on this page that has to mean distinct stores.
 */

/**
 * Who was on the truck, as one readable line — "Juan, Pedro" — or an em dash
 * when the run recorded nobody. Every screen and export names a run's people
 * through this, so they all say it the same way.
 */
export function runAgentNames(run: Run): string {
  return run.agents.map((agent) => agent.name).filter(Boolean).join(', ') || '—';
}

/**
 * Which trip of the day this run is for the same people — 1 for the first, 2
 * for the next, and so on.
 *
 * Counted here from the day's runs rather than read off `run.sequence`, and the
 * difference is a real one: the phone's counter is per agents **per account**,
 * so two logins taking the same people out — one of them by mistake — both
 * record themselves as trip 1. The dashboard can see both runs at once, so it is the
 * one place that can number them the way a reader would.
 *
 * Ordered by when each run started, with the id as a tie-break so the answer is
 * stable between renders. A run that isn't in the list falls back to what the
 * phone recorded.
 */
export function tripNumber(run: Run, dayRuns: Run[]): number {
  // The same people in any order are the same trip-mates.
  const peopleOf = (candidate: Run) =>
    candidate.agents
      .map((agent) => agent.id)
      .sort()
      .join('|');
  const people = peopleOf(run);
  const siblings = dayRuns
    .filter((candidate) => candidate.businessDay === run.businessDay && peopleOf(candidate) === people)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const index = siblings.findIndex((candidate) => candidate.id === run.id);
  return index >= 0 ? index + 1 : run.sequence;
}

/**
 * What one receipt actually put in the bag, as opposed to what it billed.
 *
 * Cash, GCash and a cheque are the whole total; a partial receipt is only what
 * has been handed over so far; credit is nothing yet. A receipt whose method
 * the phone never recorded — or one this build doesn't recognise — counts as
 * nothing collected, which files it with the money still to chase rather than
 * quietly counting it as paid.
 *
 * A voided receipt collected nothing, whatever method it was written with.
 */
export function receiptCollected(receipt: RunReceipt): number {
  if (isVoided(receipt)) return 0;
  switch (receipt.paymentMethod) {
    case 'cash':
    case 'gcash':
    case 'cheque':
      return receipt.total;
    case 'partial':
      return receipt.amountPaid ?? 0;
    default:
      return 0;
  }
}

/** How the money came in, one bucket per payment method. */
export type CollectedTotals = {
  cash: number;
  gcash: number;
  cheque: number;
  /** What the partially-paid receipts billed in full — not what was handed over. */
  partial: number;
  /** What has actually been paid against those partial receipts. */
  partialPaid: number;
  credit: number;
  /** cash + GCash + cheque + `partialPaid` — the money that is actually in. */
  collected: number;
};

/**
 * The payment split for a set of receipts.
 *
 * Lives here beside `totalReceipts` rather than inside either export, because
 * both of them ask it: the run workbook's Collected sheet and the period
 * workbook's, plus every per-day, per-truck and per-store "still owed" figure.
 * One definition of what counts as collected is what keeps them agreeing.
 *
 * Note what is **not** here: "still owed". That is net takings less what was
 * collected, and net belongs to `totalReceipts` — so the subtraction is left to
 * the caller holding both, rather than duplicated into a field that could drift
 * from the pair it is derived from.
 */
export function totalCollected(receipts: RunReceipt[]): CollectedTotals {
  const totals: CollectedTotals = {
    cash: 0,
    gcash: 0,
    cheque: 0,
    partial: 0,
    partialPaid: 0,
    credit: 0,
    collected: 0,
  };
  for (const receipt of receipts) {
    if (isVoided(receipt)) continue;
    switch (receipt.paymentMethod) {
      case 'cash':
        totals.cash += receipt.total;
        break;
      case 'gcash':
        totals.gcash += receipt.total;
        break;
      case 'cheque':
        totals.cheque += receipt.total;
        break;
      case 'partial':
        totals.partial += receipt.total;
        totals.partialPaid += receipt.amountPaid ?? 0;
        break;
      case 'credit':
        totals.credit += receipt.total;
        break;
      default:
        break;
    }
    totals.collected += receiptCollected(receipt);
  }
  return totals;
}

export type ExpenseTotals = {
  /** Expenses the run still stands behind — removed ones are not counted. */
  count: number;
  total: number;
};

/**
 * What a run spent, deleted expenses dropped.
 *
 * Deliberately its own function returning its own type, rather than a field on
 * `ReceiptTotals`. Putting it there would put it one keystroke away from every
 * net calculation on the page, and the rule for this figure is that it is shown
 * beside the takings and never taken out of them.
 */
export function totalExpenses(expenses: RunExpense[]): ExpenseTotals {
  const live = expenses.filter((expense) => !expense.deleted);
  return {
    count: live.length,
    total: live.reduce((sum, expense) => sum + expense.amount, 0),
  };
}

export type StockLine = {
  breadTypeId: string;
  /** The initial count plus every addition — what went onto the truck. */
  loaded: number;
  /** Sold, as a positive number (the ledger stores it negative). */
  sold: number;
  /** loaded − sold: what the ledger says is still aboard. */
  remaining: number;
};

/**
 * The ledger folded into one row per bread type — the same sum the phone does
 * in SQL, over the same signed quantities.
 *
 * `remaining` can legitimately read high: finalizing a receipt writes two
 * databases in two transactions, so a crash between them leaves a receipt whose
 * sale entry was never written. That is exactly why the sale entries are
 * uploaded alongside the receipts rather than derived from them — the gap shows
 * up as a mismatch instead of disappearing into a number nobody can check.
 *
 * A `'void'` entry takes loaves back *off* sold rather than adding them to
 * loaded: the bread never left the truck after all. So loaded − sold = remaining
 * still holds exactly, and a voided sale simply stops showing as one.
 */
export function totalStock(entries: RunStockEntry[]): StockLine[] {
  const lines = new Map<string, StockLine>();

  for (const entry of entries) {
    for (const item of entry.items) {
      const line = lines.get(item.breadTypeId) ?? {
        breadTypeId: item.breadTypeId,
        loaded: 0,
        sold: 0,
        remaining: 0,
      };
      if (entry.kind === 'sale') {
        line.sold += Math.abs(item.quantity);
      } else if (entry.kind === 'void') {
        line.sold -= Math.abs(item.quantity);
      } else {
        line.loaded += item.quantity;
      }
      line.remaining += item.quantity;
      lines.set(item.breadTypeId, line);
    }
  }

  return [...lines.values()];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const peso = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
});

/**
 * Money, with the peso sign. Unlike the printed receipt — which has to stay
 * ASCII because a thermal printer speaks single-byte code pages — a browser
 * renders ₱ perfectly well.
 */
export function formatMoney(value: number): string {
  return peso.format(value);
}

/** Whole counts with thousands separators. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-PH').format(value);
}

/**
 * "8.3%" / "12%" — a share, kept to one decimal only where it would otherwise
 * read as 0.
 *
 * Lives beside the other two formatters rather than in the Trends tab that
 * first needed it, because the bread section prints the same return rate in
 * three places now — the chart's Rate column, its table twin's, and the
 * per-bread dialog's headline figure — and one rounding rule is what stops
 * those disagreeing over the same fraction.
 */
export function formatShare(fraction: number): string {
  const percent = fraction * 100;
  if (percent <= 0) return '0%';
  if (percent < 1) return '<1%';
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}
