import { createContext, use, useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react';

import { useAuth } from '@/context/auth';
import { useBreadTypes } from '@/context/bread-types';
import { useInventory, type RunRecord } from '@/context/inventory';
import * as customerDb from '@/lib/customer-db';
import { describeError, logError } from '@/lib/errors';
import * as expenseDb from '@/lib/expense-db';
import * as receiptDb from '@/lib/receipt-db';
import { recordRunHistory } from '@/lib/run-history';
import * as stockDb from '@/lib/stock-db';
import * as sync from '@/lib/sync';
import type { RunContext, RunManifest } from '@/lib/sync-types';

/**
 * When to upload, and what to do when it doesn't work.
 *
 * The contract with the rest of the app is deliberately small: writing code
 * calls `requestSync()` from lib/sync.ts and forgets about it. Nothing waits
 * on an upload, nothing fails because an upload failed, and no screen blocks
 * on the network. The phone stays the source of truth for the whole day; this
 * is a background copy that catches up when it can.
 *
 * That is also why almost nothing here surfaces an alert. Uploading is work
 * the user never asked for, so it is logged and retried later (see CLAUDE.md).
 * The single exception is "End the Day", which the user *did* ask for.
 */

/**
 * How many rows one pass uploads per collection. A cap rather than "everything
 * pending" so a phone that has been offline for hours moves in visible steps
 * and never builds one enormous in-memory list; the loop simply runs again.
 */
const BatchLimit = 25;

/**
 * Retry cadence while anything is still queued. Deliberately unhurried: this
 * is a truck on a weak signal, and a tight loop would drain the battery
 * without getting the data up any sooner. The real trigger is `requestSync()`
 * firing on every write; this only covers "the network came back and nothing
 * has happened since".
 */
const RetryIntervalMs = 60_000;

/**
 * How many upload passes "End the Day" will run before giving up.
 *
 * Each pass moves at most `BatchLimit` rows per collection, so a phone that has
 * been in a dead zone all day needs several to clear its queue. Bounded anyway
 * so a row that fails for a reason retrying can't fix doesn't loop forever —
 * the loop also stops early the moment a pass makes no progress.
 */
const MaxEndDayPasses = 20;

/**
 * How many *unrecognised* upload failures one row is forgiven before it is set
 * aside. Failures that are plainly transient — no signal, server busy — are
 * never counted, so a truck in a dead zone all day still arrives with a clean
 * slate. See classifyUploadFailure in lib/sync.ts.
 */
const MaxUploadAttempts = 5;

/**
 * "End the Day" refusing because work is still on the phone.
 *
 * Thrown rather than returned so it flows into the same `runWithRetry` prompt
 * the caller already uses: the driver moves somewhere with signal and taps
 * "Try again", which runs the whole upload-then-close sequence afresh.
 */
/**
 * The one wording for "there is still a draft open".
 *
 * Shared rather than written twice because it is reported from two places — the
 * check before the confirm dialog, and the backstop inside `endTheDay` — and
 * two phrasings of one fault read as two different problems (see CLAUDE.md on
 * the "No bread types downloaded" wording).
 */
export function openDraftMessage(customerName: string): string {
  // "Finalize" and "Delete" are the words on the two buttons in the receipt
  // detail modal, so the instruction names the taps rather than describing them.
  return `There’s still a draft receipt for ${customerName}. Finalize it or delete it in the Receipts tab, then end the day.`;
}

/** What "End the Day" still needs from the Breakdown & Expenses card. */
export type MissingCloseout = { expense: boolean; breakdown: boolean };

/**
 * Whether this run is missing an expense, a saved breakdown, or both — `null`
 * when it has everything. Shared by the check before the "End the day?"
 * confirmation and the backstop inside `endTheDay`, so they can't disagree.
 *
 * Reads the databases directly rather than the Expenses context: this file
 * sits outside that provider, and the database is the authority anyway.
 */
export async function findMissingCloseout(runId: string): Promise<MissingCloseout | null> {
  const [hasExpense, cashCount] = await Promise.all([
    expenseDb.runHasExpense(runId),
    expenseDb.loadCashCountForRun(runId),
  ]);
  const missing = { expense: !hasExpense, breakdown: cashCount === null };
  return missing.expense || missing.breakdown ? missing : null;
}

/** The one wording for it — names the card and the tabs the driver has to tap. */
export function missingCloseoutMessage(missing: MissingCloseout): string {
  const needs =
    missing.expense && missing.breakdown
      ? 'record at least one expense and save the breakdown'
      : missing.expense
        ? 'record at least one expense'
        : 'save the breakdown';
  return `Before ending the day, ${needs} on the Breakdown & Expenses card. If nothing was spent, record an expense of ₱0.`;
}

/**
 * "End the Day" refusing because the Breakdown & Expenses card isn't filled in.
 *
 * Like an open draft, this is a rule rather than a glitch — "Try again" can't
 * fix it, so the end-day card reports it once with an OK.
 */
export class MissingCloseoutError extends Error {
  constructor(missing: MissingCloseout) {
    super(missingCloseoutMessage(missing));
    this.name = 'MissingCloseoutError';
  }
}

/**
 * "End the Day" refusing because a receipt is still a draft.
 *
 * A draft is scratch work that never uploads, so it doesn't show up in the
 * pending count and would otherwise sail straight through the connection
 * check — then survive into the next run, where finalizing it would file
 * yesterday's sale under today's truck. The day is the natural moment to force
 * the decision: finish it or throw it away.
 */
export class OpenDraftError extends Error {
  constructor(customerName: string) {
    super(openDraftMessage(customerName));
    this.name = 'OpenDraftError';
  }
}

/**
 * "End the Day" refusing because the open run's details couldn't be assembled.
 *
 * A run is open — the setup says so, and `runId` is pinned on it — but nothing
 * could produce the `RunContext` that goes with it, so there is no truck,
 * agents or start time to stamp the closing write with. Closing is *impossible*
 * in that state rather than merely unwise: `closeRun` and `uploadRunHeader`
 * both take the stamp, and the manifest is counted per run.
 *
 * It exists because that used to be indistinguishable from success. `endTheDay`
 * returned `{ closed: false }` — the same answer it gives when no run is open
 * at all — and the card's `if (!result.value.closed) return` swallowed it. The
 * driver tapped "End the day", watched a spinner, and got nothing: no manifest,
 * no error, and a day still open. Now it throws, so the existing retry prompt
 * reports it like every other refusal.
 *
 * Reaching this at all takes a failure the app already works hard to avoid —
 * the run log failing to load *and* `rebuildRunFromSetup` being unable to
 * stand in for it (see context/inventory.tsx). The recovery is a restart,
 * because the run log is only read on mount, which is why it is reported once
 * with an OK rather than offered as "Try again": retrying inside this session
 * re-reads the same empty state and fails identically.
 */
export class MissingRunDetailsError extends Error {
  constructor(runId: string) {
    super(
      'This phone could not read the details of the day that is open, so it cannot be closed yet. ' +
        'Nothing has been changed and your receipts and inventory are safe. ' +
        'Close the app completely, open it again, then end the day.'
    );
    this.name = 'MissingRunDetailsError';
    this.runId = runId;
  }

  /** The run that couldn't be described, for the log line. */
  readonly runId: string;
}

export class PendingUploadsError extends Error {
  constructor(pending: SyncPending, cause: unknown) {
    // Named per kind rather than totalled. "3 receipts and 1 store" is
    // something a driver can act on and repeat to the server; "4 items" is a
    // number they can only wait out — and stores in particular are invisible
    // otherwise, since nothing else on this screen mentions them.
    const count = `${describeSyncCounts(pending)} still ${pending.total === 1 ? "hasn't" : "haven't"} reached the server.`;
    // The reason matters more than the count. "No response from the server"
    // means move and try again; anything else means retrying alone won't fix
    // it, and saying "check your connection" at someone whose connection is
    // fine sends them looking in the wrong place.
    const why = cause
      ? describeError(cause)
      : 'There is no connection to the server right now.';
    super(`${count}\n\n${why}`);
    this.name = 'PendingUploadsError';
  }
}

export type SyncPending = {
  receipts: number;
  stockEntries: number;
  expenses: number;
  /** The run's cash breakdown — one per run, re-sent whenever it is re-saved. */
  cashCounts: number;
  paymentProofs: number;
  customers: number;
  total: number;
};

const NoPending: SyncPending = {
  receipts: 0,
  stockEntries: 0,
  expenses: 0,
  cashCounts: 0,
  paymentProofs: 0,
  customers: 0,
  total: 0,
};

/**
 * Records the server refused, which will not be retried on their own.
 *
 * Deliberately *not* folded into `pending`: they are the opposite state. A
 * pending record is on its way and blocks the day from closing; a blocked one
 * is going nowhere and must not, or the day could never be closed at all. They
 * are counted separately precisely so neither can be mistaken for the other —
 * and so "some of today's records never reached the server" can be said out
 * loud instead of being a silent gap in the dashboard.
 */
export type SyncBlocked = {
  receipts: number;
  stockEntries: number;
  expenses: number;
  /** The run's cash breakdown — one per run, re-sent whenever it is re-saved. */
  cashCounts: number;
  paymentProofs: number;
  customers: number;
  total: number;
};

const NoBlocked: SyncBlocked = {
  receipts: 0,
  stockEntries: 0,
  expenses: 0,
  cashCounts: 0,
  paymentProofs: 0,
  customers: 0,
  total: 0,
};

/**
 * Records the server has confirmed it received — every `'synced'` row on the
 * phone, for the life of the install. Shown next to `blocked` in Settings as
 * the other half of the same question: of everything this phone has ever
 * tried to send, how much got through versus how much was refused.
 *
 * Deliberately not scoped to a run or a day — this is a device health signal
 * ("is this phone generally getting through"), not a business figure, so it
 * reads the same whether the truck is mid-run or the app was just opened.
 */
export type SyncSynced = {
  receipts: number;
  stockEntries: number;
  expenses: number;
  /** The run's cash breakdown — one per run, re-sent whenever it is re-saved. */
  cashCounts: number;
  paymentProofs: number;
  customers: number;
  total: number;
};

const NoSynced: SyncSynced = {
  receipts: 0,
  stockEntries: 0,
  expenses: 0,
  cashCounts: 0,
  paymentProofs: 0,
  customers: 0,
  total: 0,
};

/** The five kinds either count can hold. Both types match it structurally. */
type SyncCounts = {
  receipts: number;
  stockEntries: number;
  expenses: number;
  /** The run's cash breakdown — one per run, re-sent whenever it is re-saved. */
  cashCounts: number;
  paymentProofs: number;
  customers: number;
};

/**
 * One label per kind that has anything in it — `["3 receipts", "1 store"]`.
 *
 * The single source of wording for every place the queue is described: the Home
 * card's two lines, the "End the day?" confirmation, and the refusal when the
 * queue can't be emptied. One concept, one phrasing — four hand-written
 * variations of "3 receipts" read as four different things being counted.
 *
 * Kinds with nothing in them are left out rather than printed as zeros: this is
 * a sentence, not a table.
 */
export function syncCountParts(counts: SyncCounts): string[] {
  const parts: string[] = [];
  if (counts.receipts > 0) parts.push(`${counts.receipts} ${counts.receipts === 1 ? 'receipt' : 'receipts'}`);
  if (counts.stockEntries > 0)
    parts.push(`${counts.stockEntries} inventory ${counts.stockEntries === 1 ? 'entry' : 'entries'}`);
  if (counts.expenses > 0) parts.push(`${counts.expenses} ${counts.expenses === 1 ? 'expense' : 'expenses'}`);
  // "Breakdown" is the word on the phone's tab and card, so it is the word here.
  if (counts.cashCounts > 0)
    parts.push(`${counts.cashCounts} cash ${counts.cashCounts === 1 ? 'breakdown' : 'breakdowns'}`);
  // "payment photo", not "photo": a driver has no other kind on this screen, and
  // the word is what connects the count to the GCash/cheque receipt it came from.
  if (counts.paymentProofs > 0)
    parts.push(`${counts.paymentProofs} payment ${counts.paymentProofs === 1 ? 'photo' : 'photos'}`);
  if (counts.customers > 0) parts.push(`${counts.customers} ${counts.customers === 1 ? 'store' : 'stores'}`);
  return parts;
}

/** The same counts as prose — "3 receipts, 1 inventory entry and 2 stores". */
export function describeSyncCounts(counts: SyncCounts): string {
  const parts = syncCountParts(counts);
  if (parts.length === 0) return 'Nothing';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * What "End the Day" did. `closed: false` only when there was no run to close;
 * every other refusal throws, so it can carry a reason.
 */
export type EndDayOutcome = { closed: false } | { closed: true; manifest: RunManifest };

type SyncContextValue = {
  /** What is still waiting to upload, refreshed after every pass. */
  pending: SyncPending;
  /** Records the server refused. Never retried on their own — see SyncBlocked. */
  blocked: SyncBlocked;
  /** Records the server has confirmed it received — see SyncSynced. */
  synced: SyncSynced;
  /** True while a pass is in flight. */
  syncing: boolean;
  /** When a pass last completed with nothing left over, or null if that hasn't happened yet. */
  lastSyncedAt: number | null;
  /** Runs a pass now. Safe to call at any time — overlapping calls collapse into one. */
  syncNow: () => void;
  /**
   * Puts every refused record back in the queue and starts a pass. Resolves
   * with how many were re-queued.
   *
   * The escape hatch for a quarantine that has outlived its cause. Most
   * refusals this app can produce are account problems — rules require
   * `createdByUid` to match the signed-in user, so rows abandoned by one agent
   * are rejected until that agent signs back in, then accepted. Without this
   * they would sit on the phone forever, counted and reported but unsendable.
   *
   * Safe to press at any time: a record the server still refuses is simply set
   * aside again, and re-sending one it already has changes nothing (every
   * upload is a `setDoc` at an id the phone chose).
   */
  retryBlocked: () => Promise<number>;
  /**
   * Closes the run: uploads everything still queued, writes the manifest the
   * dashboard checks for completeness, then clears the truck so the next run
   * starts at the setup wizard.
   *
   * **Needs a working connection.** Throws `PendingUploadsError` if the queue
   * can't be emptied, leaving the run open and the truck untouched — callers
   * run this inside `runWithRetry`, which turns that into a "try again" the
   * driver can act on after moving somewhere with signal.
   */
  endTheDay: () => Promise<EndDayOutcome>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync() {
  const value = use(SyncContext);
  if (!value) {
    throw new Error('useSync must be used inside a <SyncProvider>');
  }
  return value;
}

export function SyncProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const inventory = useInventory();
  // Read only to resolve bread-type ids to names when snapshotting run
  // history at close — see recordRunHistory below.
  const { breadTypes } = useBreadTypes();
  const [pending, setPending] = useState<SyncPending>(NoPending);
  const [blocked, setBlocked] = useState<SyncBlocked>(NoBlocked);
  const [synced, setSynced] = useState<SyncSynced>(NoSynced);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  // The pass in flight, plus "someone asked again while it was running". Refs,
  // not state: these are read by callbacks that fire long after the render that
  // created them, and they must not trigger re-renders of their own.
  //
  // The in-flight *promise* is held rather than a boolean, so a second caller
  // can wait for the pass instead of being told "already busy" and moving on.
  // That matters for "End the Day", which decides whether it may close by
  // whether the queue actually emptied: if the 60-second heartbeat happened to
  // be mid-pass, a bare "already running" would look exactly like a pass that
  // uploaded nothing, and the day would refuse to close while perfectly online.
  const passRef = useRef<Promise<void> | null>(null);
  const requestedRef = useRef(false);
  /** Why the last pass stopped, or null if it finished cleanly. Read by endTheDay. */
  const lastFailureRef = useRef<unknown>(null);

  // Everything the drain reads goes through a ref.
  //
  // Not a style choice: `drain` is registered as the module-level sync handler
  // and drives a `setInterval`, so it has to keep a stable identity across
  // renders. If it depended on `setup` or on `markRunHeaderSynced` — a fresh
  // function on every render of the inventory provider — the interval would be
  // torn down and recreated constantly and might never actually fire.
  const contextRef = useRef<RunContext | null>(null);
  const inputsRef = useRef({
    uid: null as string | null,
    headerSynced: false,
    markRunHeaderSynced: () => {},
    runsById: new Map<string, RunRecord>(),
    runLogLoaded: false,
    // Whether a run is open at all, which is a different question from whether
    // its details could be assembled — see endTheDay.
    runId: null as string | null,
  });

  const { setup, currentRun, recentRuns, runLogLoaded, markRunHeaderSynced } = inventory;
  const uid = user?.uid ?? null;

  // The run's identity is read from the log rather than rebuilt from the
  // current setup and the loaded catalogs. It was snapshotted when the run
  // opened, which is both more accurate (the names are the ones the driver
  // actually picked from) and available for runs that have already ended.
  const runContext: RunContext | null = currentRun;

  useEffect(() => {
    contextRef.current = runContext;
    inputsRef.current = {
      uid,
      headerSynced: setup.runHeaderSynced,
      markRunHeaderSynced,
      // Every run a queued row could belong to, not just the open one: "End the
      // Day" may close with rows still waiting, and the next run starts
      // straight afterwards.
      //
      // The open run is added on top of the log rather than taken from it,
      // because it is the one run that can be reconstructed without the log —
      // rebuilt from the pinned setup when the log lost it (see
      // rebuildRunFromSetup in context/inventory.tsx). Without this line those
      // rows would find no stamp and be written off as `'legacy'` while the run
      // they belong to is open on screen. When the log does hold it, this sets
      // back the identical object.
      runsById: new Map(
        (currentRun ? [...recentRuns, currentRun] : recentRuns).map((run) => [run.runId, run])
      ),
      // Whether that map is an answer or just an empty one — see the drains.
      runLogLoaded,
      runId: inventory.runId,
    };
  });

  /**
   * Recounts what is still waiting to upload. Resolves with `null` if it
   * couldn't be counted at all.
   *
   * `null` rather than a zeroed count, because the two mean opposite things and
   * one caller acts on the difference: "End the Day" refuses to close while
   * anything is queued, so a failed count reported as `{ total: 0 }` would let
   * it close over the top of work still sitting on the phone — the exact
   * outcome the rule exists to prevent. As a status display (the Home card) a
   * failed count is not worth surfacing, so that caller ignores it.
   */
  const refreshPending = useCallback(async (): Promise<SyncPending | null> => {
    try {
      const [receipts, stockEntries, expenses, cashCounts, paymentProofs, customers] = await Promise.all([
        receiptDb.countPendingReceipts(),
        stockDb.countPendingBatches(),
        expenseDb.countPendingExpenses(),
        expenseDb.countPendingCashCounts(),
        receiptDb.countPendingPaymentProofs(),
        customerDb.countPendingCustomers(),
      ]);
      const next = {
        receipts,
        stockEntries,
        expenses,
        cashCounts,
        paymentProofs,
        customers,
        total: receipts + stockEntries + expenses + cashCounts + paymentProofs + customers,
      };
      setPending(next);

      // Counted on the same pass but reported separately, and never allowed to
      // affect what this function returns: "End the Day" reads that to decide
      // whether the queue is empty, and a blocked record is not queued.
      const [blockedReceipts, blockedStock, blockedExpenses, blockedCashCounts, blockedProofs, blockedCustomers] =
        await Promise.all([
          receiptDb.countBlockedReceipts(),
          stockDb.countBlockedBatches(),
          expenseDb.countBlockedExpenses(),
          expenseDb.countBlockedCashCounts(),
          receiptDb.countBlockedPaymentProofs(),
          customerDb.countBlockedCustomers(),
        ]);
      setBlocked({
        receipts: blockedReceipts,
        stockEntries: blockedStock,
        expenses: blockedExpenses,
        cashCounts: blockedCashCounts,
        paymentProofs: blockedProofs,
        customers: blockedCustomers,
        total:
          blockedReceipts + blockedStock + blockedExpenses + blockedCashCounts + blockedProofs + blockedCustomers,
      });

      // Same idea, the other outcome: how much this phone has gotten through
      // versus how much it's had refused. Read on the same pass as the two
      // above so the three numbers in Settings never describe three different
      // moments.
      const [syncedReceipts, syncedStock, syncedExpenses, syncedCashCounts, syncedProofs, syncedCustomers] =
        await Promise.all([
          receiptDb.countSyncedReceipts(),
          stockDb.countSyncedBatches(),
          expenseDb.countSyncedExpenses(),
          expenseDb.countSyncedCashCounts(),
          receiptDb.countSyncedPaymentProofs(),
          customerDb.countSyncedCustomers(),
        ]);
      setSynced({
        receipts: syncedReceipts,
        stockEntries: syncedStock,
        expenses: syncedExpenses,
        cashCounts: syncedCashCounts,
        paymentProofs: syncedProofs,
        customers: syncedCustomers,
        total: syncedReceipts + syncedStock + syncedExpenses + syncedCashCounts + syncedProofs + syncedCustomers,
      });

      return next;
    } catch (error) {
      // Web has no SQLite (the .web.ts stubs throw).
      logError('sync.pending', error, runDetails(contextRef.current));
      return null;
    }
  }, []);

  /**
   * One upload pass.
   *
   * The pass stops at its first failure rather than working through the rest.
   * A failure here is almost always "no signal", which fails identically for
   * every remaining row and for the other collections too — and each attempt
   * now costs a timeout rather than an instant rejection (see CallTimeoutMs in
   * lib/sync.ts), so pressing on would spend a minute proving what the first
   * row already established.
   */
  const runPass = useCallback(async () => {
    setSyncing(true);

    try {
      // A loop rather than the pass re-invoking itself at the end: it does the
      // same thing without unbounded recursion, and keeps this callback free of
      // a reference to itself.
      do {
        requestedRef.current = false;

        try {
          lastFailureRef.current = null;
          const ctx = contextRef.current;
          const inputs = inputsRef.current;

          // Anything set aside because this phone couldn't attest goes back in
          // the queue the moment it can. Those rows were never refused — they
          // were good records on a phone that briefly couldn't prove it was a
          // real phone — so waiting for someone to find the Settings button
          // would be asking a driver to fix something they can't be expected to
          // understand. Asked only when there is something to bring back, and
          // answered from a cached token when one was minted in the last
          // minute, so an ordinary pass pays nothing for this.
          if (appCheckQuarantined && (await sync.appCheckHealthy())) {
            appCheckQuarantined = false;
            await requeueBlocked();
          }

          // Customers first, and independent of the run: they are business
          // data, not run data, so they upload even before a truck has finished
          // setup. Upload only — the store list is refreshed at setup, not
          // here. See drainCustomers.
          if (inputs.uid) await drainCustomers(inputs.uid);

          // The run header before its children — not because anything breaks
          // otherwise (every child carries its own copy of the run's identity),
          // but so the dashboard rarely sees a run whose header hasn't landed.
          //
          // Only the *open* run's header is sent. Re-sending a closed run's
          // would set its status back to "open", because the header write is
          // the one that says a run has started.
          //
          // Wrapped because it is the one upload in a pass with no row behind
          // it: it can't be quarantined, so a refusal caused by App Check would
          // otherwise reach the driver in Firestore's own words. See
          // withAppCheckWording.
          if (ctx && !inputs.headerSynced) {
            await sync.withAppCheckWording(() => sync.uploadRunHeader(ctx));
            inputs.markRunHeaderSynced();
          }

          // Children drain whether or not a run is open: each row carries the
          // run it belongs to, so leftovers from a finished run keep going up
          // into that run rather than waiting for — or worse, landing in — the
          // next one.
          await drainStock(inputs.runsById, inputs.runLogLoaded);
          await drainReceipts(inputs.runsById, inputs.runLogLoaded);
          await drainExpenses(inputs.runsById, inputs.runLogLoaded);
          await drainCashCounts(inputs.runsById, inputs.runLogLoaded);
          // Photos last. Every drain stops the pass at the first transient
          // failure, so this order is the order things reach the server on a
          // weak signal — and a 150 KB photo ahead of the day's takings would
          // be the wrong thing to spend a dying connection on.
          if (inputs.uid) await drainPaymentProofs(inputs.runsById, inputs.runLogLoaded, inputs.uid);

          const left = await refreshPending();
          if (left?.total === 0) setLastSyncedAt(Date.now());
        } catch (error) {
          // Kept, not just logged: "End the Day" reports *why* it couldn't
          // finish, and "no response from the server" and "the server rejected
          // this receipt" need different things from the driver. Without it
          // every refusal would blame the connection.
          lastFailureRef.current = error;
          // The run that was open when the pass gave up. A drain failure that
          // isn't a per-row quarantine — the header write, a timeout, a local
          // database error — carries no row id of its own, so without this the
          // line names nothing at all.
          logError('sync.drain', error, runDetails(contextRef.current));
          await refreshPending();
        }
      } while (requestedRef.current);
    } finally {
      setSyncing(false);
    }
  }, [refreshPending]);

  /**
   * Runs a pass, or joins the one already in flight.
   *
   * Callers that don't care (a write nudging sync, the heartbeat) can ignore
   * the promise; "End the Day" awaits it, and either way a request arriving
   * mid-pass collapses into one more lap of the loop above rather than starting
   * a second pass.
   */
  const drain = useCallback((): Promise<void> => {
    if (passRef.current) {
      requestedRef.current = true;
      return passRef.current;
    }
    // Never rejects. `runPass` already catches everything it does, but two of
    // the three callers here are fire-and-forget (`void drain()`), and a
    // rejection reaching one of those is an unhandled promise rejection rather
    // than anything the app can act on. "End the Day" doesn't lose by this: it
    // judges the pass by whether the queue actually emptied, not by a throw.
    const pass = runPass()
      .catch((error: unknown) => logError('sync.pass', error, runDetails(contextRef.current)))
      .finally(() => {
        passRef.current = null;
      });
    passRef.current = pass;
    return pass;
  }, [runPass]);

  const syncNow = useCallback(() => {
    void drain();
  }, [drain]);

  // Not swallowed like the drain's own failures: the user pressed a button and
  // is owed an answer, so a failure here reaches their retry prompt. The pass
  // afterwards is still fire-and-forget — the rows are queued either way, and
  // the heartbeat would pick them up regardless.
  const retryBlocked = useCallback(async (): Promise<number> => {
    const requeued = await requeueBlocked();
    // Nothing is set aside for App Check any more, so the automatic recovery
    // has nothing left to bring back — and leaving the flag up would send the
    // next pass looking for rows this one already queued.
    appCheckQuarantined = false;
    await refreshPending();
    void drain();
    return requeued;
  }, [drain, refreshPending]);

  // The rest of the app nudges sync through lib/sync.ts's module-level hook
  // rather than this context, so no other provider has to sit inside this one.
  //
  // The first pass is scheduled on a timer rather than run straight from the
  // effect body: it sets state as it goes, and doing that synchronously inside
  // an effect is what causes cascading renders. It also does the initial
  // pending count, so there's no separate mount effect for that.
  useEffect(() => {
    sync.setSyncHandler(syncNow);
    const first = setTimeout(syncNow, 0);
    return () => {
      clearTimeout(first);
      sync.setSyncHandler(null);
    };
  }, [syncNow]);

  // A slow heartbeat so a queue left over from a dead zone drains once signal
  // returns, even if the driver doesn't write anything else.
  useEffect(() => {
    const timer = setInterval(() => void drain(), RetryIntervalMs);
    return () => clearInterval(timer);
  }, [drain]);

  /**
   * Closes the run — and **requires a working connection to do it.**
   *
   * The day is not marked over until everything the phone is holding has
   * actually reached Firestore. That is a deliberate reversal of how this
   * started out: closing used to be allowed with rows still queued, on the
   * grounds that blocking a driver on a weak warehouse signal was the worse
   * trade. In practice ending the day is the one moment someone is standing
   * still, and a run that closes with work left behind puts the server in the
   * position of trusting a total that isn't complete yet.
   *
   * So: upload until the queue is empty, then close. If it can't be emptied,
   * throw — the caller's retry prompt turns that into "move somewhere with
   * signal and try again", and nothing about the run changes in the meantime.
   * The truck is not cleared, the manifest is not written, and every receipt
   * and ledger entry stays exactly where it is on the phone.
   *
   * Several passes rather than one, because a pass moves at most `BatchLimit`
   * rows per collection and a phone that has been in a dead zone since morning
   * can be holding far more than that. The loop stops early the moment a pass
   * stops making progress, which is what an offline phone looks like.
   *
   * The counts are per *run*, not per business day. A truck that goes out twice
   * would otherwise report each run's receipts in the other run's manifest too,
   * and the manifest's whole job is to be a number the dashboard can compare
   * against the documents that arrived in that one run.
   *
   * `endRun` last, and only once Firestore has the closing write: it clears the
   * truck, and doing that before the close landed would empty the screen while
   * the server still believed the day was open.
   */
  async function countOrThrow(): Promise<SyncPending> {
    const left = await refreshPending();
    // A count that didn't happen is not a count of zero. Closing on the back of
    // one would mark the day finished over the top of work still on the phone.
    if (!left) throw new Error('Could not check what is still waiting to upload on this phone.');
    return left;
  }

  async function endTheDay(): Promise<EndDayOutcome> {
    const ctx = contextRef.current;

    // Two different "no". No run is open, so there is nothing to end and
    // nothing went wrong — the card simply does nothing, which is right.
    if (!inputsRef.current.runId) return { closed: false };

    // A run *is* open and its details couldn't be assembled. Everything below
    // needs the stamp, so this stops the whole sequence — before the draft
    // check, before the upload passes spend a timeout each, and before
    // anything is counted. Thrown rather than returned so it reaches the retry
    // prompt: the two used to share `{ closed: false }`, and the driver got a
    // spinner that ended in silence over a day that was still open.
    if (!ctx) throw new MissingRunDetailsError(inputsRef.current.runId);

    // Before anything else, and before the upload passes spend a timeout each:
    // a draft is invisible to the pending count (drafts never upload), so
    // without this it would pass the connection check untouched and then
    // outlive the run.
    const draft = await receiptDb.findDraftReceipt();
    if (draft) throw new OpenDraftError(draft.customerName);

    // The owner's rule: a day isn't finished until the money side of it is
    // written down — at least one expense (₱0 is allowed for a day with none)
    // and a saved cash breakdown. Checked before the upload passes for the same
    // reason the draft is: there's no point spending timeouts on a day that
    // can't close anyway.
    const missing = await findMissingCloseout(ctx.runId);
    if (missing) throw new MissingCloseoutError(missing);

    let left = await countOrThrow();
    // From here to the end of the loop, an App Check stall is on the clock —
    // see closingRun. Restored in the `finally` so a close that fails, or one
    // that throws on the way out, doesn't leave the rest of the day running
    // under closing rules.
    closingRun = true;
    try {
      for (let pass = 0; left.total > 0 && pass < MaxEndDayPasses; pass += 1) {
        const before = left.total;
        await drain();
        left = await countOrThrow();
        // No movement means the network is down (or one row is permanently
        // stuck). Either way another pass costs a timeout and changes nothing.
        //
        // The exception is a row stalled on App Check: those passes are *meant*
        // to make no progress — each one spends one of the row's attempts (see
        // quarantineIfHopeless) until the excuse runs out and the row is set
        // aside, after which the queue moves again. Breaking here would end the
        // sequence after the first one and hand back "find a stronger signal",
        // and the driver would have to tap "Try again" five times to close a
        // day over a single stuck row. It costs nothing to let them run: a
        // refusal comes back instantly, and the probe behind it answers from
        // the last failure rather than attesting afresh — MaxEndDayPasses still
        // bounds it.
        const stalledOnAppCheck = lastFailureRef.current instanceof sync.AppCheckUnverifiedError;
        if (left.total >= before && !stalledOnAppCheck) break;
      }
    } finally {
      closingRun = false;
    }

    if (left.total > 0) throw new PendingUploadsError(left, lastFailureRef.current);

    const closedAt = Date.now();
    const [
      receiptTotals,
      stockEntryCount,
      expenseTotals,
      paymentProofCount,
      customerCount,
      blockedReceipts,
      blockedStock,
      blockedExpenses,
      blockedCashCounts,
      blockedProofs,
      blockedCustomers,
    ] = await Promise.all([
        receiptDb.summarizeFinalizedForRun(ctx.runId),
        stockDb.countBatchesForRun(ctx.runId),
        // Per run like the two above it: expenses belong to one trip out, and
        // "End the Day" is what hands the next one a clean sheet.
        expenseDb.summarizeExpensesForRun(ctx.runId),
        // Photos are counted per run through the receipt they hang off, so the
        // dashboard can tell "the photo never arrived" from "no photo was taken".
        receiptDb.countPaymentProofsForRun(ctx.runId),
        // Customers aren't run data — a store belongs to the business, not to a
        // day — so this is simply what this phone touched while the run was open.
        customerDb.countCustomersTouchedBetween(ctx.startedAt, closedAt),
        // What the server refused. Reported so a shortfall between the manifest
        // and the documents that arrived can be read as "this phone knows" and
        // not as a mystery. See RunManifest.blockedUploadCount.
        receiptDb.countBlockedReceiptsForRun(ctx.runId),
        stockDb.countBlockedBatchesForRun(ctx.runId),
        expenseDb.countBlockedExpensesForRun(ctx.runId),
        expenseDb.countBlockedCashCountsForRun(ctx.runId),
        receiptDb.countBlockedPaymentProofsForRun(ctx.runId),
        customerDb.countBlockedCustomers(),
      ]);

    const manifest: RunManifest = {
      receiptCount: receiptTotals.receiptCount,
      voidedReceiptCount: receiptTotals.voidedCount,
      stockEntryCount,
      customerCount,
      salesTotal: receiptTotals.salesTotal,
      returnsTotal: receiptTotals.returnsTotal,
      // Reported beside the takings, never taken off them — see
      // summarizeExpensesForRun for why these two count different sets.
      expenseCount: expenseTotals.expenseCount,
      expenseTotal: expenseTotals.expenseTotal,
      paymentProofCount,
      // Always 0 now — the close above is unreachable with anything queued. The
      // field stays because it is what tells the dashboard that: a manifest
      // without it can't distinguish "nothing was outstanding" from "this run
      // predates the rule".
      pendingUploadCount: 0,
      // Not 0, and allowed not to be: a refused record doesn't hold the day
      // open (nothing would ever send it), so this is the number that explains
      // a run whose documents don't add up to its own counts.
      blockedUploadCount:
        blockedReceipts + blockedStock + blockedExpenses + blockedCashCounts + blockedProofs + blockedCustomers,
    };

    // The header before the closing write, if it never made it up — a run whose
    // only document was the close would have a manifest and a status but no
    // truck or agents. Not swallowed like the drain's attempt: this is
    // the last chance to send it, so a failure has to reach the retry prompt.
    if (!inputsRef.current.headerSynced) {
      // The longer closing budget, like the manifest write below it: this is
      // the same standing-still moment, and a header that times out here stops
      // the day from closing just as surely as the manifest would.
      await sync.withAppCheckWording(() => sync.uploadRunHeader(ctx, sync.CloseTimeoutMs));
      inputsRef.current.markRunHeaderSynced();
    }

    // The last two writes of the day, and the only ones the driver waits on
    // with nothing else left to do. Both are wrapped so that if App Check is
    // what turned them away, the prompt says "this phone couldn't verify itself
    // with Google Play" rather than "Missing or insufficient permissions" —
    // which would send someone to the server over a signal problem, at the one
    // moment they can still walk outside and fix it.
    await sync.withAppCheckWording(() => sync.closeRun(ctx, manifest, closedAt));
    // Awaited: if the run can't be recorded as closed on this phone, the day is
    // not ended here, and the retry prompt says so. Re-running is safe — every
    // closing write is a setDoc at a known id, so a second attempt agrees with
    // the first rather than duplicating it.
    await inventory.endRun(closedAt);

    // Local-only convenience snapshot for the "Run history" card — see
    // lib/run-history.ts. Deliberately after the run is confirmed closed, and
    // deliberately swallowed on failure: everything it reads has already
    // uploaded on its own, so a failure here costs this one local record, not
    // the day itself. Not part of `runWithRetry`'s retry — retrying the whole
    // of endTheDay after this point would re-run the (already-succeeded)
    // upload/close steps for nothing.
    try {
      await recordRunHistory(ctx, closedAt, new Map(breadTypes.map((breadType) => [breadType.id, breadType.name])));
    } catch (error) {
      logError('sync.endTheDay.runHistory', error, runDetails(ctx));
    }

    // The manifest goes back to the caller so the "day ended" confirmation can
    // show what was actually sent. Ending the day clears the truck and takes
    // the driver to the setup wizard, which on its own looks the same whether
    // it worked or the app simply lost its state — the numbers are what make it
    // a receipt for the day rather than a screen that changed.
    return { closed: true, manifest };
  }

  const value: SyncContextValue = {
    pending,
    blocked,
    synced,
    syncing,
    lastSyncedAt,
    syncNow,
    retryBlocked,
    endTheDay,
  };

  return <SyncContext value={value}>{children}</SyncContext>;
}

/**
 * The run, written for a log line.
 *
 * Every failure on this page happens *to a run*, and the scope tag alone never
 * says which — `[sync.receipt.blocked] FirebaseError: permission-denied` is
 * true, unhelpful, and identical for every receipt of every trip. A driver
 * phones the server about "the truck this morning", so the answer has to be
 * findable from the log by the same handles the server uses: the day, the
 * truck, who was on it and the trip number, plus the run id to look it up with.
 *
 * Names are preferred over ids where the run captured both — a log read by a
 * person should say "Truck 3", not a document id — with the id as the fallback
 * for a run that opened before its catalogs had loaded.
 */
function runDetails(run: RunContext | null): Record<string, unknown> {
  if (!run) return { run: 'none open' };

  return {
    runId: run.runId,
    businessDay: run.businessDay,
    trip: run.sequence,
    truck: run.truckName || run.truckId,
    agents: run.agents.map((agent) => agent.name).join(', ') || run.agentIds.join(', '),
    account: run.createdByEmail || run.createdByUid,
  };
}

// ---------------------------------------------------------------------------
// The per-collection passes
// ---------------------------------------------------------------------------

/**
 * Each row is stamped with the run it was *written* in, looked up in the run
 * log — never with whatever run happens to be open now. That distinction is the
 * whole reason a truck can go out twice in a day: a receipt from the morning
 * that hadn't found signal yet must not be filed under the afternoon's run.
 *
 * A row whose run is no longer in the log (offline for longer than the log
 * keeps runs) can't be filed anywhere. It is marked `'legacy'` — the same word
 * the migrations use for "belongs to no run, will never upload" — so it stops
 * being counted as pending forever, and logged once on the way out rather than
 * disappearing quietly.
 *
 * An upload failure is **thrown, not swallowed**, so the pass stops at the
 * first one. A failure here is nearly always "no signal", which fails
 * identically for every remaining row *and* for the other collections — and
 * since each attempt now costs a timeout rather than an instant rejection,
 * working through the rest would spend a minute proving what the first row
 * already established. `drain` logs it and the next pass tries again.
 */
/**
 * True only while "End the Day" is driving the passes.
 *
 * The one thing it changes is how long an App Check stall may be excused, and
 * the difference is the whole point of it: during the day there is no deadline,
 * so a row the phone couldn't attest for is simply left queued and retried on
 * the next pass, forever, with nobody asked to do anything. At close there *is*
 * a deadline — the day cannot end while anything is queued — so the excuse is
 * bounded and the row is eventually set aside.
 *
 * A module-level flag rather than a parameter because it would otherwise have
 * to be threaded through every drain and `uploadOrSetAside` call to reach the
 * one function that reads it, and there is exactly one `SyncProvider`.
 */
let closingRun = false;

/**
 * Whether anything was set aside *because* this phone couldn't attest, rather
 * than because the server refused it.
 *
 * Those two look identical in the database — both are `'blocked'` — but they
 * are owed opposite things. A refusal is a real answer and waits for someone to
 * act on it; an attestation failure is a phone problem that fixes itself, and
 * the row underneath it was always fine. So this remembers that the queue holds
 * at least one of the second kind, and the next pass that finds App Check
 * working again puts them back (see `runPass`) — no Settings tap, no driver
 * having to know what App Check is.
 */
let appCheckQuarantined = false;

/**
 * Puts every set-aside row back in the queue with a clear attempt count.
 *
 * Shared by the Settings button and the automatic recovery above so the two
 * can't drift. Safe either way: a row the server still refuses is set aside
 * again on its next attempt, and one it already has is re-sent as the identical
 * `setDoc`.
 */
async function requeueBlocked(): Promise<number> {
  const [receipts, stockEntries, expenses, cashCounts, paymentProofs, customers] = await Promise.all([
    receiptDb.retryBlockedReceipts(),
    stockDb.retryBlockedBatches(),
    expenseDb.retryBlockedExpenses(),
    expenseDb.retryBlockedCashCounts(),
    receiptDb.retryBlockedPaymentProofs(),
    customerDb.retryBlockedCustomers(),
  ]);
  return receipts + stockEntries + expenses + cashCounts + paymentProofs + customers;
}

/**
 * Decides what one row's failed upload means for the rest of the queue.
 *
 * Resolves true if the row was set aside and the drain should carry on to the
 * next one; false if the failure was transient, in which case the caller
 * rethrows and the pass stops — everything behind it would fail the same way.
 * Throws `AppCheckUnverifiedError` for a refusal traced to App Check rather
 * than the rules: like the transient case the pass stops and nothing is set
 * aside, but the driver is told to find signal, not to call the server.
 *
 * This is what keeps one un-sendable row from stopping every row behind it
 * forever. See classifyUploadFailure in lib/sync.ts for why that could happen
 * and how the three kinds of failure are told apart.
 */
async function quarantineIfHopeless(
  scope: string,
  id: string,
  error: unknown,
  bumpAttempts: (id: string) => Promise<number>,
  markBlocked: (id: string) => Promise<void>,
  details: Record<string, unknown>
): Promise<boolean> {
  const kind = sync.classifyUploadFailure(error);
  if (kind === 'transient') return false;

  // A refusal is classed 'permanent', but once App Check enforcement is on it
  // might instead be App Check turning away a request whose attestation token
  // couldn't be minted — a good row that just needs the phone to reach Google
  // Play. Settle it before doing anything irreversible: if a fresh token can't
  // be had right now, stop the pass with a "find signal" error and leave the
  // row queued, rather than filing it with the records the server refused —
  // which is the one thing it isn't. `isRecoverableAppCheckDenial` gates itself
  // on the error code, so nothing else pays for a probe.
  const appCheckDenied = await sync.isRecoverableAppCheckDenial(error);

  // ...but how long that excuse lasts depends on whether anyone is waiting.
  //
  // **During the day it never runs out.** The row is good, the phone will
  // attest again, and nothing is blocked by it sitting in the queue — so it is
  // left there and retried on the next pass, indefinitely, with nobody asked to
  // press anything. Setting it aside here would be a lie about a healthy row
  // and would need a Settings tap to undo.
  //
  // **At close it is bounded**, because there the row does block something: the
  // day cannot end while anything is queued. While attestation is down the two
  // cases behind one code are indistinguishable — a good row App Check turned
  // away, and a row the rules will refuse forever on a phone that also can't
  // reach Play — so an unbounded excuse would mean a queue that never empties
  // and a day that can never be closed. The excuse is spent from the same
  // attempt count an unrecognised failure spends, and when it runs out the row
  // is set aside like any other. That is recoverable — the flag below puts it
  // back on its own once the phone can attest, the Settings tap is still there,
  // and the manifest says how many. A day that cannot be closed is not.
  if (appCheckDenied) {
    const attempts = closingRun ? await bumpAttempts(id) : 0;
    if (!closingRun || attempts < MaxUploadAttempts) {
      // Logged here rather than left to the pass's own catch: that one sees
      // only this app's wording of the failure, so without this line nothing
      // records which row stalled, under which run, or what the server actually
      // said. The pass stops at the first one, so it is a line per pass.
      logError(`${scope}.appcheck`, error, { id, attempts, closing: closingRun, ...details });
      throw new sync.AppCheckUnverifiedError(error);
    }
    // Out of grace, and about to be set aside over a phone problem rather than
    // a refusal — so remember to bring it back rather than leaving it to be
    // noticed.
    appCheckQuarantined = true;
  } else if (kind === 'unclear') {
    // Unrecognised: forgive it a few times before giving up, since the one
    // thing worse than retrying forever is setting aside a row over a passing
    // oddity.
    const attempts = await bumpAttempts(id);
    if (attempts < MaxUploadAttempts) return false;
  }

  // The one log line that matters most in this file: a quarantined row is a
  // record the server will never receive unless somebody goes and looks at it,
  // so it has to name the row *and* the run it belongs to.
  logError(`${scope}.blocked`, error, { id, appCheckDenied, ...details });
  await markBlocked(id);
  return true;
}

/**
 * Sends one row. Resolves true when Firestore has taken it, false when the row
 * was set aside and the drain should move on to the next one. Throws when the
 * failure was transient, which stops the pass — everything behind it would fail
 * the same way.
 *
 * **Only the upload itself is inside the catch, and that is the point.** The
 * `sync_state` write that records the success is deliberately left outside, in
 * the callers. Folding the two together — which is how this started — means a
 * *local* failure to mark a row synced is classified as an upload failure:
 * SQLite errors carry no Firestore code, so they land in `'unclear'`, count
 * against the row, and after five of them quarantine a record the server has
 * had all along. The queue would then report "couldn't be sent" about work that
 * was sent, which is the one thing these counts exist to be trusted about.
 *
 * Left outside, a failed mark propagates to the pass's own catch instead: it is
 * logged, the pass stops, and the row stays `'pending'` and is simply uploaded
 * again next time. Re-sending is free — every upload is a `setDoc` at an id the
 * phone chose, so the second attempt produces the identical document.
 */
async function uploadOrSetAside(
  scope: string,
  id: string,
  upload: () => Promise<void>,
  bumpAttempts: (id: string) => Promise<number>,
  markBlocked: (id: string) => Promise<void>,
  details: Record<string, unknown>
): Promise<boolean> {
  try {
    await upload();
    return true;
  } catch (error) {
    const setAside = await quarantineIfHopeless(scope, id, error, bumpAttempts, markBlocked, details);
    if (!setAside) throw error;
    return false;
  }
}

/**
 * Whether a row with no matching run may be written off as `'legacy'`.
 *
 * Only when the run log was actually read. `runsById` is empty in two very
 * different situations — this phone genuinely knows of no such run, or the log
 * failed to load this launch — and they look identical from in here. Marking a
 * row `'legacy'` is irreversible and means "will never upload", so concluding
 * it from a read that didn't happen would let one failed AsyncStorage read
 * destroy a whole day's takings on a phone that was otherwise fine.
 *
 * With an unreadable log the row is simply left `'pending'` and skipped. The
 * pass does nothing that time round and tries again next launch, which is the
 * honest outcome: nothing is lost, and nothing is decided on missing evidence.
 * The one cost is that a genuinely orphaned row keeps being re-examined until
 * the log loads once, which is free — no upload is attempted.
 */
function mayWriteOff(runLogLoaded: boolean, scope: string, id: string, runId: string | null): boolean {
  if (runLogLoaded) return true;
  logError(`${scope}.deferred`, new Error('Run log unavailable; leaving the row queued'), { id, runId });
  return false;
}

async function drainStock(runsById: Map<string, RunRecord>, runLogLoaded: boolean): Promise<void> {
  const batches = await stockDb.loadPendingBatches(BatchLimit);
  for (const batch of batches) {
    const stamp = batch.runId ? runsById.get(batch.runId) : undefined;
    if (!stamp) {
      if (!mayWriteOff(runLogLoaded, 'sync.stockEntry', batch.id, batch.runId)) continue;
      // The run id the row *names* is the whole point of this line: it says
      // which run aged out of the log, which is what makes a lost row traceable
      // rather than a mystery entry with no home.
      logError('sync.stockEntry.run', new Error(`Ledger entry ${batch.id} belongs to no known run`), {
        id: batch.id,
        runId: batch.runId,
      });
      await stockDb.markBatchLegacy(batch.id);
      continue;
    }
    const uploaded = await uploadOrSetAside(
      'sync.stockEntry',
      batch.id,
      () => sync.uploadStockEntry(stamp, batch, batch.receiptId),
      stockDb.bumpBatchAttempts,
      stockDb.markBatchBlocked,
      runDetails(stamp)
    );
    if (uploaded) await stockDb.markBatchSynced(batch.id);
  }
}

async function drainReceipts(runsById: Map<string, RunRecord>, runLogLoaded: boolean): Promise<void> {
  const receipts = await receiptDb.loadPendingReceipts(BatchLimit);
  for (const receipt of receipts) {
    const stamp = receipt.runId ? runsById.get(receipt.runId) : undefined;
    if (!stamp) {
      if (!mayWriteOff(runLogLoaded, 'sync.receipt', receipt.id, receipt.runId)) continue;
      logError('sync.receipt.run', new Error(`Receipt ${receipt.id} belongs to no known run`), {
        id: receipt.id,
        runId: receipt.runId,
      });
      await receiptDb.markReceiptLegacy(receipt.id);
      continue;
    }
    const uploaded = await uploadOrSetAside(
      'sync.receipt',
      receipt.id,
      () => sync.uploadReceipt(stamp, receipt),
      receiptDb.bumpReceiptAttempts,
      receiptDb.markReceiptBlocked,
      runDetails(stamp)
    );
    // The void state that was actually sent — see the guard in markReceiptSynced.
    if (uploaded) await receiptDb.markReceiptSynced(receipt.id, receipt.voidedAt);
  }
}

/**
 * Proof-of-payment photos, on their way to Cloud Storage.
 *
 * The only drain that uploads a file rather than a document, but it rides the
 * identical machinery — `uploadOrSetAside` classifies the failure, transient
 * ones stop the pass, permanent ones quarantine the row, and Settings' "Try
 * sending refused records again" is the way back.
 *
 * The one thing it does that the others don't: **a successful upload re-queues
 * the receipt.** `markPaymentProofSynced` flips a `'synced'` receipt back to
 * `'pending'` so it re-uploads carrying `proofStoragePath`, which is the only
 * way that field ever reaches Firestore — the receipt document was almost
 * certainly sent long before the driver took the photo. `requestSync()`
 * afterwards makes the pass take another lap, so the path lands in the same
 * pass rather than waiting up to a minute for the heartbeat.
 */
async function drainPaymentProofs(
  runsById: Map<string, RunRecord>,
  runLogLoaded: boolean,
  uid: string
): Promise<void> {
  const proofs = await receiptDb.loadPendingPaymentProofs(BatchLimit);
  let requeued = false;

  for (const proof of proofs) {
    const stamp = proof.runId ? runsById.get(proof.runId) : undefined;
    if (!stamp) {
      if (!mayWriteOff(runLogLoaded, 'sync.paymentProof', proof.receiptId, proof.runId)) continue;
      logError('sync.paymentProof.run', new Error(`Payment photo ${proof.receiptId} belongs to no known run`), {
        id: proof.receiptId,
        runId: proof.runId,
      });
      await receiptDb.markPaymentProofLegacy(proof.receiptId);
      continue;
    }

    // The resolved path comes back from the upload rather than being rebuilt
    // here, so the only thing that can ever be written to the receipt is a path
    // whose bytes actually landed.
    let path: string | null = null;
    const uploaded = await uploadOrSetAside(
      'sync.paymentProof',
      proof.receiptId,
      async () => {
        path = await sync.uploadPaymentProof(stamp, proof, uid);
      },
      receiptDb.bumpPaymentProofAttempts,
      receiptDb.markPaymentProofBlocked,
      runDetails(stamp)
    );

    if (uploaded && path) {
      await receiptDb.markPaymentProofSynced(proof.receiptId, path);
      requeued = true;
    }
  }

  if (requeued) sync.requestSync();
}

/**
 * This run's expenses, on their way up.
 *
 * Drains *after* the ledger and the receipts on purpose. All three stop the pass
 * at the first transient failure, so the order is the order they reach the
 * server on a bad signal — and an expense is the least urgent of the three: the
 * takings and the stock are what the server needs to act on, an expense is a
 * note about the trip.
 *
 * Marked synced on `updatedAt`, unlike the ledger and receipts, because an
 * expense can be *deleted* while its previous version is still in the air — see
 * markExpenseSynced in lib/expense-db.ts.
 */
async function drainExpenses(runsById: Map<string, RunRecord>, runLogLoaded: boolean): Promise<void> {
  const expenses = await expenseDb.loadPendingExpenses(BatchLimit);
  for (const expense of expenses) {
    const stamp = runsById.get(expense.runId);
    if (!stamp) {
      if (!mayWriteOff(runLogLoaded, 'sync.expense', expense.id, expense.runId)) continue;
      logError('sync.expense.run', new Error(`Expense ${expense.id} belongs to no known run`), {
        id: expense.id,
        runId: expense.runId,
      });
      await expenseDb.markExpenseLegacy(expense.id);
      continue;
    }
    const uploaded = await uploadOrSetAside(
      'sync.expense',
      expense.id,
      () => sync.uploadExpense(stamp, expense),
      expenseDb.bumpExpenseAttempts,
      expenseDb.markExpenseBlocked,
      runDetails(stamp)
    );
    if (uploaded) await expenseDb.markExpenseSynced(expense.id, expense.updatedAt);
  }
}

/**
 * Cash breakdowns, on their way up — one per run, re-sent whenever re-saved.
 *
 * After expenses: the breakdown is checked against the takings and the
 * expenses, so it is the least use to the dashboard until those have arrived.
 * Marked synced on `updatedAt`, because a driver can recount while the previous
 * count is still in the air — see markCashCountSynced in lib/expense-db.ts.
 */
async function drainCashCounts(runsById: Map<string, RunRecord>, runLogLoaded: boolean): Promise<void> {
  const counts = await expenseDb.loadPendingCashCounts(BatchLimit);
  for (const count of counts) {
    const stamp = runsById.get(count.runId);
    if (!stamp) {
      if (!mayWriteOff(runLogLoaded, 'sync.cashCount', count.runId, count.runId)) continue;
      logError('sync.cashCount.run', new Error(`Cash breakdown for ${count.runId} belongs to no known run`), {
        runId: count.runId,
      });
      await expenseDb.markCashCountLegacy(count.runId);
      continue;
    }
    const uploaded = await uploadOrSetAside(
      'sync.cashCount',
      count.runId,
      () => sync.uploadCashCount(stamp, count),
      expenseDb.bumpCashCountAttempts,
      expenseDb.markCashCountBlocked,
      runDetails(stamp)
    );
    if (uploaded) await expenseDb.markCashCountSynced(count.runId, count.updatedAt);
  }
}

/**
 * Stores this phone created or changed, on their way up.
 *
 * **Push only — the pass never pulls.** Customers move in both directions, but
 * only the outgoing half is live. Coming down, the store list is refreshed at
 * exactly one moment: when truck setup is finished (see
 * `refreshCustomers` in context/customers.tsx). The route a truck is working is
 * therefore the list it left the depot with, and it does not change under the
 * driver mid-round.
 *
 * Don't add a pull here. It would look like an improvement — stores would
 * propagate within the minute — and it would quietly undo that: a store edited
 * or deleted at the server at noon would rewrite the list a driver is halfway
 * through working from.
 */
async function drainCustomers(uid: string): Promise<void> {
  const outgoing = await customerDb.loadPendingCustomers(BatchLimit);
  for (const customer of outgoing) {
    // Customers drain first, so a store the server refuses used to abort the
    // pass before the ledger and receipts were reached at all — one bad store
    // could stop a whole day's takings from uploading.
    const uploaded = await uploadOrSetAside(
      'sync.customer',
      customer.id,
      () => sync.uploadCustomer(uid, customer),
      customerDb.bumpCustomerAttempts,
      // Both marks carry the version that was actually uploaded, and both are
      // guarded on it — see markCustomerSynced / markCustomerBlocked. A store
      // can be edited while its previous version is still in the air, and
      // either mark landing on the newer row is wrong in its own way: 'synced'
      // would send the server the old version and never correct it, 'blocked'
      // would set aside a version the server has never even seen.
      (id) => customerDb.markCustomerBlocked(id, customer.updatedAt),
      // No run details here, and that isn't an omission: a store belongs to the
      // business rather than to a trip, so there is no honest run to name. What
      // identifies it instead is the name a driver would use on the phone, and
      // the version — a store can be edited while an older one is still in the
      // air, so which one was refused is the question worth answering.
      { store: customer.name, deleted: customer.deleted, updatedAt: customer.updatedAt }
    );
    if (uploaded) await customerDb.markCustomerSynced(customer.id, customer.updatedAt);
  }
}
