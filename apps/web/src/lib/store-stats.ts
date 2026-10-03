import { shiftBusinessDay } from '@/lib/business-day';
import { daySpan, monthRange, startOfWeek } from '@/lib/day-ranges';
import { isVoided, type RunReceipt } from '@/lib/runs';

/**
 * The Trends tab's Store statistics: every store's period, folded out of
 * receipts the tab has already read.
 *
 * **It fires no query of its own.** The bread section already opens runs'
 * receipts under `MaxBreadReceiptFetches`, and every figure a store needs —
 * the money, the loaves, the day — is on those same receipts. So this is
 * arithmetic over rows in memory, and where that budget fell short of the
 * period the tab says so, exactly as it does for bread.
 *
 * The rules are the ones the rest of the dashboard counts by:
 * - **A voided receipt counts nowhere** — not its money, not its loaves, and it
 *   doesn't make a store "served" (`totalReceipts` skips it the same way).
 * - **A receipt naming no store is skipped.** An unidentified buyer can't be
 *   told apart from another one, so it can't be ranked.
 * - **Net is subtotal − returns** (`receipt.total`).
 * - **Days are the stored `businessDay` strings**, never re-derived from a
 *   timestamp — see "The business day is Manila, always" in the root CLAUDE.md.
 *
 * There is no "still owed" here, on the owner's call: this section is about
 * which stores perform, and chasing money is the period workbook's Stores sheet.
 */

export type StoreStatRow = {
  /** The `customerId`. */
  key: string;
  /** The name on the newest receipt, so a store renamed mid-period shows its current name. */
  name: string;
  net: number;
  receipts: number;
  /** Loaves sold to this store — receipt lines, not returns. */
  loaves: number;
  /** How many different business days the store bought on. */
  days: number;
  /** The latest stored `businessDay` it bought on. */
  lastDay: string;
  lastSeen: number;
};

export type StoreStats = {
  /** Biggest net first. */
  rows: StoreStatRow[];
  /**
   * How many stores a typical selling day reached: every store's buying days
   * added up, over the days anybody bought. Only days with a sale divide it,
   * so a Sunday the trucks stayed home doesn't drag the average down.
   */
  perDay: number;
  /** The business days at least one store bought on — `perDay`'s divisor. */
  sellingDays: number;
  /** What every store netted together. */
  net: number;
};

export function buildStoreStats(receipts: Iterable<RunReceipt>): StoreStats {
  const map = new Map<string, StoreStatRow & { dayset: Set<string> }>();
  const sellingDays = new Set<string>();

  for (const receipt of receipts) {
    if (isVoided(receipt) || !receipt.customerId) continue;
    const row = map.get(receipt.customerId) ?? {
      key: receipt.customerId,
      name: receipt.customerName,
      net: 0,
      receipts: 0,
      loaves: 0,
      days: 0,
      lastDay: '',
      lastSeen: 0,
      dayset: new Set<string>(),
    };
    row.net += receipt.total;
    row.receipts += 1;
    for (const item of receipt.items) row.loaves += item.quantity;
    if (receipt.businessDay) {
      row.dayset.add(receipt.businessDay);
      sellingDays.add(receipt.businessDay);
    }
    // Business-day keys are `YYYY-MM-DD`, so the later day is the larger string.
    if (receipt.businessDay > row.lastDay) row.lastDay = receipt.businessDay;
    if (receipt.createdAt >= row.lastSeen) {
      row.lastSeen = receipt.createdAt;
      if (receipt.customerName) row.name = receipt.customerName;
    }
    map.set(receipt.customerId, row);
  }

  const rows: StoreStatRow[] = [...map.values()].map(({ dayset, ...row }) => ({
    ...row,
    days: dayset.size,
    name: row.name || 'Unnamed store',
  }));
  rows.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));

  const net = rows.reduce((sum, row) => sum + row.net, 0);
  const storeDays = rows.reduce((sum, row) => sum + row.days, 0);

  return {
    rows,
    perDay: sellingDays.size > 0 ? storeDays / sellingDays.size : 0,
    sellingDays: sellingDays.size,
    net,
  };
}

/**
 * The points the "top stores over time" chart plots: the picked range cut into
 * days, weeks or months, **scaled to the length of the range** so the chart
 * always has somewhere between a handful and a dozen points.
 *
 * | Range            | One point per | Points |
 * | ---------------- | ------------- | ------ |
 * | up to 2 weeks    | day           | 2–14   |
 * | up to 3 months   | week          | 3–13   |
 * | longer           | month         | 4–12 a year |
 *
 * Fewer and there is no curve to read; many more and thirty daily points of a
 * store that buys twice a week is a comb of zeros — the running-total chart
 * this replaced died of exactly that. A single day has no curve at all (a
 * store buys about once), so the caller shows a note instead.
 *
 * **Everything stays inside the picked range**, on the owner's call: a week or
 * month that straddles an end is clipped to it, and labelled by its first day
 * inside the range — or, if that leaves a sliver of a few days, folded into
 * its neighbour. `partial` says the last point is a week or month still
 * running on `today`, which the chart draws dashed.
 */
export type TrendBucket = { from: string; to: string; label: string };

export const TrendDailyMaxDays = 14;
export const TrendWeeklyMaxDays = 92;

const MonthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(key: string): string {
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
}

export function trendBuckets(
  from: string,
  to: string,
  today: string,
): { buckets: TrendBucket[]; unit: 'day' | 'week' | 'month'; partial: boolean } {
  const span = daySpan(from, to);
  const buckets: TrendBucket[] = [];
  let unit: 'day' | 'week' | 'month';
  // Where the last bucket would end if it weren't clipped to the range.
  let lastNaturalEnd = to;

  if (span <= TrendDailyMaxDays) {
    unit = 'day';
    for (let i = 0; i < span; i += 1) {
      const day = shiftBusinessDay(from, i);
      buckets.push({ from: day, to: day, label: dayLabel(day) });
    }
  } else if (span <= TrendWeeklyMaxDays) {
    unit = 'week';
    let start = startOfWeek(from);
    while (start <= to) {
      const end = shiftBusinessDay(start, 6);
      const clippedFrom = start < from ? from : start;
      buckets.push({ from: clippedFrom, to: end > to ? to : end, label: dayLabel(clippedFrom) });
      lastNaturalEnd = end;
      start = shiftBusinessDay(start, 7);
    }
  } else {
    unit = 'month';
    let year = Number(from.slice(0, 4));
    let month = Number(from.slice(5, 7));
    for (;;) {
      const range = monthRange(year, month);
      if (range.from > to) break;
      const clippedFrom = range.from < from ? from : range.from;
      // Only a January after the first point says which year, when a chart crosses one.
      const label = month === 1 && buckets.length > 0 ? `Jan ${year}` : MonthShort[month - 1];
      buckets.push({ from: clippedFrom, to: range.to > to ? to : range.to, label });
      lastNaturalEnd = range.to;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }

  // A day still running is partial too: the trucks are still out.
  const partial = lastNaturalEnd >= today && to >= today;

  // A week or month clipped to a sliver at either end — August's Saturday 1st
  // and Monday 31st — would plot two days' takings as a sudden collapse. Fold
  // a sliver into its neighbour instead. The running period is left alone:
  // it is already drawn dashed, and folding it would hide where "so far" starts.
  if (unit !== 'day') {
    const sliver = unit === 'week' ? 4 : 10;
    const days = (b: TrendBucket) => daySpan(b.from, b.to);
    if (buckets.length > 2 && days(buckets[0]) < sliver) {
      // A week keeps its first day as its label; merged months name both.
      const label = unit === 'week' ? buckets[0].label : `${buckets[0].label}–${buckets[1].label}`;
      buckets[1] = { ...buckets[1], from: buckets[0].from, label };
      buckets.shift();
    }
    const last = buckets.length - 1;
    if (!partial && buckets.length > 2 && days(buckets[last]) < sliver) {
      const label = unit === 'week' ? buckets[last - 1].label : `${buckets[last - 1].label}–${buckets[last].label}`;
      buckets[last - 1] = { ...buckets[last - 1], to: buckets[last].to, label };
      buckets.pop();
    }
  }

  return { buckets, unit, partial };
}

/**
 * The top stores' net in each bucket, from receipts already in memory — no
 * query of its own, like the rest of the section. A receipt is filed under
 * its **run's** day, as `byDay` files the run's money; the same rules as
 * `buildStoreStats` otherwise (voided counts nowhere, net is `receipt.total`).
 */
export function storeNetByBucket(
  entries: { receipt: RunReceipt; runDay: string }[],
  keys: string[],
  buckets: TrendBucket[],
): Map<string, number[]> {
  const nets = new Map(keys.map((key) => [key, buckets.map(() => 0)]));
  for (const { receipt, runDay } of entries) {
    const line = nets.get(receipt.customerId);
    if (!line || isVoided(receipt)) continue;
    const index = buckets.findIndex((b) => runDay >= b.from && runDay <= b.to);
    if (index >= 0) line[index] += receipt.total;
  }
  return nets;
}
