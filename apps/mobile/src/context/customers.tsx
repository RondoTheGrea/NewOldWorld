import { createContext, use, useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';

import type { CatalogSourceKind } from '@/lib/catalog-source';
import { logError } from '@/lib/errors';
import * as customerDb from '@/lib/customer-db';
import { pullCustomerUpdates } from '@/lib/customer-sync';
import { isNewCustomer, type Customer, type CustomerInput } from '@/lib/customer-types';
import { requestSync, setCustomersChangedHandler } from '@/lib/sync';

export { WEEKDAYS, isNewCustomer, type Weekday, type CustomerInput, type Customer } from '@/lib/customer-types';

type CustomersContextValue = {
  customers: Customer[];
  /** True until the persisted list has been read from disk on app start. */
  loading: boolean;
  /** Set when SQLite is unavailable (currently: web) or failed to load. */
  error: string | null;
  /** Re-runs the failed load — what the "Try again" button on the error screen calls. */
  reloadCustomers: () => void;
  /**
   * Downloads every store other phones have created or changed, and applies it
   * here. Resolves with `'fresh'` / `'cache'` / `'none'` exactly like the
   * dashboard-owned catalogs, so finishing truck setup can list it as one more
   * row in its download progress and route a failure into the same prompt.
   *
   * **Called from truck setup and nowhere else.** The store list is fixed for
   * the run once the truck leaves; uploads stay live, downloads don't.
   *
   * Stores are not a cached catalog though — they live in SQLite and this phone
   * writes them too — so `'cache'` here means "the server didn't answer, but
   * this phone already has a store list", not "read from AsyncStorage".
   */
  refreshCustomers: () => Promise<CatalogSourceKind>;
  /**
   * Adds a store. `customerId` marks which user action this is, so a retry of
   * a failed save rewrites the same row rather than adding a second store —
   * callers inside a retry prompt must mint one per attempt-group and reuse it.
   */
  addCustomer: (input: CustomerInput, customerId?: string) => Promise<Customer>;
  updateCustomer: (id: string, input: CustomerInput) => Promise<void>;
  deleteCustomer: (id: string) => Promise<void>;
  /**
   * Drops a store's "New" tag and lets it fall back into name order, because a
   * receipt has now been finalized for it. Called by `context/receipts.tsx`;
   * never throws, so it can't turn a saved receipt into a reported failure.
   */
  clearNewCustomer: (id: string) => Promise<void>;
};

const CustomersContext = createContext<CustomersContextValue | null>(null);

export function useCustomers() {
  const value = use(CustomersContext);
  if (!value) {
    throw new Error('useCustomers must be used inside a <CustomersProvider>');
  }
  return value;
}

/**
 * Store name order, with one exception: a store this phone added in the last
 * day (see `isNewCustomer`) is lifted to the front, newest first.
 *
 * That is the whole reason the exception exists. A driver types a store in
 * because they are standing in front of it and are about to write it a
 * receipt — and in a list of a few hundred stores sorted by name, the one they
 * just created is the hardest of all to find, because it is the only one whose
 * position they have no memory of. Writing that receipt is therefore the moment
 * the exception has served its purpose, and `clearNewCustomer` ends it there;
 * the 24-hour window only catches a store that never gets billed at all.
 *
 * `Date.now()` is read once per sort rather than per comparison, so the
 * ordering can't come out inconsistent halfway through (which is a crash on
 * some engines, not just a wrong list) if the window happens to lapse mid-sort.
 * The order is settled at each sort and not recomputed on a timer: nothing is
 * filed by it, and every add, edit and reload re-sorts anyway.
 */
function sortCustomers(customers: Customer[]): Customer[] {
  const now = Date.now();
  return [...customers].sort((a, b) => {
    const aNew = isNewCustomer(a, now);
    const bNew = isNewCustomer(b, now);
    if (aNew !== bNew) return aNew ? -1 : 1;
    if (aNew && bNew) return b.createdAt - a.createdAt;
    return a.storeName.localeCompare(b.storeName) || a.name.localeCompare(b.name);
  });
}

export function CustomersProvider({ children }: PropsWithChildren) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by reloadCustomers to re-run the load effect below.
  const [loadToken, setLoadToken] = useState(0);

  // Which read of the table is the current one. Every path into the list — the
  // mount effect, the "Try again" button, the pull's change notification, and
  // the awaited read inside refreshCustomers — goes through applyFromDisk, so
  // ordering can't be left to each caller's own cancellation flag: an older
  // read resolving late would otherwise overwrite a newer one's answer with
  // stale rows and no sign that it had happened.
  const loadSeq = useRef(0);

  /**
   * Reads the whole table into state. Resolves true when the list on screen is
   * now what is on disk, false when it couldn't be read.
   *
   * The return value is not decoration: `refreshCustomers` reports it onward to
   * the setup screen, which decides whether the driver may start the day.
   */
  const applyFromDisk = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeq.current;
    try {
      // On web, customer-db.web.ts (the platform-matched stub Metro loads
      // there) rejects every call — this is the one place that surfaces as an
      // error message instead of a crash.
      const loaded = await customerDb.loadCustomers();
      // A newer read has started since; its answer is the current one.
      if (seq !== loadSeq.current) return true;
      setCustomers(sortCustomers(loaded));
      // A load that worked means there is nothing left to report. Only
      // `reloadCustomers` used to clear this, so a reload triggered any other
      // way — the setup pull applying new stores — refreshed the list into
      // state and left the screen showing the old error over the top of it,
      // with the data already in memory behind it.
      setError(null);
      return true;
    } catch (error) {
      logError('customers.load', error);
      if (seq !== loadSeq.current) return false;
      setError(
        Platform.OS === 'web'
          ? 'Customers aren’t available on web yet — use the app on a phone.'
          : 'Could not load customers from this phone’s storage.'
      );
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Scheduled rather than called straight from the effect body. applyFromDisk
    // sets state as it goes, and React's lint (and the React Compiler) treat a
    // setState reachable synchronously from an effect body as a cascading
    // render — the same reason context/sync.tsx puts its first pass on a timer.
    const timer = setTimeout(() => {
      void applyFromDisk().finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadToken, applyFromDisk]);

  // Back to the loading state here rather than inside the effect: React's lint
  // rules out calling setState straight from an effect body, and this is a
  // button press, which is exactly where it belongs.
  function reloadCustomers() {
    setLoading(true);
    setError(null);
    setLoadToken((token) => token + 1);
  }

  // The pull writes other devices' customers straight into SQLite, which this
  // list knows nothing about — without this, a store another truck created
  // would sit on disk invisibly until the next app launch.
  useEffect(() => {
    setCustomersChangedHandler(() => void applyFromDisk());
    return () => setCustomersChangedHandler(null);
  }, [applyFromDisk]);

  /**
   * Pull the other phones' stores down. This is the *only* place that happens:
   * finishing truck setup is when the route list is set, and it doesn't change
   * again until the next one (see lib/customer-sync.ts).
   *
   * The nudge first is the other direction, and it is not the same work: it
   * pushes whatever this phone has changed and hasn't managed to send, so the
   * server has this truck's stores before we ask it what changed. It is
   * fire-and-forget — nothing waits on it, and uploads happen live anyway.
   *
   * **The read afterwards is what makes this moment mean something.** Because
   * the pull is the only download stores ever get, the list this resolves with
   * is the list the truck works for the rest of the trip — so when the setup
   * screen ticks "Stores" off, the interface has to be holding what the disk
   * holds, not be a render or two behind it. Two ways it could not be, and both
   * were live before this read existed:
   *
   * - The pull notifies the list only when a row actually moved, and it does
   *   that from *inside* the pull, so the state update was still in flight when
   *   this resolved and setup opened the run on top of it.
   * - A pull that applied two pages and then failed on the third came back
   *   `'cache'` and never notified at all — the new stores were on disk, unseen,
   *   and stayed unseen until the next app launch.
   *
   * A read that fails is not allowed to pass as success, whatever the pull
   * said: the answer is then about what this phone can actually show, exactly
   * as `runPull`'s own fallback is. `'cache'` if there is still a store list on
   * screen to work from, `'none'` if there isn't — which is the answer that
   * stops a truck leaving the depot unable to write a single receipt.
   */
  const refreshCustomers = useCallback(async (): Promise<CatalogSourceKind> => {
    requestSync();
    const kind = await pullCustomerUpdates();
    if (await applyFromDisk()) return kind;
    // The re-read failed, so the list on screen isn't known to match the disk —
    // downgrade to `'cache'` whatever the pull said. Never `'none'`, and never
    // conditioned on how many stores are showing: `'none'` is what takes "Use
    // saved copy" away and holds the truck at the depot, and neither an empty
    // store list nor an unreadable one is fixable by standing somewhere with
    // better signal. An empty list is workable — this is the one catalog the
    // phone can write to — and a database this phone can't read is a fault
    // Retry would re-run forever, which is the trap this app refuses to build.
    // The Customers tab reports that one on its own, with its own "Try again".
    return 'cache';
  }, [applyFromDisk]);

  // Each writer nudges sync once the row is safely on disk. requestSync()
  // never throws and never waits: a failed upload leaves the row marked
  // pending for the next pass, so editing a customer is never gated on signal.
  // `customerId` identifies one press of Save, so a retry of a failed add
  // rewrites the same store instead of creating a second one — see
  // insertCustomer in lib/customer-db.ts.
  const addCustomer = async (input: CustomerInput, customerId?: string) => {
    const customer = await customerDb.insertCustomer(input, customerId);
    setCustomers((current) => sortCustomers([...current, customer]));
    requestSync();
    return customer;
  };

  const updateCustomer = async (id: string, input: CustomerInput) => {
    // Merge what was written, not what was passed in — the db layer cleans the
    // input up (see sanitizeCustomerInput), and the list on screen has to match
    // the row on disk.
    //
    // `saved` carries `updatedAt` for that reason too. This used to stamp its
    // own `Date.now()` here, a second and later reading of the clock than the
    // one the UPDATE wrote, leaving the store in memory a few milliseconds
    // ahead of the same store on disk. Nothing renders it, which is what made
    // it worth fixing rather than shrugging at: `updatedAt` is what
    // last-write-wins compares, what the pull orders by, and what
    // markCustomerSynced matches a row against.
    const saved = await customerDb.updateCustomerRow(id, input);
    setCustomers((current) => sortCustomers(current.map((c) => (c.id === id ? { ...c, ...saved } : c))));
    requestSync();
  };

  /**
   * The store has been invoiced, so it stops being the new one.
   *
   * Never rejects. It is called from inside `finalize()`, which the driver is
   * standing in front of with a receipt they have just committed to — a badge
   * failing to clear is not something to interrupt them with, and the next
   * receipt for the store tries again.
   *
   * The disk write goes first: if it fails, the list keeps saying "New", which
   * is at least what the database still says. The state update returns the
   * array unchanged when the store isn't tagged — the common case, every
   * receipt after the first — so React bails out instead of re-sorting and
   * re-rendering the store list behind every finalize.
   */
  const clearNewCustomer = useCallback(async (id: string) => {
    try {
      await customerDb.clearCustomerIsNew(id);
    } catch (error) {
      logError('customers.clearNew', error, { customer: id });
      return;
    }
    setCustomers((current) => {
      if (!current.some((c) => c.id === id && c.isNew)) return current;
      return sortCustomers(current.map((c) => (c.id === id ? { ...c, isNew: false } : c)));
    });
  }, []);

  // The row is soft-deleted on disk (see customer-db.ts) so the deletion can
  // travel to other devices; it just stops being listed here.
  const deleteCustomer = async (id: string) => {
    await customerDb.deleteCustomerRow(id);
    setCustomers((current) => current.filter((c) => c.id !== id));
    requestSync();
  };

  const value: CustomersContextValue = {
    customers,
    loading,
    error,
    reloadCustomers,
    refreshCustomers,
    addCustomer,
    updateCustomer,
    deleteCustomer,
    clearNewCustomer,
  };

  return <CustomersContext value={value}>{children}</CustomersContext>;
}
