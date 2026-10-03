import {
  type User,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { createContext, use, useEffect, useState, type PropsWithChildren } from 'react';

import { browserSessionId, claimDashboardSession } from '@/lib/dashboard-session';
import { auth, db } from '@/lib/firebase';

/**
 * Mobile and the dashboard share one Firebase project but are meant for
 * different audiences — a dashboard account shouldn't work in the mobile app,
 * and vice versa. Every account is tagged with which app it belongs to in
 * Firestore (see firestore.rules).
 *
 * `admin` rides along on the same read because it is on the same document and
 * the page needs both at the same moment. It gates the Team page and every
 * function behind it; a dashboard account without it can use the dashboard and
 * nothing else.
 */
type Account = { role: string | undefined; admin: boolean };

async function getAccount(uid: string): Promise<Account> {
  const snapshot = await getDoc(doc(db, 'users', uid));
  const data = snapshot.data();
  return { role: data?.role as string | undefined, admin: data?.admin === true };
}

/**
 * Why the user is looking at the login screen when they didn't ask to be.
 *
 * Being signed out with no explanation is indistinguishable from the app being
 * broken, and the two causes here have different answers — one is "you or a
 * colleague opened this account somewhere else", the other is "your access was
 * changed, go and ask". So the reason outlives the sign-out and is handed to the
 * login page to show.
 */
export type SignedOutReason = { title: string; detail: string };

const TakenOver = (where: string): SignedOutReason => ({
  title: 'Signed out — this account was opened somewhere else',
  detail: `Someone signed in to this account on ${where}. Each account can only be used in one place at a time, so this window was signed out. If that wasn't you or a colleague, sign back in and change the password.`,
});

const AccessChanged: SignedOutReason = {
  title: 'Signed out — your access changed',
  detail:
    'Your dashboard access was turned off or updated by an administrator. Sign in again, or ask your administrator if the problem continues.',
};

type AuthContextValue = {
  /** The signed-in staff user, or null when logged out. */
  user: User | null;
  /** True when this account may manage the dashboard team. */
  isAdmin: boolean;
  /** True until Firebase has restored any saved login on page load. */
  initializing: boolean;
  /** Set when the app signed the user out on its own. Cleared on the next sign-in. */
  signedOutReason: SignedOutReason | null;
  dismissSignedOutReason: () => void;
  signIn: (email: string, password: string) => Promise<void>;
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
  const [isAdmin, setIsAdmin] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [signedOutReason, setSignedOutReason] = useState<SignedOutReason | null>(null);

  useEffect(() => {
    // Fires once on load with the saved login (if any), then on every
    // sign-in/sign-out. Firebase keeps the session alive for us in between.
    //
    // The role check happens HERE, not just inside signIn(), and `user` is
    // only ever set once it passes. onAuthStateChanged fires the instant
    // Firebase confirms the password — before this listener has had any
    // chance to check Firestore — so if we set `user` first and checked
    // after, a mismatched account would flash the dashboard for as long as
    // the Firestore round-trip takes (barely noticeable on the emulator,
    // clearly visible against the real cloud) before getting bounced back.
    // Gating `user` itself on the check means the login screen just stays up
    // — spinner and all — until we're sure, with nothing to un-render.
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      if (!nextUser) {
        setUser(null);
        setIsAdmin(false);
        setInitializing(false);
        return;
      }
      // Every path out of here must settle `initializing`, including the
      // failure one. This callback is the only thing holding the blank screen
      // that shows before the app decides between the login page and the
      // dashboard — and a Firestore read with no connection doesn't fail fast,
      // it hangs and then rejects, inside an async callback with nothing above
      // it to catch. Unhandled, that leaves a permanently blank page, which
      // reads as an app that won't open rather than as an error. (The mobile
      // app shipped exactly this bug once; see CLAUDE.md's "Launching with no
      // internet".)
      let account: Account;
      try {
        account = await getAccount(nextUser.uid);
      } catch (error) {
        console.warn('[auth] could not check this account’s role', error);
        // Unlike mobile, an unverifiable account is NOT let in here. On the
        // phone the role check only routes people to the right app; on the
        // dashboard it is the line between a driver's login and a server-side one,
        // and the dashboard is unusable without a connection anyway. So: say
        // so, and show the login screen rather than a blank one.
        setSignedOutReason({
          title: 'Couldn’t check your account',
          detail:
            'The dashboard couldn’t reach the server to confirm your access. Check your connection and sign in again.',
        });
        // Settle FIRST. Signing out re-fires this listener with null, which is
        // what normally settles it — but if the sign-out itself rejects, that
        // never happens and we are back to the permanently blank page this
        // whole block exists to prevent. Ordering it this way means the worst
        // case is a login screen shown a moment early, not no screen at all.
        setInitializing(false);
        await firebaseSignOut(auth).catch(() => undefined);
        return;
      }
      if (account.role !== 'dashboard') {
        setInitializing(false);
        await firebaseSignOut(auth).catch(() => undefined);
        return;
      }
      setUser(nextUser);
      setIsAdmin(account.admin);
      setInitializing(false);
    });
    return unsubscribe;
  }, []);

  /**
   * Keeps `isAdmin` live for as long as the session lasts.
   *
   * The listener above reads the role doc once, which is right for the thing it
   * gates (whether to show the dashboard at all) and wrong for this: an admin
   * demoted by a colleague on another machine would keep the Team page on
   * screen until they next signed in. Every function behind it still refuses
   * them, so nothing unsafe happens — but a page full of buttons that all
   * return "permission denied" is a worse way to be told than the page simply
   * going away.
   *
   * Read-only and failure-tolerant: an error here leaves the last known answer
   * standing rather than demoting somebody because their connection dropped.
   */
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) return;
    return onSnapshot(
      doc(db, 'users', uid),
      (snapshot) => {
        // A missing doc means the account was removed from the team. The
        // session claim is deleted at the same moment, and that is what signs
        // them out — with an explanation, which this listener has no way to
        // give. So leave it alone rather than racing it.
        if (snapshot.exists()) setIsAdmin(snapshot.data()?.admin === true);
      },
      (error) => console.warn('[auth] lost sight of this account’s role', error),
    );
  }, [user?.uid]);

  /**
   * ONE BROWSER PER ACCOUNT — the watching half. See
   * firebase/functions/src/dashboard-users.ts for the server's side and why the
   * claim also swaps this browser onto a fresh credential.
   *
   * `dashboardSessions/{uid}` names the browser that signed in last. This tab
   * watches its own and reacts to exactly two things:
   *
   *   - the id isn't ours and we have never claimed  -> claim it (we just
   *     signed in, or this browser is taking the account back after being
   *     evicted and the person has clearly returned to it)
   *   - the id stops being ours after we held it     -> somebody else signed
   *     in; sign out and say so
   *
   * The `claimed` flag is what keeps those apart, and it is the whole reason
   * two browsers can't fight: only the first mismatch each tab sees is treated
   * as an invitation to claim. Without it, evicting and being evicted would
   * alternate forever and neither person could work.
   *
   * Keyed on the uid rather than the user object: the reauth below signs in
   * again as the same person, which hands us a new User instance, and re-running
   * this effect on that would claim a second time on every login.
   */
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) return;

    const mySessionId = browserSessionId();
    let claimed = false;
    let claiming = false;
    let stopped = false;

    async function claim() {
      let reauthToken: string | null = null;
      try {
        ({ reauthToken } = await claimDashboardSession(mySessionId));
      } catch (error) {
        // The claim never landed, so nothing was revoked and this browser's
        // login is untouched. Leave the user working; the next reload tries
        // again. Failing open here is deliberate — a network blip must not
        // cost somebody their session.
        console.warn('[auth] could not claim this browser’s session', error);
        claiming = false;
        return;
      }

      // From here the server HAS revoked every credential for this account,
      // including the one this tab is holding. It still works for up to an
      // hour (Firestore doesn't re-check revocation until the token is
      // renewed), which is exactly what makes getting this wrong so nasty:
      // everything looks fine, then the user is dropped mid-task with no
      // explanation. So the swap onto the replacement credential is not
      // best-effort — if it can't be done, end the session now, while there is
      // still something on screen to explain it with.
      if (!reauthToken) {
        // The server chose not to revoke at all (it couldn't mint a
        // replacement), so the current credential is still good.
        claiming = false;
        return;
      }
      try {
        await signInWithCustomToken(auth, reauthToken);
      } catch (first) {
        console.warn('[auth] retrying the credential swap', first);
        try {
          await signInWithCustomToken(auth, reauthToken);
        } catch (error) {
          console.warn('[auth] could not swap onto the new credential', error);
          setSignedOutReason({
            title: 'Signed out — please sign in again',
            detail:
              'Your session could not be renewed after signing in on this browser. Nothing is wrong with your account; signing in again will fix it.',
          });
          await firebaseSignOut(auth).catch(() => undefined);
          return;
        }
      }
      claiming = false;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'dashboardSessions', uid),
      (snapshot) => {
        if (stopped) return;
        const held = snapshot.data();
        const heldId = held?.sessionId as string | undefined;

        if (heldId === mySessionId) {
          claimed = true;
          claiming = false;
          return;
        }
        if (!claimed) {
          // Only ever once — set before the await so a second snapshot
          // arriving mid-flight can't start a duplicate claim.
          claimed = true;
          claiming = true;
          void claim();
          return;
        }
        if (claiming) {
          // Our own claim is still in the air, so this snapshot is somebody
          // else's claim landing during the ~1.5s the server spends minting a
          // replacement credential — not an eviction of a session we hold.
          // Signing out here would be signing out over a claim we are about to
          // win: ours writes last, so the document ends up naming us while
          // nobody is signed in on this browser at all, and the other browser
          // is then evicted by the claim of a tab that already quit. Waiting
          // costs nothing; the snapshot after ours lands settles it correctly.
          return;
        }
        // We held this account and no longer do.
        setSignedOutReason(
          heldId
            ? TakenOver((held?.label as string | undefined) || 'another browser')
            : // The claim is gone rather than reassigned, which is what
              // disabling or removing an account does to it.
              AccessChanged,
        );
        void firebaseSignOut(auth);
      },
      (error) => {
        // Losing the listener is not a reason to sign anybody out — it is far
        // more likely to be a dropped connection than an eviction, and a
        // dashboard that logs people out when the wifi blinks is worse than one
        // that occasionally lets a second window live a little longer. The
        // claim on the next reload settles it either way.
        console.warn('[auth] lost sight of the session claim', error);
      },
    );

    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [user?.uid]);

  const value: AuthContextValue = {
    user,
    isAdmin,
    initializing,
    signedOutReason,
    dismissSignedOutReason: () => setSignedOutReason(null),
    signIn: async (email, password) => {
      // Whatever the last sign-out was about, the user has now answered it by
      // signing in again — leaving the banner up would have it explaining a
      // screen that is no longer showing.
      setSignedOutReason(null);
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      // Redundant with the check in the listener above — that one silently
      // gates `user`, this one exists purely to give the login form an
      // immediate, specific error instead of a silent bounce back to it.
      const account = await getAccount(credential.user.uid);
      if (account.role !== 'dashboard') {
        await firebaseSignOut(auth);
        // Distinguish "this really is a mobile account" from "nobody has
        // tagged this account with a role at all" — they need different
        // fixes, and claiming the wrong one is actively misleading to debug.
        throw new Error(account.role === 'mobile' ? 'ACCOUNT_IS_MOBILE' : 'ACCOUNT_HAS_NO_ROLE');
      }
    },
    signOut: async () => {
      // A deliberate log-out needs no explanation on the way back in, and
      // clearing it here stops a stale banner from an earlier eviction
      // reappearing on the login screen.
      setSignedOutReason(null);
      await firebaseSignOut(auth);
    },
  };

  return <AuthContext value={value}>{children}</AuthContext>;
}
