import type { CashCount, CashCountInput } from '@/lib/cash-count';
import type { Expense, ExpenseInput } from '@/lib/expense-types';

// Metro's web-platform stand-in for expense-db.ts — see the comment there for
// why this split exists. The two *writes* throw, and context/expenses.tsx's
// load effect catches that to show a "not available on web" message instead of
// crashing.

const UNAVAILABLE_MESSAGE = 'Expenses aren’t available on web yet — use the app on a phone.';

export type PendingExpense = Expense & { deleted: boolean };

export async function loadExpensesForRun(_runId: string): Promise<Expense[]> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function insertExpense(
  _runId: string,
  _input: ExpenseInput,
  _expenseId?: string
): Promise<Expense> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function deleteExpenseRow(_id: string): Promise<void> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function loadCashCountForRun(_runId: string): Promise<CashCount | null> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function saveCashCountForRun(_runId: string, _input: CashCountInput): Promise<CashCount> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function runHasExpense(_runId: string): Promise<boolean> {
  return false;
}

// Sync's reads answer "nothing to do" rather than throwing — the same choice
// the other two stubs make. There is genuinely no expense database on web, so
// an empty queue is the truthful answer, and context/sync.tsx runs on a timer
// where a throw every minute would be noise rather than information.
export async function loadPendingExpenses(_limit: number): Promise<PendingExpense[]> {
  return [];
}

export async function countPendingExpenses(): Promise<number> {
  return 0;
}

export async function summarizeExpensesForRun(
  _runId: string
): Promise<{ expenseCount: number; expenseTotal: number }> {
  return { expenseCount: 0, expenseTotal: 0 };
}

export async function bumpExpenseAttempts(_id: string): Promise<number> {
  return 0;
}

export async function markExpenseBlocked(_id: string): Promise<void> {}

export async function countBlockedExpenses(): Promise<number> {
  return 0;
}

export async function countBlockedExpensesForRun(_runId: string): Promise<number> {
  return 0;
}

export async function retryBlockedExpenses(): Promise<number> {
  return 0;
}

export async function markExpenseSynced(_id: string, _updatedAt: number): Promise<void> {}

export async function countSyncedExpenses(): Promise<number> {
  return 0;
}

export async function markExpenseLegacy(_id: string): Promise<void> {}

export async function loadPendingCashCounts(_limit: number): Promise<CashCount[]> {
  return [];
}

export async function countPendingCashCounts(): Promise<number> {
  return 0;
}

export async function countBlockedCashCounts(): Promise<number> {
  return 0;
}

export async function countBlockedCashCountsForRun(_runId: string): Promise<number> {
  return 0;
}

export async function countSyncedCashCounts(): Promise<number> {
  return 0;
}

export async function bumpCashCountAttempts(_runId: string): Promise<number> {
  return 0;
}

export async function markCashCountBlocked(_runId: string): Promise<void> {}

export async function retryBlockedCashCounts(): Promise<number> {
  return 0;
}

export async function markCashCountSynced(_runId: string, _updatedAt: number): Promise<void> {}

export async function markCashCountLegacy(_runId: string): Promise<void> {}
