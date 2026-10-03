/**
 * The app's cosmetic timestamps — the ones shown on a screen, on the driver's
 * own clock.
 *
 * **These are deliberately not the business day.** Nothing is *filed* by them:
 * anything that decides what a day contains goes through `lib/business-day.ts`
 * and is pinned to Manila, and the printed receipt's date and time are pinned
 * there too because that is the copy the customer keeps. These are the other
 * kind — the receipts list, the "saved copy" badge, an expense's row, "last
 * checked" on the upload card — where showing a driver their own clock, in
 * their own locale, is friendlier than showing them the server's.
 *
 * The one thing not left to the locale is **12-hour time**. A device set to
 * 24-hour (or simply a locale that prefers it) rendered "14:32" on a screen
 * where every printed receipt beside it says "2:32 PM", and the distributor
 * reads clocks in AM/PM. That was six separate `toLocaleString` calls with
 * identical options and no `hour12`, so it was six separate bugs; they live
 * here now so the next screen can't reintroduce a seventh.
 */

/** Time only, e.g. "2:04 PM". For something already known to be today. */
export function formatDeviceTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Date alone, e.g. "Aug 15". For a narrow spot where the date and the time go
 * on separate lines — pair it with `formatDeviceTime`.
 */
export function formatDeviceDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** Date and time, e.g. "Aug 15, 2:04 PM". For anything that may not be today. */
export function formatDeviceDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
