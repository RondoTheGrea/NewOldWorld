import { useEffect, useMemo, useState } from 'react';

import {
  BarChart,
  ChartCard,
  ChartEmpty,
  ColumnChart,
  compactMoney,
  DonutChart,
  Legend,
  LineChart,
  SeriesColors,
  SequentialSoft,
  SequentialStrong,
  SplitBarChart,
  type Column,
} from '@/components/charts';
import { BreadDetailDialog } from '@/components/bread-detail-dialog';
import { DateRangePicker } from '@/components/date-range-picker';
import {
  bumpBreadSlice,
  emptyBreadBreakdown,
  joinBreadBreakdowns,
  type BreadBreakdown,
} from '@/lib/bread-detail';
import { watchBreadTypes, type BreadType } from '@/lib/bread-types';
import { currentBusinessDayKey, formatBusinessDayShort, shiftBusinessDay } from '@/lib/business-day';
// The calendar arithmetic and the range readout live in lib/day-ranges.ts
// rather than here, because the Live tab's summary export offers the same
// "this week" and "this month" and the two have to agree on what they mean.
import {
  daySpan,
  formatDateRangeLabel,
  monthRange,
  recentDayOptions,
  recentMonthOptions,
  startOfWeek,
  WeekOptionLabels,
} from '@/lib/day-ranges';
import { watchReturnedBreadTypes, type ReturnedBreadType } from '@/lib/returned-bread-types';
import { compareBreadNames } from '@/lib/run-outcome';
import { buildStoreStats, storeNetByBucket, trendBuckets } from '@/lib/store-stats';
import {
  fetchRunReceipts,
  fetchRunsForRange,
  formatCount,
  formatMoney,
  formatShare,
  totalReceipts,
  type Run,
  type RunReceipt,
} from '@/lib/runs';

/**
 * The Trends tab: the same numbers, over weeks instead of hours.
 *
 * **Where the figures come from, and why it matters.** A closed run carries the
 * manifest its phone uploaded when the driver ended the day — receipt count,
 * gross sales, returns — which is a per-run daily rollup already sitting in the
 * run header. Charting from those means ninety days costs *one query*, instead
 * of opening every run's receipts subcollection to add the same numbers up
 * again.
 *
 * The catch, stated on the page rather than buried here: a manifest is what the
 * *phone* recorded, and the Live tab exists partly because that can be higher
 * than what actually arrived. For a business trend that is the right figure —
 * the sales happened — but it is not the same question as "is everything
 * uploaded", and the two must not be confused.
 *
 * Runs with **no** manifest (still open, or abandoned without ending the day)
 * are totalled from their receipts instead — the same receipts the bread and
 * store sections read, so they are fetched once, and first.
 *
 * **The crew is the dividing line here, not the area.** Performance is
 * compared between crews — an area is a round, and the same round worked by
 * two crews is the comparison worth making — so "Net takings by crew" leads
 * the breakdown and the area chart follows it. Bread performance is scoped by
 * **both**, because the useful question is usually one crew's numbers on one
 * round rather than either on its own.
 */

type RangeType = 'month' | 'week' | 'day' | 'year' | 'custom';

/** How many months back the Month dropdown offers. */
const MonthOptionCount = 24;

/** How many days back the Day dropdown offers, today included. */
const DayOptionCount = 14;

/** How many years back the Year dropdown offers, current year included. */
const YearOptionCount = 6;

/**
 * A manifest is a per-run rollup with no bread-type breakdown in it — it was
 * written that way so ninety days of totals cost one query. Bread and store
 * performance have no such shortcut: they only exist inside each receipt, so
 * charting them means opening every run's receipts subcollection.
 *
 * **Every run in the range is read — there is no cap**, on the owner's call
 * (September 2026). There used to be one (60 runs), and a month with a few
 * trucks out daily already outgrew it, so the store rankings were built from
 * a sample. Reads go this many runs at a time: in parallel so a year doesn't
 * take minutes, but not all at once, which is rude to a phone hotspot and
 * would re-render the tab once per run.
 */
const ReceiptReadBatch = 8;

/**
 * Stands in for "this run recorded no crew" (or no area) so those runs get a
 * row of their own instead of an empty-string key that a `<select>` can't
 * meaningfully hold. A run that reaches the dashboard without a crew is a run
 * that predates crews or was written by hand — either way it is a real slice
 * of the money and must not be silently dropped from a total.
 */
const NoneKey = '__none__';

/**
 * How many stores the two store cards show at once — one "page" of the ranking.
 * Five slices plus "everyone else" is as many as a ring can hold before the
 * thin ones stop being tellable apart, five lines is as many as a line chart
 * can, and the validated palette has six hues and must never cycle.
 *
 * So "more stores" **steps through the ranking five at a time** (#1–5, #6–10…)
 * with Back / Next, rather than piling more onto the graphs — the owner's pick
 * over "add five more and draw the extras grey". Both cards, and both of their
 * table views, always show exactly the same five stores.
 */
const StorePageSize = 5;

/** The ring's "All other stores" slice — neutral grey, so it never reads as a sixth store. */
const OtherStoresColor = '#cbd5e1';

/**
 * How many *identified* shops a bread's store cut names.
 *
 * The `NoneKey` bucket holds every receipt written without a store, and it is
 * one bucket rather than one row per receipt — so it is loaves that moved but
 * not a shop that can be counted, and the column skips it exactly as
 * `totalReceipts` skips an unidentified buyer.
 */
function countStores(stores: Map<string, unknown>): number {
  let total = 0;
  for (const key of stores.keys()) if (key !== NoneKey) total += 1;
  return total;
}

/**
 * The two parts of a bread's bar, in slot order.
 *
 * One word each, because the word is doing two jobs at once: it heads that
 * segment's column of figures and it keys its colour, and the two can't drift
 * apart when they are the same string.
 */
const BreadSeries = [
  { label: 'Sold', color: SeriesColors[0] },
  { label: 'Returned', color: SeriesColors[1] },
];

/**
 * The columns with a figure but no mark on the bar: what share of a bread came
 * back, and how many different stores took it at all.
 *
 * Neither can be a segment of a bar drawn in loaves — a rate isn't a length and
 * a count of shops isn't loaves — but they are the next two things a manager
 * asks after "how much" and "how much came back", and they belong on the row
 * rather than a page away. **They are the table view's last two columns, in the
 * table view's order**: the whole point of the split bar's number columns is
 * that toggling to the table doesn't move them.
 */
const BreadExtras = [{ label: 'Rate' }, { label: 'Stores' }];

type DayTotals = { day: string; sales: number; returns: number; net: number; receipts: number; runs: number };

/**
 * One bread type's rollup for the period.
 *
 * `breakdown` is the same loaves cut three ways — by crew, by area and by
 * store — filled in the same pass as `quantity` so the per-bread dialog can
 * never disagree with the row that opens it. Its `stores` map is also what the
 * Stores column counts: the same store buying the same bread on Monday and
 * again on Friday is one store carrying it, the rule `totalReceipts` counts a
 * day's stores by, and a receipt naming no store lands in a bucket of its own
 * that the count skips. Only the *sold* side fills that column — the question
 * it answers is who takes this bread, not who sent it back.
 *
 * There is no peso total here. The money is General statistics' subject and
 * this section's is loaves, so a revenue field would only be a number nothing
 * reads.
 */
type BreadRow = { key: string; name: string; quantity: number; lastSeen: number; breakdown: BreadBreakdown };

/**
 * One row of the bread chart, once sales and returns have been joined: what
 * the bar draws, what the table prints, and what the dialog opens into.
 *
 * The two `*Breakdown` fields are the row's three cuts **unmerged** — the sold
 * side and whichever returns this row claimed — and that split is deliberate.
 * Deciding *which* returns belong to this bread is the join rule, and it stays
 * where the figures are decided (`breadMovement`, on the name, claimed once).
 * Actually folding the two together and sorting them is arithmetic nobody has
 * asked for until a dialog opens, and doing it here would run it for every
 * bread in the catalog on every recompute — of which there is one per receipt
 * batch of receipts that lands while a period loads. For a
 * popular bread over a month the store cut alone is hundreds of rows, so that
 * is hundreds of thousands of copies and a sort each, thrown away unread. See
 * `openBreadDetail`, which does it once, for one bread, on demand.
 */
type BreadMovementRow = {
  key: string;
  name: string;
  sold: number;
  returned: number;
  stores: number;
  breakdown?: BreadBreakdown;
  backBreakdown?: BreadBreakdown;
};

/** One row of a "net takings by X" breakdown — the crew and area charts share the shape. */
type GroupTotals = { id: string; name: string; net: number; runs: number };

function crewKeyOf(run: Run): string {
  return run.agentGroupId || NoneKey;
}

function areaKeyOf(run: Run): string {
  return run.areaId || NoneKey;
}

/**
 * Rolls runs up by whatever key is handed in, biggest net first.
 *
 * One function for both breakdowns rather than two near-identical memos: they
 * differ only in which field they group on and what an unset one is called,
 * and keeping them one function is what stops the two charts drifting apart on
 * how they treat a run with no crew or no area.
 */
function groupRuns(
  runs: Run[],
  keyOf: (run: Run) => string,
  nameOf: (run: Run) => string,
  figuresFor: (run: Run) => { sales: number; returns: number },
): GroupTotals[] {
  const map = new Map<string, GroupTotals>();
  for (const run of runs) {
    const id = keyOf(run);
    const figures = figuresFor(run);
    const row = map.get(id) ?? { id, name: nameOf(run), net: 0, runs: 0 };
    row.net += figures.sales - figures.returns;
    row.runs += 1;
    map.set(id, row);
  }
  return [...map.values()].sort((a, b) => b.net - a.net);
}

/** The `[id, name]` pairs a filter dropdown offers, in name order. */
function optionsFrom(rows: GroupTotals[]): [string, string][] {
  return rows.map((row): [string, string] => [row.id, row.name]).sort((a, b) => a[1].localeCompare(b[1]));
}

/**
 * A big rule with a title on it, dividing the tab into the two things it
 * actually shows: the money, and the bread. Purely structural — nothing here
 * is a control, and it scopes nothing.
 */
function SectionHeadline({ title, note }: { title: string; note: string }) {
  return (
    <div className="ops-headline-block">
      <h2 className="ops-headline">{title}</h2>
      <p className="ops-headline-note">{note}</p>
    </div>
  );
}

export function TrendsTab() {
  const today = currentBusinessDayKey();

  // The range is a type (month / week / year) plus whichever value that type
  // is currently showing — never a pair of free-standing dates. That's what
  // keeps every option always landing on a real calendar boundary: there's no
  // state that lets "from" and "to" drift apart from what the dropdowns say.
  const [rangeType, setRangeType] = useState<RangeType>('month');
  const [monthValue, setMonthValue] = useState<string>(() => currentBusinessDayKey().slice(0, 7));
  const [weekOffset, setWeekOffset] = useState(0);
  // A single day charts perfectly well — `byDay` gets one row, the breakdowns
  // and the bread chart get that day's runs — and it is the unit somebody
  // lands on after spotting something odd on a week. It sits next to Week
  // rather than at the end so the list reads longest-to-shortest.
  const [dayValue, setDayValue] = useState<string>(() => currentBusinessDayKey());
  const [yearValue, setYearValue] = useState<number>(() => Number(currentBusinessDayKey().slice(0, 4)));
  // Custom starts with nothing picked — no default 7-day window, no
  // guessed range. Selecting "Custom" just offers the picker; it's the
  // reader's job to choose two dates, and null until they do is what makes
  // that visible instead of silently substituting something for them.
  const [customFrom, setCustomFrom] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);

  const monthOptions = useMemo(() => recentMonthOptions(today, MonthOptionCount), [today]);
  const dayOptions = useMemo(() => recentDayOptions(today, DayOptionCount), [today]);

  const yearOptions = useMemo(() => {
    const currentYear = Number(today.slice(0, 4));
    return Array.from({ length: YearOptionCount }, (_, i) => currentYear - i);
  }, [today]);

  // The one calculation everything else in this tab reads from. A month or a
  // year still in progress is capped at today rather than run out to its
  // calendar end — "August" while it's the 18th means month-to-date, not
  // eleven empty days tacked on the end of the chart.
  //
  // `null` only ever happens for Custom before a range has been applied —
  // every other type always resolves to real dates. Everything downstream
  // that reads `from`/`to` treats a null pair as "nothing to show yet", not
  // as an error.
  const { from, to } = useMemo((): { from: string | null; to: string | null } => {
    let range: { from: string; to: string } | null;
    if (rangeType === 'month') {
      const [year, month] = monthValue.split('-').map(Number);
      range = monthRange(year, month);
    } else if (rangeType === 'week') {
      const start = startOfWeek(shiftBusinessDay(today, -7 * weekOffset));
      range = { from: start, to: shiftBusinessDay(start, 6) };
    } else if (rangeType === 'day') {
      range = { from: dayValue, to: dayValue };
    } else if (rangeType === 'year') {
      range = { from: `${yearValue}-01-01`, to: `${yearValue}-12-31` };
    } else if (customFrom && customTo) {
      // Already clamped to `today` by the picker's own `max` — no cap needed here.
      range = { from: customFrom, to: customTo };
    } else {
      range = null;
    }
    if (!range) return { from: null, to: null };
    return { from: range.from, to: range.to > today ? today : range.to };
  }, [rangeType, monthValue, weekOffset, dayValue, yearValue, customFrom, customTo, today]);

  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every run's receipts — see ReceiptReadBatch above for why the bread and
  // store sections can't ride the manifest path the money charts use.
  //
  // Two filters, and they narrow together. "Crew A" answers how one crew is
  // doing; "Cainta" answers what that round sells; the pair answers the
  // question that actually gets asked — how this crew did on this round —
  // which neither filter alone can.
  const [crewFilter, setCrewFilter] = useState<string>('all');
  const [areaFilter, setAreaFilter] = useState<string>('all');
  // The store section's own crew/area scope — separate from the bread one, so
  // narrowing one section never silently narrows the other.
  const [storeCrewFilter, setStoreCrewFilter] = useState<string>('all');
  const [storeAreaFilter, setStoreAreaFilter] = useState<string>('all');
  const [breadReceipts, setBreadReceipts] = useState<Map<string, RunReceipt[]>>(new Map());
  // Which bread's dialog is open, held as the row's **key** rather than the
  // row itself. A filter switched while it is open then re-resolves against
  // the rows that are actually on screen, and a bread the new scope has no row
  // for closes the dialog instead of leaving a set of figures behind the scrim
  // that nothing on the page agrees with.
  const [openBread, setOpenBread] = useState<string | null>(null);
  // Runs whose receipts could not be read. Their figures are missing, and
  // every section that reads receipts says so rather than showing a short
  // total as if it were whole.
  const [failedRuns, setFailedRuns] = useState<Set<string>>(new Set());
  // How many runs have been *attempted*, not how many landed — a failed read
  // still ends the wait. Counting successes instead left the "Reading
  // receipts…" line up forever whenever a single fetch failed.
  const [breadReadCount, setBreadReadCount] = useState(0);

  // Both catalogs, for their manual order alone — no price or unit is read
  // here. They are watched in this tab rather than passed down because each
  // sub-tab unmounts when it isn't showing, which is what closes its
  // listeners; the Live board watches its own copies for the same reason.
  const [breadTypes, setBreadTypes] = useState<BreadType[]>([]);
  const [returnedBreadTypes, setReturnedBreadTypes] = useState<ReturnedBreadType[]>([]);

  const [crewExpanded, setCrewExpanded] = useState(false);
  // Which five of the store ranking the two store cards show: 0 is #1–5, 1 is
  // #6–10. A new period, crew or area re-ranks the stores, so each resets it.
  const [storePage, setStorePage] = useState(0);

  // Whether each catalog's first snapshot has landed. An empty list can't say
  // it on its own — "no bread types yet" and "not heard back yet" look alike —
  // and the loading overlay waits for both, because the bread charts are
  // ordered by them.
  const [breadTypesLoaded, setBreadTypesLoaded] = useState(false);
  const [returnedBreadTypesLoaded, setReturnedBreadTypesLoaded] = useState(false);
  // A catalog that fails to read still counts as loaded — it only sets the
  // bread order, so the figures are right without it — but the page says so
  // rather than leaving the grey up forever or the order silently off.
  const [catalogError, setCatalogError] = useState(false);

  useEffect(
    () =>
      watchBreadTypes((next) => {
        setBreadTypes(next);
        setBreadTypesLoaded(true);
      }, () => {
        setBreadTypesLoaded(true);
        setCatalogError(true);
      }),
    [],
  );

  useEffect(
    () =>
      watchReturnedBreadTypes((next) => {
        setReturnedBreadTypes(next);
        setReturnedBreadTypesLoaded(true);
      }, () => {
        setReturnedBreadTypesLoaded(true);
        setCatalogError(true);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setError(null);
    setCrewFilter('all');
    setAreaFilter('all');
    setStoreCrewFilter('all');
    setStoreAreaFilter('all');
    setBreadReceipts(new Map());
    setFailedRuns(new Set());
    setBreadReadCount(0);
    setStorePage(0);

    // Custom with nothing applied yet — nothing to fetch. `runs` stays null,
    // and the render below reads that alongside `from`/`to` to tell "still
    // loading" apart from "nothing picked yet".
    if (!from || !to) return;
    const fromKey = from;
    const toKey = to;

    void (async () => {
      try {
        const found = await fetchRunsForRange(fromKey, toKey);
        if (cancelled) return;
        setRuns(found);
      } catch {
        if (!cancelled) setError('Could not load the history. Check your connection and try again.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [from, to]);

  /**
   * Runs with no manifest, totalled from their receipts once those are read.
   * They are the same receipts the bread and store sections use, read first
   * so the money charts fill in early, and never read twice.
   */
  const extra = useMemo(() => {
    const map = new Map<string, { sales: number; returns: number; receipts: number }>();
    for (const run of runs ?? []) {
      if (run.manifest) continue;
      const receipts = breadReceipts.get(run.id);
      if (!receipts) continue;
      const totals = totalReceipts(receipts);
      map.set(run.id, { sales: totals.salesTotal, returns: totals.returnsTotal, receipts: totals.receiptCount });
    }
    return map;
  }, [runs, breadReceipts]);

  /** Whether an unended run's receipts failed to read — its money is missing from the totals. */
  const unendedMissing = (runs ?? []).some((run) => run.manifest === null && failedRuns.has(run.id));

  /** One run's figures, from its manifest if it has one and its receipts if it doesn't. */
  function figuresFor(run: Run) {
    if (run.manifest) {
      return {
        sales: run.manifest.salesTotal,
        returns: run.manifest.returnsTotal,
        receipts: run.manifest.receiptCount,
      };
    }
    return extra.get(run.id) ?? { sales: 0, returns: 0, receipts: 0 };
  }

  const byDay = useMemo<DayTotals[]>(() => {
    const map = new Map<string, DayTotals>();
    if (!from || !to) return [];
    // Every day in the window gets a row, including the ones nothing happened
    // on. A gap is information — a Sunday off, a truck that never went out —
    // and a chart that quietly skips empty days misstates the shape of a week.
    const span = daySpan(from, to);
    for (let offset = 0; offset < span; offset += 1) {
      const day = shiftBusinessDay(from, offset);
      map.set(day, { day, sales: 0, returns: 0, net: 0, receipts: 0, runs: 0 });
    }
    for (const run of runs ?? []) {
      const row = map.get(run.businessDay);
      if (!row) continue;
      const figures = figuresFor(run);
      row.sales += figures.sales;
      row.returns += figures.returns;
      row.net += figures.sales - figures.returns;
      row.receipts += figures.receipts;
      row.runs += 1;
    }
    return [...map.values()];
    // figuresFor closes over `extra`, which is in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, extra, from, to]);

  const byCrew = useMemo(
    () => groupRuns(runs ?? [], crewKeyOf, (run) => run.agentGroupName || 'No crew recorded', figuresFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, extra],
  );

  const byArea = useMemo(
    () => groupRuns(runs ?? [], areaKeyOf, (run) => run.areaName || 'No area', figuresFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, extra],
  );

  // Built from the breakdowns rather than from `runs` again, so a dropdown can
  // never offer a crew or an area that has no row in the chart above it.
  const crewOptions = useMemo(() => optionsFrom(byCrew), [byCrew]);
  const areaOptions = useMemo(() => optionsFrom(byArea), [byArea]);

  /** Whether a run falls inside the bread charts' current scope. Both filters apply. */
  const inBreadScope = useMemo(() => {
    return (run: Run) =>
      (crewFilter === 'all' || crewKeyOf(run) === crewFilter) &&
      (areaFilter === 'all' || areaKeyOf(run) === areaFilter);
  }, [crewFilter, areaFilter]);

  /** The same test for the store section's own two dropdowns. */
  const inStoreScope = useMemo(() => {
    return (run: Run) =>
      (storeCrewFilter === 'all' || crewKeyOf(run) === storeCrewFilter) &&
      (storeAreaFilter === 'all' || areaKeyOf(run) === storeAreaFilter);
  }, [storeCrewFilter, storeAreaFilter]);

  // Reads every run's receipts, ReceiptReadBatch at a time, for the money of
  // unended runs, bread performance and the store statistics alike. Runs with
  // no manifest go first, because the money charts at the top are waiting on
  // them; newest first after that. One state update per batch, not per run.
  // The crew and area filters don't steer it — everything is read either way.
  useEffect(() => {
    if (!runs) return;

    let cancelled = false;
    const queue = [...runs].sort((a, b) => {
      const aEnded = Number(a.manifest !== null);
      const bEnded = Number(b.manifest !== null);
      if (aEnded !== bEnded) return aEnded - bEnded;
      return b.startedAt - a.startedAt;
    });

    void (async () => {
      let attempted = 0;
      for (let at = 0; at < queue.length; at += ReceiptReadBatch) {
        const batch = queue.slice(at, at + ReceiptReadBatch);
        const results = await Promise.allSettled(batch.map((run) => fetchRunReceipts(run.id)));
        if (cancelled) return;
        const failed: string[] = [];
        setBreadReceipts((prev) => {
          const next = new Map(prev);
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') next.set(batch[index].id, result.value);
          });
          return next;
        });
        results.forEach((result, index) => {
          if (result.status === 'rejected') failed.push(batch[index].id);
        });
        if (failed.length > 0) setFailedRuns((prev) => new Set([...prev, ...failed]));
        attempted += batch.length;
        setBreadReadCount(attempted);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runs]);

  const breadStats = useMemo(() => {
    const sold = new Map<string, BreadRow>();
    const returned = new Map<string, BreadRow>();

    for (const run of runs ?? []) {
      if (!inBreadScope(run)) continue;
      const receipts = breadReceipts.get(run.id);
      if (!receipts) continue;

      // The three cuts are taken from the run for the crew and the area and
      // from the receipt for the store, which is the same place each chart on
      // this tab takes them from: `groupRuns` keys on the run's own
      // `agentGroupId`/`areaId`, and a receipt carries the shop. Using the
      // receipt's `agentGroupName` here instead would be a second answer to
      // "which crew" on the same page.
      const crewKey = crewKeyOf(run);
      const crewName = run.agentGroupName || 'No crew recorded';
      const areaKey = areaKeyOf(run);
      const areaName = run.areaName || 'No area';

      for (const receipt of receipts) {
        // A voided receipt moved nothing: its loaves went back on the truck and
        // its returns were never credited.
        if (receipt.voidedAt !== null) continue;
        // A receipt with no store still has its loaves counted — they moved —
        // but under a bucket of its own that the Stores column skips, exactly
        // as totalReceipts skips it. An unidentified buyer can't be told apart
        // from another one, so counting it would inflate the reach of whatever
        // it bought.
        const storeKey = receipt.customerId || NoneKey;
        const storeName = receipt.customerId ? receipt.customerName : 'No store recorded';

        for (const item of receipt.items) {
          // Keyed on breadTypeId, not name — a catalog rename mid-period must
          // still fold into one row. Falls back to the name only for the rare
          // row with no id at all, rather than dropping it.
          const key = item.breadTypeId || item.name;
          const row = sold.get(key) ?? {
            key,
            name: item.name,
            quantity: 0,
            lastSeen: 0,
            breakdown: emptyBreadBreakdown(),
          };
          row.quantity += item.quantity;
          if (receipt.createdAt >= row.lastSeen) {
            row.name = item.name;
            row.lastSeen = receipt.createdAt;
          }
          bumpBreadSlice(row.breakdown.crews, crewKey, crewName, item.quantity, false, receipt.createdAt, receipt.businessDay);
          bumpBreadSlice(row.breakdown.areas, areaKey, areaName, item.quantity, false, receipt.createdAt, receipt.businessDay);
          bumpBreadSlice(row.breakdown.stores, storeKey, storeName, item.quantity, false, receipt.createdAt, receipt.businessDay);
          sold.set(key, row);
        }
        for (const ret of receipt.returns) {
          // Returns carry no breadTypeId (see lib/runs.ts) — a return is a
          // write-off with no link back to the catalog, so name is the only
          // key there is.
          const row = returned.get(ret.name) ?? {
            key: ret.name,
            name: ret.name,
            quantity: 0,
            lastSeen: 0,
            breakdown: emptyBreadBreakdown(),
          };
          row.quantity += ret.quantity;
          bumpBreadSlice(row.breakdown.crews, crewKey, crewName, ret.quantity, true, receipt.createdAt, receipt.businessDay);
          bumpBreadSlice(row.breakdown.areas, areaKey, areaName, ret.quantity, true, receipt.createdAt, receipt.businessDay);
          bumpBreadSlice(row.breakdown.stores, storeKey, storeName, ret.quantity, true, receipt.createdAt, receipt.businessDay);
          returned.set(ret.name, row);
        }
      }
    }

    return {
      sold: [...sold.values()].sort((a, b) => b.quantity - a.quantity),
      returned: [...returned.values()].sort((a, b) => b.quantity - a.quantity),
    };
  }, [runs, breadReceipts, inBreadScope]);

  /**
   * One row per bread type: how many loaves it sold, and how many of those
   * came back.
   *
   * **Counted in loaves, not pesos** — that is the owner's call and it is the
   * right one for this section. The money is already answered above, twice
   * over; what this section is asked is what physically moved, and a bread
   * that sells three hundred cheap loaves is a bigger part of the day than one
   * that sells four expensive ones.
   *
   * Sold and returned join on the **name**, word for word, exactly as the run
   * panel's Outcome table does (`lib/run-outcome.ts`) — a return carries no
   * `breadTypeId` at all, so the name is the only join there is. A name can be
   * claimed only once, or two bread types spelled the same would each take a
   * full copy of the same returns.
   *
   * The bar draws the two figures themselves, sold then returned, rather than
   * anything derived from them — so every segment on screen is a number
   * printed at the end of its own row. Its full length is therefore loaves
   * handled in either direction.
   *
   * **The rows are in the run panel's Outcome order**, not biggest-first: the
   * manual position a manager dragged each bread to on the reference lists,
   * with a returned-only name landing directly under the bread type holding
   * its position (`compareBreadNames`). One list of bread in one order
   * wherever the dashboard shows it, so a reader who knows where Pandesal sits
   * in that table finds it in the same place here. It also means **every row
   * is drawn** rather than a top handful — cutting a list at a count only
   * makes sense when the order is by size, and the Outcome table doesn't cut
   * it either.
   */
  const breadMovement = useMemo(() => {
    const byPosition = compareBreadNames(breadTypes, returnedBreadTypes);
    const backByName = new Map(breadStats.returned.map((row) => [row.name, row]));
    const claimed = new Set<string>();

    const rows: BreadMovementRow[] = breadStats.sold.map((row) => {
      const back = claimed.has(row.name) ? undefined : backByName.get(row.name);
      if (back) claimed.add(row.name);
      return {
        key: row.key,
        name: row.name,
        sold: row.quantity,
        returned: back?.quantity ?? 0,
        stores: countStores(row.breakdown.stores),
        // Which returns this row owns is settled here and nowhere else, so the
        // dialog's crews, areas and stores are the same claim of the same
        // returns the row's own figures are. Only the folding is deferred.
        breakdown: row.breakdown,
        backBreakdown: back?.breakdown,
      };
    });

    // A returned name nothing was sold under gets a row of its own rather than
    // being dropped: it is real money credited back, and usually a spelling
    // worth fixing in the catalogs.
    const orphans: BreadMovementRow[] = breadStats.returned
      .filter((row) => !claimed.has(row.name))
      .map((row) => ({
        key: `returned-${row.name}`,
        name: row.name,
        sold: 0,
        returned: row.quantity,
        stores: 0,
        backBreakdown: row.breakdown,
      }));

    // Every bread type in the catalog gets a row, moved or not. A deliberate
    // departure from the Outcome table, which lists only what happened on one
    // run: over a period, a bread type that sold *nothing* is itself the
    // finding, and a reader scanning for it would otherwise have to notice an
    // absence. Matched on id first and name second, because a sold row is
    // keyed by `breadTypeId` except where a receipt carried none.
    const all = [...rows, ...orphans];
    const seenIds = new Set(all.map((row) => row.key));
    const seenNames = new Set(all.map((row) => row.name));
    for (const type of breadTypes) {
      if (!type.name || seenIds.has(type.id) || seenNames.has(type.name)) continue;
      seenNames.add(type.name);
      all.push({ key: type.id, name: type.name, sold: 0, returned: 0, stores: 0 });
    }

    all.sort((a, b) => byPosition(a.name, b.name));

    return {
      rows: all,
      sold: all.reduce((sum, row) => sum + row.sold, 0),
      returned: all.reduce((sum, row) => sum + row.returned, 0),
      // Bread types that actually sold, which is no longer the row count now
      // that the untouched ones are listed too.
      active: all.filter((row) => row.sold > 0).length,
      orphans: orphans.length,
    };
  }, [breadStats.sold, breadStats.returned, breadTypes, returnedBreadTypes]);

  const openBreadRow = breadMovement.rows.find((row) => row.key === openBread) ?? null;

  /**
   * The open bread's three cuts, merged and sorted — the one place that work
   * happens, and only while a dialog is up.
   *
   * Depends on the two cuts themselves rather than on `openBreadRow`, which is
   * a fresh object on every render: this tab re-renders for plenty of reasons
   * that change nothing here — a dropdown, the range picker, a receipt landing
   * for some other bread — and none of them should re-sort hundreds of stores.
   * What *does* recompute it is the underlying maps being rebuilt, which is
   * exactly when the figures behind the scrim change too. The dialog and the
   * row it opened from must never part company on the same numbers.
   */
  const openBreadDetail = useMemo(
    () => joinBreadBreakdowns(openBreadRow?.breakdown, openBreadRow?.backBreakdown),
    [openBreadRow?.breakdown, openBreadRow?.backBreakdown],
  );

  /**
   * Every store's period, from the receipts the bread section already read —
   * no query of its own — narrowed by the store section's **own** crew and
   * area dropdowns (`inStoreScope`). Not the bread ones: those sit under the
   * Bread headline and say they scope the bread chart, and a store ranking
   * that quietly moved with them would be an unlabelled filter. Every tile
   * and chart in the section reads from this one list, so they all narrow
   * together.
   */
  const storeEntries = useMemo(() => {
    const entries: { receipt: RunReceipt; runDay: string }[] = [];
    for (const run of runs ?? []) {
      if (!inStoreScope(run)) continue;
      for (const receipt of breadReceipts.get(run.id) ?? []) entries.push({ receipt, runDay: run.businessDay });
    }
    return entries;
  }, [runs, breadReceipts, inStoreScope]);

  const storeStats = useMemo(() => buildStoreStats(storeEntries.map((entry) => entry.receipt)), [storeEntries]);

  /**
   * The ranking the pager walks: stores that netted something, biggest first.
   * A store at zero or below can't be a slice of a ring.
   */
  const rankedStores = useMemo(() => storeStats.rows.filter((row) => row.net > 0), [storeStats]);
  const storePageCount = Math.max(1, Math.ceil(rankedStores.length / StorePageSize));
  // Clamped rather than trusted: receipts still arriving can re-rank stores
  // under a page, but never leave it pointing past the end.
  const shownPage = Math.min(storePage, storePageCount - 1);
  const firstRank = shownPage * StorePageSize;

  /** The five stores both cards show, each keeping its palette slot in both. */
  const chartStores = useMemo(
    () => rankedStores.slice(firstRank, firstRank + StorePageSize),
    [rankedStores, firstRank],
  );
  /** "#6–10" — which stretch of the ranking is on screen. */
  const rankLabel =
    chartStores.length <= 1
      ? `#${firstRank + 1}`
      : `#${firstRank + 1}–${firstRank + chartStores.length}`;
  /** Everything the ring's grey slice holds — every store not on this page. */
  const otherStoresNet = storeStats.net - chartStores.reduce((sum, row) => sum + row.net, 0);

  const storeSlices = useMemo(() => {
    const slices: { key: string; label: string; value: number; color: string }[] = chartStores.map((row, index) => ({
      key: row.key,
      label: row.name,
      value: row.net,
      color: SeriesColors[index],
    }));
    if (otherStoresNet > 0) {
      slices.push({ key: '__others__', label: 'All other stores', value: otherStoresNet, color: OtherStoresColor });
    }
    return slices;
  }, [chartStores, otherStoresNet]);

  const totalRuns = (runs ?? []).length;
  const breadLoading = totalRuns > 0 && breadReadCount < totalRuns;
  /**
   * The receipt sections' honesty line: how far the reading has got while it
   * is still going, and whether any run failed to read once it is done.
   */
  const receiptStatus = [
    breadLoading ? ` Reading receipts… ${formatCount(breadReadCount)} of ${formatCount(totalRuns)} runs.` : '',
    failedRuns.size > 0
      ? ` ${formatCount(failedRuns.size)} run${failedRuns.size === 1 ? '' : 's'} could not be read, so the figures may be short. Reload to try again.`
      : '',
  ].join('');

  /**
   * Greys the whole tab below the filter bar until everything it draws is in:
   * the runs, every run's receipts and both catalogs. Half-read figures would
   * otherwise pass for real totals while the numbers climb. A failed history
   * read lifts it so the error shows; a failed receipt read still counts as
   * attempted, so it can never hold the overlay up forever. The filter bar
   * stays above it, so a new date can be picked mid-load.
   */
  const tabLoading =
    Boolean(from && to) &&
    !error &&
    (runs === null || breadLoading || !breadTypesLoaded || !returnedBreadTypesLoaded);
  const loadingLabel =
    runs === null
      ? 'Loading history…'
      : breadLoading
        ? `Reading receipts… ${formatCount(breadReadCount)} of ${formatCount(totalRuns)} runs`
        : 'Loading…';

  /**
   * The top stores' curves: the picked range cut into days, weeks or months by
   * its length (`trendBuckets`), filled from the receipts already read.
   */
  const trend = useMemo(() => (from && to ? trendBuckets(from, to, currentBusinessDayKey()) : null), [from, to]);
  const trendNets = useMemo(
    () => (trend ? storeNetByBucket(storeEntries, chartStores.map((row) => row.key), trend.buckets) : new Map<string, number[]>()),
    [trend, storeEntries, chartStores],
  );

  /**
   * " for Crew A in Cainta" — appended to each bread chart's note so the
   * figures on screen always say out loud what they are a slice of. Empty when
   * nothing is filtered, which reads as "everything".
   */
  const breadScope = [
    crewFilter === 'all' ? null : ` for ${crewOptions.find(([id]) => id === crewFilter)?.[1] ?? 'this crew'}`,
    areaFilter === 'all' ? null : ` in ${areaOptions.find(([id]) => id === areaFilter)?.[1] ?? 'this area'}`,
  ]
    .filter(Boolean)
    .join('');

  /** " for Crew A in Cainta" for the store section — `breadScope`'s twin. */
  const storeScope = [
    storeCrewFilter === 'all'
      ? null
      : ` for ${crewOptions.find(([id]) => id === storeCrewFilter)?.[1] ?? 'this crew'}`,
    storeAreaFilter === 'all'
      ? null
      : ` in ${areaOptions.find(([id]) => id === storeAreaFilter)?.[1] ?? 'this area'}`,
  ]
    .filter(Boolean)
    .join('');

  const period = byDay.reduce(
    (sum, row) => ({
      sales: sum.sales + row.sales,
      returns: sum.returns + row.returns,
      net: sum.net + row.net,
      receipts: sum.receipts + row.receipts,
    }),
    { sales: 0, returns: 0, net: 0, receipts: 0 },
  );
  const columns: Column[] = byDay.map((row) => ({
    key: row.day,
    label: row.day.slice(5).replace('-', '/'),
    value: row.net,
    partial: row.day === today,
    detail:
      row.runs === 0
        ? 'No truck went out'
        : `${row.runs} run${row.runs === 1 ? '' : 's'} · ${formatCount(row.receipts)} receipts`,
  }));

  const rangeDays = from && to ? daySpan(from, to) : 0;

  return (
    <>
      {/* One filter row, above everything it scopes — never a control inside a
          chart card, and never a different period per chart. Two dropdowns,
          not one: the first picks which calendar unit to browse by, the
          second picks which one of those. Switching the unit doesn't lose the
          other two selections — a forgotten "3 weeks ago" is still there if
          Week is picked again. */}
      <div className="ops-filterbar">
        <label className="ops-muted" htmlFor="trends-range-type">
          Range
        </label>
        <select
          id="trends-range-type"
          className="ops-select"
          value={rangeType}
          onChange={(event) => setRangeType(event.target.value as RangeType)}>
          <option value="month">Month</option>
          <option value="week">Week</option>
          <option value="day">Day</option>
          <option value="year">Year</option>
          <option value="custom">Custom</option>
        </select>

        {rangeType === 'month' && (
          <select
            className="ops-select"
            aria-label="Month"
            value={monthValue}
            onChange={(event) => setMonthValue(event.target.value)}>
            {monthOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        {rangeType === 'week' && (
          <select
            className="ops-select"
            aria-label="Week"
            value={weekOffset}
            onChange={(event) => setWeekOffset(Number(event.target.value))}>
            {WeekOptionLabels.map((label, offset) => (
              <option key={label} value={offset}>
                {label}
              </option>
            ))}
          </select>
        )}
        {rangeType === 'day' && (
          <select
            className="ops-select"
            aria-label="Day"
            value={dayValue}
            onChange={(event) => setDayValue(event.target.value)}>
            {dayOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        {rangeType === 'year' && (
          <select
            className="ops-select"
            aria-label="Year"
            value={yearValue}
            onChange={(event) => setYearValue(Number(event.target.value))}>
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        )}
        {rangeType === 'custom' && (
          <DateRangePicker
            from={customFrom}
            to={customTo}
            max={today}
            onChange={(range) => {
              setCustomFrom(range.from);
              setCustomTo(range.to);
            }}
            formatLabel={formatDateRangeLabel}
          />
        )}

        {/* Custom's trigger already shows the actual dates — a second copy of
            the same text right beside it would just be noise. */}
        {rangeType !== 'custom' && from && to && <span className="ops-muted">{formatDateRangeLabel(from, to)}</span>}
      </div>

      <div className="ops-trends-body" aria-busy={tabLoading}>
      {tabLoading && (
        <div className="ops-busy" role="status">
          <div className="ops-busy-label">
            <div className="ops-spinner" aria-hidden="true" />
            {loadingLabel}
          </div>
        </div>
      )}

      {(error || catalogError) && (
        <div className="ops-day-notices">
          {error && <div className="ops-notice ops-notice-alert">{error}</div>}
          {catalogError && (
            <div className="ops-notice ops-notice-alert">
              Could not load the bread lists, so the bread may be listed in the wrong order. Reload to try again.
            </div>
          )}
        </div>
      )}

      {from && to && (
        <SectionHeadline
          title="General statistics"
          note="The money and the receipts, across every crew and every area in this period."
        />
      )}

      {from && to && (
        <div className="ops-stats">
          <div className="ops-stat">
            <span className="ops-label">Sales</span>
            <div className="ops-figure">{formatMoney(period.sales)}</div>
            <p className="ops-stat-note">before returns</p>
          </div>
          <div className="ops-stat">
            <span className="ops-label">Returns</span>
            <div className="ops-figure">{formatMoney(period.returns)}</div>
            <p className="ops-stat-note">credited back</p>
          </div>
          <div className="ops-stat ops-stat-accent">
            <span className="ops-label">Net</span>
            <div className="ops-figure">{formatMoney(period.net)}</div>
            <p className="ops-stat-note">
              over {formatCount(rangeDays)} day{rangeDays === 1 ? '' : 's'}
            </p>
          </div>
          <div className="ops-stat">
            <span className="ops-label">Receipts</span>
            <div className="ops-figure">{formatCount(period.receipts)}</div>
            <p className="ops-stat-note">{formatCount((runs ?? []).length)} runs</p>
          </div>
        </div>
      )}

      {!from || !to ? (
        <p className="ops-muted">Pick a start and end date to see that range's numbers.</p>
      ) : runs === null ? null : (
        <div className="ops-charts">
          <ChartCard
            title="Net takings by day"
            note={
              <>
                Sales less returns, as each phone recorded them. Today is still being written and is drawn in a lighter
                shade.
                {unendedMissing && ' Some runs that were never ended could not be read and are not counted.'}
              </>
            }
            table={
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="ops-num">Sales</th>
                    <th className="ops-num">Returns</th>
                    <th className="ops-num">Net</th>
                    <th className="ops-num">Receipts</th>
                    <th className="ops-num">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byDay].reverse().map((row) => (
                    <tr key={row.day}>
                      <td>{row.day}</td>
                      <td className="ops-num">{formatMoney(row.sales)}</td>
                      <td className="ops-num">{formatMoney(row.returns)}</td>
                      <td className="ops-num">
                        <b>{formatMoney(row.net)}</b>
                      </td>
                      <td className="ops-num">{formatCount(row.receipts)}</td>
                      <td className="ops-num">{formatCount(row.runs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }>
            {period.net === 0 ? (
              <ChartEmpty>No runs were recorded in this period.</ChartEmpty>
            ) : (
              <>
                <ColumnChart columns={columns} formatFull={formatMoney} format={compactMoney} />
                {/* Two classes on screen — finished days and the one still
                    running — so they get a key rather than a caption alone. */}
                <ul className="ops-legend">
                  <li>
                    <span className="ops-legend-key" style={{ background: SequentialStrong }} />
                    Finished day
                  </li>
                  <li>
                    <span className="ops-legend-key" style={{ background: SequentialSoft }} />
                    Still in progress
                  </li>
                </ul>
              </>
            )}
          </ChartCard>

          {/* Crew before area, because the crew is the comparison that gets
              made: an area is a round, and two crews working the same round is
              the pair of numbers worth putting side by side. The area chart
              stays below it — a round can still be a good or a bad one — but it
              is no longer the heading a reader lands on first. */}
          <ChartCard
            title="Net takings by crew"
            note={`Across all ${formatCount((runs ?? []).length)} runs in the period. Each crew is named as it was when the run started.`}
            table={
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Crew</th>
                    <th className="ops-num">Net</th>
                    <th className="ops-num">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {(crewExpanded ? byCrew : byCrew.slice(0, 3)).map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td className="ops-num">
                        <b>{formatMoney(row.net)}</b>
                      </td>
                      <td className="ops-num">{formatCount(row.runs)}</td>
                    </tr>
                  ))}
                  {!crewExpanded && byCrew.length > 3 && (
                    <tr>
                      <td colSpan={3} style={{ textAlign: 'center', paddingTop: '12px', paddingBottom: '12px' }}>
                        <button
                          onClick={() => setCrewExpanded(true)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'inherit',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            padding: 0,
                            font: 'inherit',
                          }}>
                          Show {byCrew.length - 3} more crew{byCrew.length - 3 === 1 ? '' : 's'}
                        </button>
                      </td>
                    </tr>
                  )}
                  {crewExpanded && byCrew.length > 3 && (
                    <tr>
                      <td colSpan={3} style={{ textAlign: 'center', paddingTop: '12px', paddingBottom: '12px' }}>
                        <button
                          onClick={() => setCrewExpanded(false)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'inherit',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            padding: 0,
                            font: 'inherit',
                          }}>
                          Show less
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            }>
            {byCrew.length === 0 ? (
              <ChartEmpty>No runs were recorded in this period.</ChartEmpty>
            ) : (
              <>
                <BarChart
                  rows={(crewExpanded ? byCrew : byCrew.slice(0, 3)).map((row) => ({ key: row.id, label: row.name, value: row.net }))}
                  formatFull={formatMoney}
                />
                {!crewExpanded && byCrew.length > 3 && (
                  <div style={{ textAlign: 'center', paddingTop: '18px' }}>
                    <button
                      onClick={() => setCrewExpanded(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        padding: 0,
                        font: 'inherit',
                      }}>
                      Show {byCrew.length - 3} more crew{byCrew.length - 3 === 1 ? '' : 's'}
                    </button>
                  </div>
                )}
                {crewExpanded && byCrew.length > 3 && (
                  <div style={{ textAlign: 'center', paddingTop: '12px' }}>
                    <button
                      onClick={() => setCrewExpanded(false)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        padding: 0,
                        font: 'inherit',
                      }}>
                      Show less
                    </button>
                  </div>
                )}
              </>
            )}
          </ChartCard>

          <ChartCard
            title="Net takings by area"
            note={`Across all ${formatCount((runs ?? []).length)} runs in the period.`}
            table={
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Area</th>
                    <th className="ops-num">Net</th>
                    <th className="ops-num">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {byArea.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td className="ops-num">
                        <b>{formatMoney(row.net)}</b>
                      </td>
                      <td className="ops-num">{formatCount(row.runs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }>
            {byArea.length === 0 ? (
              <ChartEmpty>No runs were recorded in this period.</ChartEmpty>
            ) : (
              <BarChart
                rows={byArea.map((row) => ({ key: row.id, label: row.name, value: row.net }))}
                formatFull={formatMoney}
              />
            )}
          </ChartCard>

          <SectionHeadline
            title="Bread statistics"
            note="Counted from the receipts themselves."
          />

          {/* Bread performance gets its own scope, because "for this crew, on
              this round" is the question here — not two more columns bolted
              onto the charts above. Same period; a narrower slice of it. Crew
              first, since it is the dividing line the rest of the tab leads
              with. */}
          <div className="ops-filterbar">
            {/* The two dropdowns share one grid so they can share one width —
                see .ops-scope in overview.css. Nothing else belongs inside it:
                the grid is sized by what it contains, so the note below would
                stretch it. */}
            <div className="ops-scope">
              <label className="ops-muted" htmlFor="trends-crew-filter">
                Crew
              </label>
              <select
                id="trends-crew-filter"
                className="ops-select"
                value={crewFilter}
                onChange={(event) => setCrewFilter(event.target.value)}>
                <option value="all">All crews</option>
                {crewOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>

              <label className="ops-muted" htmlFor="trends-area-filter">
                Area
              </label>
              <select
                id="trends-area-filter"
                className="ops-select"
                value={areaFilter}
                onChange={(event) => setAreaFilter(event.target.value)}>
                <option value="all">All areas</option>
                {areaOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            {/* Both narrow together, which is worth saying out loud: two
                dropdowns side by side are as easily read as "or". */}
            {/* Where the bread figures' honesty lives: what they are a slice
                of, whether they are still loading, and whether any run's
                receipts failed to read. */}
            <span className="ops-muted">
              Both scope the bread chart below.{receiptStatus}
            </span>
          </div>

          {/* One chart, not two. Loaves sold and loaves returned are the same
              unit and one is part of the other, so two cards made the reader
              hold the first in their head while looking at the second — and
              the second, being a tenth the size, said almost nothing on its
              own scale. */}
          <ChartCard
            title="Loaves sold, and how many came back"
            /* Says the rows are openable. A hover highlight tells a reader
               who is already pointing at one; this tells the reader who
               isn't. */
            note="Click any bread for its crews, areas and stores."
            fullTable
            /* Under the table as well as under the bars. It is what the whole
               card adds up to rather than a caption for the drawing, and a
               reader who switched views to read the figures exactly is the
               last one who should lose the total. Nothing when there is
               nothing to total — the empty state says it instead. */
            footer={
              breadMovement.sold === 0 && breadMovement.returned === 0 ? null : (
                <p className="ops-chart-note">
                  {formatCount(breadMovement.sold)} loaves sold across {formatCount(breadMovement.active)} bread
                  type{breadMovement.active === 1 ? '' : 's'}, {formatCount(breadMovement.returned)} total returns which is
                  {breadMovement.sold > 0 && ` ${formatShare(breadMovement.returned / breadMovement.sold)} of them`}.
                </p>
              )
            }
            table={
              <table className="ops-table ops-table-even">
                <thead>
                  <tr>
                    <th>Bread type</th>
                    <th className="ops-num">Sold</th>
                    <th className="ops-num">Came back</th>
                    <th className="ops-num">Rate</th>
                    <th className="ops-num">Stores</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Nothing marks out a returned-only name — a bread with
                      returns and no sales reads as exactly that, a zero in the
                      Sold column, and the annotation that used to sit beside
                      the name was struck out on the owner's call. Zero, not an
                      em-dash: the chart draws the same row as a 0 and the two
                      views must never print one figure two ways. */}
                  {/* The table's rows open the same dialog the chart's do —
                      the toggle changes how a row is drawn, never what it can
                      do. The handler is on the `<tr>` so a click anywhere
                      along the row works, and the *name* is a real button so
                      the keyboard can reach it; a button's Enter and Space
                      raise a click that bubbles up to the row, so one handler
                      serves both and there is no key handling to write.

                      The row itself is deliberately not given `tabIndex` and
                      `role="button"`: a `<tr>` announced as a button stops
                      being announced as a row, and the table around it stops
                      being a table. */}
                  {breadMovement.rows.map((row) => (
                    <tr key={row.key} className="ops-row-tap" onClick={() => setOpenBread(row.key)}>
                      <td>
                        <button type="button" className="ops-cell-tap">
                          {row.name}
                        </button>
                      </td>
                      <td className="ops-num">{formatCount(row.sold)}</td>
                      <td className="ops-num">{formatCount(row.returned)}</td>
                      <td className="ops-num">
                        <b>{row.sold > 0 ? formatShare(row.returned / row.sold) : '—'}</b>
                      </td>
                      <td className="ops-num">{formatCount(row.stores)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }>
            {breadMovement.sold === 0 && breadMovement.returned === 0 ? (
              <ChartEmpty>
                {breadLoading ? 'Reading receipts…' : `No bread moved in this period${breadScope}.`}
              </ChartEmpty>
            ) : (
              <SplitBarChart
                rows={breadMovement.rows.map((row) => ({
                  key: row.key,
                  label: row.name,
                  values: [row.sold, row.returned],
                  // The rate arrives already formatted — it is a share, not
                  // loaves, and the chart's one formatter counts loaves.
                  extras: [row.sold > 0 ? formatShare(row.returned / row.sold) : '—', row.stores],
                }))}
                series={BreadSeries}
                extras={BreadExtras}
                leadLabel="Bread type"
                format={formatCount}
                onSelect={setOpenBread}
              />
            )}
          </ChartCard>

          {/* Stores: who brings in the most. Read from the same receipts the
              bread chart already opened, so it costs no query — and says so
              when those were only a sample. */}
          <SectionHeadline
            title="Store statistics"
            note="Which stores bring in the most in this period."
          />

          {/* The store section's own scope, laid out exactly like the bread
              one above — same grid, same order (crew first), same honesty
              line — so the two read as one idiom. */}
          <div className="ops-filterbar">
            <div className="ops-scope">
              <label className="ops-muted" htmlFor="trends-store-crew-filter">
                Crew
              </label>
              <select
                id="trends-store-crew-filter"
                className="ops-select"
                value={storeCrewFilter}
                onChange={(event) => {
                  setStoreCrewFilter(event.target.value);
                  setStorePage(0);
                }}>
                <option value="all">All crews</option>
                {crewOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>

              <label className="ops-muted" htmlFor="trends-store-area-filter">
                Area
              </label>
              <select
                id="trends-store-area-filter"
                className="ops-select"
                value={storeAreaFilter}
                onChange={(event) => {
                  setStoreAreaFilter(event.target.value);
                  setStorePage(0);
                }}>
                <option value="all">All areas</option>
                {areaOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <span className="ops-muted">
              Both scope the store figures below.{receiptStatus}
            </span>
          </div>

          <div className="ops-stats">
            <div className="ops-stat">
              <span className="ops-label">Stores served</span>
              <div className="ops-figure">{formatCount(storeStats.rows.length)}</div>
              <p className="ops-stat-note">bought at least once</p>
            </div>
            <div className="ops-stat">
              <span className="ops-label">Average stores per day</span>
              <div className="ops-figure">{formatCount(Math.round(storeStats.perDay))}</div>
              <p className="ops-stat-note">stores on days with sales</p>
            </div>
            <div className="ops-stat ops-stat-accent">
              <span className="ops-label">Average per store</span>
              <div className="ops-figure">
                {formatMoney(storeStats.rows.length > 0 ? storeStats.net / storeStats.rows.length : 0)}
              </div>
              <p className="ops-stat-note">net takings</p>
            </div>
          </div>

          {/* Steps both store cards through the ranking five at a time. Just
              above the first card, outside it, so it sits in one place whichever
              view either card shows. One line, no label — the owner rejected a
              labelled row (cluttered), a line between the cards, and a spot
              inside the first card. */}
          {rankedStores.length > StorePageSize && (
            <div className="ops-store-pager">
              <button
                type="button"
                className="ops-pager-button"
                aria-label="Previous 5 stores"
                disabled={shownPage === 0}
                onClick={() => setStorePage(shownPage - 1)}>
                ‹
              </button>
              <span className="ops-pager-position">
                Stores {rankLabel} <span className="ops-muted">of {formatCount(rankedStores.length)}</span>
              </span>
              <button
                type="button"
                className="ops-pager-button"
                aria-label="Next 5 stores"
                disabled={shownPage >= storePageCount - 1}
                onClick={() => setStorePage(shownPage + 1)}>
                ›
              </button>
            </div>
          )}

          {/* The page's stores get one colour each, and it is the same colour
              in both cards — the ring's slice and the line below are one store. */}
          <ChartCard
            title="Top stores’ share of takings"
            note={`Net sales of the stores ranked ${rankLabel}${storeScope}, against every other store together. Point at a slice for its figures.`}
            fullTable
            table={
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Store</th>
                    <th className="ops-num">Net</th>
                    <th className="ops-num">Share</th>
                    <th className="ops-num">Receipts</th>
                    <th className="ops-num">Days bought</th>
                    <th className="ops-num">Loaves</th>
                    <th className="ops-num">Last bought</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Exactly the ring: this page's stores, then the grey
                      slice as a row of its own. */}
                  {chartStores.map((row, index) => (
                    <tr key={row.key}>
                      <td>{firstRank + index + 1}</td>
                      <td>{row.name}</td>
                      <td className="ops-num">
                        <b>{formatMoney(row.net)}</b>
                      </td>
                      <td className="ops-num">
                        {storeStats.net > 0 ? formatShare(Math.max(0, row.net) / storeStats.net) : '—'}
                      </td>
                      <td className="ops-num">{formatCount(row.receipts)}</td>
                      <td className="ops-num">{formatCount(row.days)}</td>
                      <td className="ops-num">{formatCount(row.loaves)}</td>
                      <td className="ops-num">{row.lastDay ? formatBusinessDayShort(row.lastDay) : '—'}</td>
                    </tr>
                  ))}
                  {otherStoresNet > 0 && (
                    <tr>
                      <td />
                      <td>All other stores</td>
                      <td className="ops-num">
                        <b>{formatMoney(otherStoresNet)}</b>
                      </td>
                      <td className="ops-num">{storeStats.net > 0 ? formatShare(otherStoresNet / storeStats.net) : '—'}</td>
                      <td className="ops-num">—</td>
                      <td className="ops-num">—</td>
                      <td className="ops-num">—</td>
                      <td className="ops-num">—</td>
                    </tr>
                  )}
                </tbody>
              </table>
            }>
            {storeStats.rows.length === 0 ? (
              <ChartEmpty>{breadLoading ? 'Reading receipts…' : `No store bought anything in this period${storeScope}.`}</ChartEmpty>
            ) : (
              <DonutChart slices={storeSlices} centerLabel="all stores" formatFull={formatMoney} />
            )}
          </ChartCard>

          <ChartCard
            title="Top stores over time"
            note={
              trend && trend.buckets.length > 1
                ? `Net takings of the stores ranked ${rankLabel}, ${
                    trend.unit === 'day' ? 'day by day' : trend.unit === 'week' ? 'week by week' : 'month by month'
                  } across this period${storeScope}. Point at a ${trend.unit} for the figures.`
                : undefined
            }
            table={
              // Stores down the side and time across the top, the way the
              // chart itself reads — on the owner's call. A Total column ends
              // each row; it is the store's net for the whole period.
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Store</th>
                    {(trend?.buckets ?? []).map((bucket, slot) => (
                      <th key={bucket.from} className="ops-num">
                        {trend?.unit === 'week' ? `Week of ${bucket.label}` : bucket.label}
                        {trend?.partial && slot === trend.buckets.length - 1 ? ' (so far)' : ''}
                      </th>
                    ))}
                    <th className="ops-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {chartStores.map((row) => {
                    const line = trendNets.get(row.key) ?? [];
                    return (
                      <tr key={row.key}>
                        <td>{row.name}</td>
                        {(trend?.buckets ?? []).map((bucket, slot) => (
                          <td key={bucket.from} className="ops-num">
                            {formatMoney(line[slot] ?? 0)}
                          </td>
                        ))}
                        <td className="ops-num">
                          <strong>{formatMoney(line.reduce((sum, value) => sum + value, 0))}</strong>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            }>
            {chartStores.length === 0 || !trend ? (
              <ChartEmpty>{breadLoading ? 'Reading receipts…' : `No store bought anything in this period${storeScope}.`}</ChartEmpty>
            ) : trend.buckets.length < 2 ? (
              <ChartEmpty>A single day has no curve to draw — pick a week or longer to see how the top stores move.</ChartEmpty>
            ) : (
              <>
                <LineChart
                  curved
                  partialLast={trend.partial}
                  labels={trend.buckets.map((bucket) => bucket.label)}
                  series={chartStores.map((row, index) => ({
                    id: row.key,
                    name: row.name.length > 12 ? `${row.name.slice(0, 11)}…` : row.name,
                    color: SeriesColors[index],
                    values: trendNets.get(row.key) ?? [],
                  }))}
                  formatFull={formatMoney}
                />
                <Legend items={chartStores.map((row, index) => ({ label: row.name, color: SeriesColors[index] }))} />
                {/* Its own line rather than a clause in the card's note, on the
                    owner's call: the dash is a mark on the plot, so what it
                    means belongs with the plot's key. */}
                {trend.partial && (
                  <p className="ops-dash-note">
                    <svg width="22" height="8" aria-hidden="true">
                      <line x1="1" y1="4" x2="21" y2="4" strokeDasharray="5 4" strokeLinecap="round" />
                    </svg>
                    Dashed line means {trend.unit === 'day' ? 'today' : `this ${trend.unit}`} isn’t over yet. The last
                    point only counts up to today, so it may still go up.
                  </p>
                )}
              </>
            )}
          </ChartCard>
        </div>
      )}
      </div>

      {/* One bread, cut by crew, by area and by store. Rendered last so it
          sits above the tab in source order as well as in z-index, and only
          while its row still exists — see `openBread`. It reads the figures
          the row already holds and fires no query of its own. */}
      {openBreadRow && from && to && (
        <BreadDetailDialog
          name={openBreadRow.name}
          sold={openBreadRow.sold}
          returned={openBreadRow.returned}
          stores={openBreadRow.stores}
          detail={openBreadDetail}
          series={BreadSeries}
          rangeLabel={formatDateRangeLabel(from, to)}
          scope={breadScope}
          failed={failedRuns.size > 0}
          loading={breadLoading}
          onClose={() => setOpenBread(null)}
        />
      )}
    </>
  );
}
