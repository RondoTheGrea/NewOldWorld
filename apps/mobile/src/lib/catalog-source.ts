import type { SnapshotMetadata } from 'firebase/firestore';

import { formatDeviceDateTime } from '@/lib/device-time';

/**
 * Where the catalog data currently on screen came from.
 *
 * The three dashboard-owned catalogs (bread types, returned bread types,
 * business settings) are fetched fresh when a truck finishes setup and cached
 * on the device so the day still works with no signal. Everything that shows a
 * "Fresh / Saved copy" badge reads this.
 *
 * - `fresh` — the server answered this session, so what's on screen is what the
 *   dashboard held at that moment.
 * - `cache` — we're running on the copy saved to this device, because the
 *   fetch failed or timed out.
 * - `none` — nothing has ever arrived: no successful fetch, no cache.
 *
 * **`at` means one thing in every kind: when this phone last got this data off
 * the server.** Not when the dashboard last edited it. That distinction was
 * the bug this type used to carry — `fresh` reported the newest
 * `updatedAt`/`createdAt` on the documents, so a catalog downloaded a minute
 * ago read "updated Aug 15" because Aug 15 was the last time anyone touched it
 * on the dashboard. The date on the badge is a *freshness* claim about the
 * download, so it has to be the download's own clock; and it is the same
 * quantity in both directions, which is what lets a `fresh` badge downgrade to
 * `cache` without the date jumping.
 *
 * `at` is null only for a saved copy written by a build from before this was
 * recorded. A fresh answer always knows when it landed.
 */
export type CatalogSourceKind = 'fresh' | 'cache' | 'none';

export type CatalogSource = {
  kind: CatalogSourceKind;
  /** Epoch milliseconds — when this phone last downloaded this data. */
  at: number | null;
};

export const UnknownCatalogSource: CatalogSource = { kind: 'none', at: null };

/**
 * A read that Firestore answered out of its own local cache because the client
 * is offline. See `assertFromServer`.
 */
export class OfflineAnswerError extends Error {
  constructor() {
    super('Firestore answered from its local cache — the device is offline.');
    this.name = 'OfflineAnswerError';
  }
}

/**
 * Refuses an answer that didn't come from the server.
 *
 * **A Firestore read with no connection does not fail.** `getDocs` only rejects
 * when you explicitly pass `source: 'server'`; with the default source it falls
 * back to the SDK's own local cache and resolves a perfectly well-formed
 * snapshot — empty in a freshly-launched app, or holding whatever this session
 * already fetched. Nothing in the shape of that answer says the server was
 * never reached, so every catalog took it as gospel: reported `'fresh'`, and in
 * the empty case overwrote the saved copy on disk with nothing.
 *
 * `metadata.fromCache` is the flag that tells the two apart, and it is reliable
 * in the direction that matters here: the SDK raises an early cache-only
 * snapshot *only* once it has decided it is offline (`waitForSyncWhenOnline`),
 * so when the server does answer this is false.
 *
 * Throwing is deliberate — every caller already has a "the fetch failed" path
 * that falls back to the saved copy and reports `'cache'`, which is what puts
 * the driver in front of the Retry / Use-saved-copy prompt that already exists.
 *
 * It is also what keeps `at` honest: an offline replay of a document this
 * session already fetched would otherwise be stamped with the current time and
 * shown as a download that never happened.
 *
 * `getDoc` on a document the cache has never seen rejects on its own, so this
 * is belt-and-braces there; it still matters for the doc this session already
 * fetched.
 */
export function assertFromServer(metadata: SnapshotMetadata): void {
  if (metadata.fromCache) throw new OfflineAnswerError();
}

/**
 * Rolls several catalogs into the single badge shown on the Inventory tab.
 *
 * One rule covers both halves of it: **the worst answer wins.** The kind is the
 * worst of the kinds, so the badge can never say "Fresh" while something on
 * screen is running on a saved copy; the date is the *oldest* download among
 * the sources that produced that kind, so the badge can never claim a screen is
 * more recently downloaded than its stalest part. A single unknown date makes
 * the whole line undated rather than quietly reporting one of the others.
 */
export function combineCatalogSources(sources: CatalogSource[]): CatalogSource {
  if (sources.length === 0) return UnknownCatalogSource;
  if (sources.some((source) => source.kind === 'none')) return { kind: 'none', at: null };

  const kind: CatalogSourceKind = sources.some((source) => source.kind === 'cache') ? 'cache' : 'fresh';
  const contributing = sources.filter((source) => source.kind === kind);
  const times = contributing.map((source) => source.at).filter((at): at is number => at !== null);
  return { kind, at: times.length === contributing.length ? Math.min(...times) : null };
}

/**
 * The badge's own words, e.g. "Fresh · downloaded Aug 15, 6:30 AM".
 *
 * Both kinds use the same verb on purpose: the number after it is the same
 * measurement either way — when this phone last got the data — so two wordings
 * would read as two different facts.
 */
export function describeCatalogSource(source: CatalogSource): string {
  if (source.kind === 'fresh') {
    return source.at === null
      ? 'Fresh · downloaded just now'
      : `Fresh · downloaded ${formatDeviceDateTime(source.at)}`;
  }
  if (source.kind === 'cache') {
    return source.at === null
      ? 'Saved copy · downloaded earlier'
      : `Saved copy · downloaded ${formatDeviceDateTime(source.at)}`;
  }
  return 'Not downloaded yet · needs internet';
}
