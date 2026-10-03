import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { beforeUserCreated, HttpsError } from 'firebase-functions/v2/identity';

// Run functions in Singapore, the same region as Firestore and the closest one
// to the Philippines. The default is us-central1, which would send every call
// across the Pacific twice — once for the request, and again for each Firestore
// read the function makes. Keeping compute and data in one region avoids that.
//
// Changing a function's region later means deleting and recreating it, so this
// is set once here and inherited by every function we add.
setGlobalOptions({ region: 'asia-southeast1' });

// Dashboard staff management and the one-browser-per-account rule. Kept in its
// own file because it is the only part of the backend that writes anything —
// everything else here answers a question — and re-exported rather than
// imported for use, since a Cloud Function only deploys if it is exported from
// the entry point.
export {
  claimDashboardSession,
  createDashboardUser,
  listDashboardUsers,
  removeDashboardUser,
  setDashboardUserAdmin,
  setDashboardUserDisabled,
} from './dashboard-users';

// Placeholder health check. Hitting this is the quickest way to confirm a deploy
// landed, and `environment` tells you whether you reached the emulator on your
// machine or the real deployed function — the emulator sets FUNCTIONS_EMULATOR.
export const api = onRequest((request, response) => {
  response.json({
    ok: true,
    environment: process.env.FUNCTIONS_EMULATOR === 'true' ? 'emulator' : 'cloud',
    region: process.env.FUNCTION_REGION ?? 'asia-southeast1',
  });
});

/**
 * "Did this phone's request arrive with a valid App Check token?"
 *
 * The one thing the App Check console cannot tell you. That page counts every
 * request naming this app's Firebase app id — and the app id ships inside the
 * APK (see the `EXPO_PUBLIC_FIREBASE_*` note in CLAUDE.md), so a script hitting
 * the public REST API is counted there too. The percentage is a fleet figure
 * with strangers mixed into it, which is the wrong shape for the only question
 * worth asking before enforcement is switched on: *does the handset in my hand
 * attest?*
 *
 * Firestore and Storage can't answer it either. They allow or deny and say
 * nothing about why, and once enforcement is on their denial is byte-for-byte
 * the `permission-denied` the security rules raise. Functions is the only
 * product that will hand back the verification result instead of acting on it.
 *
 * `enforceAppCheck: false` is the whole mechanism, and it reads backwards. With
 * it *true* an unverified request is rejected before this body ever runs, so
 * all the caller learns is that something failed — indistinguishable from bad
 * signal in a truck. With it *false* the runtime still fully verifies a token
 * when one is present and populates `request.app` only for a valid one, so
 * `request.app !== undefined` below is Google's verdict rather than our guess.
 *
 * Enforcement is per-product but the *token* is not: a device that mints one
 * Functions accepts is minting one Firestore and Storage will accept. That is
 * what makes this a safe pre-flight for flipping the console switch.
 *
 * Two things about reading the result, both of which make a healthy phone look
 * broken:
 *
 * - **The emulator never verifies anything.** It doesn't implement App Check,
 *   so `request.app` is always undefined against it and a local run always
 *   reports "not verified". `environment` is echoed back so the app can say so
 *   instead of raising a false alarm.
 * - **Play Integrity only works on a build Google Play knows about.** A local
 *   dev-client build attests with the debug provider (`__DEV__` picks it in
 *   `apps/mobile/src/lib/firebase.ts`), so a true answer here is only worth
 *   anything on an Internal Testing download or later.
 *
 * Left unauthenticated on purpose — it reveals nothing about the project, and
 * requiring a login would mean a failure could equally be a stale session.
 */
export const appCheckStatus = onCall({ enforceAppCheck: false }, (request) => ({
  // Present only when the runtime verified a real token. Never trust a field
  // the caller sent for this — the client is the thing being tested.
  appCheckVerified: request.app !== undefined,
  appId: request.app?.appId ?? null,
  // `undefined` when absent, never null — comparing against null reports every
  // anonymous caller as signed in.
  signedIn: request.auth !== undefined,
  environment: process.env.FUNCTIONS_EMULATOR === 'true' ? 'emulator' : 'cloud',
  checkedAt: Date.now(),
}));

// Same throwaway-domain list as isDisposableEmail() in firebase/firestore.rules.
// Firestore rules can only stop a bad account from *writing* once it exists;
// this stops the account from ever being created at all — which is what
// actually gets rid of junk sign-ups showing up in Authentication. Keep the
// two lists in sync if either one changes; there's no way to share the regex
// between the rules language and TypeScript.
const DISPOSABLE_EMAIL_PATTERN =
  /@(example|test|mailinator|guerrillamail|tempmail|10minutemail|yopmail|trashmail|dispostable|fakeinbox|sharklasers)\.(com|org|net)$/i;

// Runs before ANY account is created — including a script calling Firebase's
// public Auth REST API directly, not just sign-ups that go through the app.
// That's the whole point: a scanner bot doesn't need the app to get an
// account, so this has to sit in front of account creation itself, not
// behind it.
export const blockDisposableSignUps = beforeUserCreated((event) => {
  const email = event.data?.email;
  if (email && DISPOSABLE_EMAIL_PATTERN.test(email)) {
    throw new HttpsError('invalid-argument', 'Sign-up is not available for this email address.');
  }
});
