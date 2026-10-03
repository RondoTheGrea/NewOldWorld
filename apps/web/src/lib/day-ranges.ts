import { shiftBusinessDay, startOfBusinessDay } from '@/lib/business-day';

/**
 * Calendar ranges over business days — "which days are in this week", "what
 * does this span read as".
 *
 * Split out of `trends-tab.tsx`, where all of this started, the moment a second
 * part of the dashboard needed the same answers: the Live tab's summary-export
 * dialog offers the same Month / Week / Year units in the same dropdowns, and
 * they have to mean *exactly* what the Trends tab means by them — down to the
 * wording, which is why `WeekOptionLabels` lives here too. Two copies of
 * `startOfWeek` is two definitions of Monday.
 *
 * Everything here takes and returns `YYYY-MM-DD` business-day keys, and none of
 * it does timezone work of its own: `lib/business-day.ts` already decided which
 * Manila day a key names, and these functions only walk between keys. Where a
 * key is parsed back into a `Date` it is parsed as **UTC** and formatted in
 * UTC — Tuesday the 4th is Tuesday everywhere, and re-reading the key through
 * the browser's own timezone is how a boundary day quietly prints as the one
 * before.
 *
 * `components/calendar-popover.tsx` keeps its own month arithmetic rather than
 * importing this. Its job is laying out a grid of digits, not naming a business
 * range, and it deliberately touches nothing that knows what a business day is.
 */

/** Inclusive day count between two business-day keys — 1 for a single day. */
export function daySpan(fromKey: string, toKey: string): number {
  return Math.round((startOfBusinessDay(toKey) - startOfBusinessDay(fromKey)) / 86_400_000) + 1;
}

/**
 * The Monday that starts the week a business day falls in.
 *
 * The key is parsed as a bare UTC date rather than a Manila instant on
 * purpose: `businessDayKey` already resolved which Manila calendar date this
 * is, so which weekday that date falls on doesn't depend on a timezone at
 * all.
 */
export function startOfWeek(dayKey: string): string {
  const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const sinceMonday = (weekday + 6) % 7;
  return shiftBusinessDay(dayKey, -sinceMonday);
}

/** The first and last day of a calendar month, as business-day keys. */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

/** `{ year, month }` (1–12) `offset` months from the given one, wrapping year ends both directions. */
export function shiftMonth(year: number, month: number, offset: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + offset;
  return { year: Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

/** "August 2026" — formatted in UTC so the reader's own timezone can't nudge day 1 into the prior month. */
export function formatMonthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The `count` months ending with the one holding `dayKey`, newest first —
 * `{ value: "2026-09", label: "September 2026" }`, ready for a `<select>`.
 *
 * The `value` is a `YYYY-MM` prefix rather than a pair of dates because that is
 * what survives switching the range type and back: a month is one string, and
 * the two ends are worked out from it whenever they are needed.
 */
export function recentMonthOptions(dayKey: string, count: number): { value: string; label: string }[] {
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  return Array.from({ length: count }, (_, i) => {
    const shifted = shiftMonth(year, month, -i);
    return {
      value: `${shifted.year}-${String(shifted.month).padStart(2, '0')}`,
      label: formatMonthLabel(shifted.year, shifted.month),
    };
  });
}

/**
 * The Day dropdown's options, newest first — `{ value: "2026-09-01", label:
 * "Sep 1, 2026" }`, ready for a `<select>`.
 *
 * **Only the first row is named; every other one is dated.** "Yesterday" was
 * there too and came off on the owner's call — a named row and a dated row
 * answer different questions, and mixing them makes the reader translate one
 * of the two before they can compare. "Today" survives because it is the row
 * that is *always* wanted and the only one whose date changes under the
 * reader; the rest are the exact dates that appear on the paperwork.
 *
 * Like `WeekOptionLabels`, that first label is only true because both callers
 * anchor to **today**. Pass anything else as `dayKey` and the top row lies.
 */
export function recentDayOptions(dayKey: string, count: number): { value: string; label: string }[] {
  return Array.from({ length: count }, (_, offset) => {
    const value = shiftBusinessDay(dayKey, -offset);
    return { value, label: offset === 0 ? 'Today' : formatDateRangeLabel(value, value) };
  });
}

/**
 * The Week dropdown's options, newest first — the offset into this array *is*
 * the number of weeks back, so index 2 is the week starting
 * `shiftBusinessDay(startOfWeek(today), -14)`.
 *
 * Shared by the Trends tab and the summary-export dialog so the two can't come
 * to offer different weeks under the same words. Relative wording works here
 * precisely because both are anchored to **today** — write a control that
 * counts back from some other day and these labels stop being true.
 */
export const WeekOptionLabels = ['This week', '1 week ago', '2 weeks ago', '3 weeks ago'];

/**
 * Never let a range run past a day that cannot hold data yet.
 *
 * "This month" on the 3rd means the 1st to the 3rd, not eleven empty days
 * tacked onto the end. The start is left alone — a range that begins in the
 * future is not something any caller here can produce.
 */
export function clampRangeEnd(range: { from: string; to: string }, max: string): { from: string; to: string } {
  return range.to > max ? { from: range.from, to: max } : range;
}

/** The weekday a business day falls on, e.g. "Tuesday". UTC-parsed — see the module note. */
export function formatWeekday(dayKey: string): string {
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/**
 * "Aug 1 – 18, 2026" — a span written the shortest way that is still
 * unambiguous. Purely a readout: nothing that uses it is a control, so it can
 * afford to be terser than the pickers that set it.
 *
 * **The dash is spaced in every branch**, which is why the spacing is written
 * out three times rather than folded into one template. A same-month span used
 * to close up to "Aug 1–18, 2026" while one crossing a month stayed open as
 * "Aug 28 – Sep 3, 2026" — the typographically correct pair, and wrong here on
 * the owner's call: the two forms appear side by side on the same screens (the
 * Trends readout, both Custom triggers, the Day dropdown's older options), and
 * a range punctuated one way inside a month and another way across one reads
 * as two different kinds of thing. One shape everywhere.
 */
export function formatDateRangeLabel(fromKey: string, toKey: string): string {
  const from = new Date(`${fromKey}T00:00:00Z`);
  const to = new Date(`${toKey}T00:00:00Z`);
  const monthDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const full = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  if (fromKey === toKey) return full(from);
  if (from.getUTCFullYear() !== to.getUTCFullYear()) return `${full(from)} – ${full(to)}`;
  if (from.getUTCMonth() !== to.getUTCMonth()) return `${monthDay(from)} – ${full(to)}`;
  return `${monthDay(from)} – ${to.getUTCDate()}, ${to.getUTCFullYear()}`;
}
