import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { UnknownCatalogSource, type CatalogSource, type CatalogSourceKind } from '@/lib/catalog-source';
import { logError } from '@/lib/errors';

/**
 * If the server hasn't answered within this window, stop waiting and fall back
 * to whatever copy is saved on the device — trucks are often on a weak signal,
 * and a screen stuck loading forever is worse than slightly old prices.
 */
const FETCH_TIMEOUT_MS = 6000;

/**
 * What gets written to AsyncStorage. The wrapper exists purely to carry
 * `storedAt` — "when this device last downloaded this" is what the Inventory
 * tab's badge shows, whether the app is running on the fresh copy or the saved
 * one.
 */
type CachePayload<T> = {
  /** Bumped only if the wrapper shape itself changes; the value inside is the caller's business. */
  version: 1;
  storedAt: number;
  value: T;
};

export type RefreshOptions = {
  /**
   * Start a request even if one is already in flight, instead of riding along
   * on it.
   *
   * Riding along is right for the incidental callers — a provider mounting, a
   * "Try again" tap — where an answer that is already seconds away is the same
   * answer. It is wrong for finishing truck setup, which is a deliberate
   * "download everything now" and, for some of these, the only moment in the
   * day they are downloaded at all: riding an in-flight request there starts
   * the day on an attempt made before the driver reached the button, and if
   * that attempt times out, setup reports a failure for a fetch it never made.
   * Setup passes `force`.
   */
  force?: boolean;
};

export type CachedCatalog<T> = {
  value: T;
  /** True only while we're working AND nothing usable has arrived yet — fresh or cached. */
  loading: boolean;
  error: string | null;
  source: CatalogSource;
  /**
   * Fetches fresh and resolves with what the caller actually ended up with:
   * `fresh` on success, `cache` when it failed but a usable copy is on the
   * device, `none` when it failed with nothing to fall back on. The setup
   * screen keys its retry / use-saved-copy prompt off exactly this.
   */
  refresh: (options?: RefreshOptions) => Promise<CatalogSourceKind>;
};

type Options<T> = {
  /** AsyncStorage key. Must be unique per catalog and stable across releases. */
  cacheKey: string;
  /** Shown before anything has loaded (`[]`, or the hardcoded defaults). */
  initial: T;
  /**
   * One Firestore read, resolving with the catalog itself.
   *
   * It must reject rather than resolve when the server wasn't actually reached
   * (`assertFromServer` — see lib/catalog-source.ts), because resolving is what
   * stamps "downloaded just now" on the badge.
   */
  fetch: () => Promise<T>;
  /** Applied to fetched *and* cached values, e.g. re-sorting. Must be pure. */
  normalize?: (value: T) => T;
  /** Plain-language message shown when there's nothing at all to fall back to. */
  errorMessage: string;
  /**
   * Recognises a value that is *technically* a successful answer but holds
   * nothing in it — an empty list. Optional: with it omitted the hook behaves
   * exactly as it always has.
   *
   * Supplying it changes two things, and they're the same claim in both
   * directions — **an empty catalog is never allowed to displace a real one:**
   *
   * - **An empty fetch doesn't overwrite the saved copy.** A query that comes
   *   back with zero documents is indistinguishable from a healthy one, so
   *   without this a single bad answer — the app pointed at a project whose
   *   catalog was never filled in, a rule change that hides every doc — quietly
   *   replaces good prices with nothing *and writes that to disk*, where it
   *   survives every restart. Keeping the copy and reporting `'cache'` instead
   *   puts it in front of the user through the machinery that already exists
   *   (the setup screen's retry / use-saved-copy prompt).
   * - **An empty saved copy doesn't count as a saved copy.** Otherwise "Use
   *   saved copy" would happily start a day on a catalog with nothing in it.
   *
   * When there is nothing cached to protect, an empty answer is still accepted
   * as `'fresh'` — a dashboard that genuinely has no bread types yet is a real
   * state, and the screens say so in plain words rather than blaming the
   * network.
   */
  isEmpty?: (value: T) => boolean;
  /**
   * Whether to fetch once as soon as the provider mounts. Default true.
   *
   * Pass `false` for a catalog whose *only* trigger is the user opening the
   * control that shows it (areas, trucks, agents — see context/inventory.tsx).
   * Those lists are read at one moment in the day, so fetching them on every
   * app launch spends a request on a weak signal for data nobody is looking
   * at. The disk cache is still hydrated on mount either way, so the list is
   * never empty while the fetch runs.
   */
  fetchOnMount?: boolean;
};

/**
 * The fetch-fresh / fall-back-to-cache behaviour every dashboard-owned catalog
 * shares: hydrate from disk on mount, fetch, cache what comes back, and keep
 * an honest record of which of the two the app is running on and when it last
 * came off the server.
 *
 * Three things worth knowing:
 *
 * - **A late answer still counts.** When the timeout fires we resolve against
 *   the cache, but the in-flight request is left alone — if it lands a second
 *   later, its data and its cache write still happen, and the source flips
 *   back up to `fresh`.
 * - **…but only while nothing newer has answered.** Every request carries a
 *   generation number and acts on its result only if it is the newest one to
 *   get an answer. So a slow request overtaken by a later, faster one can't
 *   reinstate the data it fetched, stamp an old download time over a newer one,
 *   or downgrade a `fresh` badge to `cache` on the strength of a timeout that
 *   has since been overtaken. `force` is what makes two requests being out at
 *   once ordinary rather than theoretical, so the counter comes with it.
 * - **A failed refresh downgrades the badge to `cache`.** Data fetched
 *   successfully ten minutes ago is real data, but it is no longer "what the
 *   server says now", and after the user chooses "Use saved copy" the badge
 *   has to agree with them. The date doesn't move when it does: it was the time
 *   of the last real download before, and it still is.
 */
export function useCachedCatalog<T>({
  cacheKey,
  initial,
  fetch,
  normalize,
  errorMessage,
  isEmpty,
  fetchOnMount = true,
}: Options<T>): CachedCatalog<T> {
  const [value, setValue] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [source, setSourceState] = useState<CatalogSource>(UnknownCatalogSource);
  // Starts true so the very first render says "loading", not "nothing here" —
  // the cache read below hasn't had a chance to run yet at that point.
  const [busy, setBusy] = useState(true);

  // Refs, not state, for anything a fetch callback has to read *as of now*:
  // those callbacks fire long after the render that created them, so a state
  // value captured in their closure would be stale.
  const sourceRef = useRef<CatalogSource>(UnknownCatalogSource);
  /** When the copy currently on disk was downloaded — what a downgrade to `cache` reports. */
  const storedAtRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<CatalogSourceKind> | null>(null);
  /** Ticks once per request; `appliedRef` is the newest one whose answer was acted on. */
  const generationRef = useRef(0);
  const appliedRef = useRef(0);
  // `fetch` / `normalize` are re-created every render by the calling provider;
  // going through a ref keeps `refresh` stable without asking callers to
  // memoize. Seeded with the first render's versions and re-synced in an
  // effect — writing a ref during render is what the React Compiler's rules
  // forbid. This effect is declared first so the refs are already current by
  // the time the mount effect below reads them.
  const fetchRef = useRef(fetch);
  const normalizeRef = useRef(normalize);
  const isEmptyRef = useRef(isEmpty);

  useEffect(() => {
    fetchRef.current = fetch;
    normalizeRef.current = normalize;
    isEmptyRef.current = isEmpty;
  });

  const setSource = useCallback((next: CatalogSource) => {
    sourceRef.current = next;
    setSourceState(next);
  }, []);

  const refresh = useCallback(
    ({ force = false }: RefreshOptions = {}): Promise<CatalogSourceKind> => {
      // A second caller during an in-flight fetch rides along on the same
      // request rather than starting a competing one — unless it asked for an
      // attempt of its own. See `force` above.
      if (inFlightRef.current && !force) return inFlightRef.current;

      setBusy(true);
      setError(null);

      const generation = ++generationRef.current;

      const promise: Promise<CatalogSourceKind> = new Promise<CatalogSourceKind>((resolve) => {
        let settled = false;

        /**
         * Whether this request's answer is still the newest one in, and so may
         * be acted on. A request that has been overtaken reports what the app
         * ended up running on and changes nothing.
         */
        function claim(): boolean {
          if (generation < appliedRef.current) return false;
          appliedRef.current = generation;
          return true;
        }

        /** What we're left holding when the fetch doesn't deliver. */
        function fallBack(): CatalogSourceKind {
          const haveData = sourceRef.current.kind !== 'none';
          if (!claim()) return sourceRef.current.kind;
          if (haveData) {
            setSource({ kind: 'cache', at: storedAtRef.current });
          } else {
            setError(errorMessage);
          }
          return haveData ? 'cache' : 'none';
        }

        function finish(kind: CatalogSourceKind) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          // Only the request that is actually current may clear the slot: an
          // older one finishing must not advertise a newer one as done.
          if (inFlightRef.current === promise) inFlightRef.current = null;
          // Likewise, a request still out there keeps the screen "busy".
          if (generation === generationRef.current) setBusy(false);
          resolve(kind);
        }

        const timeoutId = setTimeout(() => finish(fallBack()), FETCH_TIMEOUT_MS);

        fetchRef
          .current()
          .then((fetched) => {
            const next = normalizeRef.current ? normalizeRef.current(fetched) : fetched;

            // A successful-but-empty answer, with a real copy already in hand, is
            // treated exactly like a failed one: keep what we have. See `isEmpty`
            // above for why an empty response can't be taken at face value.
            if (isEmptyRef.current?.(next) && sourceRef.current.kind !== 'none') {
              logError('catalog.emptyResponse', new Error(`${cacheKey} came back empty; keeping the saved copy`));
              finish(fallBack());
              return;
            }

            // Overtaken by a later request that has already answered: its data
            // is at least as current as this one's, so this one is dropped
            // whole rather than written over the top of it.
            if (!claim()) {
              finish('fresh');
              return;
            }

            // The moment the server answered. *This* is what the badge's date
            // means — not any timestamp inside the documents, which says when
            // the dashboard last edited them and nothing about this phone.
            const storedAt = Date.now();
            setValue(next);
            setError(null);
            setSource({ kind: 'fresh', at: storedAt });
            storedAtRef.current = storedAt;
            const payload: CachePayload<T> = { version: 1, storedAt, value: next };
            // Not awaited: the data is already live in state, and a failed disk
            // write only costs us the offline copy next launch.
            void AsyncStorage.setItem(cacheKey, JSON.stringify(payload));
            finish('fresh');
          })
          .catch(() => {
            finish(fallBack());
          });
      });

      inFlightRef.current = promise;
      return promise;
    },
    [cacheKey, errorMessage, setSource],
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (!cancelled && raw) {
          const parsed = JSON.parse(raw) as unknown;
          const wrapped =
            !!parsed && typeof parsed === 'object' && (parsed as CachePayload<T>).version === 1
              ? (parsed as CachePayload<T>)
              : null;
          // An unwrapped payload is a cache written by a build from before
          // `storedAt` existed: still perfectly good data, just undated.
          const cached = wrapped ? wrapped.value : (parsed as T);
          const storedAt = wrapped ? wrapped.storedAt : null;
          const value = normalizeRef.current ? normalizeRef.current(cached) : cached;
          // An empty cache is left on the floor rather than adopted: a copy
          // with nothing in it is not something the app can run a day on, and
          // calling it a saved copy would let "Use saved copy" start one.
          if (!isEmptyRef.current?.(value)) {
            storedAtRef.current = storedAt;
            setValue(value);
            setSource({ kind: 'cache', at: storedAt });
          }
        }
      } catch {
        // A corrupt or unreadable cache isn't worth crashing the app over —
        // the fetch right below replaces it either way.
      }
      if (cancelled) return;
      if (fetchOnMount) {
        void refresh();
      } else {
        // `busy` starts true so the first render says "loading" rather than
        // "nothing here". Nothing else will clear it when no fetch runs on
        // mount, and a stuck-true flag would leave the control showing a
        // spinner forever instead of the cached list.
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, fetchOnMount, refresh, setSource]);

  return {
    value,
    loading: busy && source.kind === 'none',
    error,
    source,
    refresh,
  };
}
