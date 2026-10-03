import { sanitizeMultiline, sanitizeSingleLine } from '@/lib/text-input';

/**
 * What a truck spent while it was out — fuel, a toll, lunch for the crew.
 *
 * Deliberately the smallest possible record: a title, an amount, and optional
 * notes. It is **informational only**. Nothing in this app or on the dashboard
 * subtracts an expense from sales, from the net, or from anything else. If that
 * ever changes it has to be a decision, not a side effect of somebody adding a
 * subtraction somewhere.
 *
 * An expense belongs to a **run**, the same way a ledger entry does. That is
 * what makes "End the Day" hand back a clean sheet without deleting anything:
 * the next run simply has no expenses yet, while the previous run's are still
 * on disk and still queued to upload.
 */

export type Expense = {
  id: string;
  /** The run this was spent on. Never null — an expense with no run can't be filed. */
  runId: string;
  title: string;
  /** Pesos, to the centavo. Always positive: this is an amount spent, not a signed delta. */
  amount: number;
  /** Free text, or '' — the field is optional. */
  notes: string;
  createdAt: number;
  /**
   * Last local write. Bumped by a delete, which is how the sync guard tells "the
   * version that just uploaded" from "the version on disk now" — see
   * markExpenseSynced in lib/expense-db.ts.
   */
  updatedAt: number;
};

export type ExpenseInput = {
  title: string;
  amount: number;
  notes: string;
};

/**
 * Length caps, used twice: as `maxLength` on the input so the cap is visible
 * while typing, and inside the sanitizer so a value that arrived another way is
 * still bounded. See lib/text-input.ts for what the sanitizers are actually for
 * (it is not SQL injection — every query binds its values).
 */
export const ExpenseFieldLimits = {
  title: 80,
  notes: 500,
} as const;

/**
 * The most one expense may record.
 *
 * Not a business rule so much as a typo catcher: a truck's expense is tens or
 * hundreds of pesos, and a stray keypress that files a seven-figure fuel stop
 * would sit on the dashboard looking like a real number.
 */
export const MaxExpenseAmount = 1_000_000;

/**
 * Rounds to the centavo and rejects anything that isn't a real, positive
 * amount — `NaN` from a half-typed field, a negative, an infinity.
 *
 * Returns 0 for all of those, and 0 is what the form treats as "not valid yet",
 * so a bad amount can never reach the database.
 */
export function normalizeExpenseAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(Math.round(amount * 100) / 100, MaxExpenseAmount);
}

/**
 * Cleans an expense on the way in. Called inside `insertExpense` rather than
 * only in the form, so it holds for any future caller.
 */
export function sanitizeExpenseInput(input: ExpenseInput): ExpenseInput {
  return {
    title: sanitizeSingleLine(input.title, ExpenseFieldLimits.title),
    amount: normalizeExpenseAmount(input.amount),
    notes: sanitizeMultiline(input.notes, ExpenseFieldLimits.notes),
  };
}
