/**
 * The cash the driver is actually holding, counted by bill.
 *
 * Receipts say what *should* be in the bag; this says what *is*. The two drift
 * apart for ordinary reasons — change given wrong, a bill dropped, an expense
 * paid out of the takings — and the cash count is how the driver sees the gap
 * before handing the money in, not after.
 *
 * One count per **run**, overwritten each time it is saved: it is a snapshot of
 * the bag right now, not a log. The driver counts, saves, maybe counts again
 * later in the day, and the latest count is the one that means anything. Like
 * expenses, it is scoped to the run so "End the Day" hands the next trip a blank
 * count without deleting anything.
 *
 * **On this phone only for now.** It is not uploaded and the dashboard does not
 * see it. And like expenses, nothing here changes a receipt, the day's takings
 * or any figure the server keeps — the comparison on screen is the only place
 * the counted cash is set against anything.
 */

/** The bills counted one by one, largest first — the order the form shows them. */
export const BillDenominations = [1000, 500, 200, 100, 50, 20] as const;

export type BillDenomination = (typeof BillDenominations)[number];

/** How many of each bill. Whole numbers, never negative. */
export type BillCounts = Record<BillDenomination, number>;

export type CashCountInput = {
  bills: BillCounts;
  /** Coins as a single peso amount — nobody counts ₱1 coins one by one. */
  coins: number;
};

export type CashCount = CashCountInput & {
  runId: string;
  /** When this count was last saved. Shown on screen; nothing is filed by it. */
  updatedAt: number;
};

/**
 * Typo catchers, not business rules — the same idea as MaxExpenseAmount. A stray
 * extra zero on a bill count would otherwise show a shortage or overage of tens
 * of thousands of pesos and look like a real one.
 */
export const MaxBillCount = 9_999;
export const MaxCoinAmount = 100_000;

export function emptyBillCounts(): BillCounts {
  return { 1000: 0, 500: 0, 200: 0, 100: 0, 50: 0, 20: 0 };
}

/** A bill count as typed: whole, non-negative, capped. Anything unreadable is 0. */
export function normalizeBillCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MaxBillCount);
}

/** A coin amount as typed: to the centavo, non-negative, capped. Anything unreadable is 0. */
export function normalizeCoinAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value * 100) / 100, MaxCoinAmount);
}

/** Cleans a count on the way into the database, so any future caller is bounded too. */
export function sanitizeCashCountInput(input: CashCountInput): CashCountInput {
  const bills = emptyBillCounts();
  for (const denomination of BillDenominations) {
    bills[denomination] = normalizeBillCount(input.bills[denomination]);
  }
  return { bills, coins: normalizeCoinAmount(input.coins) };
}

/** The pesos a count adds up to. Rounded to the centavo so float noise never shows. */
export function cashCountTotal(count: CashCountInput): number {
  let total = count.coins;
  for (const denomination of BillDenominations) {
    total += denomination * count.bills[denomination];
  }
  return Math.round(total * 100) / 100;
}
