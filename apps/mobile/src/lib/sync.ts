import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  limit as limitTo,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes } from 'firebase/storage';

import { businessDayKey } from '@/lib/business-day';
import { assertFromServer } from '@/lib/catalog-source';
import type { PendingCustomer } from '@/lib/customer-db';
import { logError } from '@/lib/errors';
import { appCheckTokenObtainable, db, recentAppCheckFailure, storage } from '@/lib/firebase';
import type { PendingPaymentProof } from '@/lib/receipt-db';
import type { PendingReceipt } from '@/lib/receipt-types';
import type { PendingExpense } from '@/lib/expense-db';
import type { Batch } from '@/lib/stock-types';
import { SchemaVersion, composeRunId, type RunContext, type RunManifest, type RunStamp } from '@/lib/sync-types';

/**
 * Everything that talks to Firestore on the way *up*.
 *
 * The rule this whole file is built around: **every write is a `setDoc` at an
 * id the phone already chose** (see lib/id.ts), never an `addDoc`. That makes
 * each upload idempotent — sending the same row once and sending it five times
 * produce the identical document — which is what lets the retry policy be as
 * simple as "try again" without any risk of a duplicate receipt or a
 * double-counted sale. If you add an upload here, keep that property.
 *
 * Nothing in this file decides *when* to upload; context/sync.tsx does. Nothing
 * here alerts the user either — a failed upload throws, and the caller logs it
 * and moves on. Sync is background work the user didn't ask for, and the app's
 * rule for that is "log, don't alert" (see CLAUDE.md).
 */

const RunsCollection = 'runs';
const StockEntriesCollection = 'stockEntries';
const ReceiptsCollection = 'receipts';
const ExpensesCollection = 'expenses';
const CustomersCollection = 'customers';

/** How far back a device that has never pulled starts from. Epoch = everything. */
const CustomerWatermarkKey = 'sync.customers.pulledAt.v1';

/**
 * How long one Firestore call is given before it is treated as "no signal".
 *
 * This is not a nicety, it is what makes a failed upload *detectable at all*.
 * Firestore's write promise resolves when the **backend** acknowledges the
 * write, so with no connection it does not reject — it simply never settles.
 * Left bare, one offline `setDoc` hangs its caller forever: the sync pass never
 * finishes (so the heartbeat, which skips while a pass is running, never starts
 * another), and "End the Day" sits on "Ending…" with no alert, because the
 * retry prompt only appears on a rejection.
 *
 * Generous rather than snappy — a truck on a weak signal is slow, not offline,
 * and giving up on a write that was about to land would be its own bug.
 */
const CallTimeoutMs = 12_000;

/**
 * The same, for the two writes that close a run — the last-chance run header
 * and the manifest itself.
 *
 * Nearly four times `CallTimeoutMs`, for two reasons that only apply here.
 * Nothing is queued behind these: the drains have already finished and the
 * queue is empty, so a long wait costs the pass nothing it could have spent
 * on another row. And this is the one moment the driver is standing still
 * watching a spinner, with no way to act on the answer except to tap the same
 * button again — so giving up early doesn't save them anything, it just turns
 * a slow link into a day that won't close.
 *
 * That is not hypothetical. On a marginal signal a 12-second budget classified
 * a closing write that was about to land as "no signal" — and because
 * `withTimeout` does not cancel the underlying write (see below), the write
 * then landed anyway, minutes later. The server was told the day had ended
 * while the phone still believed the run was open, and the truck went out the
 * next morning still stamping its work with the previous run's id.
 */
export const CloseTimeoutMs = 45_000;

/**
 * The same, for the one upload that sends a *file* rather than a document.
 *
 * Much longer than `CallTimeoutMs` because it is a much bigger request:
 * a resized proof photo is around 150 KB where a receipt document is a couple
 * of kilobytes, and on the weak signal this timeout exists for, that is the
 * difference between a few seconds and most of a minute. Giving a photo only
 * 12 seconds would mark a perfectly good upload as "no signal" and retry it
 * forever, re-sending the same bytes each time and never finishing.
 */
const UploadTimeoutMs = 90_000;

/** Where a receipt's proof photo lives in Cloud Storage. */
export function paymentProofPath(receiptId: string): string {
  return `paymentProofs/${receiptId}.jpg`;
}

/**
 * A Firestore call that didn't answer in time.
 *
 * The message names the operation in the user's terms rather than the code's,
 * because this one *is* seen: `describeError` puts it under the "Could not end
 * the day" retry prompt, where "No response from the server while trying to end
 * the day" tells a driver what to do and a stack-shaped message would not.
 */
export class SyncTimeoutError extends Error {
  constructor(operation: string) {
    super(`No response from the server while trying to ${operation}. Check your connection.`);
    this.name = 'SyncTimeoutError';
  }
}

/**
 * Raised when a `permission-denied` upload failure was traced to App Check
 * rather than the security rules — the phone couldn't get a Play Integrity
 * attestation token, so the request was turned away before the rules were even
 * consulted (see `isRecoverableAppCheckDenial`).
 *
 * Worded for the driver — the fix is a better signal so the phone can reach
 * Google Play, not anything about their account or the receipt. Without it the
 * raw "Missing or insufficient permissions" would surface in the "End the Day"
 * prompt and point the driver at the server.
 *
 * It stops the pass like a transient failure and sets nothing aside, but unlike
 * one it is **not free**: `quarantineIfHopeless` spends one of the row's
 * attempts each time, and after `MaxUploadAttempts` the row is quarantined
 * anyway. Attestation that is down for a minute costs nothing; attestation that
 * is down for good must not be able to hold a day open forever, because a row
 * that is never set aside is a queue that never empties.
 */
export class AppCheckUnverifiedError extends Error {
  constructor(cause?: unknown) {
    super(
      "This phone couldn't verify itself with Google Play, so the upload was refused. " +
        'Move somewhere with a stronger signal and try again.',
      // The refusal this stands in for. Carried so a log line can still name
      // the original code rather than only this app's wording of it — nothing
      // else keeps it, since the row is not set aside and never reaches the
      // quarantine log.
      { cause }
    );
    this.name = 'AppCheckUnverifiedError';
  }
}

/**
 * What a failed upload means for the row that failed.
 *
 * The drain uploads rows one at a time and stops at the first failure, because
 * the usual failure is "no signal" — which fails identically for every row
 * behind it. That is right for a failure that will pass. It is *fatal* for one
 * that won't: the next pass reloads the same oldest rows in the same order, so
 * a document the server will never accept is retried first, forever, and
 * nothing behind it is ever sent. Closing the day needs an empty queue, so that
 * phone could never end a day again.
 *
 * Reachable, not theoretical: `firestore.rules` requires `createdByUid` to
 * equal the signed-in uid on every run document, and Settings' "Reset this
 * truck's setup" abandons a run without closing it. Sign in as a different
 * agent afterwards and the leftover rows carry the previous account's uid —
 * rejected permanently, every time.
 *
 * So failures are sorted into three:
 *
 * - `'permanent'` — the server understood and refused. Retrying cannot change
 *   the answer, so the row is quarantined and the queue moves on.
 * - `'transient'` — no answer, or an answer that says "not now". Never counted
 *   against a row: a truck in a dead zone all day would otherwise rack up
 *   hundreds of failures on a perfectly good row and quarantine it.
 *   `AppCheckUnverifiedError` is classed here so it can never be mistaken for
 *   a rules refusal, but it is the one kind the row's attempt count *is* spent
 *   on — bounded by `quarantineIfHopeless`, because an unbounded excuse is a
 *   day that can never be closed.
 * - `'unclear'` — anything unrecognised. Counted, and quarantined only after
 *   `MaxUploadAttempts` of them, so an unforeseen permanent failure still can't
 *   block the queue forever while a one-off oddity is forgiven.
 */
export type UploadFailureKind = 'permanent' | 'transient' | 'unclear';

/** Firestore codes meaning the request was understood and refused. */
const PermanentCodes = new Set(['permission-denied', 'invalid-argument']);

/** Firestore codes meaning "no answer" or "not now" — always worth retrying. */
const TransientCodes = new Set([
  'unavailable',
  'deadline-exceeded',
  'cancelled',
  'resource-exhausted',
  'internal',
  'aborted',
  'unauthenticated',
  'unknown',
]);

export function classifyUploadFailure(error: unknown): UploadFailureKind {
  // Our own timeout, which is what an offline write looks like — see
  // withTimeout below. Checked first: it carries no Firestore code.
  if (error instanceof SyncTimeoutError) return 'transient';
  if (error instanceof AppCheckUnverifiedError) return 'transient';

  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return 'unclear';
  if (PermanentCodes.has(code)) return 'permanent';
  if (TransientCodes.has(code)) return 'transient';
  return 'unclear';
}

/**
 * Rejects if the call hasn't answered within `CallTimeoutMs`.
 *
 * The underlying Firestore operation is **not** cancelled — it stays in the
 * SDK's queue and may well land later. That is fine and deliberate: every
 * upload is a `setDoc` at an id the phone chose, so a write that arrives after
 * we gave up and a re-send that arrives afterwards produce the identical
 * document. The row simply stays marked pending until an attempt is *seen* to
 * succeed, which is the honest state to be in.
 */
function withTimeout<T>(operation: string, work: Promise<T>, ms: number = CallTimeoutMs): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SyncTimeoutError(operation)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/**
 * The refusal codes App Check enforcement is capable of producing — **two,
 * because two products.** Firestore says `permission-denied` and Cloud Storage
 * says `storage/unauthorized` for the same event, and the proof photo is the
 * one upload that goes to Storage. Leaving it out would exempt from the check
 * below exactly the upload App Check hits hardest: a 150 KB photo on a weak
 * signal, drained last, when whatever briefly cost the phone its attestation is
 * most likely to still be true.
 */
const AppCheckDeniableCodes = new Set(['permission-denied', 'storage/unauthorized']);

/**
 * Is this refusal really App Check briefly having no token, rather than the
 * security rules refusing the write?
 *
 * The two arrive as the identical error and need opposite handling: a rules
 * refusal is set aside so the queue (and "End the Day") can move on; an App
 * Check refusal must keep being retried, because the row is fine and the device
 * just needs to reach Google Play again.
 *
 * A recent attestation miss (recorded by our own `getToken`) settles it for
 * free. Otherwise force a fresh attestation — the token may have been minted
 * locally but rejected by the backend for expiry, clock skew, a soft integrity
 * verdict, or App Check simply going unhealthy — and if one can't be had, the
 * refusal was App Check's. Bounded by `withTimeout`; a timeout counts as "not
 * obtainable", the safe direction, since it keeps the row queued rather than
 * writing it off.
 *
 * `false` for any code outside `AppCheckDeniableCodes`, so the caller can gate
 * on it without re-checking — a probe is a network round trip and must not run
 * for unrelated failures.
 */
export async function isRecoverableAppCheckDenial(error: unknown): Promise<boolean> {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string' || !AppCheckDeniableCodes.has(code)) return false;
  if (recentAppCheckFailure()) return true;
  return !(await appCheckHealthy());
}

/**
 * Can this phone attest right now?
 *
 * The same question `isRecoverableAppCheckDenial` asks, exposed on its own for
 * the one caller that has no failure in hand: the pass checking whether a row
 * set aside during an attestation outage can be let back into the queue.
 *
 * `false` on a timeout — the safe direction for both callers, since it keeps a
 * row queued rather than writing it off, and leaves a set-aside row set aside
 * rather than resurrecting it into a queue that still can't send it. Answers
 * from `firebase.ts`'s 60-second cache whenever a token was minted recently, so
 * asking on every pass costs nothing.
 */
export async function appCheckHealthy(): Promise<boolean> {
  try {
    return await withTimeout('verify this device', appCheckTokenObtainable());
  } catch {
    return false;
  }
}

/**
 * Runs one Firestore write that has **no row behind it** — the run header and
 * the closing manifest — and words an App Check refusal as one.
 *
 * Every other upload goes through `uploadOrSetAside` and reaches
 * `isRecoverableAppCheckDenial` on its way to being quarantined. These two
 * don't: there is no `sync_state` column to set aside, no attempt count to
 * spend, and nothing to quarantine — the header and the manifest are simply
 * retried until they land. So without this they are the one path where a
 * refusal caused by App Check still surfaces raw, as "Missing or insufficient
 * permissions" in the "End the Day" prompt, pointing the driver at the server
 * over something only a better signal can fix.
 *
 * That is not a corner: a run opened offline ("Use saved copy" at setup) has an
 * unsent header, and the pass writes it *before* the drains — so on a phone
 * that can't attest, the header is the first thing refused and the only thing
 * the driver is ever told about.
 *
 * Wording is all this changes. The failure still propagates, the write is still
 * retried, and nothing is set aside — there is nothing here to set aside.
 */
export async function withAppCheckWording<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (await isRecoverableAppCheckDenial(error)) throw new AppCheckUnverifiedError(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

let handler: (() => void) | null = null;

/**
 * Registered by context/sync.tsx on mount.
 *
 * A module-level hook rather than a React context on purpose: the stock,
 * receipts and customers contexts all need to say "something changed, go
 * upload", and routing that through context would force them all to sit
 * *inside* a sync provider. That constrains the provider tree for no benefit —
 * sync reads the databases directly and needs nothing from those contexts.
 */
export function setSyncHandler(fn: (() => void) | null): void {
  handler = fn;
}

/**
 * Nudges the sync loop. Safe to call from anywhere, including before the
 * provider mounts.
 *
 * Never throws, and that is depended on rather than merely tidy: every caller
 * runs it *after* its row is safely on disk, so a throw here would reject a
 * write that actually succeeded. The ledger's callers sit inside a retry
 * prompt, which would then offer to run the write again — asking the user to
 * repeat work that was already done, over a failure that has nothing to do
 * with their data.
 */
export function requestSync(): void {
  try {
    handler?.();
  } catch (error) {
    logError('sync.request', error);
  }
}

let customersChanged: (() => void) | null = null;

/**
 * Registered by context/customers.tsx.
 *
 * Pulling customers writes straight to SQLite, which the customers list in
 * memory knows nothing about — without this, a store another truck created
 * would sit on disk invisibly until the next app launch.
 */
export function setCustomersChangedHandler(fn: (() => void) | null): void {
  customersChanged = fn;
}

/**
 * Called after a pull actually changed something on disk.
 *
 * Never throws, for the same reason `requestSync` above doesn't — and here it
 * is load-bearing rather than tidy. This runs at the *end* of a successful
 * pull, so a throw escaping it would be caught by the pull's own catch and
 * reported as a failed download: the rows are on disk, the watermark has moved,
 * and the setup screen would still put "Retry / Use saved copy" in front of the
 * driver over data that arrived perfectly.
 */
export function notifyCustomersChanged(): void {
  try {
    customersChanged?.();
  } catch (error) {
    logError('sync.customersChanged', error);
  }
}

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------

/**
 * How long the sequence probe below is given before the phone stops asking.
 *
 * Much shorter than `CallTimeoutMs`, and for the opposite reason. A timed-out
 * *upload* has to be retried or the record is lost, so it is worth waiting for;
 * a timed-out probe just means the phone falls back to counting its own run log,
 * which is exactly what it did before this existed. Meanwhile a driver is
 * watching a spinner at the end of truck setup, so the wait is charged to them.
 * Six seconds matches the catalog fetches that ran immediately beforehand.
 */
const SequenceProbeTimeoutMs = 6_000;

/**
 * How many numbers are tried before the phone gives up and takes the last one.
 *
 * A truck goes out once or twice a day, so reaching even three is unusual and
 * ten is a fault. The cap exists so a strange state can't turn finishing setup
 * into an unbounded run of round trips.
 */
const MaxSequenceProbes = 10;

/** What `findFreeRunSequence` settled on, and whether Firestore actually said so. */
export type RunSequenceProbe = {
  sequence: number;
  /**
   * True only when Firestore answered and the id at `sequence` was genuinely
   * free. False means the phone is falling back to the caller's own count —
   * no signal, or every number tried was taken.
   */
  confirmed: boolean;
};

/**
 * The first run number of the day that isn't already taken in Firestore.
 *
 * The sequence suffix (`_2`, `_3` …) is what lets one account take the same people out
 * twice in a day without the second trip landing on the first trip's document
 * and overwriting its header and its manifest. Counting it from the phone's own
 * run log answers that correctly whenever the phone remembers the morning — and
 * silently wrongly when it doesn't:
 *
 * - a handset reinstalled, reset, or replaced between the two trips has an
 *   empty run log, so it counts 1 and recomputes the morning's id;
 * - two handsets sharing one login — which happens, and which the account
 *   segment of the id can't separate because it is the same account — each
 *   count only their own trips.
 *
 * It also settles the one collision the agents segment can't, since that
 * segment is made of *names* rather than ids: two agents who share a name (or
 * two names that flatten to one segment) compute the same base id, and the
 * second run is moved onto the next free number here exactly as a second trip
 * by the same people is.
 *
 * Both are exactly the collision the suffix exists to prevent, and both are
 * quiet: the child documents keep their phone-minted ids and survive, so
 * nothing looks broken until the server reads a manifest that describes the
 * wrong trip.
 *
 * So the log is used as the *starting* number and Firestore decides from there.
 * The local count still matters and is not redundant: a run whose header hasn't
 * uploaded yet — a morning spent out of signal — has no document to find, so
 * asking the server alone would hand back a number the phone already knows is
 * taken.
 *
 * **An id that exists is taken, whoever wrote it and whether or not it is
 * closed.** This is a deliberate change from the older behaviour, where a
 * reinstalled phone recomposed the morning's id and rejoined that run: it can't
 * really rejoin it, because a reinstall takes the local databases with it, so
 * the truck is re-counted from scratch and the "rejoined" run would close with
 * a manifest describing only the afternoon. A fresh number leaves the morning's
 * run open and unmanifested, which the dashboard shows as a run that never
 * ended — a visible loose end instead of a plausible wrong number.
 *
 * **Never rejects, and never blocks setup.** Truck setup has to work at a depot
 * with no signal, so a probe that fails or times out resolves with the caller's
 * own count and `confirmed: false`. That is the pre-existing behaviour, not a
 * degraded one.
 */
export async function findFreeRunSequence(
  agentNames: string[],
  account: string,
  at: number,
  from: number
): Promise<RunSequenceProbe> {
  let sequence = Math.max(1, Math.floor(from) || 1);

  for (let probe = 0; probe < MaxSequenceProbes; probe += 1) {
    const runId = composeRunId(agentNames, account, at, sequence);

    try {
      const snapshot = await withTimeout(
        'check the run number',
        getDoc(doc(db, RunsCollection, runId)),
        SequenceProbeTimeoutMs
      );
      if (!snapshot.exists()) return { sequence, confirmed: true };
    } catch (error) {
      // Logged, never alerted: nothing the driver can act on, and the fallback
      // is the number they would have got anyway. The details are what make
      // that line worth having — "the probe failed" says nothing, while the run
      // it was about to open, the number it settled on and the number the phone
      // asked for are enough to tell a depot with no signal apart from a run
      // that really is being numbered wrong.
      logError('sync.runSequence', error, { runId, agentNames, account, sequence, askedFrom: from });
      return { sequence, confirmed: false };
    }

    sequence += 1;
  }

  return { sequence, confirmed: false };
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * Creates or refreshes the run header — the document that groups one trip out.
 * Merged rather than overwritten so it can be re-sent safely without erasing
 * the manifest a later "End the Day" writes onto the same document.
 *
 * Only ever called for the run that is currently *open*. It writes
 * `status: 'open'`, so re-sending it for a run that has already been closed
 * would reopen it — see the drain in context/sync.tsx, which is deliberately
 * written to skip it for anything but the open run.
 */
export async function uploadRunHeader(ctx: RunContext, timeoutMs: number = CallTimeoutMs): Promise<void> {
  await withTimeout('start the day', setDoc(
    doc(db, RunsCollection, ctx.runId),
    {
      schemaVersion: SchemaVersion,
      runId: ctx.runId,
      businessDay: ctx.businessDay,
      // Which trip of the day this is: 1, then 2 if the same people go back out.
      sequence: ctx.sequence,
      truckId: ctx.truckId,
      truckName: ctx.truckName,
      agentIds: ctx.agentIds,
      agents: ctx.agents,
      createdByUid: ctx.createdByUid,
      // The account is part of the run id, but flattened to be id-safe. This is
      // the readable form — what the dashboard shows when it lists the two runs
      // that appear if two phones picked the same truck.
      createdByEmail: ctx.createdByEmail,
      startedAt: ctx.startedAt,
      status: 'open',
      uploadedAt: serverTimestamp(),
    },
    { merge: true }
  ), timeoutMs);
}

/**
 * Closes the run and records what the device believes it produced.
 *
 * The manifest is the point: the dashboard counts the documents that actually
 * arrived and compares. A run whose manifest says 47 receipts but holds 45 is
 * visibly incomplete, with no acknowledgement protocol and nothing to trust
 * about the upload path.
 */
export async function closeRun(stamp: RunStamp, manifest: RunManifest, closedAt: number): Promise<void> {
  try {
    await withTimeout('end the day', setDoc(
      doc(db, RunsCollection, stamp.runId),
      {
        status: 'closed',
        closedAt,
        // The Manila day the run *ended* on, computed on the phone like every
        // other day key in this app. A run may now stay open across midnight —
        // the truck goes out Monday and comes back Wednesday — so `businessDay`
        // (the day it started) is no longer enough to say when it finished, and
        // the dashboard must never re-derive a day from a timestamp in whatever
        // timezone the browser happens to be in.
        closedBusinessDay: businessDayKey(closedAt),
        manifest,
        uploadedAt: serverTimestamp(),
      },
      { merge: true }
    ), CloseTimeoutMs);
  } catch (error) {
    if (!(error instanceof SyncTimeoutError)) throw error;
    // The write was not cancelled — `withTimeout` never cancels one (see its
    // comment). So a timeout here means "no answer yet", which is not the same
    // as "did not happen": the write may be with the server already, or may
    // have landed on an earlier attempt whose acknowledgement never came back.
    //
    // Reporting that as a failure is what split a run in half in production.
    // The manifest reached Firestore, the driver was told the day could not be
    // ended, and `endRun` — the local half, the one that actually clears the
    // truck — never ran. The server saw a closed day; the phone kept stamping
    // the next morning's work with the same run.
    //
    // So before giving up, ask the server outright. If the run is already
    // closed there, the close is done and the caller may go on to clear the
    // truck. If it isn't (or we can't reach the server to find out), the
    // timeout stands and the retry prompt gets it, unchanged.
    if (await runClosedOnServer(stamp.runId)) return;
    throw error;
  }
}

/**
 * Does the server already have this run as closed?
 *
 * `getDocFromServer`, never a plain `getDoc`: the default source falls back to
 * the SDK's own cache, and the cache is exactly where our own timed-out write
 * is sitting — so a plain read would cheerfully report the run closed on the
 * strength of a write that has not left the phone. The same trap
 * `assertFromServer` exists for on the catalog reads.
 *
 * `false` on any failure, which is the safe direction both ways: an unreachable
 * server means the close is unconfirmed, and an unconfirmed close must leave
 * the run open on the phone rather than clear a truck whose day the server has
 * never heard about.
 */
async function runClosedOnServer(runId: string): Promise<boolean> {
  try {
    const snapshot = await withTimeout(
      'check whether the day was already ended',
      getDocFromServer(doc(db, RunsCollection, runId)),
      CloseTimeoutMs
    );
    return snapshot.exists() && snapshot.get('status') === 'closed';
  } catch (error) {
    logError('sync.closeRun.verify', error, { runId });
    return false;
  }
}

/**
 * One ledger entry — the initial count, a mid-route addition, or the negative
 * entry a finalized receipt appends.
 *
 * Sale entries are uploaded even though the matching receipt already lists what
 * was sold. That redundancy is deliberate: finalizing writes to two databases
 * in two transactions, so a crash between them leaves a receipt whose stock was
 * never deducted. Uploading the ledger as its own record keeps the two
 * comparable in the cloud, so that gap shows up as a mismatch instead of
 * vanishing into a derived number.
 */
export async function uploadStockEntry(stamp: RunStamp, batch: Batch, receiptId: string | null): Promise<void> {
  await withTimeout('send an inventory entry', setDoc(doc(db, RunsCollection, stamp.runId, StockEntriesCollection, batch.id), {
    schemaVersion: SchemaVersion,
    entryId: batch.id,
    kind: batch.kind,
    // Quantities arrive already signed — negative for a sale — so the cloud
    // sums the ledger exactly the way SQLite does on the phone.
    items: batch.items.map((item) => ({ breadTypeId: item.breadTypeId, quantity: item.quantity })),
    receiptId,
    createdAt: batch.createdAt,
    businessDay: businessDayKey(batch.createdAt),
    ...stampFields(stamp),
    uploadedAt: serverTimestamp(),
  }));
}

/**
 * The proof-of-payment photo for one GCash or cheque receipt.
 *
 * The only upload in this app that sends bytes to Cloud Storage rather than a
 * document to Firestore, and it keeps the same two properties as the rest:
 *
 * - **The path is derived from the receipt id**, so re-sending overwrites the
 *   same object instead of leaving a second copy behind. That is the Storage
 *   equivalent of `setDoc` at a minted id, and it is what makes the retry
 *   policy safe to be as simple as "try again". A random name per attempt would
 *   accumulate orphaned megabytes nobody could find.
 * - **`createdByUid` rides along as custom metadata**, because `storage.rules`
 *   requires it to match the signed-in account — the same check the Firestore
 *   rules make on every run document, refused in the same way and fixed from
 *   the same Settings button.
 *
 * A photo whose file has gone missing — storage cleared, the OS reclaiming an
 * app directory — throws a plain Error rather than a Firestore-coded one, so
 * `classifyUploadFailure` files it under `'unclear'`: retried a few times in
 * case it is a transient read failure, then set aside. That is the right shape,
 * because nothing can bring those bytes back and blocking the queue on them
 * would stop the day being closed.
 */
export async function uploadPaymentProof(
  stamp: RunStamp,
  proof: PendingPaymentProof,
  uid: string
): Promise<string> {
  const file = new File(proof.localUri);
  if (!file.exists) {
    throw new Error(`The photo for receipt ${proof.receiptId} is no longer on this phone.`);
  }

  const blob = await readFileAsBlob(proof.localUri, proof.receiptId);
  const path = paymentProofPath(proof.receiptId);

  try {
    await withTimeout(
      'send a payment photo',
      uploadBytes(storageRef(storage, path), blob, {
        contentType: 'image/jpeg',
        // Strings only — Storage custom metadata has no other type. The run
        // identity is repeated here for the same reason every child document
        // repeats it: an object has to be interpretable on its own, and this is
        // the only record attached to the file itself.
        customMetadata: {
          receiptId: proof.receiptId,
          runId: stamp.runId,
          businessDay: stamp.businessDay,
          truckId: stamp.truckId,
          createdByUid: uid,
        },
      }),
      UploadTimeoutMs
    );
  } finally {
    // React Native blobs hold a native allocation the JS garbage collector
    // knows nothing about, so it is released by hand. In the `finally` because
    // a failed upload is retried from the top and re-reads the file anyway.
    (blob as { close?: () => void }).close?.();
  }

  return path;
}

/**
 * Reads a local file into a React Native `Blob`.
 *
 * **It has to be a Blob, and specifically not a `Uint8Array`.** That is a hard
 * constraint of the Firebase JS SDK on React Native, not a preference:
 * `uploadBytes` assembles its multipart body with
 * `new Blob([header, payload, footer])`, and React Native's Blob refuses to be
 * built from an `ArrayBuffer` or a typed array — it throws "Creating blobs from
 * 'ArrayBuffer' and 'ArrayBufferView' are not supported"
 * (react-native/Libraries/Blob/BlobManager.js). Handing the SDK bytes therefore
 * fails inside `uploadBytes`, which makes it look like a Storage or a rules
 * problem when it is neither. A native Blob is a legal part, so the concat
 * works. `expo-file-system`'s `File` is not one either, despite implementing
 * the `Blob` interface — RN checks `instanceof`.
 *
 * XHR rather than `fetch(uri).blob()`: RN's fetch is a polyfill over this same
 * request, and going direct skips the `Response` layer that is the part with a
 * history of getting `file://` wrong on Android. The blob it hands back is
 * backed by the file on disk rather than by a copy on the JS heap, so a photo
 * never has to fit in memory twice.
 */
function readFileAsBlob(uri: string, receiptId: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', uri, true);
    request.responseType = 'blob';
    request.onload = () => {
      const blob = request.response as Blob | null;
      // A zero-byte read is a failure that would otherwise upload happily and
      // leave the server with an empty file it can't tell from a real one.
      if (!blob || blob.size === 0) {
        reject(new Error(`The photo for receipt ${receiptId} could not be read from this phone.`));
        return;
      }
      resolve(blob);
    };
    request.onerror = () =>
      reject(new Error(`The photo for receipt ${receiptId} could not be read from this phone.`));
    request.send(null);
  });
}

/** One finalized receipt, line items included — a receipt is a single document, never a document plus a row per line. */
export async function uploadReceipt(stamp: RunStamp, receipt: PendingReceipt): Promise<void> {
  await withTimeout('send a receipt', setDoc(doc(db, RunsCollection, stamp.runId, ReceiptsCollection, receipt.id), {
    schemaVersion: SchemaVersion,
    receiptId: receipt.id,
    customerId: receipt.customerId,
    customerName: receipt.customerName,
    customerContactName: receipt.customerContactName,
    items: receipt.items.map((item) => ({
      breadTypeId: item.breadTypeId,
      name: item.name,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
    })),
    returns: receipt.returns.map((line) => ({
      returnedBreadTypeId: line.returnedBreadTypeId,
      name: line.name,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
    })),
    subtotal: receipt.subtotal,
    returnsTotal: receipt.returnsTotal,
    total: receipt.total,
    paymentMethod: receipt.paymentMethod,
    amountPaid: receipt.amountPaid,
    // Who was on the truck, snapshotted onto the receipt when it was finalized
    // and sent as its own field rather than left to be resolved from the run:
    // this is what was printed on the paper the customer is holding, which a
    // later rename must never contradict. It is also on the child document for
    // the same reason every stamp field is — the store history (a
    // collection-group query, see firestore.rules) reads receipts without ever
    // opening their runs.
    //
    // Null on every receipt finalized before it was recorded — nothing is
    // backfilled, so the dashboard has to treat it as optional. (Those older
    // receipts carry `agentGroupName` — the crew, from before crews were
    // removed — instead.)
    agentNames: receipt.agentNames,
    // When the driver voided it, or null. A void re-queues the receipt (see
    // markVoided in lib/receipt-db.ts), so a receipt the server already has is
    // sent again with this filled in — the dashboard leaves any receipt carrying
    // it out of every total, and still lists it.
    voidedAt: receipt.voidedAt,
    createdAt: receipt.createdAt,
    finalizedAt: receipt.finalizedAt,
    // Where the proof photo landed in Cloud Storage, or null — either because
    // this receipt has no photo, or because the photo hasn't uploaded yet.
    //
    // Never guessed from the receipt id, always the path a *completed* upload
    // reported: the dashboard resolves a download URL straight from this, so a
    // path written before the bytes arrived would show as a broken image rather
    // than as "no photo". markPaymentProofSynced re-queues the receipt once the
    // photo lands, which is what fills this in on a receipt that was uploaded
    // before the driver took the picture.
    proofStoragePath: receipt.proofStoragePath,
    businessDay: businessDayKey(receipt.createdAt),
    ...stampFields(stamp),
    uploadedAt: serverTimestamp(),
  }));
}

/**
 * One expense — what the truck spent on this trip out.
 *
 * A child of the run, like a ledger entry, because that is what it is: money
 * spent during one trip, by one truck, on one day. It carries `deleted` for the
 * same reason a customer does — `firestore.rules` refuses every delete under
 * `/runs`, so an expense the driver removed has to travel as a *change* rather
 * than as an absence the server would have to notice.
 *
 * Merged rather than overwritten, so re-sending a row that was deleted after its
 * first upload can only ever add the flag.
 */
export async function uploadExpense(stamp: RunStamp, expense: PendingExpense): Promise<void> {
  await withTimeout('send an expense', setDoc(
    doc(db, RunsCollection, stamp.runId, ExpensesCollection, expense.id),
    {
      schemaVersion: SchemaVersion,
      expenseId: expense.id,
      title: expense.title,
      // Always positive. Expenses are never netted off anything — see
      // lib/expense-types.ts — so there is no signed form of this number.
      amount: expense.amount,
      notes: expense.notes,
      createdAt: expense.createdAt,
      updatedAt: expense.updatedAt,
      deleted: expense.deleted,
      businessDay: businessDayKey(expense.createdAt),
      ...stampFields(stamp),
      uploadedAt: serverTimestamp(),
    },
    { merge: true }
  ));
}

/**
 * One customer. Top-level, not under a run — a store belongs to the business,
 * not to the day somebody happened to create it.
 *
 * `deleted` rides along as a field because deletes have to be soft: a hard
 * delete is absent from the watermark query below, so an offline device would
 * never learn the store is gone.
 */
export async function uploadCustomer(uid: string, customer: PendingCustomer): Promise<void> {
  await withTimeout('send a store', setDoc(
    doc(db, CustomersCollection, customer.id),
    {
      schemaVersion: SchemaVersion,
      storeName: customer.storeName,
      name: customer.name,
      address: customer.address,
      phone: customer.phone,
      schedule: customer.schedule,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      deleted: customer.deleted,
      updatedByUid: uid,
      uploadedAt: serverTimestamp(),
    },
    { merge: true }
  ));
}

/** The run identity every child document repeats — see RunStamp for why. */
function stampFields(stamp: RunStamp) {
  return {
    runId: stamp.runId,
    truckId: stamp.truckId,
    agentIds: stamp.agentIds,
    createdByUid: stamp.createdByUid,
  };
}

// ---------------------------------------------------------------------------
// Customer pull
// ---------------------------------------------------------------------------

export async function readCustomerWatermark(): Promise<number> {
  const raw = await AsyncStorage.getItem(CustomerWatermarkKey);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function writeCustomerWatermark(at: number): Promise<void> {
  await AsyncStorage.setItem(CustomerWatermarkKey, String(at));
}

/**
 * Customers changed since the last successful pull — stores another truck's
 * agent created or edited.
 *
 * A watermark query rather than reading the whole collection, so a device that
 * syncs regularly downloads almost nothing. `updatedAt` is the device clock of
 * whichever phone wrote the row, which is fine for this purpose: it only has to
 * order changes well enough for last-write-wins, and the local upsert refuses
 * to move a row backwards regardless.
 *
 * Soft-deleted rows come back too, and must — that is how a delete travels.
 *
 * **`>=`, not `>`, and that is deliberate.** The result set is capped at `max`,
 * so a catch-up walks it a page at a time with the last row's `updatedAt` as
 * the next cursor. With a strict `>`, two stores written in the same
 * millisecond that land either side of a page boundary lose the second one
 * *permanently* — it is behind the cursor from then on, and nothing ever asks
 * for it again. `>=` re-reads the boundary row instead (normally one document),
 * and re-reading costs nothing: `upsertCustomerFromServer` is a no-op for a row
 * the phone already has at that version, so it doesn't even rebuild the list.
 */
export async function pullCustomers(since: number, max: number): Promise<PendingCustomer[]> {
  const snapshot = await withTimeout(
    'fetch stores',
    getDocs(
      query(
        collection(db, CustomersCollection),
        where('updatedAt', '>=', since),
        orderBy('updatedAt'),
        limitTo(max)
      )
    )
  );

  // An offline `getDocs` resolves out of the SDK's own cache instead of
  // rejecting, so without this a pull with no signal returned an empty page,
  // the caller broke out of its paging loop, and truck setup ticked "Stores"
  // off as downloaded having downloaded nothing. Nothing is lost when it
  // throws — pullCustomerUpdates catches it and reports 'cache'/'none', and
  // the watermark hasn't moved, so the missed stores arrive next time.
  assertFromServer(snapshot.metadata);

  return snapshot.docs.map((snap) => {
    const data = snap.data();
    return {
      id: snap.id,
      storeName: (data.storeName as string) ?? '',
      name: (data.name as string) ?? '',
      address: (data.address as string) ?? '',
      phone: (data.phone as string) ?? '',
      schedule: (data.schedule as string) ?? '',
      createdAt: (data.createdAt as number) ?? 0,
      updatedAt: (data.updatedAt as number) ?? 0,
      deleted: data.deleted === true,
      // Never true for a store arriving from the server, whoever wrote it
      // originally: the flag is one handset's note to itself about its own
      // screen, it isn't part of the document, and `upsertCustomerFromServer`
      // doesn't write the column — so a store this phone added keeps its own
      // answer when its copy comes back down. See lib/customer-db.ts.
      isNew: false,
    };
  });
}
