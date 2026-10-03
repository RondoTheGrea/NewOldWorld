import type { RunHistoryEntry, RunHistorySummary } from '@/lib/run-history-types';

// Metro's web-platform stand-in for run-history-db.ts — see the comment there
// for why this split exists. Run history is native-only, same as the ledger,
// receipts and expenses it's built from; context/run-history.tsx's load effect
// catches the throw to show a "not available on web" message instead of
// crashing.

const UNAVAILABLE_MESSAGE = 'Run history isn’t available on web yet — use the app on a phone.';

export async function loadRunHistorySummaries(): Promise<RunHistorySummary[]> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function loadRunHistoryDetail(_runId: string): Promise<RunHistoryEntry | null> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function saveRunHistory(_entry: RunHistoryEntry): Promise<void> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function clearRunHistory(): Promise<void> {
  throw new Error(UNAVAILABLE_MESSAGE);
}
