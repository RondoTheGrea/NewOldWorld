/**
 * On-screen money and counts.
 *
 * The locale is pinned to `en-US` rather than read off the device, which is the
 * opposite of what this app does for cosmetic timestamps. A timestamp shown in
 * the driver's own format is friendlier and nothing is filed by it; an *amount*
 * is the number they read back to a store owner, and a phone set to a locale
 * that swaps the two marks would render 1234.50 as "1.234,50". The distributor
 * is in the Philippines, which writes money the en-US way, and the printed
 * receipt (`lib/receipt-print.ts`) already pins the same locale — so the screen
 * and the paper agree character for character.
 *
 * Note that the printed *item table* deliberately drops its separators to save
 * columns on 58mm paper. That is a constraint of the paper, not a house style:
 * nothing on screen is short of width, so everything here keeps them.
 */
const AmountLocale = 'en-US';

/** A peso amount, always two decimals: `1,234.50`. No sign, no `₱`. */
export function formatAmount(value: number): string {
  return value.toLocaleString(AmountLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A whole-number count of things: `1,200`. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString(AmountLocale);
}
