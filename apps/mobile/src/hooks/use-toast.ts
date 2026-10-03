import { useCallback, useRef, useState } from 'react';

export type ToastState = {
  message: string | null;
  /** Bumped on every `show()`, even with identical text — what restarts `ScopeToast`'s fade timer. */
  token: number;
  show: (message: string) => void;
};

/**
 * A tiny "say this, then let it fade" queue for `components/scope-toast.tsx`.
 *
 * `token` rather than `message` alone is what a toast component keys its
 * animation off: tapping the same side of a toggle twice in a row (e.g.
 * "All" while already on "All" — not reachable today, since the toggle
 * disables its own active side, but a future caller might not) should still
 * restart the timer rather than being a no-op because the text didn't change.
 */
export function useToast(): ToastState {
  const [message, setMessage] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const tokenRef = useRef(0);

  const show = useCallback((text: string) => {
    tokenRef.current += 1;
    setToken(tokenRef.current);
    setMessage(text);
  }, []);

  return { message, token, show };
}
