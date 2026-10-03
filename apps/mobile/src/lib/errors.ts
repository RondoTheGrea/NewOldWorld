/**
 * Turning a thrown *thing* into something a person can read, and getting it
 * into the logs on the way past.
 *
 * JavaScript lets any value be thrown, not just `Error`s — a rejected promise
 * deep inside a library can hand back a string, an object, or `undefined`. So
 * nothing that displays an error is allowed to assume `error.message` exists;
 * everything goes through describeError first.
 */

/** Last-resort wording when the failure carries no usable message of its own. */
const GENERIC_MESSAGE = 'Something went wrong.';

/**
 * A short, human-readable line for the failure — safe to show in an alert.
 * Technical messages are kept as-is: they're what makes a bug report from the
 * field useful, and there's no polished catalogue of friendly rewrites to map
 * them onto. The *context* ("Could not save the batch") is the caller's job;
 * this is only the detail line under it.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return GENERIC_MESSAGE;
}

/**
 * One place that writes failures to the console, tagged with where they came
 * from (`'receipts.finalize'`, `'stock.addBatch'`, …). In development that
 * shows up in the Expo terminal; on a real phone it lands in `adb logcat`.
 * If crash reporting is ever added, this is the single function to change.
 *
 * `details` is an optional bag of identifying facts about *what* failed —
 * which run, which receipt, which number was being checked. The scope says
 * where in the code the failure happened, which on its own is rarely enough:
 * `[sync.receipt.blocked] FirebaseError: permission-denied` names no receipt
 * and no run, so nobody reading it afterwards can go and look at the record.
 * Details are printed ahead of the error as `{key=value key=value}` so one
 * line carries both.
 *
 * Values are formatted defensively — this runs inside `catch` blocks all over
 * the app, and a logger that can itself throw would replace a failure that was
 * being handled with one that isn't.
 */
export function logError(scope: string, error: unknown, details?: Record<string, unknown>): void {
  const context = formatDetails(details);
  if (context) console.error(`[${scope}] ${context}`, error);
  else console.error(`[${scope}]`, error);
}

/** `{runId=2026-08-22_grp_1 sequence=2}`, or '' when there is nothing to say. */
function formatDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return '';

  try {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(details)) {
      // Skipped rather than printed as "undefined": a caller spreading an
      // optional record shouldn't have to filter its own holes out first.
      if (value === undefined) continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
    return parts.length ? `{${parts.join(' ')}}` : '';
  } catch {
    return '{details unreadable}';
  }
}

function formatValue(value: unknown): string {
  // `null` is meaningful here — "this row names no run" is exactly the kind of
  // thing being logged — so it is spelled out rather than dropped.
  if (value === null) return 'none';
  if (typeof value === 'string') return value || "''";
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    // Circular structures throw; a value with a hostile toJSON can too.
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unprintable]';
  }
}
