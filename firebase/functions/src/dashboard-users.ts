import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { type DocumentReference, FieldValue, getFirestore, type Transaction } from 'firebase-admin/firestore';
import { type CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

/**
 * Dashboard staff management — the client's own admin adds and removes the
 * people who can open the dashboard, without anybody touching the Firebase
 * console.
 *
 * WHY THIS IS SERVER-SIDE AT ALL. Creating a user with the browser SDK
 * (`createUserWithEmailAndPassword`) signs the *current tab* in as the new
 * account — so an admin adding a colleague would be thrown out of their own
 * session and land in the new person's empty one. The Admin SDK has no such
 * side effect: it mints the account out-of-band and leaves the caller exactly
 * where they were. Listing other people's accounts is here for a different
 * reason: `firestore.rules` deliberately lets an account read only its *own*
 * `users/{uid}` doc, and a roster page shouldn't be a reason to widen that.
 *
 * WHO MAY CALL THESE. Every function below goes through `requireAdmin`, which
 * demands `role: 'dashboard'` AND `admin: true` on the caller's own user doc.
 * The dashboard also hides the Team page from non-admins, but that is a
 * courtesy — this check is the one that actually holds, because it runs on a
 * machine the caller does not control.
 */

if (getApps().length === 0) {
  initializeApp();
}

const db = () => getFirestore();
const adminAuth = () => getAuth();

/** Where a browser's claim on an account is recorded. See `claimDashboardSession`. */
const SessionCollection = 'dashboardSessions';

const MaxDisplayNameLength = 80;

/**
 * Strips anything a keyboard can't type but a clipboard can — control codes,
 * zero-width characters, the bidi overrides that make stored text display as
 * something other than what it holds — then caps the length. Same reasoning as
 * `apps/mobile/src/lib/text-input.ts`: these names end up on a roster other
 * people read and act on.
 */
function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MaxDisplayNameLength);
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

// Deliberately loose. Firebase itself is the authority on whether an address is
// acceptable (it rejects a bad one at create time with a clear code); this only
// catches the obvious typo before we spend a round trip on it.
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * The caller must be a signed-in dashboard account carrying `admin: true`.
 * Returns their uid, which every caller needs anyway for the "you can't do this
 * to yourself" guards.
 */
async function requireAdmin(request: CallableRequest): Promise<string> {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const data = (await db().collection('users').doc(uid).get()).data();
  if (data?.role !== 'dashboard' || data?.admin !== true) {
    throw new HttpsError('permission-denied', 'Only a dashboard administrator can manage the team.');
  }
  return uid;
}

/** Auth records for a batch of uids. `getUsers` caps at 100 per call. */
async function fetchAuthRecords(uids: string[]): Promise<Map<string, UserRecord>> {
  const found = new Map<string, UserRecord>();
  for (let i = 0; i < uids.length; i += 100) {
    const result = await adminAuth().getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })));
    for (const record of result.users) found.set(record.uid, record);
  }
  return found;
}

/** The Firestore half of the roster: every account tagged as a dashboard admin. */
function adminQuery() {
  // Two equality filters need no composite index; Firestore serves them from
  // the automatic single-field ones.
  return db().collection('users').where('role', '==', 'dashboard').where('admin', '==', true);
}

/**
 * The administrators who could actually sign in right now.
 *
 * **Not simply a count of `admin: true` docs**, and the difference is the whole
 * point. An admin whose Auth account has been disabled — or deleted from the
 * console — still carries the flag on their Firestore doc, so counting docs
 * would report two administrators when only one of them can reach the Team
 * page, and cheerfully let that one be removed. The guard below is described as
 * making lockout impossible; it has to count the people who can actually
 * unlock things.
 */
async function eligibleAdminUids(): Promise<string[]> {
  const uids = (await adminQuery().get()).docs.map((snapshot) => snapshot.id);
  if (uids.length === 0) return [];
  const records = await fetchAuthRecords(uids);
  return uids.filter((uid) => {
    const record = records.get(uid);
    return record !== undefined && !record.disabled;
  });
}

/**
 * Every team change that could remove somebody's access runs through here.
 *
 * It does two jobs that neither half can do alone:
 *
 *   1. **The target must be a dashboard account.** The uid arrives from the
 *      caller, and without this check `deleteUser`/`updateUser` would run
 *      against *any* uid in the project — a driver's included. Deleting a
 *      driver's account doesn't just stop them signing in: `firestore.rules`
 *      requires `createdByUid == request.auth.uid`, so any run they had open
 *      could never be closed by anyone, ever. Nothing about a team-management
 *      screen should be able to reach a phone account.
 *
 *   2. **The last administrator is protected**, so the Team page can never
 *      become unreachable by everyone — which would put the client back in the
 *      Firebase console, the one outcome this feature exists to prevent.
 *
 * Worth knowing when the second one actually fires, because it is rarer than it
 * looks. A caller is always an administrator (`requireAdmin`) and can never
 * target themselves (each function refuses that first), so the ordinary path
 * always leaves at least the caller behind — one admin cannot demote their way
 * to an empty team on their own. The two checks exist for the two ways round
 * that:
 *
 * - **The transaction** catches two admins acting *at the same moment* — A
 *   demoting B while B demotes A. Both read "two admins", both pass, and
 *   without this both writes land and nobody can manage the team again.
 *   Reading the roster inside the transaction puts it in the read set, so the
 *   second commit is retried against the first's result and correctly refused.
 *   This is the case that would really happen, and the reason the check and the
 *   change must be one operation rather than two.
 * - **The eligibility pre-check** catches a caller who has *just been disabled*
 *   and is spending the last of an unexpired token. Firestore does not re-check
 *   revocation until a token is renewed, so such a caller can still act for a
 *   while — and they no longer count as somebody who can unlock things, which
 *   is why the count is of admins who could actually sign in rather than of
 *   documents (see `eligibleAdminUids`).
 *
 * The caller's own mutation is passed in and applied inside the transaction, so
 * the check and the change cannot be separated. Any Auth-side work happens
 * after it commits.
 */
async function applyTeamChange(
  targetUid: string,
  action: string,
  write: (tx: Transaction, target: DocumentReference) => void,
): Promise<void> {
  const target = db().collection('users').doc(targetUid);

  const existing = await target.get();
  if (!existing.exists || existing.data()?.role !== 'dashboard') {
    throw new HttpsError('not-found', 'That account is not on the dashboard team.');
  }
  if (existing.data()?.admin === true) {
    const others = (await eligibleAdminUids()).filter((uid) => uid !== targetUid);
    if (others.length === 0) {
      throw new HttpsError(
        'failed-precondition',
        `This is the only administrator who can still sign in. Make someone else an administrator before you ${action}.`,
      );
    }
  }

  await db().runTransaction(async (tx) => {
    // Every read before every write — Firestore transactions require it.
    const admins = await tx.get(adminQuery());
    const snapshot = await tx.get(target);
    if (!snapshot.exists || snapshot.data()?.role !== 'dashboard') {
      throw new HttpsError('not-found', 'That account is not on the dashboard team.');
    }
    if (snapshot.data()?.admin === true && admins.size <= 1) {
      throw new HttpsError(
        'failed-precondition',
        `This is the only administrator left. Make someone else an administrator before you ${action}.`,
      );
    }
    write(tx, target);
  });
}

/** The shape the Team page renders one row from. */
type DashboardUserRow = {
  uid: string;
  email: string;
  displayName: string;
  admin: boolean;
  disabled: boolean;
  /** ISO strings, or null when the account has never signed in / has no record. */
  lastSignInAt: string | null;
  createdAt: string | null;
};

/**
 * Everyone who can open the dashboard.
 *
 * Firestore holds the roster (it is the thing that decides who counts as a
 * dashboard account) and Auth holds the live state of each account — whether it
 * is disabled, when it last signed in. `getUsers` fetches those in one batch;
 * an account present in Firestore but missing from Auth (deleted out from under
 * us in the console) is still listed, marked disabled, rather than silently
 * dropped, so the admin can see it and clean it up.
 */
export const listDashboardUsers = onCall(async (request) => {
  await requireAdmin(request);

  const docs = (await db().collection('users').where('role', '==', 'dashboard').get()).docs;
  if (docs.length === 0) return { users: [] as DashboardUserRow[] };

  const records = await fetchAuthRecords(docs.map((snapshot) => snapshot.id));

  const users: DashboardUserRow[] = docs.map((snapshot) => {
    const data = snapshot.data();
    const record = records.get(snapshot.id);
    return {
      uid: snapshot.id,
      email: record?.email ?? (data.email as string | undefined) ?? '',
      displayName: (data.displayName as string | undefined) ?? record?.displayName ?? '',
      admin: data.admin === true,
      // No Auth record means the account is gone; it certainly can't sign in.
      disabled: record ? record.disabled : true,
      lastSignInAt: record?.metadata.lastSignInTime ?? null,
      createdAt: record?.metadata.creationTime ?? null,
    };
  });

  users.sort((a, b) => {
    if (a.admin !== b.admin) return a.admin ? -1 : 1; // admins first
    return (a.displayName || a.email).localeCompare(b.displayName || b.email);
  });

  return { users };
});

/**
 * Adds a person to the dashboard team.
 *
 * The account is created with a long random password that is never shown to
 * anyone and never stored — it exists only because Firebase requires an account
 * to have one. The person sets their own by following the password-reset email
 * the dashboard sends immediately after this returns (`sendPasswordResetEmail`,
 * a browser-side call, because the Admin SDK can generate a reset link but
 * cannot actually deliver it — Firebase's built-in mail sender is only reachable
 * from a client SDK).
 *
 * Rolled back on a partial failure: if the role doc can't be written, the Auth
 * account is deleted again rather than left behind as an account that exists,
 * can be signed into, and is rejected by both apps for having no role.
 */
export const createDashboardUser = onCall(async (request) => {
  const callerUid = await requireAdmin(request);

  const email = normalizeEmail(request.data?.email);
  const displayName = sanitizeName(request.data?.displayName);
  const makeAdmin = request.data?.admin === true;

  if (!looksLikeEmail(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  }
  if (displayName.length === 0) {
    throw new HttpsError('invalid-argument', 'Enter the person’s name.');
  }

  let created;
  try {
    created = await adminAuth().createUser({
      email,
      displayName,
      // Never surfaced, never reused. The reset email is how a password is set.
      password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      emailVerified: false,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'An account with that email already exists.');
    }
    if (code === 'auth/invalid-email') {
      throw new HttpsError('invalid-argument', 'Enter a valid email address.');
    }
    logger.error('[team.create] could not create the account', { email, error });
    throw new HttpsError('internal', 'Could not create the account. Please try again.');
  }

  try {
    await db().collection('users').doc(created.uid).set({
      role: 'dashboard',
      admin: makeAdmin,
      displayName,
      email,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: callerUid,
    });
  } catch (error) {
    // An Auth account with no role doc is a half-made user that neither app
    // will admit and no page lists. Undo it rather than leave it stranded.
    await adminAuth().deleteUser(created.uid).catch(() => undefined);
    logger.error('[team.create] role doc failed, account rolled back', { email, error });
    // 'aborted', not 'internal', and the distinction is carried all the way to
    // the screen: the browser replaces an `internal` message with something
    // generic (that code is what the runtime uses for a crash it has no wording
    // for, so its message is a stack-trace artefact). This one is hand-written
    // and load-bearing — "Nothing was created" is what tells the admin whether
    // to add the person again, and losing it means they either re-add and hit
    // "already exists" or leave a colleague off the team.
    throw new HttpsError('aborted', 'Could not finish setting up the account. Nothing was created — please try again.');
  }

  return { uid: created.uid, email };
});

/**
 * Turns an account off (or back on). Preferred over removal for someone who has
 * left but might return, and it is the immediate lever when a password is
 * suspected of having got out: `revokeRefreshTokens` kills every saved login
 * that account has, so an already-open tab stops working rather than running
 * until its session happens to expire.
 */
export const setDashboardUserDisabled = onCall(async (request) => {
  const callerUid = await requireAdmin(request);
  const uid = String(request.data?.uid ?? '');
  const disabled = request.data?.disabled === true;

  if (!uid) throw new HttpsError('invalid-argument', 'Which account?');
  if (uid === callerUid && disabled) {
    throw new HttpsError('failed-precondition', 'You can’t disable your own account.');
  }

  // Turning an account back ON can't lock anybody out, so it only needs the
  // "is this even a dashboard account" half. Passing it through the same
  // function keeps that check in one place rather than two shapes of it.
  await applyTeamChange(uid, disabled ? 'disable this one' : 'enable this one', (tx, target) => {
    // Informational, and the transaction's write — Auth stays the authority on
    // whether an account is disabled (it is what `listDashboardUsers` reports),
    // so this is a note about when it happened, never a second source of truth.
    tx.update(target, disabled ? { disabledAt: FieldValue.serverTimestamp(), disabledBy: callerUid } : { disabledAt: FieldValue.delete(), disabledBy: FieldValue.delete() });
  });

  await adminAuth().updateUser(uid, { disabled });
  if (disabled) {
    // Kills every saved login this account has, so an already-open tab stops
    // working instead of running until its session happens to lapse. Dropping
    // the session claim signs that tab out immediately, with an explanation.
    await adminAuth().revokeRefreshTokens(uid);
    await db().collection(SessionCollection).doc(uid).delete().catch(() => undefined);
  }
  return { ok: true };
});

/**
 * Removes a person entirely — Auth account, role doc and session claim.
 *
 * A hard delete is right here in a way it is not for a store or a run: a
 * dashboard account owns no records. Everything it can reach is read-only by
 * rule, so nothing anywhere refers back to it and nothing is orphaned by its
 * going. (Mobile accounts are a different matter — receipts and runs carry
 * `createdByUid` — which is why there is no equivalent of this for them.)
 */
export const removeDashboardUser = onCall(async (request) => {
  const callerUid = await requireAdmin(request);
  const uid = String(request.data?.uid ?? '');

  if (!uid) throw new HttpsError('invalid-argument', 'Which account?');
  if (uid === callerUid) {
    throw new HttpsError('failed-precondition', 'You can’t remove your own account.');
  }

  // The role doc goes first, inside the guarded transaction — which is also
  // what makes the guard mean anything, since a check followed by a separate
  // delete is a check two callers can both pass. A crash between this and the
  // Auth delete below leaves an Auth account with no role doc, which both apps
  // already reject on sign-in, so the intermediate state is a closed door
  // rather than an open one.
  await applyTeamChange(uid, 'remove this one', (tx, target) => tx.delete(target));

  await adminAuth()
    .deleteUser(uid)
    .catch((error) => {
      // Already gone from Auth (removed in the console) — the Firestore half
      // was the part still showing on the roster, and it is now cleaned up.
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
    });
  await db().collection(SessionCollection).doc(uid).delete().catch(() => undefined);

  return { ok: true };
});

/**
 * Promotes or demotes an administrator. Exists so the client is never one
 * forgotten password away from having nobody who can manage the team — they can
 * appoint a second admin themselves.
 */
export const setDashboardUserAdmin = onCall(async (request) => {
  const callerUid = await requireAdmin(request);
  const uid = String(request.data?.uid ?? '');
  const admin = request.data?.admin === true;

  if (!uid) throw new HttpsError('invalid-argument', 'Which account?');
  if (uid === callerUid && !admin) {
    // Demoting yourself is how an admin locks themselves out by accident, and
    // it reads as a small change right up until the Team page disappears.
    throw new HttpsError('failed-precondition', 'You can’t remove your own administrator access.');
  }

  // Promoting can't lock anyone out, but it still goes through the same guard
  // for its other half: without the "is this a dashboard account" check, this
  // would happily stamp `admin: true` onto a mobile driver's user doc.
  await applyTeamChange(uid, 'demote this one', (tx, target) => tx.update(target, { admin }));
  return { ok: true };
});

/**
 * ONE BROWSER PER ACCOUNT.
 *
 * The dashboard records which browser currently holds an account at
 * `dashboardSessions/{uid}`. A browser signing in writes its own id there; every
 * other browser signed in as that account is watching the same document, sees an
 * id that isn't theirs, and signs itself out with an explanation. Newest login
 * wins, deliberately — the alternative (first session blocks the rest) strands
 * people out of their own account whenever a tab crashes or a laptop dies.
 *
 * Written only from here, never from the browser: rules refuse client writes to
 * this collection, so a tab cannot award itself a claim it did not obtain.
 *
 * `revokeRefreshTokens` is what makes it more than a UI courtesy — it kills the
 * saved credential in every other browser, so a tampered client that ignored the
 * sign-out can't quietly keep reading either. The catch is that it kills the
 * *caller's* saved credential too (Firebase has no "revoke all but this one"),
 * and a caller that lost its own login an hour later would be a self-inflicted
 * lockout. So a fresh sign-in credential is minted first and handed back for the
 * caller to swap onto:
 *
 *   1. mint a custom token  — if this fails, skip the revoke entirely and
 *      return nothing, leaving the browser signed in exactly as it was. Session
 *      enforcement still works through the watched document; only the extra
 *      credential-killing hardening is skipped. Failing open here is the whole
 *      point: `createCustomToken` needs the runtime service account to hold
 *      "Service Account Token Creator", which it normally does but might not,
 *      and a missing IAM role must not become a dashboard nobody can log in to.
 *   2. revoke everything
 *   3. pause, because `tokensValidAfterTime` is stored to the second — signing
 *      in during the same second the revoke landed can be read as "before" it,
 *      which would invalidate the very credential we just issued
 *   4. return the token; the browser signs in with it and is the only holder of
 *      a live credential for this account
 *
 * Not admin-gated: every dashboard account claims its own session, and the uid
 * it claims for is the authenticated one, never a parameter.
 */
export const claimDashboardSession = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');

  const data = (await db().collection('users').doc(uid).get()).data();
  if (data?.role !== 'dashboard') {
    throw new HttpsError('permission-denied', 'This is not a dashboard account.');
  }

  const sessionId = String(request.data?.sessionId ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    throw new HttpsError('invalid-argument', 'Bad session id.');
  }

  await db().collection(SessionCollection).doc(uid).set({
    sessionId,
    // Shown to whoever gets signed out, so they can tell "my other laptop" from
    // "somebody I need to ask about".
    label: sanitizeName(request.data?.label) || 'another browser',
    claimedAt: FieldValue.serverTimestamp(),
  });

  let reauthToken: string | null = null;
  try {
    reauthToken = await adminAuth().createCustomToken(uid);
  } catch (error) {
    logger.warn('[session.claim] could not mint a replacement credential; skipping revoke', { uid, error });
    return { reauthToken: null };
  }

  await adminAuth().revokeRefreshTokens(uid);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  return { reauthToken };
});
