import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  type User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';

import { logError } from '@/lib/errors';
import { auth, db } from '@/lib/firebase';

/**
 * How long to wait for the launch-time role check before deciding the phone
 * has no usable signal. Same window as the catalog fetches
 * (hooks/use-cached-catalog.ts) and for the same reason: a truck on a weak
 * signal must still get into the app.
 */
const RoleCheckTimeoutMs = 6000;

/**
 * Absolute cap on how long the app may sit on the splash screen. Nothing in
 * the path below should ever take this long — this exists so that if some
 * future await in here does hang, the driver still lands on a real screen
 * instead of a blank white app they can only fix by reinstalling.
 */
const StartupTimeoutMs = 12000;

/** Where a confirmed role is remembered, so the check survives going offline. */
function roleCacheKey(uid: string) {
  return `auth.role.${uid}`;
}

/**
 * Mobile and the web dashboard share one Firebase project but are meant for
 * different audiences — a driver's account shouldn't work on the dashboard,
 * and vice versa. Every account is tagged with which app it belongs to in
 * Firestore (see firestore.rules), and both apps check this right after
 * sign-in.
 */
async function getAccountRole(uid: string): Promise<string | undefined> {
  const roleDoc = await getDoc(doc(db, 'users', uid));
  return roleDoc.data()?.role;
}

/** Rejects instead of waiting forever when the network never answers. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Timed out checking this account.')), ms);
    }),
  ]).finally(() => clearTimeout(timeoutId));
}

/**
 * `'mobile'` / `'other'` are answers; `'unknown'` means we couldn't reach
 * Firestore to ask.
 */
type RoleVerdict = 'mobile' | 'other' | 'unknown';

/**
 * The role check, made survivable offline.
 *
 * A role can never change once set (firestore.rules forbids it), so a role we
 * have confirmed for an account once is true forever — which is what makes it
 * safe to remember on the device and trust without asking again. That matters
 * because the alternative is a Firestore read on every single launch, and a
 * Firestore read with no internet does not fail quickly: it either hangs or
 * eventually rejects, and either way the app is stuck until it does.
 */
async function resolveAccountRole(uid: string): Promise<RoleVerdict> {
  const cached = await AsyncStorage.getItem(roleCacheKey(uid)).catch(() => null);
  if (cached === 'mobile') return 'mobile';

  try {
    const role = await withTimeout(getAccountRole(uid), RoleCheckTimeoutMs);
    if (role !== 'mobile') return 'other';
    void rememberMobileAccount(uid);
    return 'mobile';
  } catch (error) {
    // Offline, or the server is slow. Not an answer — deliberately *not*
    // cached, so the next launch with signal asks again.
    logError('auth.roleCheck', error);
    return 'unknown';
  }
}

/**
 * Only ever records a confirmed *pass*. A failed check is never written, so a
 * one-off Firestore hiccup can't lock an account out of the app offline.
 */
async function rememberMobileAccount(uid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(roleCacheKey(uid), 'mobile');
  } catch (error) {
    // Costs us the offline shortcut next launch, nothing more.
    logError('auth.rememberRole', error);
  }
}

type AuthContextValue = {
  /** The signed-in driver, or null when logged out. */
  user: User | null;
  /** True until Firebase has restored any saved login on app start. */
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = use(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside an <AuthProvider>');
  }
  return value;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    // The splash screen stays up for exactly as long as `initializing` is
    // true (src/app/_layout.tsx), and this app's splash is plain white — so
    // anything that stops this effect from clearing the flag doesn't look
    // like an error, it looks like an app that won't open. Every path out of
    // here must reach setInitializing(false).
    let done = false;
    const finish = (nextUser: User | null) => {
      done = true;
      clearTimeout(startupTimeoutId);
      setUser(nextUser);
      setInitializing(false);
    };

    // Last resort, see StartupTimeoutMs.
    const startupTimeoutId = setTimeout(() => {
      if (done) return;
      logError('auth.startup', new Error('Auth did not settle in time; showing the app anyway.'));
      finish(auth.currentUser);
    }, StartupTimeoutMs);

    // Fires once on start with the saved login (if any), then on every
    // login/logout. Firebase keeps the session alive for us in between.
    //
    // The role check happens HERE, not just inside signIn(), and `user` is
    // only ever set once it passes. onAuthStateChanged fires the instant
    // Firebase confirms the password — before this listener has had any
    // chance to check Firestore — so if we set `user` first and checked
    // after, a mismatched account would flash the app for as long as the
    // Firestore round-trip takes (barely noticeable on the emulator, clearly
    // visible against the real cloud) before getting bounced back out.
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      // The work below is async, so it needs its own try/catch: a rejection
      // inside an onAuthStateChanged callback has nothing above it to land
      // in. It becomes an unhandled promise rejection — invisible in a
      // release build — and skips setInitializing(false) on the way out.
      void (async () => {
        try {
          if (!nextUser) {
            finish(null);
            return;
          }
          if ((await resolveAccountRole(nextUser.uid)) === 'other') {
            await firebaseSignOut(auth); // re-fires this listener with null
            return;
          }
          // 'mobile' or 'unknown'. An unverifiable account is let in rather
          // than held at a white screen: the role check is about sending
          // people to the right app, not about protecting data — that is
          // firestore.rules' job, and it applies whatever this app shows.
          // The check runs again on the next launch that has signal.
          finish(nextUser);
        } catch (error) {
          logError('auth.restore', error);
          finish(nextUser);
        }
      })();
    });

    return () => {
      clearTimeout(startupTimeoutId);
      unsubscribe();
    };
  }, []);

  const value: AuthContextValue = {
    user,
    initializing,
    signIn: async (email, password) => {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      // Redundant with the check in the listener above — that one silently
      // gates `user`, this one exists purely to give the sign-in form an
      // immediate, specific error instead of a silent bounce back to it.
      const role = await getAccountRole(credential.user.uid);
      if (role !== 'mobile') {
        await firebaseSignOut(auth);
        // Distinguish "this really is a dashboard account" from "nobody has
        // tagged this account with a role at all" — they need different fixes,
        // and claiming the wrong one is actively misleading to debug against.
        throw new Error(role === 'dashboard' ? 'ACCOUNT_IS_DASHBOARD' : 'ACCOUNT_HAS_NO_ROLE');
      }
      // Signing in is by definition online, so this is the one moment the
      // check is guaranteed to be answerable. Recording it here is what lets
      // the app open on a route with no signal tomorrow morning.
      await rememberMobileAccount(credential.user.uid);
    },
    signUp: async (email, password) => {
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      try {
        await setDoc(doc(db, 'users', credential.user.uid), { role: 'mobile' });
        await rememberMobileAccount(credential.user.uid);
      } catch (error) {
        // Don't leave a half-created account behind — with no role doc it
        // could never pass the mobile-account check and sign in again.
        await credential.user.delete().catch(() => {});
        throw error;
      }
    },
    signOut: async () => {
      await firebaseSignOut(auth);
    },
  };

  return <AuthContext value={value}>{children}</AuthContext>;
}
