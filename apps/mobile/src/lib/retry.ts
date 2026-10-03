import { Alert, Platform } from 'react-native';

import { describeError, logError } from '@/lib/errors';

/**
 * The app's answer to "the save just failed — now what?".
 *
 * Every write in this app is local-first (SQLite, AsyncStorage, Bluetooth), so
 * a failure is almost always transient: the phone was out of storage for a
 * moment, the printer went out of range, the database was mid-lock. The right
 * response is almost never "give up silently" — it's "say what didn't happen,
 * and offer to do it again". That's what runWithRetry is.
 *
 * Deliberately built on a plain alert rather than an in-screen error state:
 * these actions fire from inside modals that are already stacked two deep, and
 * an alert is the one thing guaranteed to be visible on top of all of them.
 */

type RetryOptions = {
  /** Log tag, e.g. `'receipts.finalize'`. Never shown to the user. */
  scope: string;
  /** Alert title — what failed, in the user's words: 'Could not save the batch'. */
  title: string;
  /** The consequence, so the user knows what state things are in: 'Nothing was saved.' */
  message: string;
  /** Label for the give-up button. 'Cancel' unless something better fits. */
  cancelLabel?: string;
  /**
   * Return false for a failure that would fail identically next time — a rule
   * the user has to resolve first ("a draft already exists"), not a glitch.
   * Those are reported with a plain OK, because offering "Try again" for
   * something guaranteed to fail again is worse than saying so outright.
   */
  retryable?: (error: unknown) => boolean;
};

/** `completed: false` means the user chose to stop, not that it silently failed. */
export type RetryResult<T> = { completed: true; value: T } | { completed: false };

/**
 * Runs `action`. If it throws, logs it, tells the user what didn't happen, and
 * offers "Try again" — looping as many times as they're willing to. Resolves
 * only once the action succeeds or the user backs out; it never rejects, so
 * callers can't leave an unhandled rejection behind.
 *
 * The caller decides what "backed out" means for its own UI — usually: leave
 * the modal open with the user's input intact so nothing they typed is lost.
 */
export async function runWithRetry<T>(action: () => Promise<T>, options: RetryOptions): Promise<RetryResult<T>> {
  for (;;) {
    try {
      return { completed: true, value: await action() };
    } catch (error) {
      logError(options.scope, error);
      if (options.retryable && !options.retryable(error)) {
        notifyFailure(options.title, describeError(error));
        return { completed: false };
      }
      const again = await confirmRetry(options.title, `${options.message}\n\n${describeError(error)}`, options.cancelLabel);
      if (!again) return { completed: false };
    }
  }
}

/**
 * Reports a failure the user can't retry their way out of (or that already
 * half-succeeded, where running it again would be wrong). Resolves once the
 * alert is dismissed.
 */
export function notifyFailure(title: string, message: string): void {
  if (Platform.OS === 'web') {
    if (typeof globalThis.alert === 'function') globalThis.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message, [{ text: 'OK' }]);
}

/**
 * Two-button "that didn't work — try again?" prompt, as a promise.
 *
 * React Native's `Alert` is a no-op on web, which would leave the promise
 * hanging forever and freeze the calling flow, so web falls back to the
 * browser's own confirm dialog. (Receipts and Inventory are native-only today,
 * but this is shared code and a silent hang is the worst possible failure.)
 */
function confirmRetry(title: string, message: string, cancelLabel = 'Cancel'): Promise<boolean> {
  if (Platform.OS === 'web') {
    const confirmFn = globalThis.confirm;
    return Promise.resolve(typeof confirmFn === 'function' ? confirmFn(`${title}\n\n${message}`) : false);
  }

  return new Promise((resolve) => {
    let answered = false;
    const answer = (again: boolean) => {
      if (answered) return;
      answered = true;
      resolve(again);
    };

    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => answer(false) },
        { text: 'Try again', onPress: () => answer(true) },
      ],
      // Android's back button / tap-outside would otherwise dismiss the alert
      // without firing either handler, leaving this promise pending forever.
      { cancelable: true, onDismiss: () => answer(false) },
    );
  });
}
