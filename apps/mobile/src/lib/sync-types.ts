import { businessDayKey } from '@/lib/business-day';

/**
 * The shapes that leave this phone, and the rule that names a run.
 *
 * Kept separate from lib/sync.ts (which does the uploading) so the shapes can
 * be imported anywhere — including by the web stubs — without dragging the
 * Firestore SDK along.
 */

/** Bumped only if an uploaded shape changes incompatibly. Written on every document. */
export const SchemaVersion = 1;

/** A run is open until "End the Day" closes it. */
export type RunStatus = 'open' | 'closed';

/**
 * What the device believes it produced during the run, uploaded when the day
 * is closed. The dashboard compares these counts against the documents that
 * actually arrived — that comparison is the whole completeness check, and it
 * needs no acknowledgement protocol between phone and server.
 */
export type RunManifest = {
  /** Receipts that stand — voided ones are counted in `voidedReceiptCount` instead. */
  receiptCount: number;
  /**
   * Receipts the driver voided. Kept out of `receiptCount`, `salesTotal` and
   * `returnsTotal`, which are business figures the Trends tab charts; the two
   * counts together are every receipt document the run sent.
   */
  voidedReceiptCount: number;
  stockEntryCount: number;
  customerCount: number;
  salesTotal: number;
  returnsTotal: number;
  /**
   * Expense documents this run produced — **including ones the driver deleted**,
   * because this is the number the dashboard checks against the documents that
   * arrived, and a deleted expense is still a document (deletes are soft; see
   * lib/expense-db.ts).
   */
  expenseCount: number;
  /**
   * What the truck spent, deleted expenses excluded — the opposite set from
   * `expenseCount`, because this one is about money rather than documents.
   *
   * Reported, never subtracted. Expenses are informational everywhere: no total
   * on this phone or on the dashboard nets them off sales.
   */
  expenseTotal: number;
  /**
   * Proof-of-payment photos this run produced.
   *
   * Counted through the receipts they hang off, so the dashboard can tell a
   * photo that never arrived from one that was never taken — without it, "no
   * photo on this GCash receipt" and "the photo is lost" look identical.
   */
  paymentProofCount: number;
  /** Still queued on this phone at the moment the day was closed. 0 is the happy path. */
  pendingUploadCount: number;
  /**
   * Records the server **refused**, which this phone has stopped retrying.
   *
   * Without it, a refused record is indistinguishable from a lost one: both
   * show up as a manifest count higher than the documents that arrived, and the
   * server has no way to tell "this phone knows these two were rejected" from
   * "two receipts vanished somewhere". They are different problems with
   * different fixes, so the phone says which it is.
   *
   * Counted per run for receipts and ledger entries. Stores are not run data,
   * so *every* refused store on the device is included — there is no honest way
   * to attribute one to a trip.
   */
  blockedUploadCount: number;
};

/**
 * Everything a child document needs to repeat about its run.
 *
 * Every stock entry and receipt carries a copy of this, even though the parent
 * run document already holds it. Two reasons: it makes every dashboard query
 * one hop instead of two, and it means a document that arrives *before* its
 * parent run — uploads land in whatever order the signal allows — is still
 * completely interpretable on its own.
 */
export type RunStamp = {
  runId: string;
  businessDay: string;
  truckId: string;
  /**
   * Who was on the truck — the agents the driver ticked on the setup screen,
   * one by one, from the list the dashboard keeps.
   *
   * Captured when the run opens and never re-resolved: an agent renamed or
   * removed next week must not change who was on the truck today.
   */
  agentIds: string[];
  createdByUid: string;
};

/** The run header, plus the display names captured when the run started. */
export type RunContext = RunStamp & {
  truckName: string;
  agents: { id: string; name: string }[];
  startedAt: number;
  /**
   * Which run of the day this is for this truck — 1 for the first, 2 for a
   * truck that went back out. It is already implied by the run id's suffix, but
   * uploaded as a field so the dashboard can label and order a day's runs
   * without parsing ids.
   */
  sequence: number;
  /**
   * The login the run was opened under, as typed. The run id carries a
   * flattened form of it; this is the readable one for the dashboard.
   */
  createdByEmail: string;
};

/**
 * Makes a value safe to put in a Firestore document id. Ids may not contain
 * `/`, may not be `.` or `..`, and may not match `__.*__`; a composed run id
 * always starts with the business day, so only the first rule can bite.
 *
 * **This has to be injective — two different values must never come out the
 * same.** The account segment exists to keep two logins off each other's run,
 * and any lossy mapping quietly hands that collision back. Two earlier
 * versions were lossy in exactly that way: deleting punctuation merged
 * `juan.delacruz@` with `juandelacruz@`, and replacing it with `-` merged
 * `juan.delacruz@` with `juan-delacruz@`.
 *
 * So the allowed set is widened to everything a real address uses —
 * `.`, `@`, `+` and `%` are all legal in a document id — and characters land
 * on `-` only if they are outside it, which for an email means never. The
 * residual risk is theoretical rather than clerical: it needs two accounts
 * differing only in characters no address actually contains.
 *
 * The agents segment is made of typed *names*, so it does flatten — a space and
 * a `/` both become `-`, which makes "Juan Cruz" and "Juan-Cruz" one segment.
 * That is covered rather than ignored: `finalizeSetup` counts a day's runs
 * through the same segment, so two lists that flatten together are numbered as
 * one and take `_2` instead of colliding.
 */
export function runIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._@+%-]/g, '-') || 'unknown';
}

function compose(subject: string, account: string, at: number, sequence: number): string {
  const head = `${businessDayKey(at)}_${runIdSegment(subject)}`;
  const base = account ? `${head}_${runIdSegment(account)}` : head;
  return sequence > 1 ? `${base}_${sequence}` : base;
}

/**
 * The segment of a run id that says who was on the truck: each ticked agent's
 * name, flattened by `runIdSegment`, joined with `+` — `Juan+Pedro-Santos`.
 *
 * The agents arrive in the dashboard's own order (the setup screen keeps them
 * that way), so the same people always make the same segment however the
 * driver happened to tick them. `+` is legal in a document id and never made
 * by `runIdSegment` out of a space, so where one name ends stays readable.
 */
export function agentsRunIdSegment(agentNames: string[]): string {
  return agentNames.map(runIdSegment).join('+') || 'unknown';
}

/**
 * The id of the run a phone is on for a given moment.
 *
 * Composed rather than generated — `2026-08-15_Juan+Pedro_juan@bakery.ph` — so
 * it can be read: a run id says on its face which day, who was on the truck
 * and which account it belongs to, which is what makes a stray document
 * traceable without a lookup table.
 *
 * **The middle segment is the ticked agents' names, not their document ids**
 * (see `agentsRunIdSegment`), for the same reason: an id is only readable next
 * to the list it came from. The names are captured when the run opens and the
 * id is pinned into the setup and never recomposed, so renaming an agent
 * afterwards doesn't move an open run. The real ids are still stamped on the
 * run and on every child document as `agentIds`.
 *
 * (Runs opened while crews existed were keyed on the crew's name instead.
 * Their ids are pinned, so they keep them; nothing recomposes an old id.)
 *
 * The day comes from `businessDayKey`, so it is a *Manila* day. Deriving it
 * from the device's own timezone would put a 6:30 AM run into the previous
 * day's document — see lib/business-day.ts.
 *
 * Two suffixes, each preventing a different collision:
 *
 * - **`account` is what keeps two phones off each other's run.** Two phones can
 *   tick the same people on the same day — one of them by mistake — and
 *   without this both compute the same id and share one document: the second
 *   phone's header overwrites the first's, and whichever ends the day last
 *   overwrites the other's manifest. Keyed on the login rather than on the
 *   device so a reinstall rejoins the same run; a run is one *account's* trip.
 * - **`sequence` is what allows the same account to take the same people out
 *   twice in one day** (or two agents sharing a name). The first run carries
 *   no suffix; a second appends `_2`, a third `_3`. The counter is per
 *   business day and resets with it.
 *
 *   Where the number comes from is deliberately two-sided — `finalizeSetup` in
 *   context/inventory.tsx counts this phone's own run log, then
 *   `findFreeRunSequence` in lib/sync.ts asks Firestore whether that number is
 *   free and moves past it if not. Counting locally alone misses a run this
 *   handset has no memory of (reinstalled between trips, or a second handset on
 *   the same login); asking the server alone misses a run whose header hasn't
 *   uploaded yet. Either miss recomposes an id that is already in use, which is
 *   the collision this suffix exists to prevent.
 */
export function composeRunId(
  agentNames: string[],
  account: string,
  at: number = Date.now(),
  sequence: number = 1
): string {
  // Already a segment, so it goes through `compose` as-is: runIdSegment leaves
  // `+` and `-` alone, so flattening it a second time changes nothing.
  return compose(agentsRunIdSegment(agentNames), account, at, sequence);
}

/**
 * The id a run got before ids were composed from *names* — keyed on the
 * truck's document id.
 *
 * Only ever called for a run that was already open when this build was
 * installed: its setup carries no pinned `runId`, and every ledger entry and
 * receipt already written under it is stamped with the truck-id-keyed id.
 * Deriving a name-keyed id for that run instead would leave those rows pointing at a run
 * the phone no longer believes in — un-uploadable, and silently so. A run
 * opened from now on pins its id at setup, so nothing new reaches this.
 */
export function composeLegacyTruckRunId(
  truckId: string,
  account: string,
  at: number = Date.now(),
  sequence: number = 1
): string {
  return compose(truckId, account, at, sequence);
}
