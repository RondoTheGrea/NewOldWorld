import type { CatalogSourceKind } from '@/lib/catalog-source';
import * as customerDb from '@/lib/customer-db';
import { logError } from '@/lib/errors';
import { notifyCustomersChanged, pullCustomers, readCustomerWatermark, writeCustomerWatermark } from '@/lib/sync';

/**
 * Bringing this phone's store list up to date with every other phone's.
 *
 * Customers are the one collection that moves **both ways**, but the two halves
 * run on completely different clocks, and that asymmetry is the design:
 *
 * - **Up is live.** A store created or edited here queues immediately and rides
 *   the normal sync pass with receipts and ledger entries (context/sync.tsx).
 * - **Down happens once, when truck setup is finished** — alongside bread
 *   types, return prices and business details, at the depot, where there is
 *   signal. This file is that half.
 *
 * The route a truck works is therefore the list it left with. Pulling
 * continuously would look like an improvement and isn't one: a store edited or
 * deleted at the server at noon would rewrite a list the driver is halfway
 * through working from, mid-round, with no way to tell that it changed.
 *
 * `pullCustomerUpdates` still collapses overlapping calls into one request —
 * finishing setup twice in quick succession (retry, or "Use saved copy" after a
 * failure) costs one pull, not two.
 */

/**
 * How many changed stores one request asks for. A page rather than "everything
 * since the watermark" so a phone that has been away for a week never builds
 * one enormous in-memory list; the loop below simply asks again.
 */
const PullPageLimit = 200;

/**
 * How many pages one catch-up walks before leaving the rest to the next pass.
 * 25 × 200 is far more than this business will ever have, and the bound is what
 * stops an unexpected answer from looping forever.
 */
const MaxPullPages = 25;

/**
 * How long one catch-up keeps paging before handing the rest to the background.
 *
 * A page count alone is the wrong bound for the caller that matters. Finishing
 * truck setup shows a full-screen spinner until every download reports back,
 * and each page is allowed up to `CallTimeoutMs` (12s) of its own — so a phone
 * with a long backlog on a slow link could hold that screen for minutes with
 * the "Stores" row stuck on "Downloading…". A spinner nobody can get past is
 * the failure this app is most careful about (see CLAUDE.md).
 *
 * Stopping early loses nothing: every page applied is already on disk and the
 * watermark has moved with it, so the ordinary sync pass picks the rest up
 * within the minute. Only a slow link ever reaches this — thousands of changed
 * stores over a good one page through in well under the budget.
 */
const PullBudgetMs = 30_000;

let inFlight: Promise<CatalogSourceKind> | null = null;

/**
 * Downloads every store changed since the last successful pull and applies it
 * to SQLite.
 *
 * Resolves with the same three words the cached catalogs use, so the setup
 * screen's progress list and its retry / use-saved-copy prompt can treat stores
 * exactly like bread types:
 *
 * - `'fresh'` — the server answered. (Including "answered with nothing new",
 *   which is the normal case, and "this business genuinely has no stores yet",
 *   which is a real state on a brand-new install.)
 * - `'cache'` — it didn't, so the day runs on whatever store list this phone
 *   already holds. **Including none at all**, which is why this never reports
 *   `'none'`: see below.
 *
 * **Never rejects.** The caller is the setup screen's download list, which
 * reports a failure by showing it in the progress rows and offering Retry —
 * a thrown error would instead hit `runFetch`'s catch-all, which treats every
 * download as failed with nothing cached and takes "Use saved copy" off the
 * table.
 *
 * **And never answers `'none'`, unlike the three dashboard catalogs.** `'none'`
 * is what takes "Use saved copy" off the table and holds the truck at the depot
 * until it finds signal, and an empty store list is not a reason to do that:
 * stores are the one collection **mobile can write** (see "Customer sync" in
 * CLAUDE.md), so a driver who starts a day with none can add the ones in front
 * of them, which is exactly what a new route does. A missing price list has no
 * such way out — nothing on the phone can invent what a loaf costs — which is
 * why bread types, return prices and business details still report `'none'` and
 * still make the first setup on a phone an online one. Stores ride along with
 * whatever they decide.
 */
export function pullCustomerUpdates(): Promise<CatalogSourceKind> {
  if (inFlight) return inFlight;

  const pull = runPull().finally(() => {
    inFlight = null;
  });
  inFlight = pull;
  return pull;
}

async function runPull(): Promise<CatalogSourceKind> {
  try {
    const deadline = Date.now() + PullBudgetMs;
    let cursor = await readCustomerWatermark();
    let changed = false;

    for (let page = 0; page < MaxPullPages; page += 1) {
      const incoming = await pullCustomers(cursor, PullPageLimit);
      if (incoming.length === 0) break;

      let newest = cursor;
      for (const remote of incoming) {
        // Last-write-wins, decided inside the upsert by comparing `updatedAt` —
        // it will not move a local row backwards, which is what protects an
        // edit this phone hasn't managed to push yet.
        if (await customerDb.upsertCustomerFromServer(remote)) changed = true;
        if (remote.updatedAt > newest) newest = remote.updatedAt;
      }

      // Advanced only after every row of the page is safely on disk. Moving it
      // first would mean a crash mid-apply silently skipped those stores
      // forever — the watermark says "I already have everything up to here".
      const advanced = newest > cursor;
      if (advanced) await writeCustomerWatermark(newest);
      cursor = newest;

      // A short page is the end of the list.
      if (incoming.length < PullPageLimit) break;

      // Out of budget with more to come. Reported as 'fresh' rather than a
      // failure, because that is what happened: the server answered, the rows
      // are on disk and the watermark moved with them. The remainder is
      // ordinary background work from here.
      if (Date.now() >= deadline) {
        logError('sync.customer.pull', new Error('Store catch-up ran out of time; the rest follows in the background'));
        break;
      }

      // A full page that didn't move the cursor means every row in it shares
      // one millisecond, so asking again would return the same page for ever.
      // Effectively impossible with a 200-row page; bounded anyway, because the
      // alternative is a loop that never ends.
      if (!advanced) {
        logError('sync.customer.pull', new Error('A full page of stores shared one timestamp; stopping the catch-up'));
        break;
      }
    }

    // Only when a row actually moved. A pull that returns rows this device
    // already had — its own pushes coming back, or the boundary row the `>=`
    // cursor deliberately re-reads — shouldn't rebuild the list on screen.
    if (changed) notifyCustomersChanged();
    return 'fresh';
  } catch (error) {
    logError('sync.customer.pull', error);
    // Deliberately not conditioned on how many stores are on disk. Counting
    // them only ever answered a question nobody was asking: an empty list is a
    // real, workable state here — the driver can add the stores they visit —
    // so "zero" is a saved copy like any other, and reporting it as `'none'`
    // stranded a phone at the setup screen over a list it was allowed to
    // build itself.
    return 'cache';
  }
}
