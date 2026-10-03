/**
 * "Which day is this?" for the dashboard — always a **Manila** day.
 *
 * The mobile app has its own copy of this (apps/mobile/src/lib/business-day.ts)
 * with the long-form reasoning. The short version, and why the dashboard needs
 * its own: every uploaded receipt, ledger entry and run already carries a
 * `businessDay` string that the *phone* computed. The dashboard must never
 * re-derive a day from a timestamp — a browser open in another timezone would
 * file a 6:30 AM Manila receipt under the previous day, which is the exact bug
 * the string exists to prevent.
 *
 * So this file is only ever used to decide **which day to ask for** (today, or
 * whichever day the operator paged back to) and to label it. The documents are
 * always matched on their own stored string.
 *
 * Deliberately duplicated rather than shared: packages/shared is still an empty
 * scaffold, and this file imports nothing, so a copy costs less than standing up
 * a workspace for it. If the two ever drift, the phone's answer wins — it is the
 * one that gets written down.
 */

/** The distributor's timezone. The Philippines has no daylight saving, so this is UTC+8 year-round. */
export const BusinessTimeZone = 'Asia/Manila';

/**
 * Some engines ship without the full timezone database, in which case asking
 * for a named zone throws. Detected once so a missing tz database degrades to
 * the browser's own timezone instead of a blank page.
 */
function timeZoneSupported(): boolean {
  try {
    new Date().toLocaleString('en-US', { timeZone: BusinessTimeZone });
    return true;
  } catch {
    return false;
  }
}

const supported = timeZoneSupported();

function withBusinessZone(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return supported ? { ...options, timeZone: BusinessTimeZone } : options;
}

/**
 * The Manila calendar day a timestamp belongs to, as `YYYY-MM-DD`.
 *
 * `en-CA` is not a typo — it is the locale whose short date format is already
 * `YYYY-MM-DD`, which sorts correctly as a plain string.
 */
export function businessDayKey(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(
    'en-CA',
    withBusinessZone({ year: 'numeric', month: '2-digit', day: '2-digit' }),
  );
}

/** Today's business day key, in Manila — not in the browser's timezone. */
export function currentBusinessDayKey(): string {
  return businessDayKey(Date.now());
}

/** UTC+8, in milliseconds. Constant year-round. */
const BusinessUtcOffsetMs = 8 * 60 * 60 * 1000;

/**
 * Midnight of a `YYYY-MM-DD` business day, as an absolute instant.
 *
 * Derived by arithmetic rather than by formatting: a Manila day starts exactly
 * 8 hours before the UTC day of the same name, always. Deriving it from the
 * *browser's* midnight instead is the bug this whole file exists to prevent.
 */
export function startOfBusinessDay(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - BusinessUtcOffsetMs;
}

/**
 * Which hour of its business day a timestamp falls in, 0–23 — Manila again, so
 * a 6 AM sale plots at 6 whatever the browser's clock says.
 */
export function businessDayHour(timestamp: number, dayKey: string): number {
  const offset = timestamp - startOfBusinessDay(dayKey);
  return Math.max(0, Math.min(23, Math.floor(offset / 3_600_000)));
}

/** "5 AM" / "12 PM" — an hour tick, short enough to repeat across an axis. */
export function formatHourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display} ${suffix}`;
}

/**
 * The business day `offset` days away from `key` — `-1` for yesterday.
 *
 * Done by stepping a whole day from that day's midnight and re-deriving the
 * key, rather than by adding to the date parts, so month and year ends need no
 * special case.
 */
export function shiftBusinessDay(key: string, offset: number): string {
  return businessDayKey(startOfBusinessDay(key) + offset * 24 * 60 * 60 * 1000);
}

/** e.g. "Saturday, 16 August 2026" — the heading for a day being viewed. */
export function formatBusinessDayLong(key: string): string {
  return new Date(startOfBusinessDay(key) + 12 * 60 * 60 * 1000).toLocaleDateString(
    'en-GB',
    withBusinessZone({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  );
}

/**
 * Clock time in Manila, e.g. "6:42 AM".
 *
 * Pinned to Manila rather than the browser on purpose: "the truck left at 5 AM"
 * has to mean 5 AM where the truck is, wherever the page is open.
 */
export function formatBusinessTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(
    'en-US',
    withBusinessZone({ hour: 'numeric', minute: '2-digit' }),
  );
}

/** e.g. "16 Aug" — a day named in passing, beside a time rather than as a heading. */
export function formatBusinessDayShort(key: string): string {
  return new Date(startOfBusinessDay(key) + 12 * 60 * 60 * 1000).toLocaleDateString(
    'en-GB',
    withBusinessZone({ day: 'numeric', month: 'short' }),
  );
}

/**
 * "48m" / "3h 12m" / "2d 7h" — how long a run has been out, or how long it
 * lasted.
 *
 * Days are a real unit here, not a rounding nicety. A run may stay open across
 * midnight — the truck goes out Monday and comes back Wednesday — and "55h 12m"
 * is a number a reader has to divide before it means anything, which on an
 * operations board is the same as not saying it. Minutes are dropped once the
 * span reaches a day for the same reason: at that length they are noise, and
 * the exact end time is printed next to this anyway.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
