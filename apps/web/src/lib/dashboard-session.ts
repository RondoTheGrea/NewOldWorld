import { httpsCallable } from 'firebase/functions';

import { functions } from '@/lib/firebase';

/**
 * ONE BROWSER PER ACCOUNT — the browser's half.
 *
 * The server records which browser holds an account at `dashboardSessions/{uid}`
 * (see firebase/functions/src/dashboard-users.ts). This file owns the id that
 * identifies *this* browser and the call that claims the account for it; the
 * watching and the signing-out live in `context/auth.tsx`, where the user is.
 */

const SessionKey = 'newoldworld.dashboard.sessionId';

/**
 * A stable id for this browser profile.
 *
 * **localStorage, not sessionStorage, and that choice is the feature.**
 * sessionStorage is per-tab, so a second tab of the same dashboard would look
 * like a different browser and evict the first — a manager with the Live board
 * open beside the Team page would fight themselves. localStorage is shared by
 * every tab in one browser profile, so tabs coexist and the id only differs
 * where we actually want it to: another computer, another browser, another
 * person's profile, or a private window. That is the real unit of "somebody
 * else is using this login".
 *
 * It survives a reload on purpose. A browser that already holds the claim
 * re-signs-in to the same id and nothing happens — no eviction, no credential
 * churn, no 1.5-second pause. Only a genuinely new browser costs that.
 */
/**
 * A random id in the shape the server accepts.
 *
 * **`crypto.randomUUID` is not always there**, and its absence is not exotic:
 * it exists only in a secure context, so a dashboard opened over plain HTTP on
 * a local network (`http://192.168.1.x`) has `crypto.randomUUID === undefined`.
 * Calling it there throws a TypeError — which is why the fallback below cannot
 * itself be a call to `crypto.randomUUID`, as the catch that used to wrap this
 * was: the handler would throw the identical error, synchronously, out of a
 * React effect, taking the whole app down. `getRandomValues` is tried next
 * because it is available in more places, and `Math.random` last, which is not
 * cryptographic but does not need to be — this id only has to be unlikely to
 * collide with the same account's other browser.
 */
function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fall through to Math.random below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function browserSessionId(): string {
  try {
    const existing = localStorage.getItem(SessionKey);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const minted = randomId();
    localStorage.setItem(SessionKey, minted);
    return minted;
  } catch {
    // Storage can be unavailable (private mode, blocked site data). A one-off
    // id still works — it just means this browser behaves like a brand-new one
    // on every reload, which is the safe direction: it evicts others rather
    // than silently inheriting somebody else's claim.
    return randomId();
  }
}

/**
 * A short, human phrase for this browser, shown to whoever gets signed out so
 * they can tell "my other laptop" from "someone I should go and ask about".
 *
 * Read off the user-agent, which is guesswork by nature — hence the plain
 * fallback rather than anything that would read as certain.
 */
export function browserLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : '';
  const platform =
    /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'Mac'
    : '';
  if (browser && platform) return `${browser} on ${platform}`;
  return browser || platform || 'another browser';
}

type ClaimResult = {
  /**
   * A one-use credential to sign in with, replacing the one the claim just
   * revoked. Null when the server chose not to revoke at all — see the function
   * for why that is a supported outcome and not an error.
   */
  reauthToken: string | null;
};

const claim = httpsCallable<{ sessionId: string; label: string }, ClaimResult>(
  functions,
  'claimDashboardSession',
);

export async function claimDashboardSession(sessionId: string): Promise<ClaimResult> {
  const result = await claim({ sessionId, label: browserLabel() });
  return result.data;
}
