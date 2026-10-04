import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';

import { useAuth } from '@/context/auth';
import { useCachedCatalog } from '@/hooks/use-cached-catalog';
import { businessDayKey } from '@/lib/business-day';
import { logError } from '@/lib/errors';
import { db } from '@/lib/firebase';
import { findFreeRunSequence } from '@/lib/sync';
import { agentsRunIdSegment, composeLegacyTruckRunId, composeRunId, type RunContext } from '@/lib/sync-types';

// Trucks and Agents are both **dashboard-owned** reference data: the
// manager maintains them on the web dashboard, mobile only ever reads them
// (see firestore.rules). They used to be different things — areas came
// from Firestore with a bespoke fetch, while trucks and employees were typed
// into each phone and kept in AsyncStorage.
//
// That local list wasn't just untidy, it made uploads meaningless: two phones
// typing "Truck 3" minted two unrelated local ids, so no cloud record could
// ever be grouped by truck. Now both run on the same shared catalog hook
// as bread types, and their ids are the dashboard's ids — stable across every
// device.
//
// Agents are a flat list, and the driver ticks each one who is on the truck.
// (They used to be organised into crews and assigned as a whole; crews were
// removed on the owner's call and the `agentGroups` collection is no longer
// read.)
const SETUP_KEY = 'inventory.setup.v1';
const RUN_LOG_KEY = 'inventory.runlog.v1';
const TRUCKS_CACHE_KEY = 'inventory.trucks.cache.v1';
// v3: back to a flat agent list after crews were removed (v2 held crews with
// their members). A new key rather than a migration — the old copy is one
// picker's worth of names that the next open re-downloads.
const AGENTS_CACHE_KEY = 'inventory.agents.cache.v3';

/** A named record from a dashboard-owned collection. */
export type NamedRecord = { id: string; name: string };

export type Truck = NamedRecord;
export type Agent = NamedRecord;

/**
 * What this phone is doing right now: which truck it is and which agents are
 * aboard — plus the bookkeeping for the **run** those
 * identify (see docs/sync-design.md).
 *
 * The run's id is `composeRunId(agentNames, runAccount, runStartedAt,
 * runSequence)` — **composed once when setup is finished and then pinned** in
 * `runId`. Pinned rather than recomputed on every read so the id can never
 * shift under a run that is already writing rows stamped with it; that matters
 * twice over because the middle segment is made of agents' *names*, so renaming
 * one on the dashboard would otherwise re-point an open run at a document that
 * doesn't exist. `runSequence` is also settled partly by asking Firestore (see
 * finalizeSetup), and an answer there is no reason to re-ask for.
 *
 * Nothing here is read fresh. `runStartedAt` keeps a run that crosses Manila
 * midnight as one run rather than silently splitting it in two, `runAccount`
 * keeps it pointed at one document even if someone logs out and back in as
 * somebody else, and `agentIds` are the people whose trip this is.
 */
export type InventorySetup = {
  truckId: string | null;
  /**
   * The agents aboard, each ticked by the driver from the dashboard's list.
   * Their names are resolved once, at finalizeSetup, and pinned into the run.
   */
  agentIds: string[];
  complete: boolean;
  /** When setup was finished. The run's business day is taken from this. */
  runStartedAt: number | null;
  /**
   * Which run of the day this is for these agents: 1 for the first, 2 for the
   * same people going back out, and so on. Only a value above 1 shows up in the
   * run id.
   *
   * Counted per agents segment rather than per truck, to match what the id is
   * keyed on — the same people coming back and taking a different truck out are
   * on their second trip, and numbering it 1 again would compute the morning's
   * id and merge the two trips into one document.
   */
  runSequence: number;
  /**
   * The login the run was opened under — part of the run id, so two phones that
   * pick the same truck on the same day get a run each instead of writing over
   * one another's header and manifest.
   *
   * Pinned here rather than read from `useAuth()` wherever the id is needed:
   * logging out does not end a run (it clears the Firebase session and nothing
   * else), so an agent swap on one handset must not silently re-point an open
   * run at a different document — every row already written is stamped with the
   * old id. Empty on a run opened before this field existed, which is what lets
   * such a run still recompute the id it was created under.
   */
  runAccount: string;
  /**
   * The run's document id, composed at `finalizeSetup` and never recomputed.
   *
   * Null on a setup saved before this field existed — such a run is still open
   * under a truck-keyed id, so it is resolved with `composeLegacyTruckRunId`
   * instead. Also null whenever no run is open, which `complete` already says.
   */
  runId: string | null;
  /** Whether the run header document has made it to Firestore yet. */
  runHeaderSynced: boolean;
};

const EMPTY_SETUP: InventorySetup = {
  truckId: null,
  agentIds: [],
  complete: false,
  runStartedAt: null,
  runSequence: 1,
  runAccount: '',
  runId: null,
  runHeaderSynced: false,
};

/**
 * How many finished runs are remembered. Two jobs, both of which need the
 * *past* runs and not just the current one:
 *
 * 1. **Numbering.** A second run by the same account and agents on the same day
 *    has to know it is the second, or it computes the first run's id and merges
 *    into it.
 * 2. **Stamping late uploads.** A queued row must upload into the run it was
 *    *written* in, so a run has to stay describable after the phone has moved
 *    on from it — see drainStock in context/sync.tsx. "End the Day" no longer
 *    leaves rows behind (it refuses to close until the queue is empty), but a
 *    *refused* row does outlive its run — that is the one count allowed to be
 *    non-zero in the manifest — and Settings' "Try sending refused records
 *    again" re-queues it long after the run closed, still needing its stamp.
 *    So does a **proof-of-payment photo**: one can be added to a finalized
 *    receipt from *any* earlier run, and both the photo and the receipt it
 *    re-sends are filed under that receipt's own run — a run that has aged out
 *    of this log turns the photo `'legacy'`, never to upload.
 *
 * 200 because of that last case: a truck goes out once or twice a day, so this
 * is months of history, enough for a photo that turns up long after the sale.
 * It is capped only because the list is rewritten to disk whole — each entry is
 * well under a kilobyte, so 200 is a few hundred KB at most, read once at launch
 * and written only when a run opens or closes.
 */
const RunLogLimit = 200;

/** A run in the log: its full identity, plus when "End the Day" closed it. */
export type RunRecord = RunContext & { closedAt: number | null };

/**
 * A write that needs an open run when there isn't one.
 *
 * Reachable in one place that isn't a bug: "End the Day" clears the setup, and
 * the Receipts tab stays open behind it, so a leftover draft can still be
 * finalized after the truck has been handed back. Its own class because
 * retrying is guaranteed to fail identically — the user has to finish the setup
 * first — so callers pass it to `runWithRetry`'s `retryable` and it is reported
 * once with an OK instead of an endless "Try again".
 */
export class NoOpenRunError extends Error {
  constructor() {
    super('No day is set up on this phone yet. Set the truck up first, then try again.');
    this.name = 'NoOpenRunError';
  }
}

type InventoryContextValue = {
  // Each of the two lists comes with the two things its picker needs: a
  // `loading` flag that is only true while there is *nothing* to show, and an
  // error that is only set when the fetch failed with no saved copy to fall
  // back on. `ensure*Loaded` is what the picker calls when it opens.
  trucks: Truck[];
  trucksLoading: boolean;
  trucksError: string | null;
  ensureTrucksLoaded: () => void;

  agents: Agent[];
  agentsLoading: boolean;
  agentsError: string | null;
  ensureAgentsLoaded: () => void;

  setup: InventorySetup;
  /** True until the persisted setup has been read from disk on app start. */
  setupLoading: boolean;
  updateSetup: (partial: Partial<InventorySetup>) => void;
  /**
   * Marks setup complete and opens the run — this is the moment a run begins.
   *
   * Resolves false if it couldn't (no truck, no agents, or no signed-in user).
   * A caller must not ignore that: this screen is a full-screen progress view,
   * and a silent no-op leaves it spinning with no way forward.
   *
   * **Rejects if the run couldn't be saved to disk.** The run only counts as
   * open once it is durable, so this is a real failure the caller has to
   * handle — see the implementation for what an in-memory-only run would cost.
   */
  finalizeSetup: () => Promise<boolean>;
  /**
   * Clears the selection and the run bookkeeping so the setup wizard runs
   * again. Rejects if it couldn't be saved — nothing is cleared in that case.
   */
  resetSetup: () => Promise<void>;

  /** The run this phone is on, or null before setup is finished. */
  runId: string | null;
  /** The full identity of that run — what every upload from it is stamped with. */
  currentRun: RunRecord | null;
  /**
   * Recent runs, newest first, including the one that is open. Uploads look
   * runs up here rather than reading the current setup, so work left over from
   * a finished run still lands in that run and not in the one that followed it.
   */
  recentRuns: RunRecord[];
  /**
   * Whether the run log could be read this launch. False means `recentRuns` is
   * empty because the read failed, not because there are no runs — the drains
   * must not conclude a row belongs to no run from that. See the state of the
   * same name in the provider.
   */
  runLogLoaded: boolean;
  /** Recorded once the run header reaches Firestore, so it isn't re-sent every drain. */
  markRunHeaderSynced: () => void;
  /**
   * Ends the run: stamps it closed in the log and hands back an empty truck by
   * clearing the setup, so the next run starts at the wizard. Called by "End
   * the Day" once the closing manifest has actually reached Firestore.
   *
   * Rejects if that couldn't be saved to disk, leaving the run open and the
   * truck loaded rather than half-ended — see the implementation.
   */
  endRun: (closedAt: number) => Promise<void>;
};

const InventoryContext = createContext<InventoryContextValue | null>(null);

export function useInventory() {
  const value = use(InventoryContext);
  if (!value) {
    throw new Error('useInventory must be used inside an <InventoryProvider>');
  }
  return value;
}

/**
 * The manager's chosen display order, with the name as the tiebreak.
 *
 * `order` is set on the dashboard by dragging rows around, and it is the whole
 * point of that control — sorting by name here instead would quietly throw it
 * away, so "Truck 1, Truck 2, Truck 10" would come back as "Truck 1, Truck 10,
 * Truck 2". A document with no `order` yet falls to the end in name order
 * rather than jumping to the front.
 */
function sortByOrder<T extends { name: string; order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Strips the sort key back off once sorting is done — nothing downstream needs it. */
function withoutOrder<T extends { order: number }>(items: T[]): Omit<T, 'order'>[] {
  return items.map(({ order: _order, ...rest }) => rest);
}

type OrderedRecord = NamedRecord & { order: number };

function readOrdered(id: string, data: Record<string, unknown>): OrderedRecord {
  return {
    id,
    name: (data.name as string) ?? '',
    // Number.MAX_SAFE_INTEGER, not 0: a doc written before the dashboard
    // started stamping `order` has no opinion about where it goes, and
    // defaulting to 0 would put it in front of everything the manager
    // deliberately placed.
    order: typeof data.order === 'number' ? data.order : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Reads one dashboard-owned collection of `{ name, order }` documents.
 *
 * The query orders by name so every document comes back — ordering by `order`
 * would silently drop any document that doesn't carry the field, the same trap
 * bread-types.tsx documents. The manager's order is applied afterwards, here.
 */
function fetchNamed(collectionName: string) {
  return async () => {
    const snapshot = await getDocs(query(collection(db, collectionName), orderBy('name')));
    const datas = snapshot.docs.map((d) => d.data());
    return withoutOrder(sortByOrder(snapshot.docs.map((d, index) => readOrdered(d.id, datas[index]))));
  };
}

// Built once at module scope rather than per render. useCachedCatalog reads
// `fetch` through a ref so it doesn't require a stable identity, but there's no
// reason to rebuild these closures on every render either.
const fetchTrucks = fetchNamed('trucks');
const fetchAgents = fetchNamed('agents');

/** Fire-and-forget disk write. A failure costs the value on next launch, not now, so it's logged rather than surfaced. */
function persist(key: string, value: unknown, details?: Record<string, unknown>): void {
  AsyncStorage.setItem(key, JSON.stringify(value)).catch((error: unknown) =>
    logError(`inventory.persist.${key}`, error, details)
  );
}

/**
 * The open run's details, rebuilt from the setup when the run log can't supply
 * them.
 *
 * The run log and the setup are two separate AsyncStorage keys, and a run needs
 * only one of them to keep working — but until now it needed the log
 * specifically, and losing that entry was silent and expensive. `runId` comes
 * off the setup, so a phone whose log failed to load had `runId` set and
 * `currentRun` null, which is a state nothing handles: "End the Day" returns
 * `{ closed: false }` and does nothing, the header never uploads, and every
 * receipt and ledger entry stamped with that id is marked `'legacy'` — the
 * day's work made permanently un-uploadable by a failed *read*.
 *
 * The setup already pins everything that identifies the run: the id, when it
 * started, its number, and the ids that were picked. What it doesn't hold are
 * the display names, so those are resolved the same way `finalizeSetup`
 * resolved them — from the catalogs, falling back to empty. That is a real loss
 * and worth being clear about: an agent renamed since gives the *current* name
 * where the log held the one captured when the run opened. It is the lesser
 * wrong. Nothing the
 * server needs to file the day is missing — the ids, the day and the trip
 * number all come from the setup untouched — and the alternative is not a more
 * accurate run but no run at all.
 *
 * `createdByUid` is the signed-in account rather than anything stored, and that
 * is correct rather than convenient: `firestore.rules` refuses any write whose
 * `createdByUid` isn't the caller, so no other value could upload. Logging out
 * is blocked while a run is open, so it is also the account that opened it.
 */
function rebuildRunFromSetup(
  runId: string,
  setup: InventorySetup,
  startedAt: number,
  uid: string,
  email: string,
  trucks: Truck[],
  agents: Agent[]
): RunRecord {

  return {
    runId,
    closedAt: null,
    // From the pinned start time, never from "now" — the whole point of
    // pinning it is that a run keeps its own business day.
    businessDay: businessDayKey(startedAt),
    truckId: setup.truckId ?? '',
    truckName: trucks.find((truck) => truck.id === setup.truckId)?.name ?? '',
    agentIds: setup.agentIds,
    agents: setup.agentIds.map((id) => ({ id, name: agents.find((agent) => agent.id === id)?.name ?? '' })),
    createdByUid: uid,
    createdByEmail: email,
    startedAt,
    sequence: setup.runSequence,
  };
}

export function InventoryProvider({ children }: PropsWithChildren) {
  // Both are fetched **when their dropdown opens**, not on mount and not
  // as part of finishing setup — hence `fetchOnMount: false`. Each open tries
  // the server fresh and drops back to the saved copy without saying anything
  // if it can't, which is what `refresh()` already does.
  //
  // These are picked once, at one moment in the day, so tying the fetch to the
  // tap is both the freshest possible answer and the cheapest: no requests are
  // spent on lists nobody is looking at.
  // `isEmpty` on both for the same reason bread types carry it: a query
  // that comes back with zero documents is indistinguishable from a healthy
  // one, and letting an empty answer overwrite the saved copy — *and the disk* —
  // would strand a truck at the setup screen with no truck and no agents
  // to pick, every restart, until it found signal again. Keeping the saved copy
  // and reporting `'cache'` leaves the driver able to start the day.
  //
  // No `normalize`: the fetch already applies the manager's order, and the
  // cached copy is the sorted array as it was written.
  const trucks = useCachedCatalog<Truck[]>({
    cacheKey: TRUCKS_CACHE_KEY,
    initial: [],
    isEmpty: (items) => items.length === 0,
    errorMessage: 'Could not load trucks. Check your connection and try again.',
    fetch: fetchTrucks,
    fetchOnMount: false,
  });

  const agents = useCachedCatalog<Agent[]>({
    cacheKey: AGENTS_CACHE_KEY,
    initial: [],
    isEmpty: (items) => items.length === 0,
    errorMessage: 'Could not load agents. Check your connection and try again.',
    fetch: fetchAgents,
    fetchOnMount: false,
  });

  const { user } = useAuth();
  const [setup, setSetup] = useState<InventorySetup>(EMPTY_SETUP);
  const [recentRuns, setRecentRuns] = useState<RunRecord[]>([]);
  /**
   * Whether the run log was actually *read* this launch — not whether it holds
   * anything. A first launch reads an empty log successfully and is `true`.
   *
   * The distinction is the same one `refreshPending` makes by resolving `null`
   * instead of zero: a failed read is a missing answer, not the answer "no
   * runs". Marking a queued row `'legacy'` is irreversible, so the drains are
   * not allowed to conclude "this row belongs to no known run" from a log they
   * could not open — see context/sync.tsx.
   */
  const [runLogLoaded, setRunLogLoaded] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    /**
     * **Two reads, two catches, and neither can cost the other.**
     *
     * They used to share one `Promise.all` and one `try`, which quietly coupled
     * two independent stores: a run log that failed to parse threw before the
     * setup was applied, so an unreadable list of *past* runs also threw away
     * the record of the day that was open. The two answer different questions
     * and either is worth having without the other.
     */
    async function loadSetup(): Promise<void> {
      try {
        const raw = await AsyncStorage.getItem(SETUP_KEY);
        // Spread over EMPTY_SETUP so a setup saved by an older build — one
        // with no run fields, or a crew-era one with `agentGroupId` and no
        // `agentIds` — still loads with sane defaults instead of undefined
        // holes. A half-filled crew-era form simply asks for the agents again.
        if (!cancelled && raw) {
          const saved = JSON.parse(raw) as Partial<InventorySetup>;
          setSetup({ ...EMPTY_SETUP, ...saved, agentIds: Array.isArray(saved.agentIds) ? saved.agentIds : [] });
        }
      } catch (error) {
        // Costs the user one setup form they can fill in again. An uncaught
        // throw here used to leave the Inventory tab blank forever, because
        // setSetupLoading(false) never ran.
        logError('inventory.load.setup', error, { key: SETUP_KEY });
      }
    }

    async function loadRunLog(): Promise<void> {
      try {
        const raw = await AsyncStorage.getItem(RUN_LOG_KEY);
        if (cancelled) return;
        if (raw) setRecentRuns(JSON.parse(raw) as RunRecord[]);
        // Set only on the success path, empty log included — see runLogLoaded.
        setRunLogLoaded(true);
      } catch (error) {
        logError('inventory.load.runlog', error, { key: RUN_LOG_KEY });
      }
    }

    (async () => {
      // Still in parallel; each simply settles on its own. Neither rejects, so
      // this Promise.all can't either.
      await Promise.all([loadSetup(), loadRunLog()]);
      if (!cancelled) setSetupLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function persistSetup(next: InventorySetup) {
    setSetup(next);
    // Which run the lost write was about. This is how `runHeaderSynced` and the
    // rest of the run bookkeeping reach disk, so a failure here is a run that
    // comes back at the next launch believing something about itself that isn't
    // true — worth being able to name.
    persist(SETUP_KEY, next, { runId: next.runId, complete: next.complete });
  }

  function updateSetup(partial: Partial<InventorySetup>) {
    persistSetup({ ...setup, ...partial });
  }

  /**
   * Finishing setup is what opens the run.
   *
   * Stamping the start time here (rather than deriving it later from "now") is
   * what pins the run to one business day. The sequence is settled here too:
   * the run log gives a starting number — how many runs *this account* has
   * already opened with these agents on this day, so the first is 1 and carries
   * no suffix and the same people heading back out get 2 — and `findFreeRunSequence` then
   * asks Firestore whether that number is actually free, taking the next one if
   * it isn't.
   *
   * Both halves are needed and neither is enough alone. The log knows about a
   * morning spent out of signal, whose run header hasn't reached Firestore for
   * the server to know about at all. Firestore knows about the runs this
   * handset has no memory of — it was reinstalled, reset or replaced between
   * the two trips, or a second handset is signed in to the same login. Either
   * gap ends the same way: two trips computing one id, the second overwriting
   * the first's header and manifest while all the child documents survive, so
   * nothing looks wrong until the server reads it. See findFreeRunSequence in
   * lib/sync.ts for the rest, including why an existing id is treated as taken
   * even when it is this phone's own.
   *
   * The probe never blocks: with no signal it times out and hands back the
   * local count, which is what the phone used to run on outright.
   *
   * The whole run identity — including the truck and agent *names* — is
   * snapshotted into the run log now, while the dropdowns that produced them
   * are still loaded. Uploads read the run from there, so a receipt can still
   * be stamped correctly hours later with the catalogs long since replaced.
   */
  async function finalizeSetup(): Promise<boolean> {
    // Guarded, not idempotent-by-merge: "Use saved copy" in the catalog alert
    // and the normal finish path both land here, and opening a *second* run on
    // top of one that is already open is exactly what must not happen.
    if (setup.complete) return true;
    if (!setup.truckId || setup.agentIds.length === 0 || !user) return false;

    const startedAt = Date.now();
    const businessDay = businessDayKey(startedAt);
    const truckId = setup.truckId;
    // Lower-cased so `Juan@x.com` and `juan@x.com` are one account and not two
    // runs. Falls back to the uid, which is never null, for the theoretical
    // account with no email address on it.
    const account = (user.email ?? user.uid).toLowerCase();

    // Resolved from the agent list rather than from anything stored in `setup`,
    // and **every ticked agent has to be found**.
    //
    // The saved copy of the list hydrates on mount, so in practice this always
    // resolves. But a setup survives an app restart, so an agent id can outlive
    // the list it came from (deleted on the dashboard since) — and opening a run
    // naming nobody, or a nameless somebody, would be silent and unfixable
    // afterwards. Throwing puts it in front of the driver through the retry
    // prompt openRun already wraps this in; backing out of that prompt returns
    // them to the form, where opening the picker re-downloads the list.
    //
    // Kept in the **list's** order, not the order they were ticked, so the same
    // people always compose the same run id.
    const aboard = agents.value.filter((agent) => setup.agentIds.includes(agent.id));
    if (aboard.length !== setup.agentIds.length) {
      throw new Error(
        'Some of the agents picked for this truck could not be found on this phone. Open the Agents list, check who is ticked, then try once more.'
      );
    }
    const agentNames = aboard.map((agent) => agent.name);

    // Counted on the agents *segment of the id*, not on the ids, because this
    // number's whole job is to say how many runs already exist under the id
    // about to be composed, so it has to count exactly what that id would
    // gather together. With no signal `findFreeRunSequence` can't catch a
    // miscount, since the local count is all there is.
    const agentsSegment = agentsRunIdSegment(agentNames);
    const localSequence =
      recentRuns.filter(
        (run) =>
          run.businessDay === businessDay &&
          agentsRunIdSegment(run.agents.map((agent) => agent.name)) === agentsSegment &&
          run.createdByUid === user.uid
      ).length + 1;
    const { sequence } = await findFreeRunSequence(agentNames, account, startedAt, localSequence);
    const runId = composeRunId(agentNames, account, startedAt, sequence);

    const context: RunRecord = {
      runId,
      closedAt: null,
      businessDay,
      truckId,
      truckName: trucks.value.find((truck) => truck.id === truckId)?.name ?? '',
      // Who was aboard is resolved **here and never again**. Who was on the
      // truck today is a fact about today; re-reading the names later would let
      // a rename next week rewrite it.
      agentIds: aboard.map((agent) => agent.id),
      agents: aboard.map((agent) => ({ id: agent.id, name: agent.name })),
      createdByUid: user.uid,
      createdByEmail: user.email ?? '',
      startedAt,
      sequence,
    };

    // Keyed by runId, so a double-tap on "Finish setup" (both presses reading
    // the same not-yet-updated state, so both computing the same id) leaves one
    // entry rather than two identical ones.
    const nextRuns = [context, ...recentRuns.filter((run) => run.runId !== context.runId)].slice(0, RunLogLimit);
    const nextSetup: InventorySetup = {
      ...setup,
      complete: true,
      runStartedAt: startedAt,
      runSequence: sequence,
      runAccount: account,
      runId,
      runHeaderSynced: false,
    };

    // **Written to disk before either reaches state, and awaited** — the one
    // place in this file that doesn't use the fire-and-forget `persist`.
    //
    // Everything the run produces is stamped with its id, and uploads resolve
    // that id by looking the run up in this log (see drainStock in
    // context/sync.tsx). A run that opened in memory but never reached disk is
    // therefore gone at the next launch, and every ledger entry and receipt
    // written under it becomes `'legacy'` — un-uploadable, permanently. A whole
    // day's work can't hang on a write nobody checked, so a failure here throws
    // and the caller offers to try again rather than starting a day that can
    // never be sent.
    //
    // Retrying is safe: the id is composed from the business day, agents, account
    // and sequence, none of which change between attempts, so a second attempt
    // recomputes the same run and the log dedupes it by id. The Firestore probe
    // doesn't change that — nothing above it writes anything, so the number it
    // found free the first time is still free the second.
    await AsyncStorage.multiSet([
      [RUN_LOG_KEY, JSON.stringify(nextRuns)],
      [SETUP_KEY, JSON.stringify(nextSetup)],
    ]);

    setRecentRuns(nextRuns);
    setSetup(nextSetup);
    return true;
  }

  /**
   * Back to the setup wizard.
   *
   * The run log is deliberately *not* cleared: it is what numbers the next run
   * of the day, and what still describes the run this leaves behind so its
   * unsent rows can finish uploading into it.
   */
  async function resetSetup(): Promise<void> {
    // Awaited for the same reason endRun is: the caller reports it as done, and
    // a setup that clears on screen but not on disk comes back at the next
    // launch — with the abandoned run open again.
    await AsyncStorage.setItem(SETUP_KEY, JSON.stringify(EMPTY_SETUP));
    setSetup(EMPTY_SETUP);
  }

  function markRunHeaderSynced() {
    persistSetup({ ...setup, runHeaderSynced: true });
  }

  /**
   * Ends the run and hands back an empty truck.
   *
   * Clearing the setup is what empties it: the ledger is scoped by run
   * (lib/stock-db.ts), so the next run reads back nothing without a single row
   * being deleted. The day's work stays on the phone in full — the Receipts tab
   * is still a running history, and the ledger is still there to be re-read.
   *
   * Called only once the closing write has reached Firestore, and closing
   * itself requires an empty upload queue, so by this point everything from the
   * run is safely in the cloud. The run stays in the log regardless: it is what
   * numbers the next run of the day.
   */
  async function endRun(closedAt: number): Promise<void> {
    // Usually a stamp on the entry that is already there. The second branch is
    // for a run the log never held — one rebuilt from the setup because the log
    // couldn't be read when the day started (see rebuildRunFromSetup) — which
    // would otherwise close and leave no record of itself behind at all.
    const nextRuns = recentRuns.some((run) => run.runId === runId)
      ? recentRuns.map((run) => (run.runId === runId ? { ...run, closedAt } : run))
      : currentRun
        ? [{ ...currentRun, closedAt }, ...recentRuns].slice(0, RunLogLimit)
        : recentRuns;

    // Awaited, and written before either reaches state — the mirror of
    // finalizeSetup, and load-bearing for the same kind of reason.
    //
    // A setup that clears on screen but never reaches disk is back at the next
    // launch, with the run it just closed looking open again. The sync loop
    // would then re-send that run's header, and the header write says
    // `status: 'open'` — so a closed day would reopen in Firestore, after the
    // driver had already been shown the manifest confirming it was done.
    //
    // Failing instead leaves the run open and the truck loaded, which is the
    // honest state: "End the Day" already runs inside a retry prompt, and
    // repeating it is safe because every closing write is a setDoc at a known
    // id.
    await AsyncStorage.multiSet([
      [RUN_LOG_KEY, JSON.stringify(nextRuns)],
      [SETUP_KEY, JSON.stringify(EMPTY_SETUP)],
    ]);

    setRecentRuns(nextRuns);
    setSetup(EMPTY_SETUP);
  }

  // Read back off the setup rather than recomposed, so the id a run writes
  // under is fixed for its whole life. The fallback is only for a run that was
  // already open when this build arrived: its rows are stamped with the old
  // truck-keyed id, so that is the run it has to stay on until it is closed.
  const runId = !setup.complete
    ? null
    : (setup.runId ??
      (setup.truckId && setup.runStartedAt
        ? composeLegacyTruckRunId(setup.truckId, setup.runAccount, setup.runStartedAt, setup.runSequence)
        : null));
  const loggedRun = runId ? (recentRuns.find((run) => run.runId === runId) ?? null) : null;

  // The log is still the preferred answer — it holds the names the driver
  // actually picked and the agents as they stood when the run opened. The rebuild
  // is only for when it can't answer at all.
  const currentRun =
    loggedRun ??
    (runId && user && setup.runStartedAt !== null
      ? rebuildRunFromSetup(
          runId,
          setup,
          setup.runStartedAt,
          user.uid,
          user.email ?? '',
          trucks.value,
          agents.value
        )
      : null);


  const value: InventoryContextValue = {
    trucks: trucks.value,
    trucksLoading: trucks.loading,
    trucksError: trucks.error,
    ensureTrucksLoaded: () => void trucks.refresh(),

    agents: agents.value,
    agentsLoading: agents.loading,
    agentsError: agents.error,
    ensureAgentsLoaded: () => void agents.refresh(),

    setup,
    setupLoading,
    updateSetup,
    finalizeSetup,
    resetSetup,

    runId,
    currentRun,
    recentRuns,
    runLogLoaded,
    markRunHeaderSynced,
    endRun,
  };

  return <InventoryContext value={value}>{children}</InventoryContext>;
}
