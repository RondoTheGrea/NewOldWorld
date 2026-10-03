import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';

import { logError } from '@/lib/errors';
import { summarizeRunHistoryForRun } from '@/lib/receipt-db';
import * as runHistoryDb from '@/lib/run-history-db';
import { loadInventoryBatchesForRun } from '@/lib/stock-db';
import type { RunHistoryEntry, RunHistorySummary } from '@/lib/run-history-types';

export type { RunHistoryEntry, RunHistorySummary } from '@/lib/run-history-types';

/**
 * Finished runs, kept on this phone only — see lib/run-history-types.ts.
 *
 * Not scoped to the current run the way ExpensesProvider is: this is a list
 * across every day the truck has run, so it loads once at mount rather than
 * re-loading when a run opens or closes. The list only actually changes when
 * "End the Day" writes a new row (context/sync.tsx), so RunHistoryModal calls
 * `reload()` itself when it opens, rather than this provider trying to notice
 * a write that happens in a sibling context.
 */
type RunHistoryContextValue = {
  /** Finished runs, newest first. */
  summaries: RunHistorySummary[];
  /** True only while there is nothing to show yet and no error. */
  loading: boolean;
  /** Set when SQLite is unavailable (currently: web) or the load failed. */
  error: string | null;
  /** Re-reads the list — what "Try again" and opening the modal both call. */
  reload: () => void;
  /** One run's full breakdown, or null if it can't be read. Never throws. */
  loadDetail: (runId: string) => Promise<RunHistoryEntry | null>;
  /** Wipes every saved summary. The runs themselves — the ledger, receipts — are untouched. */
  clearHistory: () => Promise<void>;
};

const RunHistoryContext = createContext<RunHistoryContextValue | null>(null);

export function useRunHistory() {
  const value = use(RunHistoryContext);
  if (!value) {
    throw new Error('useRunHistory must be used inside a <RunHistoryProvider>');
  }
  return value;
}

const UNAVAILABLE_MESSAGE = 'Run history isn’t available on web yet — use the app on a phone.';

export function RunHistoryProvider({ children }: PropsWithChildren) {
  const [summaries, setSummaries] = useState<RunHistorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadToken, setLoadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    runHistoryDb
      .loadRunHistorySummaries()
      .then((rows) => {
        if (cancelled) return;
        setSummaries(rows);
        setError(null);
      })
      .catch((loadError: unknown) => {
        // On web, run-history-db.web.ts (the platform-matched stub Metro loads
        // there) rejects this call — the one place that surfaces as a message
        // rather than a crash.
        logError('runHistory.load', loadError);
        if (cancelled) return;
        setError(Platform.OS === 'web' ? UNAVAILABLE_MESSAGE : 'Could not load run history from this phone’s storage.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadToken]);

  function reload() {
    setLoading(true);
    setLoadToken((token) => token + 1);
  }

  async function loadDetail(runId: string): Promise<RunHistoryEntry | null> {
    try {
      const entry = await runHistoryDb.loadRunHistoryDetail(runId);
      if (!entry) return null;

      // The snapshot is written once at "End the Day". Older ones folded partial
      // receipts into `other_total` as down-payment only, so `partial_total` can
      // read zero even though the receipts are still on disk. Re-read the money
      // split here — one run's worth of receipts, on demand, not on every list open.
      if (Platform.OS === 'web') return entry;

      const fresh = await summarizeRunHistoryForRun(runId);

      // Snapshots saved before the initial count's time was recorded don't
      // have it. The ledger is never deleted, so it still knows — read it for
      // this one run. A failure here only costs the time, never the run.
      let initialCreatedAt = entry.initialCreatedAt;
      if (initialCreatedAt === null) {
        try {
          const batches = await loadInventoryBatchesForRun(runId);
          initialCreatedAt = batches.find((batch) => batch.kind === 'initial')?.createdAt ?? null;
        } catch (ledgerError) {
          logError('runHistory.loadDetail.initialTime', ledgerError, { runId });
        }
      }

      return {
        ...entry,
        initialCreatedAt,
        money: {
          cash: fresh.cashTotal,
          gcash: fresh.gcashTotal,
          cheque: fresh.chequeTotal,
          partial: fresh.partialTotal,
          partialPaid: fresh.partialPaidTotal,
          credit: fresh.creditTotal,
        },
      };
    } catch (detailError) {
      // Background-ish read behind a tap, not a form submit — logged like any
      // other read failure (see CLAUDE.md's "When something fails"), and the
      // modal shows nothing selected rather than an alert.
      logError('runHistory.loadDetail', detailError);
      return null;
    }
  }

  async function clearHistory(): Promise<void> {
    await runHistoryDb.clearRunHistory();
    setSummaries([]);
  }

  const value: RunHistoryContextValue = {
    summaries,
    loading,
    error,
    reload,
    loadDetail,
    clearHistory,
  };

  return <RunHistoryContext value={value}>{children}</RunHistoryContext>;
}
