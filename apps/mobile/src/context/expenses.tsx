import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';

import { NoOpenRunError, useInventory } from '@/context/inventory';
import { logError } from '@/lib/errors';
import * as expenseDb from '@/lib/expense-db';
import type { Expense, ExpenseInput } from '@/lib/expense-types';
import { requestSync } from '@/lib/sync';

export type { Expense, ExpenseInput } from '@/lib/expense-types';

/**
 * What the truck spent on this trip out.
 *
 * Scoped to the run, exactly like the inventory ledger and for the same reason:
 * "End the Day" clears the truck by *closing the run*, not by deleting rows, so
 * the next run reads back an empty sheet while the previous run's expenses are
 * still on disk and still queued to upload.
 *
 * **Nothing here is arithmetic anybody else consumes.** `expenseTotal` is for
 * the Expenses card to show; no receipt total, no manifest sales figure and no
 * dashboard statistic nets it off anything. See lib/expense-types.ts.
 */

type ExpensesContextValue = {
  /** This run's expenses, newest first. Empty until the run's own rows have loaded. */
  expenses: Expense[];
  /** True only while there is a run whose expenses haven't arrived yet. */
  expensesLoading: boolean;
  /** Set when SQLite is unavailable (currently: web) or the load failed. */
  expensesError: string | null;
  /** Re-runs a failed load — what the "Try again" button calls. */
  reloadExpenses: () => void;
  /** What this run has spent so far. Informational; nothing subtracts it. */
  expenseTotal: number;
  /**
   * Records an expense.
   *
   * `expenseId` marks which user action this is, so a retry of a failed save
   * rewrites the same row rather than recording a second, identical expense.
   * Callers inside a retry prompt must mint one per attempt-group and reuse it.
   */
  addExpense: (input: ExpenseInput, expenseId?: string) => Promise<void>;
  /** Removes an expense. A soft delete — see deleteExpenseRow in lib/expense-db.ts. */
  removeExpense: (id: string) => Promise<void>;
};

const ExpensesContext = createContext<ExpensesContextValue | null>(null);

export function useExpenses() {
  const value = use(ExpensesContext);
  if (!value) {
    throw new Error('useExpenses must be used inside an <ExpensesProvider>');
  }
  return value;
}

/**
 * Thrown if an expense is written with no run open.
 *
 * Shouldn't be reachable — the Expenses card only renders once setup is
 * finished — but an expense is scoped by run, so a write with no run would land
 * in a row nothing can read back and no upload can file. Better to fail loudly.
 */
function requireRun(runId: string | null): string {
  if (!runId) throw new NoOpenRunError();
  return runId;
}

export function ExpensesProvider({ children }: PropsWithChildren) {
  const { runId } = useInventory();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Which run the list in state actually belongs to. Without it, the instant a
  // new run opens the previous run's expenses are still in state and would be
  // rendered as this trip's — the same masking context/stock.tsx does, for the
  // same reason: a wrong number is worse than a spinner.
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null);
  const [loadToken, setLoadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // No run open — before setup, and again straight after "End the Day". There
    // is nothing to read, and what is already in state is masked below rather
    // than cleared here, so this effect never sets state on its own.
    if (!runId) return;

    expenseDb
      .loadExpensesForRun(runId)
      .then((rows) => {
        if (cancelled) return;
        setExpenses(rows);
        setLoadedRunId(runId);
      })
      .catch((error: unknown) => {
        // On web, expense-db.web.ts (the platform-matched stub Metro loads
        // there) rejects this call — the one place that surfaces as a message
        // rather than a crash.
        logError('expenses.load', error);
        if (cancelled) return;
        setError(
          Platform.OS === 'web'
            ? 'Expenses aren’t available on web yet — use the app on a phone.'
            : 'Could not load expenses from this phone’s storage.'
        );
      });

    return () => {
      cancelled = true;
    };
  }, [loadToken, runId]);

  function reloadExpenses() {
    setError(null);
    setLoadedRunId(null);
    setLoadToken((token) => token + 1);
  }

  const ready = runId !== null && loadedRunId === runId;
  const visible = ready ? expenses : [];

  // Both writers nudge sync only after the row is safely on disk. requestSync()
  // never throws and never waits — a failed upload leaves the row pending and
  // the loop tries again later, so nothing here is gated on the network.
  async function addExpense(input: ExpenseInput, expenseId?: string) {
    const saved = await expenseDb.insertExpense(requireRun(runId), input, expenseId);
    // Keyed by id, so a retry of a write that had actually committed replaces
    // the row on screen instead of showing the same expense twice.
    setExpenses((current) => [saved, ...current.filter((expense) => expense.id !== saved.id)]);
    requestSync();
  }

  async function removeExpense(id: string) {
    await expenseDb.deleteExpenseRow(id);
    setExpenses((current) => current.filter((expense) => expense.id !== id));
    requestSync();
  }

  const value: ExpensesContextValue = {
    expenses: visible,
    // Only "loading" when there is a run whose expenses haven't arrived. With no
    // run open the card isn't rendered at all, so it must not claim to be busy.
    expensesLoading: runId !== null && !ready && error === null,
    expensesError: error,
    reloadExpenses,
    expenseTotal: visible.reduce((total, expense) => total + expense.amount, 0),
    addExpense,
    removeExpense,
  };

  return <ExpensesContext value={value}>{children}</ExpensesContext>;
}
