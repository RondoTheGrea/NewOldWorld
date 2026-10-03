import { getApp as getNativeFirebaseApp } from '@react-native-firebase/app';
import {
  type AppCheck as NativeAppCheck,
  ReactNativeFirebaseAppCheckProvider,
  getToken as getNativeAppCheckToken,
  initializeAppCheck as initializeNativeAppCheck,
} from '@react-native-firebase/app-check';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  type AppCheck,
  CustomProvider,
  getToken as getJsAppCheckToken,
  initializeAppCheck,
} from 'firebase/app-check';
import * as FirebaseAuth from 'firebase/auth';
import {
  type Auth,
  type Persistence,
  connectAuthEmulator,
  getAuth,
  initializeAuth,
} from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, initializeFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { Platform } from 'react-native';

// getReactNativePersistence exists in the SDK's React Native build and works at
// runtime, but the types published for 'firebase/auth' are the web ones and omit
// it — so we reach it through a typed accessor rather than a plain import.
const getReactNativePersistence = (
  FirebaseAuth as unknown as {
    getReactNativePersistence: (storage: unknown) => Persistence;
  }
).getReactNativePersistence;

/**
 * Which backend is this app talking to — the emulators on your computer, or the
 * real Firebase project in the cloud?
 *
 *   npm start         -> emulators   (fast, free, throwaway data)
 *   npm run start:cloud -> real cloud (slower, real data, catches deploy bugs)
 *
 * Two separate conditions have to agree before we use the emulators:
 *
 *   __DEV__ is a React Native built-in: true while you're developing, and always
 *   false in a release build. Having it here means a shipped app can NEVER be
 *   talked into pointing at localhost, no matter what the .env file says. That
 *   is the safety net — the .env value alone is not trusted.
 *
 *   EXPO_PUBLIC_USE_EMULATOR is the switch you actually flip, via the npm
 *   scripts above. Anything other than the string "false" means emulators.
 *
 * Note: this must be written as a direct `process.env.SOMETHING` lookup. Expo
 * swaps these values into the code when it builds, and it only recognises that
 * exact spelling — pulling the name out into a variable silently yields undefined.
 */
export const usingEmulators = __DEV__ && process.env.EXPO_PUBLIC_USE_EMULATOR !== 'false';

/**
 * Config for the emulators. These are deliberate fakes — the emulators accept
 * any values and never check them against a real account.
 *
 * The "demo-" prefix on projectId is meaningful to Firebase: it marks this as a
 * demo project, so the tooling stays fully offline and never needs a login. It
 * must stay in sync with the --project flag in firebase/package.json, otherwise
 * users created by the app won't show up in the Emulator UI.
 */
const emulatorConfig = {
  apiKey: 'demo-api-key',
  authDomain: 'demo-newoldworld.firebaseapp.com',
  projectId: 'demo-newoldworld',
  appId: 'demo-app-id',
  // Needed even against the emulator. Without a bucket the Storage SDK has no
  // default to resolve a path against and throws `storage/no-default-bucket` —
  // and it throws at the first `ref()`, not at `getStorage()`, so the failure
  // would surface as one proof photo that never uploads rather than as a
  // startup error. Any name works here; the emulator does not check it.
  storageBucket: 'demo-newoldworld.firebasestorage.app',
};

/**
 * Config for the real cloud project, read from apps/mobile/.env.
 *
 * These are safe to commit and safe to ship inside the app — they only identify
 * which Firebase project to talk to, they don't grant any access. What actually
 * protects your data is the Firestore security rules. (Real secrets, like a
 * payment provider key, must never go in an EXPO_PUBLIC_ variable — everything
 * with that prefix is readable by anyone who downloads the app.)
 */
const cloudConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

/**
 * Fails loudly if the real config hasn't been filled in yet. Without this you'd
 * get a vague "auth/invalid-api-key" from deep inside Firebase; this says what
 * to actually go and do.
 */
function requireCloudConfig() {
  const missing = Object.entries(cloudConfig)
    .filter(([, value]) => !value || value.startsWith('REPLACE_ME'))
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      [
        `Cannot connect to the real Firebase project — missing config: ${missing.join(', ')}.`,
        '',
        'Fix: open the Firebase console for project newoldworld-b8f5d,',
        'go to Project Settings > General > Your apps > Web app, copy the',
        'firebaseConfig values, and paste them into apps/mobile/.env.',
        '',
        'Or run `npm start` instead to use the local emulators.',
      ].join('\n'),
    );
  }

  return cloudConfig as Record<keyof typeof cloudConfig, string>;
}

const firebaseConfig = usingEmulators ? emulatorConfig : requireCloudConfig();

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

/**
 * App Check — proves a request came from a genuine, unmodified build of this
 * app on a real device, not a script calling Firebase's (deliberately public)
 * REST API directly. Closed a real hole: bots signed up and wrote a
 * fabricated `runs` document by hitting the Auth REST API with none of this
 * app's code involved (see firestore.rules' isDisposableEmail comment).
 *
 * Android only for now — app.json's ios block has no bundleIdentifier, so
 * there's no real iOS build to attest yet.
 *
 * This uses @react-native-firebase/app + @react-native-firebase/app-check
 * SOLELY to obtain a Play Integrity attestation token from the native SDK —
 * everything else (Auth, Firestore, Functions, Storage) still goes through
 * the Firebase JS SDK above, per the "shared with the future web dashboard"
 * decision. The native token is handed to the JS SDK's own App Check via a
 * CustomProvider, which is the documented bridge for this exact situation.
 *
 * __DEV__ (not usingEmulators) decides debug vs. Play Integrity: Play
 * Integrity only validates on a build Play actually knows about (e.g. an
 * Internal Testing download), which a local dev-client build never is, cloud
 * backend or not.
 */
let nativeAppCheck: NativeAppCheck | null = null;

/**
 * When Play Integrity last failed to hand us an attestation token, as epoch ms
 * (0 = not since the app started, or it last succeeded).
 *
 * Why this exists: once App Check enforcement is on, a request that reaches
 * Firestore without a valid App Check token is rejected with `permission-denied`
 * — the *exact same* error code a real security-rules refusal uses. The two are
 * indistinguishable from the error alone. But a rules refusal is permanent
 * (wrong account on the run, say) while a failed attestation is almost always a
 * passing blip — the phone briefly couldn't reach Play's servers — and clears
 * itself the moment signal is back.
 *
 * Our own `getToken` below is the one place that knows an attestation just
 * failed, so it records the time here and `isRecoverableAppCheckDenial` in
 * `lib/sync.ts` reads it: a `permission-denied` landing right after a miss is
 * retried on the normal loop instead of being set aside as "the server refused
 * this", which would leave a good receipt stuck until someone taps the Settings
 * retry button by hand.
 */
let lastAppCheckFailureAt = 0;

/**
 * When an attestation token was last obtained, as epoch ms (0 = not since the
 * app started, or it last failed).
 *
 * A cache, and one with a job: `isRecoverableAppCheckDenial` probes on *every*
 * `permission-denied`, and a drain that quarantines twenty-five refused rows in
 * one pass would otherwise force twenty-five separate attestations — a minute
 * of round trips, repeated every `RetryIntervalMs`, against a Play Integrity
 * quota that is per-app and finite. A token minted `AppCheckProbeCacheMs` ago
 * already answers the only question being asked ("can this phone attest right
 * now?"), so the rest of the pass reuses it.
 */
let lastAppCheckSuccessAt = 0;

/**
 * How long a successful attestation stands in for a fresh probe. Short enough
 * that a phone which has just lost Play connectivity is re-probed within the
 * same minute, long enough that one drain pass costs at most one attestation.
 */
const AppCheckProbeCacheMs = 60 * 1000;

/**
 * Whether `initializeAppCheck` actually ran to completion on this device. When
 * it didn't (not Android, or `google-services.json` missing, or the native
 * module failed to load), App Check plays no part in any request — so a
 * `permission-denied` is unambiguously the security rules, and the probe below
 * must not second-guess it, or a genuinely refused row could never be set aside
 * and the day could never close.
 */
let appCheckReady = false;

/**
 * The JS SDK's own App Check handle, kept rather than discarded because the
 * probe has to ask *this* layer, not the native one — see
 * `appCheckTokenObtainable`.
 */
let jsAppCheck: AppCheck | null = null;

/**
 * Is App Check actually capable of turning a request away on this device?
 *
 * Two conditions, and the emulator one is easy to miss: the emulators do not
 * enforce App Check at all, so against them a `permission-denied` is *always*
 * the security rules. Without this guard local development is actively
 * misleading — a dev build attests with the debug provider, which fails
 * outright whenever `EXPO_PUBLIC_APP_CHECK_DEBUG_TOKEN` is blank or
 * unregistered, so every rules refusal you were trying to test would be
 * excused as an App Check blip and the row would never be set aside.
 *
 * A dev build pointed at the *cloud* project (`npm run start:cloud`) is
 * deliberately not excused: enforcement is a per-product setting on the whole
 * project, so once it is on, that build is subject to it like any other.
 */
function appCheckInPlay(): boolean {
  return appCheckReady && !usingEmulators;
}

/**
 * The raw result of trying to attest, for the Settings check only.
 *
 * `appCheckTokenObtainable` above answers the same question with a bare
 * boolean, which is all the upload path needs — it only has to decide whether
 * to blame App Check for a refusal. A person staring at "Not verified" needs
 * the opposite: the actual message, because every distinct cause (no SHA-256
 * registered, project not linked to Play, a build Play doesn't recognise)
 * arrives here as different text and is otherwise indistinguishable.
 */
export type AppCheckTokenProbe = { ok: true } | { ok: false; message: string };

/**
 * Force an attestation and report what happened, message and all.
 *
 * **Asks the JS layer only, and once.** An earlier version probed the native
 * layer first and then the JS one, on the theory that Play Integrity's own
 * wording would otherwise be lost — but it isn't: the JS SDK wraps the native
 * message rather than replacing it, so a throttle arrives here intact as
 * `[appCheck/token-error] ... Too many attempts`. Probing both cost two Play
 * Integrity requests per tap against a quota this feature was already straining,
 * which is how a diagnostic ended up causing the fault it was built to explain.
 *
 * Bypasses the `AppCheckProbeCacheMs` cache on purpose: someone tapping this
 * row has just changed something in a console and wants to know whether it took
 * effect, so answering from a minute-old success would be worse than useless.
 * It deliberately does not touch `noteAppCheckSuccess`/`Failure` either — this
 * is a person asking a question, and letting it write to the state the upload
 * path reads would let a diagnostic change how the next refusal is classified.
 */
export async function probeAppCheckToken(): Promise<AppCheckTokenProbe> {
  if (!jsAppCheck) return { ok: false, message: 'App Check is not running on this device.' };
  try {
    await getJsAppCheckToken(jsAppCheck, true);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Does this message mean Play Integrity throttled us rather than refused us?
 *
 * Worth singling out because it is the one failure that says the setup is
 * *right*: a request that is rate-limited is one Play accepted as coming from a
 * recognised app. Read as an ordinary failure it sends someone back to the
 * console to re-check registration that was never broken.
 */
export function isAttestationThrottled(message: string): boolean {
  return /too many (attempts|requests)|-8|throttl/i.test(message);
}

/**
 * Did `initializeAppCheck` actually complete on this handset?
 *
 * Exported for the Settings check only. Without it, a phone where App Check
 * never started at all (an iPhone, a build with no `google-services.json`, a
 * native module that failed to load) is indistinguishable from one that is
 * attesting and being turned away — both send requests carrying no token. The
 * two need opposite responses, so the check has to be able to tell them apart.
 * Nothing on the upload path uses this; that path wants `appCheckInPlay`,
 * which also excludes the emulators.
 */
export function appCheckInitialized(): boolean {
  return appCheckReady;
}

/** True if attestation failed within the last `withinMs`. */
export function recentAppCheckFailure(withinMs = 2 * 60 * 1000): boolean {
  return appCheckInPlay() && lastAppCheckFailureAt > 0 && Date.now() - lastAppCheckFailureAt < withinMs;
}

/** Remember that attestation just worked, and that whatever went wrong is over. */
function noteAppCheckSuccess(): void {
  lastAppCheckSuccessAt = Date.now();
  lastAppCheckFailureAt = 0;
}

/**
 * Remember that attestation just failed. Clears the success stamp too, or a
 * token minted seconds *before* the failure would keep answering the probe from
 * cache and blame the rules for a refusal App Check caused.
 */
function noteAppCheckFailure(): void {
  lastAppCheckFailureAt = Date.now();
  lastAppCheckSuccessAt = 0;
}

/**
 * Force a fresh attestation and report whether one could be had.
 *
 * This is how a `permission-denied` is pinned to a cause. App Check enforcement
 * rejects a token-less request with the same code the security rules use for a
 * real refusal, and the two need opposite handling — retry vs. set the row
 * aside. If a token can't be had right now, the refusal was App Check's.
 *
 * **It asks the JS SDK, not the native one, and that is the whole point.** The
 * request that just failed carried (or failed to carry) a token from
 * `firebase/app-check` — the `CustomProvider` below is only that layer's
 * supplier. When the provider throws, the JS SDK enters its own backoff and
 * keeps sending requests *without* a token for minutes afterwards, and it
 * throttles itself the same way when the App Check backend rejects an exchange.
 * A native probe is blind to both: it would answer "obtainable" while every
 * real request was still going out unattested, and a good row would be
 * quarantined on the spot (a `permission-denied` is classed permanent, so there
 * is no attempt count to catch it). Asking the JS layer tests exactly what the
 * upload uses — and, because it force-refreshes, repairs the cached token so
 * the next attempt carries one.
 *
 * Returns `true` (obtainable, so don't blame App Check) wherever App Check
 * isn't in play, so callers don't special-case those. Bounded by the caller's
 * timeout — a hang here is treated as "not obtainable", the safe direction,
 * since it keeps the row queued rather than writing it off.
 */
export async function appCheckTokenObtainable(): Promise<boolean> {
  if (!appCheckInPlay() || !jsAppCheck) return true;
  if (lastAppCheckSuccessAt > 0 && Date.now() - lastAppCheckSuccessAt < AppCheckProbeCacheMs) {
    return true;
  }
  try {
    await getJsAppCheckToken(jsAppCheck, true);
    noteAppCheckSuccess();
    return true;
  } catch (error) {
    noteAppCheckFailure();
    console.warn('[firebase] App Check token refresh failed', error);
    return false;
  }
}

// initializeAppCheck() here returns synchronously (native provider setup
// continues in the background) — no await needed, unlike the JS SDK's own
// Firestore/Storage/Functions calls elsewhere in this file.
function getNativeAppCheck(): NativeAppCheck {
  if (!nativeAppCheck) {
    const provider = new ReactNativeFirebaseAppCheckProvider();
    provider.configure({
      android: {
        provider: __DEV__ ? 'debug' : 'playIntegrity',
        // Registered once in the Firebase console (App Check > Apps > manage
        // debug tokens) for local development only — production builds never
        // take this branch. Not set up yet is fine: the native SDK just logs
        // and fails to attest, caught below.
        debugToken: process.env.EXPO_PUBLIC_APP_CHECK_DEBUG_TOKEN,
      },
    });
    nativeAppCheck = initializeNativeAppCheck(getNativeFirebaseApp(), {
      provider,
      isTokenAutoRefreshEnabled: true,
    });
  }
  return nativeAppCheck;
}

if (Platform.OS === 'android') {
  try {
    jsAppCheck = initializeAppCheck(app, {
      isTokenAutoRefreshEnabled: true,
      provider: new CustomProvider({
        getToken: async () => {
          try {
            // `false`, NOT `true`. Passing forceRefresh here was the bug that
            // produced "Too many attempts" on a correctly configured project:
            // it bypasses the native SDK's own hour-long token cache, so every
            // single JS-side token request became a fresh Play Integrity
            // *classic* request — and those are throttled per app instance and
            // capped at 10,000 a day for the whole app. With `false` the native
            // SDK hands back its cached token and only attests when the token
            // has actually expired, which is the once-an-hour this is supposed
            // to be. Nothing above needs a forced one: the JS SDK only calls
            // this when its own cache has run out, and the probes below want a
            // *usable* token rather than a newly minted one.
            const { token } = await getNativeAppCheckToken(getNativeAppCheck(), false);
            // A good token means whatever went wrong before is over — don't let
            // a stale failure timestamp keep excusing permission-denied errors.
            // It also stands in for the next probe: this *is* a fresh
            // attestation, obtained on the path a request actually uses.
            noteAppCheckSuccess();
            return {
              token,
              // The native SDK's token result doesn't surface the real expiry
              // (only `token`), and App Check tokens default to a 1-hour
              // lifetime — 55 minutes leaves margin without refetching on
              // every single call.
              expireTimeMillis: Date.now() + 55 * 60 * 1000,
            };
          } catch (error) {
            // Note the miss so isRecoverableAppCheckDenial can tie a
            // permission-denied that lands right after it back to App Check
            // without a second probe, then rethrow so the App Check SDK's own
            // backoff/refresh still runs.
            noteAppCheckFailure();
            throw error;
          }
        },
      }),
    });
    // Reached only if the line above didn't throw: App Check is now part of
    // every request, so a permission-denied may be its doing (see
    // appCheckTokenObtainable).
    appCheckReady = true;
  } catch (error) {
    // Non-fatal on purpose: App Check isn't enforced yet (see the rollout
    // notes in CLAUDE.md), so a phone that can't attest today still works
    // exactly as it did before this file changed.
    console.warn('[firebase] could not initialize App Check', error);
  }
}

function createAuth(): Auth {
  // On web, Firebase uses its built-in browser persistence (localStorage);
  // getReactNativePersistence only exists in the native build of the SDK.
  if (Platform.OS === 'web') {
    return getAuth(app);
  }
  try {
    // AsyncStorage persistence is what keeps a driver logged in across app
    // restarts and phone power cycles, until they explicitly log out.
    return initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    // Already initialized (can happen on Fast Refresh) — reuse the instance.
    return getAuth(app);
  }
}

export const auth = createAuth();

function createFirestore() {
  try {
    // Firestore's default streaming transport (WebChannel/gRPC-Web) is a known
    // hang risk on React Native — it can stall with no error instead of
    // failing loudly. This SDK auto-detects and falls back to long-polling by
    // default already (since v9.22.0), but that's set explicitly here so it
    // can't silently regress on an SDK upgrade.
    return initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
    });
  } catch {
    // Already initialized (Fast Refresh) — reuse the instance.
    return getFirestore(app);
  }
}

export const db = createFirestore();

// The region MUST match setGlobalOptions() in firebase/functions/src/index.ts.
// The SDK defaults to us-central1, so if these two drift apart every call fails
// with "not found" against a region that has no functions deployed in it.
export const functions = getFunctions(app, 'asia-southeast1');

/**
 * Cloud Storage — the one thing in this app that uploads a *file* rather than a
 * document: the proof-of-payment photo on a GCash or cheque receipt.
 *
 * Unlike Firestore, the bucket has no region pinned here; it is fixed when the
 * bucket is created and the SDK resolves it from `storageBucket` in the config
 * above. Nothing else belongs in here — receipts, the ledger and expenses are
 * all Firestore.
 */
export const storage = getStorage(app);

/**
 * Works out the address of the machine running the emulators.
 *
 * "localhost" on a phone or emulator means the device itself, not your computer,
 * so it can never reach the emulators. Expo advertises the computer's LAN address
 * through the dev server URI, which is what we want whenever it's available.
 */
function emulatorHost(): string {
  const fromExpo = Constants.expoConfig?.hostUri?.split(':')[0];
  if (fromExpo && fromExpo !== 'localhost' && fromExpo !== '127.0.0.1') {
    return fromExpo;
  }
  // Android emulator: Expo often reports "localhost" here because it port-forwards
  // the Metro bundler with `adb reverse` — but that forwarding only covers Metro,
  // not the Firebase ports. 10.0.2.2 is the fixed address the Android emulator
  // reserves for "the host machine".
  if (Platform.OS === 'android') {
    return '10.0.2.2';
  }
  // Web / iOS simulator both share the host's network, so localhost is correct.
  return 'localhost';
}

// Point every Firebase service at the emulators — not just auth. Miss one here
// and that service quietly reads and writes your real cloud data while
// everything else stays local, which is a genuinely nasty bug to track down.
// Ports must match firebase/firebase.json.
if (usingEmulators) {
  const host = emulatorHost();
  // Each one is guarded separately on purpose: these throw when they've already
  // been connected (which Fast Refresh causes), and a shared try/catch would let
  // the first throw skip the services after it, leaving them on the cloud.
  const connect = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      // Re-connecting is the expected, harmless case; anything else is worth seeing.
      if (!(error instanceof Error) || !/already|initialized|started/i.test(error.message)) {
        console.warn(`[firebase] could not connect ${label} emulator`, error);
      }
    }
  };

  connect('auth', () => connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true }));
  connect('firestore', () => connectFirestoreEmulator(db, host, 8080));
  connect('functions', () => connectFunctionsEmulator(functions, host, 5001));
  connect('storage', () => connectStorageEmulator(storage, host, 9199));
}

// Prints once on startup so it's never a mystery which backend you're hitting.
console.log(
  usingEmulators
    ? `[firebase] emulators at ${emulatorHost()}`
    : `[firebase] CLOUD project ${firebaseConfig.projectId} — this is real data`,
);
