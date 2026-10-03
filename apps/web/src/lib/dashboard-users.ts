import { FirebaseError } from 'firebase/app';
import { sendPasswordResetEmail } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';

import { auth, functions } from '@/lib/firebase';

/**
 * The Team page's data layer — thin typed wrappers around the Cloud Functions in
 * firebase/functions/src/dashboard-users.ts.
 *
 * Nothing here decides who may do what. Every one of these functions re-checks
 * the caller's `admin` flag on the server, because a check made in a browser is
 * a check made on a machine the caller controls. The page hiding buttons is
 * courtesy; these calls failing is the rule.
 */

export type DashboardUser = {
  uid: string;
  email: string;
  displayName: string;
  /** May manage the team — add, disable, remove and appoint other admins. */
  admin: boolean;
  /** Turned off: the password still exists but Firebase refuses the sign-in. */
  disabled: boolean;
  /** ISO date strings from Firebase Auth, or null when there is nothing to show. */
  lastSignInAt: string | null;
  createdAt: string | null;
};

const callList = httpsCallable<void, { users: DashboardUser[] }>(functions, 'listDashboardUsers');
const callCreate = httpsCallable<{ email: string; displayName: string; admin: boolean }, { uid: string; email: string }>(
  functions,
  'createDashboardUser',
);
const callSetDisabled = httpsCallable<{ uid: string; disabled: boolean }, { ok: true }>(
  functions,
  'setDashboardUserDisabled',
);
const callRemove = httpsCallable<{ uid: string }, { ok: true }>(functions, 'removeDashboardUser');
const callSetAdmin = httpsCallable<{ uid: string; admin: boolean }, { ok: true }>(functions, 'setDashboardUserAdmin');

export async function listDashboardUsers(): Promise<DashboardUser[]> {
  return (await callList()).data.users;
}

/**
 * Adds someone to the team and emails them a link to set their own password.
 *
 * The two halves are deliberately separate calls. Account creation has to happen
 * on the server (the browser SDK's version would sign the admin out and into the
 * new account); the *email* has to happen in the browser, because the Admin SDK
 * can generate a password-reset link but cannot deliver one — Firebase's own
 * mail sender is only reachable from a client SDK. So the account is made first
 * and the email sent second.
 *
 * A failure to send is therefore reported but never treated as a failed
 * creation, because it isn't one: the person is on the team and the admin only
 * needs to press "Resend setup email". Saying "could not add them" over a
 * bounced email would send an admin back to add somebody who already exists.
 */
export async function addDashboardUser(input: {
  email: string;
  displayName: string;
  admin: boolean;
}): Promise<{ emailSent: boolean }> {
  const created = await callCreate({
    email: input.email.trim().toLowerCase(),
    displayName: input.displayName.trim(),
    admin: input.admin,
  });
  try {
    await sendPasswordResetEmail(auth, created.data.email);
    return { emailSent: true };
  } catch {
    return { emailSent: false };
  }
}

/** Sends the "set your password" email again — also the way to reset a forgotten one. */
export async function sendSetupEmail(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

export async function setDashboardUserDisabled(uid: string, disabled: boolean): Promise<void> {
  await callSetDisabled({ uid, disabled });
}

export async function removeDashboardUser(uid: string): Promise<void> {
  await callRemove({ uid });
}

export async function setDashboardUserAdmin(uid: string, admin: boolean): Promise<void> {
  await callSetAdmin({ uid, admin });
}

/**
 * A callable's rejection carries the server's own message in `error.message`,
 * and every message thrown by these functions is already written for the person
 * reading it ("This is the only administrator left…"), so the useful thing is
 * to show it rather than replace it with something generic.
 *
 * `internal` is the exception: that is the code the runtime uses for a crash it
 * has no wording for, so its message is a stack-trace artefact, not a sentence.
 * Note which code the server uses where — a hand-written message that must
 * survive (the "Nothing was created" rollback) is thrown as `aborted` precisely
 * so it isn't swallowed here.
 */
export function friendlyTeamError(error: unknown): string {
  if (error instanceof FirebaseError) {
    if (error.code === 'functions/internal' || !error.message) {
      return 'Something went wrong. Please try again.';
    }
    if (error.code === 'functions/unavailable' || error.code === 'functions/deadline-exceeded') {
      return 'Can’t reach the server. Check your connection and try again.';
    }
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
}
