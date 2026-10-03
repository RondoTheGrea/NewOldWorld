/**
 * The payment methods a receipt can carry, and how each one is labelled and
 * coloured.
 *
 * One copy for the whole dashboard. These strings and the colour each method
 * is drawn in are decided on the phone — `apps/mobile/src/lib/receipt-types.ts`
 * for the labels, the `PAYMENT_METHOD_TAG_COLOR` map in
 * `apps/mobile/src/app/(app)/receipts.tsx` for the colours — and the dashboard
 * only ever reads receipts, so it copies them rather than inventing its own. A
 * manager reading "GCash" here is reading the same word off the same receipt
 * the agent is holding.
 *
 * The tone is a *name*, not a colour: what each one resolves to depends on
 * where the tag is drawn (the board's ink-and-navy palette, or the receipt
 * card's verbatim copy of the phone's), so the value lives in CSS. See
 * `.ops-tag` in overview.css.
 */

export const PAYMENT_METHODS = ['cash', 'gcash', 'cheque', 'partial', 'credit'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  cheque: 'Cheque',
  partial: 'Partial',
  credit: 'Credit',
};

/**
 * A method the phone wrote that this build doesn't know is shown as-is rather
 * than dropped — an unrecognised word on screen is a question a manager can
 * ask; a blank tag is one nobody knows to.
 */
export function paymentLabel(method: string): string {
  return PAYMENT_LABELS[method] ?? method;
}
