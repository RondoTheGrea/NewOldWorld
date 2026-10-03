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
  areaId: string;
  truckId: string;
  /**
   * The crew assigned to the run. A truck is assigned a whole group, never a
   * hand-picked set of people, so this is what "who was out" is filed under.
   */
  agentGroupId: string;
  /**
   * Who was in that crew **at the moment the run opened**.
   *
   * Kept alongside the group id rather than resolved from it later, because
   * the two answer different questions and only one of them stays true: a
   * person moved to another crew next week must not retroactively change who
   * was on the truck today.
   */
  agentIds: string[];
  createdByUid: string;
};

/** The run header, plus the display names captured when the run started. */
export type RunContext = RunStamp & {
  areaName: string;
  truckName: string;
  /** The crew's name as it read when the run started — see agentGroupId. */
  agentGroupName: string;
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
 * The crew segment is a typed *name*, so it does flatten — a space and a `/`
 * both become `-`, which makes "Team A" and "Team-A" one segment. That is
 * covered rather than ignored: `finalizeSetup` counts a day's runs through this
 * same function, so two names that flatten together are numbered as one crew
 * and take `_2` instead of colliding. Exported for exactly that.
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
 * The id of the run a phone is on for a given moment.
 *
 * Composed rather than generated — `2026-08-15_Alpha-Crew_juan@bakery.ph` — so
 * it can be read: a run id says on its face which day, which crew and which
 * account it belongs to, which is what makes a stray document traceable without
 * a lookup table.
 *
 * **The crew segment is the crew's name, not its document id.** That is the
 * whole point of composing the id at all: `grp_9f2a1c` is only readable next to
 * the crew list it came from, which is the lookup this is meant to avoid. The
 * name is captured at the moment the run opens, so renaming a crew afterwards
 * doesn't move an open run — the id is pinned into the setup and never
 * recomposed — and the crew's real id is still stamped on the run and on every
 * child document as `agentGroupId`, which is what the dashboard groups by.
 *
 * A name is not unique the way an id is, and that is handled by `sequence`
 * rather than avoided: two different crews sharing a name, taken out by one
 * account on one day, compute the same base id, and the second gets `_2` from
 * the same machinery a crew's own second trip uses.
 *
 * It used to be composed for a second reason — so a phone reinstalled mid-day
 * could fill the wizard in again and recompute its way back onto the same run
 * document. That no longer happens, and shouldn't: a reinstall takes the local
 * databases with it, so the truck is counted from scratch and the rejoined run
 * would have closed with a manifest describing only the second half of its own
 * day. `findFreeRunSequence` in lib/sync.ts moves such a phone onto the next
 * free number instead, leaving the morning's run open and unmanifested for the
 * server to see.
 *
 * **The subject is the crew, not the truck.** A run is a crew's trip out: the
 * crew is what the server compares day to day (see the dashboard's "net takings
 * by crew"), and it is the part of the setup a driver is least likely to get
 * wrong, because the picker makes them open the crew and read its members
 * before it will confirm. The truck can change under a crew mid-day — a
 * breakdown, a swap at the depot — and keying the id to it would file the same
 * trip under two names. `truckId` is still stamped on the run and on every
 * child document, so nothing about grouping a day by truck is lost.
 *
 * The day comes from `businessDayKey`, so it is a *Manila* day. Deriving it
 * from the device's own timezone would put a 6:30 AM run into the previous
 * day's document — see lib/business-day.ts.
 *
 * Two suffixes, each preventing a different collision:
 *
 * - **`account` is what keeps two phones off each other's run.** Two agents can
 *   pick the same crew on the same day — one of them by mistake — and without
 *   this both compute the same id and share one document: the second phone's
 *   header overwrites the first's, and whichever ends the day last overwrites
 *   the other's manifest. Keyed on the login rather than on the device so a
 *   reinstall rejoins the same run; a run is one *account's* trip. Optional
 *   only so a run opened before this existed still recomputes its old id.
 * - **`sequence` is what allows the same account to take the same crew out
 *   twice in one day.** The first run carries no suffix, so the common case
 *   stays short; a second appends `_2`, a third `_3`. The counter is per
 *   business day and resets with it, and it counts the *crew's* runs, so a crew
 *   that changes trucks between trips still numbers 1 then 2 rather than
 *   starting again at 1 under the new truck.
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
  agentGroupName: string,
  account: string,
  at: number = Date.now(),
  sequence: number = 1
): string {
  return compose(agentGroupName, account, at, sequence);
}

/**
 * The id a run *used* to get, when the truck rather than the crew was the
 * subject.
 *
 * Only ever called for a run that was already open when this build was
 * installed: its setup carries no pinned `runId`, and every ledger entry and
 * receipt already written under it is stamped with the truck-keyed id. Deriving
 * a crew-keyed id for that run instead would leave those rows pointing at a run
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
