import { paymentLabel } from '@/lib/payment-methods';

/**
 * The payment method as an outlined pill — the same tag the phone puts at the
 * right of every row in its receipts list.
 *
 * Copied rather than reinvented on purpose: the agent who wrote the receipt
 * saw a green "Cash" or a red "Partial" against it, and a manager looking the
 * same receipt up should see the tag they'd be told about over the phone. The
 * outline-and-coloured-text shape is what makes it a *tag* rather than one of
 * the board's filled `.ops-pill` status badges, which mean something else
 * ("Out now", "Refused records") and shouldn't be confused with it.
 *
 * Renders nothing without a method. Only a draft has none, drafts never leave
 * the phone, and a receipt written before payment methods existed is better
 * shown with a blank slot than with a guess.
 */
export function PaymentTag({ method }: { method?: string | null }) {
  if (!method) return null;
  return <span className={`ops-tag ops-tag-${method}`}>{paymentLabel(method)}</span>;
}

/**
 * "Void", in the payment tag's slot — the phone's receipts list puts it in the
 * same place. It replaces the method rather than sitting beside it: a voided
 * cash receipt collected nothing, and a green "Cash" next to it would say
 * otherwise.
 */
export function ReceiptTag({ method, voided }: { method?: string | null; voided: boolean }) {
  if (voided) return <span className="ops-tag ops-tag-void">Void</span>;
  return <PaymentTag method={method} />;
}
