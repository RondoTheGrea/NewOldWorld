import { FirebaseError } from 'firebase/app';

/**
 * Turns Firebase's technical error codes into plain messages a driver can read.
 * Anything we don't specifically recognise falls back to a generic message.
 */
export function friendlyAuthError(error: unknown): string {
  if (error instanceof Error && error.message === 'ACCOUNT_IS_DASHBOARD') {
    return 'This account is for the dashboard, not the app.';
  }
  if (error instanceof Error && error.message === 'ACCOUNT_HAS_NO_ROLE') {
    return 'This account isn’t set up yet. Ask an admin for help.';
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
      case 'auth/email-already-in-use':
        return 'An account already exists for that email.';
      case 'auth/weak-password':
        return 'Password must be at least 6 characters.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Please wait a moment and try again.';
      case 'auth/network-request-failed':
        return 'Can’t reach the server. Check your connection and try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}
