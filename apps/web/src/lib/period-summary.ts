import { businessDayKey, shiftBusinessDay } from '@/lib/business-day';
import type { BreadType } from '@/lib/bread-types';
import { fetchCustomers, type Customer } from '@/lib/customers';
import { daySpan } from '@/lib/day-ranges';
import type { NamedRecord } from '@/lib/named-records';
import type { ReturnedBreadType } from '@/lib/returned-bread-types';
import { buildNameFor, compareBreadNames } from '@/lib/run-outcome';
import {
  compareCashCount,
  fetchRunCashCount,
  fetchRunExpenses,
  fetchRunReceipts,
  fetchRunStockEntries,
  fetchRunsForRange,
  isVoided,
  receiptCollected,
  runAgentNames,
  totalCollected,
  totalExpenses,
  totalStock,
  type CollectedTotals,
  type Run,
  type RunCashCount,
  type RunExpense,
  type RunReceipt,
  type RunStockEntry,
} from '@/lib/runs';

/**
 * A stretch of business days, folded into the handful of tables somebody
 * actually asks a month of trucking for.
 *
 * This is the reading and the arithmetic; `lib/export-period-excel.ts` is the
 * workbook. Split for the same reason `lib/run-outcome.ts` is split from
 * `lib/export-run-excel.ts` — the ordering and joining rules are the part worth
 * being able to read on their own, and ExcelJS geometry is not.
 *
 * ## Where every figure comes from
 *
 * **From the documents that actually arrived, never from a run's manifest.**
 * The Trends tab charts manifests, and it is right to: ninety days of takings
 * is one query that way, and a manifest is a per-run rollup already sitting in
 * the run header. But a manifest holds five totals — no store in it, no bread
 * type, no payment method — so every sheet past the first would be
 * unanswerable from one. Since the receipts have to be opened anyway, they are
 * what the money is summed from, and the workbook has one source throughout
 * rather than two that could disagree row to row.
 *
 * That is also why this is deliberately **not** a claimed-versus-arrived check.
 * The dashboard used to carry one and it was taken out on the owner's call (see
 * "There is no claimed-vs-arrived comparison in the UI" in `apps/web/CLAUDE.md`).
 * Nothing here compares the two; it reads the one it can answer with.
 *
 * ## Loaves come off the ledger, pesos off the receipts
 *
 * **Every loaf figure in this file is the stock ledger's**, at every level:
 * loaded, sold and left on the truck are one arithmetic — `totalStock` builds
 * them so that loaded − sold = left exactly — and a run belongs to exactly one
 * day and one truck, so the same three numbers roll up to every sheet
 * and still add to the same total. Taking "sold" off the receipt lines instead
 * would read just as well on one sheet and stop the Days sheet totalling to the
 * Summary.
 *
 * The **money**, the **stores** and the **returns** are the receipts'. Returns
 * have no choice about it: a return is a write-off that carries no
 * `breadTypeId` and writes no ledger entry at all (see "Returns are a write-off
 * only" in `apps/mobile/CLAUDE.md`), so the name on the receipt is the only
 * join there is. The Bread sheet's footnote says which column came from where.
 *
 * ## Two Manila rules this file has to keep
 *
 * A run is counted on **the day it started**, matched on the `businessDay`
 * string the phone stored — never on a day re-derived from a timestamp here.
 * And a run's receipts are read under `runs/{runId}/receipts`, so a truck that
 * stayed out past midnight keeps its late receipts with the trip they belong to
 * rather than dropping them into the next day's query.
 *
 * ## "Stores" is a set everywhere, and that is the whole definition
 *
 * Every store count this file produces — a day's, a truck's, a run's,
 * a bread's, and the period total — is the size of a `Set` of `customerId`. So a
 * shop served five times counts once, a receipt naming no shop counts nowhere,
 * and **no store count in this file may ever be added to another**: two trucks
 * that both called at the same shop would double it. That is why the workbook
 * totals none of them and footnotes every one, and why the Summary's "Stores
 * served" is counted here rather than summed in Excel.
 *
 * ## A few figures are folded that no sheet currently prints
 *
 * `days` on a group row, `daysWithRuns` and `trucks` on the
 * totals, `daysSince` on a store, `sales` / `returnsValue` on a bread row, and
 * `expenseGroups` (the Expenses sheet's old grouped table) are all still
 * computed, and the workbook stopped laying any of them out in
 * September 2026 (see the sheet-by-sheet notes in `export-period-excel.ts`).
 * They are kept because this file is meant to be *what a period is* rather than
 * a backing array for the columns that happen to be on screen — each is a fold
 * of rows that have already been read, so none of them costs a query, and a
 * column asked for again is then one line in the layout rather than a change
 * here.
 */

/** Runs whose child collections this will open in one export. */
export const MaxRunsPerExport = 500;

/**
 * Above this the export still runs, but the dialog warns first that it will
 * take a while. Roughly a busy month; the point is that the reader chose to
 * wait rather than wondering whether the page has hung.
 */
export const SlowRunCount = 150;

/**
 * How many runs are read at once. Each one is three subcollection queries, so
 * this is really eighteen requests in flight — enough to hide the round trips
 * on a good connection, few enough to be polite to a phone hotspot.
 */
const RunConcurrency = 6;

/** Stands in for "this run recorded no truck", as the Trends tab's `NoneKey` does. */
const NoneKey = '__none__';

export type PeriodProgress = { done: number; total: number };

/** The three figures the stock ledger answers, for a run or for one bread type. */
type StockFigures = {
  /** The initial count plus every top-up — what went onto the truck. */
  loaded: number;
  /** Loaves that left the truck against a receipt. */
  sold: number;
  /** loaded − sold: what came home unsold. */
  remaining: number;
};

/** One run, with everything read for it folded down to a row. */
export type PeriodRunRow = StockFigures & {
  run: Run;
  receipts: number;
  stores: number;
  sales: number;
  returns: number;
  net: number;
  collected: number;
  /** net − collected: the credit and the half-paid receipts somebody has to chase. */
  owed: number;
  expenses: number;
  returnedLoaves: number;
  /**
   * False when this run's receipts, ledger or expenses could not be read at
   * all. The row is still written, with zeroes and a note in the status column,
   * rather than dropped — a run missing from the list would be invisible, where
   * a row of zeroes saying "could not be read" is a question somebody can ask.
   */
  read: boolean;
};

export type PeriodDayRow = StockFigures & {
  day: string;
  runs: number;
  receipts: number;
  stores: number;
  sales: number;
  returns: number;
  net: number;
  collected: number;
  owed: number;
  expenses: number;
  returnedLoaves: number;
};

/**
 * A truck's slice of the period. (There used to be crew and area slices of this
 * same shape; both dimensions were removed on the owner's call.)
 */
export type PeriodGroupRow = StockFigures & {
  id: string;
  name: string;
  runs: number;
  /** Distinct business days this truck went out on. */
  days: number;
  receipts: number;
  stores: number;
  sales: number;
  returns: number;
  net: number;
  collected: number;
  owed: number;
  expenses: number;
  returnedLoaves: number;
};

export type PeriodBreadRow = StockFigures & {
  name: string;
  /** Receipts: loaves written off back to a store, joined on the name. */
  returned: number;
  /** Receipts: distinct stores that took this bread at all. */
  stores: number;
  /** Receipts: what it was billed for. */
  sales: number;
  /** Receipts: what was credited back for it. */
  returnsValue: number;
};

export type PeriodStoreRow = {
  id: string;
  name: string;
  contact: string;
  phone: string;
  receipts: number;
  loaves: number;
  sales: number;
  returns: number;
  net: number;
  collected: number;
  owed: number;
  firstDay: string;
  lastDay: string;
  /**
   * When the last receipt was written. Kept only to decide *which* receipt is
   * the latest, so the name and contact on this row are that receipt's — an
   * ordering question, not a calendar one, which is why the day columns above
   * are the stored `businessDay` strings and this is a raw timestamp.
   */
  lastAt: number;
  /** Days between the store's last receipt and the end of the period — 0 on the last day. */
  daysSince: number;
};

/** Expenses folded by what they were for — "Fuel × 14, ₱18,400". */
export type PeriodExpenseGroup = { title: string; count: number; total: number };

/** One expense, with enough of its run beside it to be chased up. */
export type PeriodExpenseItem = {
  day: string;
  /** Who was on the truck — `runAgentNames`. */
  agents: string;
  truck: string;
  title: string;
  notes: string;
  amount: number;
  createdAt: number;
};

/**
 * One run's cash breakdown, for the workbook's Cash breakdown sheet — **one row
 * per run in the period**, including runs with no breakdown (`count: null`), so
 * a missing one is a visible row rather than an absence.
 *
 * The run is named the way the Runs sheet names it (day, agents, truck, start
 * time) plus its id, so every row can be matched to the trip it belongs to.
 * The comparison figures are the phone's own sum — see `compareCashCount`.
 */
export type PeriodCashCountItem = {
  run: Run;
  count: RunCashCount | null;
  /** Cash receipts + down payments on partial ones, voided receipts left out. */
  cashFromReceipts: number;
  expenses: number;
  expected: number;
  /** counted − expected; null when there is no breakdown to compare. */
  difference: number | null;
};

/**
 * One receipt, with enough of its run beside it to be found — **voided ones
 * included**, for the workbook's Receipts sheet.
 *
 * Voided receipts are folded into **nothing** else in this file — not the money,
 * not the stores, not the receipt counts, not the returned loaves. This list is
 * the one place they still appear, marked by `voidedAt`, so the sheet can show
 * them struck through and total around them. Their sold loaves need no special
 * handling: the phone wrote a `'void'` ledger entry putting them back on the
 * truck, and `totalStock` already reads it.
 */
export type PeriodReceiptItem = {
  day: string;
  /** Who delivered it — the names the receipt itself carries, else the run's. */
  agents: string;
  truck: string;
  store: string;
  paymentMethod: string | null;
  /** Gross, before the returns credit. */
  sales: number;
  returns: number;
  /** sales − returns. */
  net: number;
  /** What actually came in on it (`receiptCollected`) — 0 on a voided receipt. */
  collected: number;
  createdAt: number;
  /** Null unless the receipt was voided on the phone. */
  voidedAt: number | null;
};

export type PeriodTotals = StockFigures & {
  runs: number;
  daysWithRuns: number;
  trucks: number;
  receipts: number;
  stores: number;
  sales: number;
  returns: number;
  net: number;
  collected: number;
  owed: number;
  expenses: number;
  returnedLoaves: number;
};

export type PeriodSummary = {
  from: string;
  to: string;
  /** Every calendar day in the range, empty ones included. */
  days: PeriodDayRow[];
  runs: PeriodRunRow[];
  trucks: PeriodGroupRow[];
  bread: PeriodBreadRow[];
  stores: PeriodStoreRow[];
  collected: CollectedTotals;
  expenseGroups: PeriodExpenseGroup[];
  expenseItems: PeriodExpenseItem[];
  /** One row per run, newest first like `runs` — see PeriodCashCountItem. */
  cashCounts: PeriodCashCountItem[];
  /**
   * Every receipt in the period, oldest first, voided ones included. The voided
   * ones are counted in nothing above; the Receipts sheet leaves them out of its
   * totals too.
   */
  receipts: PeriodReceiptItem[];
  totals: PeriodTotals;
  /** Runs whose child collections could not be read. 0 is the ordinary case. */
  unreadRuns: number;
  /** True when the store catalog could not be read — names still come off the receipts. */
  storeDetailsMissing: boolean;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type LoadedRun = {
  run: Run;
  receipts: RunReceipt[];
  entries: RunStockEntry[];
  expenses: RunExpense[];
  cashCount: RunCashCount | null;
  read: boolean;
};

/** Thrown before anything is opened, so the dialog can say how far over the cap the range is. */
export class PeriodTooLargeError extends Error {
  readonly runCount: number;

  constructor(runCount: number) {
    super(`This range holds ${runCount} runs, more than the ${MaxRunsPerExport} one export can gather.`);
    this.name = 'PeriodTooLargeError';
    this.runCount = runCount;
  }
}

/**
 * How many runs a range holds, without opening any of them.
 *
 * The dialog asks this before the reader commits, so "23 runs across 7 days" is
 * on screen next to the Export button rather than discovered halfway through a
 * progress bar. One indexed range query on `businessDay`.
 */
export async function countRunsInRange(from: string, to: string): Promise<number> {
  const runs = await fetchRunsForRange(from, to);
  return runs.length;
}

/**
 * Reads a period and folds it down.
 *
 * **Nothing here rejects on a single bad run**, the same rule the proof photos
 * follow in the run export: one unreadable subcollection would otherwise cost
 * the reader the other two hundred runs. A failure marks its run `read: false`,
 * bumps `unreadRuns`, and the workbook says so on the Summary. Only the two
 * things nothing can be built without — the run list itself, and being over the
 * cap — throw.
 *
 * The runs query is re-run here rather than reusing the list the dialog
 * counted: a truck can start a day between the dialog opening and Export being
 * clicked, and the file should be the period as it stands at the moment of
 * export.
 */
export async function buildPeriodSummary({
  from,
  to,
  trucks,
  breadTypes,
  returnedBreadTypes,
  onProgress,
}: {
  from: string;
  to: string;
  /** The Trucks reference list, for putting the truck rows in the dashboard's own order. */
  trucks: NamedRecord[];
  breadTypes: BreadType[];
  returnedBreadTypes: ReturnedBreadType[];
  onProgress?: (progress: PeriodProgress) => void;
}): Promise<PeriodSummary> {
  const runs = await fetchRunsForRange(from, to);
  if (runs.length > MaxRunsPerExport) throw new PeriodTooLargeError(runs.length);

  // The store catalog is wanted for the phone number on the Stores sheet,
  // which is not on a receipt. It is an enrichment, not a
  // source: if it fails, every store still has its name, its money and its
  // dates from the receipts themselves, so the export goes ahead without it.
  let customers: Customer[] = [];
  let storeDetailsMissing = false;
  try {
    customers = await fetchCustomers();
  } catch (error) {
    console.error('[period-summary.customers]', error);
    storeDetailsMissing = true;
  }

  onProgress?.({ done: 0, total: runs.length });
  const loaded = await loadRuns(runs, onProgress);
  return foldPeriod({
    from,
    to,
    loaded,
    customers,
    trucks,
    breadTypes,
    returnedBreadTypes,
    storeDetailsMissing,
  });
}

async function loadRuns(runs: Run[], onProgress?: (progress: PeriodProgress) => void): Promise<LoadedRun[]> {
  const results: LoadedRun[] = new Array(runs.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= runs.length) return;
      const run = runs[index];
      try {
        const [receipts, entries, expenses, cashCount] = await Promise.all([
          fetchRunReceipts(run.id),
          fetchRunStockEntries(run.id),
          fetchRunExpenses(run.id),
          fetchRunCashCount(run.id),
        ]);
        results[index] = { run, receipts, entries, expenses, cashCount, read: true };
      } catch (error) {
        console.error('[period-summary.run]', run.id, error);
        results[index] = { run, receipts: [], entries: [], expenses: [], cashCount: null, read: false };
      } finally {
        done += 1;
        onProgress?.({ done, total: runs.length });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(RunConcurrency, runs.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * The running total behind every "by X" sheet.
 *
 * Stores are a `Set` rather than a count for the same reason `totalReceipts`
 * keeps one: two receipts to the same shop are one shop served, and adding
 * per-run counts up would double it the moment two trucks both called there.
 */
type Bucket = StockFigures & {
  runs: number;
  receipts: number;
  stores: Set<string>;
  sales: number;
  returns: number;
  collected: number;
  expenses: number;
  returnedLoaves: number;
};

function newBucket(): Bucket {
  return {
    runs: 0,
    receipts: 0,
    stores: new Set(),
    sales: 0,
    returns: 0,
    collected: 0,
    expenses: 0,
    loaded: 0,
    sold: 0,
    remaining: 0,
    returnedLoaves: 0,
  };
}

function addReceipt(bucket: Bucket, receipt: RunReceipt) {
  bucket.receipts += 1;
  if (receipt.customerId) bucket.stores.add(receipt.customerId);
  bucket.sales += receipt.subtotal;
  bucket.returns += receipt.returnsTotal;
  bucket.collected += receiptCollected(receipt);
  for (const ret of receipt.returns) bucket.returnedLoaves += ret.quantity;
}

/** Everything one run contributes that isn't a receipt: its ledger and its spending. */
function addRun(bucket: Bucket, stock: StockFigures, spend: number) {
  bucket.runs += 1;
  bucket.expenses += spend;
  bucket.loaded += stock.loaded;
  bucket.sold += stock.sold;
  bucket.remaining += stock.remaining;
}

function bucketFigures(bucket: Bucket) {
  const net = bucket.sales - bucket.returns;
  return {
    runs: bucket.runs,
    receipts: bucket.receipts,
    stores: bucket.stores.size,
    sales: bucket.sales,
    returns: bucket.returns,
    net,
    collected: bucket.collected,
    owed: net - bucket.collected,
    expenses: bucket.expenses,
    loaded: bucket.loaded,
    sold: bucket.sold,
    remaining: bucket.remaining,
    returnedLoaves: bucket.returnedLoaves,
  };
}

function upsert<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing) return existing;
  const made = create();
  map.set(key, made);
  return made;
}

/** A truck, mid-fold. */
type GroupAccumulator = { name: string; bucket: Bucket; days: Set<string> };

function foldPeriod({
  from,
  to,
  loaded,
  customers,
  trucks,
  breadTypes,
  returnedBreadTypes,
  storeDetailsMissing,
}: {
  from: string;
  to: string;
  loaded: LoadedRun[];
  customers: Customer[];
  trucks: NamedRecord[];
  breadTypes: BreadType[];
  returnedBreadTypes: ReturnedBreadType[];
  storeDetailsMissing: boolean;
}): PeriodSummary {
  const allReceipts = loaded.flatMap((entry) => entry.receipts);
  // One resolver for the whole period: the catalog's spelling first, then the
  // snapshot a receipt carries, so a bread type deleted mid-period still shows
  // the name it sold under instead of an id.
  const nameFor = buildNameFor(breadTypes, allReceipts);

  // Every day in the range gets a row, including the ones nothing happened on.
  // A gap is information — a Sunday off, a truck that never went out — and a
  // table that silently skips empty days misstates the shape of a week.
  const dayBuckets = new Map<string, Bucket>();
  for (let offset = 0; offset < daySpan(from, to); offset += 1) {
    dayBuckets.set(shiftBusinessDay(from, offset), newBucket());
  }

  const truckBuckets = new Map<string, GroupAccumulator>();
  const period = newBucket();

  const runRows: PeriodRunRow[] = [];
  const expenseItems: PeriodExpenseItem[] = [];
  const cashCountItems: PeriodCashCountItem[] = [];
  const receiptItems: PeriodReceiptItem[] = [];

  const breadRows = new Map<string, PeriodBreadRow>();
  const breadStores = new Map<string, Set<string>>();
  const breadRow = (name: string) =>
    upsert(breadRows, name, () => ({
      name,
      loaded: 0,
      sold: 0,
      remaining: 0,
      returned: 0,
      stores: 0,
      sales: 0,
      returnsValue: 0,
    }));

  const storeRows = new Map<string, PeriodStoreRow>();

  for (const entry of loaded) {
    const { run, entries, expenses } = entry;
    // Everything below folds `receipts`, so taking the voided ones out here is
    // what keeps them out of every figure at once. The Receipts sheet's list
    // below still carries them, marked, rather than dropping them.
    const receipts = entry.receipts.filter((receipt) => !isVoided(receipt));
    for (const receipt of entry.receipts) {
      receiptItems.push({
        day: receipt.businessDay || run.businessDay,
        agents: receipt.agentNames || runAgentNames(run),
        truck: run.truckName || 'Unnamed truck',
        store: receipt.customerName || 'Unnamed store',
        paymentMethod: receipt.paymentMethod,
        sales: receipt.subtotal,
        returns: receipt.returnsTotal,
        net: receipt.total,
        collected: receiptCollected(receipt),
        createdAt: receipt.createdAt,
        voidedAt: receipt.voidedAt,
      });
    }
    const spend = totalExpenses(expenses);
    // Off the standing receipts only — `totalCollected` skips voided ones too.
    const cashCompare = compareCashCount(totalCollected(receipts), spend.total, entry.cashCount?.total ?? 0);
    cashCountItems.push({
      run,
      count: entry.cashCount,
      cashFromReceipts: cashCompare.cashFromReceipts,
      expenses: spend.total,
      expected: cashCompare.expected,
      difference: entry.cashCount ? cashCompare.difference : null,
    });
    const lines = totalStock(entries);
    const stock: StockFigures = {
      loaded: lines.reduce((sum, line) => sum + line.loaded, 0),
      sold: lines.reduce((sum, line) => sum + line.sold, 0),
      remaining: lines.reduce((sum, line) => sum + line.remaining, 0),
    };

    const runBucket = newBucket();
    addRun(runBucket, stock, spend.total);
    for (const receipt of receipts) addReceipt(runBucket, receipt);
    runRows.push({ run, ...bucketFigures(runBucket), read: entry.read });

    // The run is counted on the day it *started*, which is the day the board
    // files it under — never on a day derived from a receipt's timestamp, which
    // for a truck that crossed midnight would scatter one trip across two days.
    const day = dayBuckets.get(run.businessDay);
    if (day) {
      addRun(day, stock, spend.total);
      for (const receipt of receipts) addReceipt(day, receipt);
    }

    const truck = upsert(truckBuckets, run.truckId || NoneKey, () => newGroup(run.truckName || 'No truck recorded'));
    addRun(truck.bucket, stock, spend.total);
    truck.days.add(run.businessDay);
    for (const receipt of receipts) addReceipt(truck.bucket, receipt);

    addRun(period, stock, spend.total);
    for (const receipt of receipts) addReceipt(period, receipt);

    for (const expense of expenses) {
      if (expense.deleted) continue;
      expenseItems.push({
        day: run.businessDay,
        agents: runAgentNames(run),
        truck: run.truckName || 'Unnamed truck',
        title: expense.title || 'Untitled',
        notes: expense.notes,
        amount: expense.amount,
        createdAt: expense.createdAt,
      });
    }

    // Bread, the ledger's half. Keyed by the resolved *name* rather than the
    // id, exactly as `buildOutcomeRows` keys its rows — over a period two ids
    // can resolve to one name (a bread type deleted and made again), and one
    // name is one row.
    for (const line of lines) {
      const row = breadRow(nameFor(line.breadTypeId));
      row.loaded += line.loaded;
      row.sold += line.sold;
      row.remaining += line.remaining;
    }

    for (const receipt of receipts) {
      // Bread, the receipts' half: the money, and who took it.
      for (const item of receipt.items) {
        // Resolved through `nameFor` wherever there is an id, so a receipt line
        // and the ledger entry it was written beside land on the same row.
        const name = item.breadTypeId ? nameFor(item.breadTypeId) : item.name || 'Unnamed bread type';
        breadRow(name).sales += item.unitPrice * item.quantity;
        if (receipt.customerId) upsert(breadStores, name, () => new Set<string>()).add(receipt.customerId);
      }
      // A return carries no `breadTypeId` at all, so the name it was written
      // under is the only join there is — word for word, as everywhere else.
      for (const ret of receipt.returns) {
        const row = breadRow(ret.name || 'Unnamed bread type');
        row.returned += ret.quantity;
        row.returnsValue += ret.unitPrice * ret.quantity;
      }

      foldStore(storeRows, receipt);
    }
  }

  for (const [name, stores] of breadStores) {
    const row = breadRows.get(name);
    if (row) row.stores = stores.size;
  }

  return {
    from,
    to,
    days: [...dayBuckets.entries()].map(([day, bucket]) => ({ day, ...bucketFigures(bucket) })),
    // Newest run first — a period is read from its most recent end, the same
    // way the board reads a day.
    runs: runRows.sort((a, b) => b.run.startedAt - a.run.startedAt),
    trucks: toGroupRows(truckBuckets, trucks),
    bread: toBreadRows(breadRows, breadTypes, returnedBreadTypes),
    stores: toStoreRows(storeRows, customers, to),
    collected: totalCollected(allReceipts),
    expenseGroups: groupExpenses(expenseItems),
    expenseItems: expenseItems.sort((a, b) => a.createdAt - b.createdAt),
    cashCounts: cashCountItems.sort((a, b) => b.run.startedAt - a.run.startedAt),
    receipts: receiptItems.sort((a, b) => a.createdAt - b.createdAt),
    totals: {
      ...bucketFigures(period),
      daysWithRuns: [...dayBuckets.values()].filter((bucket) => bucket.runs > 0).length,
      trucks: truckBuckets.size,
    },
    unreadRuns: loaded.filter((entry) => !entry.read).length,
    storeDetailsMissing,
  };
}

function newGroup(name: string): GroupAccumulator {
  return { name, bucket: newBucket(), days: new Set<string>() };
}

/**
 * One store's running row.
 *
 * The **day** is the receipt's own `businessDay` string, not a day derived from
 * its timestamp — the same rule the rest of the dashboard follows, and the one
 * that keeps a 6:30 AM Manila sale out of the day before. The **name** is a
 * different question, and turns on `createdAt`: receipts arrive from
 * `fetchRunReceipts` in no particular order and a period holds many runs, so
 * comparing days alone would leave "the latest spelling" meaning "whichever of
 * that day's receipts happened to be read last".
 */
function foldStore(rows: Map<string, PeriodStoreRow>, receipt: RunReceipt) {
  if (!receipt.customerId) return;
  const day = receipt.businessDay || businessDayKey(receipt.createdAt);
  const store = upsert(rows, receipt.customerId, () => ({
    id: receipt.customerId,
    name: receipt.customerName || 'Unnamed store',
    contact: receipt.customerContactName,
    phone: '',
    receipts: 0,
    loaves: 0,
    sales: 0,
    returns: 0,
    net: 0,
    collected: 0,
    owed: 0,
    firstDay: day,
    lastDay: day,
    lastAt: receipt.createdAt,
    daysSince: 0,
  }));
  store.receipts += 1;
  store.sales += receipt.subtotal;
  store.returns += receipt.returnsTotal;
  store.collected += receiptCollected(receipt);
  for (const item of receipt.items) store.loaves += item.quantity;
  if (day < store.firstDay) store.firstDay = day;
  if (day > store.lastDay) store.lastDay = day;
  if (receipt.createdAt >= store.lastAt) {
    store.lastAt = receipt.createdAt;
    // The latest receipt's spelling wins, so a store renamed on a phone
    // mid-period appears under the name it goes by now.
    store.name = receipt.customerName || store.name;
    store.contact = receipt.customerContactName || store.contact;
  }
}

/**
 * The trucks in **the order the dashboard lists them** — the position a
 * manager dragged each one to on the reference lists page, the same rule the
 * Bread sheet follows: a reader who knows where a truck sits in that list finds
 * it in the same place here, month after month, instead of hunting for it in a
 * ranking that reshuffles every period.
 *
 * Matched on **id**, never on name, so a truck renamed since still sorts into
 * its place. Two kinds of row have no place in the list, and go after every one
 * that does: a truck **deleted since** the run (by name, among themselves), and
 * last of all the "No truck recorded" row. If the list itself could not be
 * read, everything falls to name order rather than failing.
 */
function toGroupRows(buckets: Map<string, GroupAccumulator>, catalog: NamedRecord[]): PeriodGroupRow[] {
  const position = new Map(catalog.map((record) => [record.id, record.order]));
  const band = (id: string) => (id === NoneKey ? 2 : position.has(id) ? 0 : 1);
  return [...buckets.entries()]
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      days: entry.days.size,
      ...bucketFigures(entry.bucket),
    }))
    .sort(
      (a, b) =>
        band(a.id) - band(b.id) ||
        (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The bread rows, in the reference lists' own manual order — the position a
 * manager dragged each bread to, with a returned-only name landing directly
 * under the bread type holding its place (`compareBreadNames`). One list of
 * bread in one order wherever the dashboard shows it.
 *
 * **Every bread type in the catalog gets a row**, whether it moved or not: the
 * same departure from the run panel's Outcome table that the Trends tab makes,
 * for the same reason. Over a period a bread that sold *nothing* is itself the
 * finding, and a reader scanning for it would otherwise have to notice an
 * absence.
 */
function toBreadRows(
  rows: Map<string, PeriodBreadRow>,
  breadTypes: BreadType[],
  returnedBreadTypes: ReturnedBreadType[],
): PeriodBreadRow[] {
  const byPosition = compareBreadNames(breadTypes, returnedBreadTypes);
  const all = [...rows.values()];
  const seen = new Set(all.map((row) => row.name));
  for (const type of breadTypes) {
    if (!type.name || seen.has(type.name)) continue;
    seen.add(type.name);
    all.push({
      name: type.name,
      loaded: 0,
      sold: 0,
      remaining: 0,
      returned: 0,
      stores: 0,
      sales: 0,
      returnsValue: 0,
    });
  }
  return all.sort((a, b) => byPosition(a.name, b.name));
}

/**
 * The stores, biggest net first, enriched from the catalog where it can be.
 *
 * `daysSince` is measured to the **end of the period**, not to today, so an
 * export of last March still reads correctly next year: "went quiet 24 days
 * before this period ended" is a fact about the period, where "24 days before
 * you clicked Export" would not be.
 */
function toStoreRows(
  rows: Map<string, PeriodStoreRow>,
  customers: Customer[],
  to: string,
): PeriodStoreRow[] {
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  return [...rows.values()]
    .map((row) => {
      const customer = byId.get(row.id);
      const net = row.sales - row.returns;
      return {
        ...row,
        name: customer?.storeName || row.name,
        contact: customer?.name || row.contact,
        phone: customer?.phone ?? '',
        net,
        owed: net - row.collected,
        daysSince: Math.max(0, daySpan(row.lastDay, to) - 1),
      };
    })
    .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
}

/**
 * Expenses folded by what they were for, biggest first.
 *
 * Titles are matched **word for word**, the same rule the Outcome table joins
 * bread names by: "Fuel" and "fuel " are two rows, which is a visible, fixable
 * thing, where quietly folding them together would file one truck's spending
 * under another's heading.
 */
function groupExpenses(items: PeriodExpenseItem[]): PeriodExpenseGroup[] {
  const groups = new Map<string, PeriodExpenseGroup>();
  for (const item of items) {
    const group = upsert(groups, item.title, () => ({ title: item.title, count: 0, total: 0 }));
    group.count += 1;
    group.total += item.amount;
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
}
