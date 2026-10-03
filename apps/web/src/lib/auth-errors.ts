import { FirebaseError } from 'firebase/app';

/**
 * Turns Firebase's technical error codes into plain messages a user can read.
 * Anything we don't specifically recognise falls back to a generic message.
 */
export function friendlyAuthError(error: unknown): string {
  if (error instanceof Error && error.message === 'ACCOUNT_IS_MOBILE') {
    return 'This account is for the mobile app, not the dashboard.';
  }
  if (error instanceof Error && error.message === 'ACCOUNT_HAS_NO_ROLE') {
    return 'This account isn’t set up for the dashboard. Ask your dashboard administrator to add you.';
  }
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case 'auth/invalid-email':
        return 'That email address doesn’t look right.';
      case 'auth/missing-password':
        return 'Please enter your password.';
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'Email or password is incorrect.';
      case 'auth/user-disabled':
        return 'This account has been turned off. Ask your dashboard administrator to switch it back on.';
      // This SDK does not emit 'auth/user-token-revoked'. A credential that
      // was revoked — which is exactly what the one-browser-per-account claim
      // does on purpose, see lib/dashboard-session.ts — arrives here as
      // 'auth/user-token-expired'. Both are listed so the wording survives if
      // that ever changes back.
      case 'auth/user-token-expired':
      case 'auth/user-token-revoked':
        return 'This login is no longer valid. Please sign in again.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Please wait a moment and try again.';
      case 'auth/network-request-failed':
        return 'Can’t reach the server. Check your connection and try again.';
    }
  }
  // Nothing matched, so the message below tells the person reading it nothing
  // about what actually failed — and the code, the only thing that can, would
  // otherwise be thrown away here. Logged rather than shown: a raw Firebase
  // code on screen helps nobody trying to sign in, but it is one glance into
  // the browser console when somebody rings up about this message.
  //
  // Worth knowing while reading it: this fallback catches BOTH halves of
  // signIn() — the password check (an `auth/...` code) and the Firestore read
  // of users/{uid} that follows it (a plain Firestore code like
  // `unavailable` or `permission-denied`, none of which the switch above
  // handles). The code says which half gave up.
  console.error(
    '[auth] unrecognised sign-in error',
    error instanceof FirebaseError ? error.code : error,
    error,
  );
  return 'Something went wrong. Please try again.';
}
