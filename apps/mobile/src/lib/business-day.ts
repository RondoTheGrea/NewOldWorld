/**
 * Everything in this app that has to answer "which day is this?" must ask
 * here, and nowhere else.
 *
 * Every timestamp the app stores is `Date.now()` — epoch milliseconds, an
 * absolute instant with no timezone attached. That is the right way to store
 * a moment, and it is deliberately *not* a date. Turning one into a date
 * requires picking a timezone, and picking the wrong one is how a POS quietly
 * files a morning's work under yesterday.
 *
 * The distributor operates in the Philippines (UTC+8, no daylight saving), so
 * the business day is always a Manila day:
 *
 * - A receipt written at 7:00 AM Manila is 11:00 PM UTC **the previous day**.
 *   Anything that groups by UTC — `toISOString().slice(0, 10)` is the usual
 *   culprit — puts every sale before 8 AM into the wrong day. On a bread truck
 *   that starts before dawn, that is most of the route.
 * - Reading the day off the *device* instead is no safer: a phone with
 *   auto-timezone off, or a tablet with no SIM that falls back to UTC, gives a
 *   different answer than the phone parked next to it.
 *
 * So: never `getTimezoneOffset()`, never `toISOString().slice(0, 10)`, never
 * `new Date(ts).getDate()` for anything that decides what a day contains.
 * Use `businessDayKey` to group or compare days, and the formatters here for
 * anything printed on paper.
 *
 * Purely *cosmetic* on-screen timestamps (the receipts list, the "saved copy"
 * badge) deliberately stay on the device's own locale and timezone — if a
 * driver's phone is set to another timezone, showing them their own clock is
 * the friendlier answer, and nothing is filed by it.
 */

/** The distributor's timezone. The Philippines has no daylight saving, so this is UTC+8 year-round. */
export const BusinessTimeZone = 'Asia/Manila';

/**
 * Some JS engines ship without the full timezone database, in which case
 * asking for a named zone throws. Rather than let that crash a receipt print,
 * we detect it once and fall back to the device's own timezone — the same
 * behaviour the app had before this file existed, so a missing tz database
 * degrades to "no worse than before" instead of a broken screen.
 *
 * Hermes on Android and iOS both carry the platform's timezone data, so this
 * fallback is not expected to fire on a real phone; it exists so that a web
 * build or an unusual engine can't take the app down.
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

/** Adds the business timezone to format options, unless this engine can't honour it. */
function withBusinessZone(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return supported ? { ...options, timeZone: BusinessTimeZone } : options;
}

/**
 * The calendar day a timestamp belongs to, as `YYYY-MM-DD` in Manila.
 *
 * This is the string to group by, compare, or store when something is "per
 * day" — a daily stock reset, a day's sales total, "has this store been
 * visited today". Two timestamps belong to the same business day when their
 * keys are equal, whatever the phone's clock is set to.
 *
 * `en-CA` is not a typo: it is the locale whose short date format is already
 * `YYYY-MM-DD`, which sorts correctly as a plain string.
 */
export function businessDayKey(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(
    'en-CA',
    withBusinessZone({ year: 'numeric', month: '2-digit', day: '2-digit' })
  );
}

/** Today's business day key. */
export function currentBusinessDayKey(): string {
  return businessDayKey(Date.now());
}

/** True when both timestamps fall on the same Manila calendar day. */
export function isSameBusinessDay(a: number, b: number): boolean {
  return businessDayKey(a) === businessDayKey(b);
}

/** UTC+8, in milliseconds. Constant year-round — the Philippines has no daylight saving. */
const BusinessUtcOffsetMs = 8 * 60 * 60 * 1000;

/**
 * The first and last millisecond of the business day a timestamp falls in.
 *
 * `businessDayKey` answers "which day is this?"; this answers "which instants
 * belong to that day?", which is what a SQL query needs — `created_at` is an
 * absolute instant, so a day's rows are a range over it, not a string match.
 *
 * Derived by arithmetic rather than by formatting: a Manila day starts exactly
 * 8 hours before the UTC day of the same name, always. Deriving the boundary
 * from the *device's* midnight instead is the bug this whole file exists to
 * prevent — a phone set to UTC would put every sale before 8 AM in the wrong
 * day, which on a bread truck is most of the route.
 */
export function businessDayRange(timestamp: number): { from: number; to: number } {
  const key = businessDayKey(timestamp);
  const [year, month, day] = key.split('-').map(Number);
  // Date.UTC gives midnight UTC for that calendar date; a Manila midnight is
  // 8 hours earlier in absolute terms.
  const from = Date.UTC(year, month - 1, day) - BusinessUtcOffsetMs;
  return { from, to: from + 24 * 60 * 60 * 1000 - 1 };
}

/**
 * The date as it should appear on a printed receipt, e.g. "August 15, 2026".
 *
 * Pinned to Manila rather than the device: the receipt is a business document
 * the customer keeps, and a phone with the wrong timezone would otherwise
 * print every morning receipt dated the previous day, with nothing on the
 * paper to reveal it.
 */
export function formatBusinessDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(
    'en-US',
    withBusinessZone({ month: 'long', day: 'numeric', year: 'numeric' })
  );
}

/** The time as it should appear on a printed receipt, e.g. "2:04 PM". Manila, for the same reason as above. */
export function formatBusinessTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(
    'en-US',
    withBusinessZone({ hour: 'numeric', minute: '2-digit' })
  );
}
