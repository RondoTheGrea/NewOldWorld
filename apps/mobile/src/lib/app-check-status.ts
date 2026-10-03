import { httpsCallable } from 'firebase/functions';

import {
  appCheckInitialized,
  functions,
  isAttestationThrottled,
  probeAppCheckToken,
  usingEmulators,
} from '@/lib/firebase';

/**
 * Asks the backend whether this handset's requests arrive attested.
 *
 * The counterpart to `appCheckStatus` in `firebase/functions/src/index.ts` —
 * read that first, it carries the reasoning. In short: this is the only way to
 * get a straight yes/no for *this phone*, because the App Check console counts
 * every request naming the app id (bots included) and Firestore answers a
 * missing token with the same `permission-denied` the security rules use.
 *
 * Deliberately *not* wired into the upload path. Nothing here changes how a
 * refusal is classified — that stays with `isRecoverableAppCheckDenial` in
 * `lib/sync.ts`, which has to work with no connection and can't call a
 * function. This is a person tapping a row and waiting for an answer.
 */

/**
 * Long enough for a cold start in Singapore on a truck's signal, short enough
 * that someone standing at the depot doesn't give up on it. Well under the
 * callable SDK's own 70s default, which would look like a frozen button.
 */
const CheckTimeoutMs = 20_000;

/** What the callable sends back. Mirrors the function's return exactly. */
type AppCheckStatusResponse = {
  appCheckVerified: boolean;
  appId: string | null;
  signedIn: boolean;
  environment: 'emulator' | 'cloud';
  checkedAt: number;
};

/**
 * The verdict, already reduced to the four cases worth wording differently.
 * The caller renders these; it does no reasoning of its own about tokens.
 */
export type AppCheckVerdict =
  /** The backend verified a real token. This phone will pass enforcement. */
  | { kind: 'verified'; appId: string | null }
  /**
   * The request arrived with no valid token — this phone would be turned away.
   *
   * `reason` is the attestation error itself, and it is what makes the verdict
   * actionable: every cause of this (no SHA-256 registered in Firebase, the
   * project not linked to Play, an install Play doesn't recognise) produces a
   * different message here and is otherwise identical on screen. `null` is its
   * own finding — the phone *can* mint a token but the backend still didn't see
   * a valid one, which points at the project or app registration rather than
   * the device. `throttled` separates out Play Integrity's rate limit, which is
   * the one failure here that means the setup is correct.
   */
  | { kind: 'unverified'; reason: string | null; throttled: boolean }
  /**
   * App Check never started here, so there was never a token to send. Not a
   * failure to attest — a device that isn't attesting at all (iOS, or a build
   * missing `google-services.json`).
   */
  | { kind: 'not-running' }
  /**
   * Pointed at the emulators, which don't implement App Check. The answer
   * would be "unverified" on a perfectly healthy phone, so it isn't reported
   * as one.
   */
  | { kind: 'no-verdict-locally' };

/**
 * Runs the check. Throws on a network or deploy failure so the caller's
 * `runWithRetry` can offer "Try again" — a timeout here says nothing about
 * App Check, and reporting it as "not verified" would be a false alarm of
 * exactly the kind this whole feature exists to remove.
 */
export async function checkAppCheckStatus(): Promise<AppCheckVerdict> {
  // Both of these are settled on the phone, before spending a request: the
  // backend's answer in either case would be "unverified" for a reason that
  // has nothing to do with whether this build can attest.
  if (usingEmulators) return { kind: 'no-verdict-locally' };
  if (!appCheckInitialized()) return { kind: 'not-running' };

  const call = httpsCallable<undefined, AppCheckStatusResponse>(functions, 'appCheckStatus', {
    timeout: CheckTimeoutMs,
  });
  const { data } = await call();

  // Trust the flag the *runtime* set, never a field the request could have
  // carried up — the client is the thing under test.
  if (data.appCheckVerified) return { kind: 'verified', appId: data.appId };

  // Only now, and only on a failure: the probe forces a Play Integrity round
  // trip against a per-app quota, so a healthy phone never spends one. The
  // request that just went out carried whatever token the SDK had, so asking
  // afterwards is what turns "not verified" into a cause.
  const probe = await probeAppCheckToken();
  return probe.ok
    ? { kind: 'unverified', reason: null, throttled: false }
    : { kind: 'unverified', reason: probe.message, throttled: isAttestationThrottled(probe.message) };
}
