import { getApp, getApps, initializeApp } from 'firebase/app';
import { ReCaptchaEnterpriseProvider, initializeAppCheck } from 'firebase/app-check';
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  initializeAuth,
} from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

/**
 * Which backend is this app talking to — the emulators on your computer, or the
 * real Firebase project in the cloud?
 *
 *   npm run dev        -> emulators   (fast, free, throwaway data)
 *   npm run dev:cloud   -> real cloud (slower, real data, catches deploy bugs)
 *
 * import.meta.env.DEV is Vite's built-in: true for `vite`/`vite dev`, always
 * false in a production build (`vite build`). Having it here means a deployed
 * dashboard can NEVER be talked into pointing at localhost, no matter what the
 * .env file says — same safety net as the mobile app's __DEV__ check.
 */
export const usingEmulators = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR !== 'false';

/**
 * Config for the emulators. These are deliberate fakes — the emulators accept
 * any values and never check them against a real account.
 *
 * The "demo-" prefix on projectId marks this as a demo project to Firebase, so
 * the tooling stays fully offline and never needs a login. Must match the
 * --project flag in firebase/package.json and the mobile app's emulatorConfig,
 * otherwise users created here won't show up in the same Emulator UI.
 */
const emulatorConfig = {
  apiKey: 'demo-api-key',
  authDomain: 'demo-newoldworld.firebaseapp.com',
  projectId: 'demo-newoldworld',
  appId: 'demo-app-id',
  // Needed even against the emulator. Without a bucket the Storage SDK has no
  // default to resolve a path against and throws `storage/no-default-bucket` —
  // and it throws at the first `ref()`, not at `getStorage()`, so the failure
  // would surface as one broken proof photo rather than as a startup error.
  // Any name works here; the emulator does not check it against a real bucket.
  // Must match the mobile app's emulatorConfig, or the dashboard looks for
  // photos in a different bucket than the one the phone uploaded to.
  storageBucket: 'demo-newoldworld.firebasestorage.app',
};

/**
 * Config for the real cloud project, read from apps/web/.env.
 *
 * Safe to commit and safe to ship in the bundle — these only identify which
 * Firebase project to talk to, they don't grant access. What actually protects
 * the data is the Firestore security rules. (Real secrets must never go in a
 * VITE_ variable — everything with that prefix is baked into the built JS and
 * readable by anyone who loads the page. Secrets belong in Cloud Functions.)
 */
const cloudConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
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
        'Fix: open the Firebase console for project REPLACE-WITH-NEW-PROJECT-ID,',
        'go to Project Settings > General > Your apps > Web app, copy the',
        'firebaseConfig values, and paste them into apps/web/.env.',
        '',
        'Or run `npm run dev` instead to use the local emulators.',
      ].join('\n'),
    );
  }

  return cloudConfig as Record<keyof typeof cloudConfig, string>;
}

const firebaseConfig = usingEmulators ? emulatorConfig : requireCloudConfig();

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

/**
 * App Check — proves a request came from this actual dashboard page, not a
 * script calling Firestore/Storage/Auth directly with the (deliberately
 * public) config above. Exists for the same reason the mobile app has one
 * (see CLAUDE.md's "App Check (mobile)" section and the bot-signup incident
 * it documents): once Firestore/Storage/Authentication enforcement is turned
 * on for the project, it applies to *every* client talking to them — the
 * dashboard included, not just mobile. Without this, flipping enforcement on
 * would lock the dashboard itself out.
 *
 * reCAPTCHA Enterprise is invisible in normal use — no checkbox, no puzzle,
 * nothing shown to whoever's logged in. It scores the session silently in the
 * background.
 */
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;

if (import.meta.env.DEV) {
  // The debug provider bypasses reCAPTCHA entirely for local dev, so
  // localhost doesn't need to be registered with the real site key. Set to a
  // specific token once you've registered one (Firebase console > App Check >
  // Apps > manage debug tokens) — until then this defaults to `true`, which
  // logs a fresh token to the browser console for you to go register.
  (self as typeof self & { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    import.meta.env.VITE_APP_CHECK_DEBUG_TOKEN || true;
}

if (recaptchaSiteKey || import.meta.env.DEV) {
  try {
    initializeAppCheck(app, {
      // The debug-token global above makes the SDK use the debug provider
      // regardless of what's passed here, so a placeholder is fine when only
      // developing locally with no site key registered yet.
      provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey || 'unconfigured-dev-only'),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (error) {
    // Non-fatal on purpose, same as mobile: App Check isn't enforced yet, so
    // a session that can't attest today still works exactly as it did before
    // this existed.
    console.warn('[firebase] could not initialize App Check', error);
  }
} else {
  console.warn(
    '[firebase] App Check not configured — set VITE_RECAPTCHA_SITE_KEY in apps/web/.env once registered in the Firebase console.',
  );
}

function createAuth() {
  try {
    // Explicit browserLocalPersistence (localStorage) so a login survives a tab
    // or browser close, same as the mobile app staying signed in until "Log
    // out" — this is Firebase's web default too, but pinned so it can't
    // silently regress on an SDK upgrade.
    return initializeAuth(app, { persistence: browserLocalPersistence });
  } catch {
    // Already initialized (can happen on Vite HMR) — reuse the instance.
    return getAuth(app);
  }
}

export const auth = createAuth();

export const db = getFirestore(app);

// The region MUST match setGlobalOptions() in firebase/functions/src/index.ts.
// The SDK defaults to us-central1, so if these two drift apart every call fails
// with "not found" against a region that has no functions deployed in it.
export const functions = getFunctions(app, 'asia-southeast1');

/**
 * Cloud Storage — read-only from this end. The dashboard never uploads; it
 * resolves the proof photo a phone uploaded, from the `proofStoragePath` stored
 * on the receipt document. Switched to the emulator in the same block below as
 * every other service, so a local dashboard can't read production files.
 */
export const storage = getStorage(app);

// Point every Firebase service at the emulators — not just auth. Miss one here
// and that service quietly reads and writes real cloud data while everything
// else stays local, which is a genuinely nasty bug to track down.
// Ports must match firebase/firebase.json.
if (usingEmulators) {
  const connect = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      // Re-connecting is the expected, harmless case on HMR; anything else is
      // worth seeing.
      if (!(error instanceof Error) || !/already|initialized|started/i.test(error.message)) {
        console.warn(`[firebase] could not connect ${label} emulator`, error);
      }
    }
  };

  connect('auth', () => connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true }));
  connect('firestore', () => connectFirestoreEmulator(db, 'localhost', 8080));
  connect('functions', () => connectFunctionsEmulator(functions, 'localhost', 5001));
  connect('storage', () => connectStorageEmulator(storage, 'localhost', 9199));
}

// Prints once on startup so it's never a mystery which backend you're hitting.
console.log(
  usingEmulators
    ? '[firebase] emulators at localhost'
    : `[firebase] CLOUD project ${firebaseConfig.projectId} — this is real data`,
);
