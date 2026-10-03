import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { NoticeDialog, type NoticeRow } from '@/components/notice-dialog';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useInventory } from '@/context/inventory';
import { useReceipts } from '@/context/receipts';
import {
  MissingRunDetailsError,
  OpenDraftError,
  describeSyncCounts,
  openDraftMessage,
  syncCountParts,
  useSync,
  type SyncBlocked,
  type SyncPending,
} from '@/context/sync';
import { useTheme } from '@/hooks/use-theme';
import { formatDeviceTime } from '@/lib/device-time';
import { logError } from '@/lib/errors';
import { formatAmount, formatCount } from '@/lib/money';
import type { RunManifest } from '@/lib/sync-types';
import { notifyFailure, runWithRetry } from '@/lib/retry';

/**
 * The Home card for the day's upload state, and the button that closes it.
 *
 * Two jobs, in order of how often they matter:
 *
 * 1. **Show whether the day's work has actually reached the server.** Uploads
 *    are silent by design — they're background work nobody asked for, so they
 *    never interrupt a sale with an alert. This is where that silence is
 *    accounted for, so "still 12 to send" is something a driver can see and
 *    act on rather than discover a week later.
 * 2. **End the day**, which closes the run and uploads the manifest the
 *    dashboard uses to spot an incomplete upload.
 *
 * Renders nothing before setup is finished — there is no run to report on yet.
 */
export function EndDayCard() {
  const theme = useTheme();
  const { setup } = useInventory();
  const { pending, blocked, syncing, lastSyncedAt, syncNow, endTheDay } = useSync();
  const { findDraftReceipt, returnVoidedStock } = useReceipts();
  const [closing, setClosing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The manifest the server was just handed, kept so the read-back can be
  // shown after the run closes. It is state on this component rather than
  // markup inside the card, because ending the day clears the setup — the
  // card itself is gone by the very next render.
  const [ended, setEnded] = useState<RunManifest | null>(null);

  const allSent = pending.total === 0;

  async function handleEndDayPress() {
    // Checked before the confirm rather than after it: `endTheDay` refuses on
    // an open draft anyway, but asking "End the day?" and then refusing wastes
    // the driver's decision. A failure to *look* is deliberately ignored — the
    // check inside endTheDay is the authoritative one, and its failure surfaces
    // through the retry prompt below rather than silently blocking here.
    try {
      const draft = await findDraftReceipt();
      if (draft) {
        notifyFailure('Finish the draft receipt first', openDraftMessage(draft.customerName));
        return;
      }
    } catch (error) {
      logError('sync.endTheDay.draftCheck', error);
    }

    setConfirming(true);
  }

  async function handleConfirmEndDay() {
    setConfirming(false);
    setClosing(true);
    // Unlike the uploads themselves, this one is offered with a retry: the
    // user explicitly asked for it, and a silent failure would leave them
    // believing the server knows the day is done when it doesn't.
    //
    // The retry loop is also how "no signal" is handled — endTheDay refuses to
    // close while anything is still queued, and "Try again" is exactly what a
    // driver who has moved somewhere with signal needs. The reason it gives is
    // the real one (see PendingUploadsError), so a rejection that retrying
    // can't fix doesn't get reported as a connection problem.
    //
    // A void whose "put the bread back" step was skipped is finished first, and
    // inside the same retried action: its new ledger entry joins the queue that
    // endTheDay then refuses to close over, so it reaches the server with the
    // day. Done here rather than in endTheDay because only this side of the
    // providers can reach the stock context's totals — see returnVoidedStock.
    const result = await runWithRetry(async () => {
      await returnVoidedStock();
      return endTheDay();
    }, {
      scope: 'sync.endTheDay',
      title: 'Could not end the day',
      message: 'The day is still open and nothing has been cleared — your receipts and inventory are safe on this phone.',
      cancelLabel: 'Not now',
      // Two refusals that "Try again" cannot fix, reported once with an OK
      // instead. An open draft is a rule, not a glitch — retrying can't clear
      // it, and the alert is covering the Receipts tab the user has to go to.
      // (Only reachable if a draft appears between the pre-flight check above
      // and here.) Missing run details need a restart, because the run log is
      // only read when the app starts, so retrying in this session re-reads the
      // same empty state and fails identically.
      retryable: (error) =>
        !(error instanceof OpenDraftError) && !(error instanceof MissingRunDetailsError),
    });
    setClosing(false);

    if (!result.completed || !result.value.closed) return;

    setEnded(result.value.manifest);
  }

  return (
    <>
      {/* Rendered conditionally rather than returned early: ending the day
          clears the setup, so an early return would take the two dialogs
          below down with the card — including the one reporting that the
          day just ended. */}
      {setup.complete ? (
        <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
          <View style={styles.header}>
            <SymbolView
              name={
                allSent
                  ? { ios: 'checkmark.icloud.fill', android: 'cloud_done', web: 'cloud_done' }
                  : { ios: 'arrow.up.circle', android: 'cloud_upload', web: 'cloud_upload' }
              }
              tintColor={allSent ? theme.success : theme.warning}
              size={20}
            />
            <ThemedText type="smallBold" style={styles.headerLabel}>
              Today&apos;s upload
            </ThemedText>
            {syncing ? (
              <ThemedText type="small" themeColor="textSecondary">
                Sending…
              </ThemedText>
            ) : null}
          </View>

          <ThemedText type="small" themeColor="textSecondary" style={styles.statusLine}>
            {describeState({ pending, lastSyncedAt })}
          </ThemedText>

          {/* Separate line, and in the warning colour, because this is the opposite
              of the line above: those records are not on their way. They no longer
              hold the day open — nothing would ever send them — so without saying so
              here the day would close clean while the server was quietly missing
              them. Not a button: the driver can't fix a refused record from the
              truck, and the server can see exactly which ones from the manifest. */}
          {blocked.total > 0 ? (
            <ThemedText type="small" style={[styles.statusLine, { color: theme.warning }]}>
              {describeBlocked(blocked)}
            </ThemedText>
          ) : null}

          {/* Ending the day clears the setup, so this card is gone by the next
              render and the Inventory tab is back on the wizard. What the day
              produced is reported by the notice below, which outlives it. */}
          <View style={styles.actions}>
            {/* "Send now" only earns its place when there is something to send. */}
            {!allSent ? (
              <Pressable
                onPress={syncNow}
                disabled={syncing}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.secondaryButton,
                  { borderColor: theme.textSecondary, opacity: syncing ? 0.4 : pressed ? 0.7 : 1 },
                ]}>
                <ThemedText type="smallBold">Send now</ThemedText>
              </Pressable>
            ) : null}

            <Pressable
              onPress={() => void handleEndDayPress()}
              disabled={closing}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: theme.text, opacity: closing ? 0.4 : pressed ? 0.8 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.background }}>
                {closing ? 'Ending…' : 'End the day'}
              </ThemedText>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Worth asking: closing is one-way, and it empties the truck.
          Re-opening a run isn’t supported — a truck heading back out sets
          up a new run rather than reviving this one, which is why the
          wording promises the setup screen rather than just "finished". */}
      {/* "Your receipts", not "today's". A run may stay open across midnight —
          the truck goes out Monday and comes back Wednesday — and this sentence
          exists to promise the driver that nothing they wrote is thrown away.
          Scoped to today it promises the opposite of that to the one person who
          most needs to hear it: someone ending a three-day trip, reading that
          only today's are kept. */}
      <ConfirmDialog
        visible={confirming}
        title="End the day?"
        message={
          pending.total > 0
            ? `${describeSyncCounts(pending)} will be sent to the server first, so this needs a connection. The truck inventory is then cleared and you’re taken back to the setup screen. Your receipts are kept.`
            : 'Everything has been uploaded. The truck inventory will be cleared and you’re taken back to the setup screen. Your receipts are kept.'
        }
        cancelLabel="Not yet"
        confirmLabel="End the day"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void handleConfirmEndDay()}
      />

      {/* Ending the day clears the truck and drops back to the setup wizard,
          which on its own looks identical whether it worked or the app lost
          its state. The counts are what make it a confirmation: they are the
          same numbers the server was just given, so a driver can be asked
          "what did it say?" and answer usefully. */}
      <NoticeDialog
        visible={ended !== null}
        title="Day ended"
        message={
          // Not "everything was sent" when it demonstrably wasn’t. Closing
          // needs an empty queue, but refused records don’t hold the day
          // open — so this is the one way a day can end with work still on
          // the phone, and the confirmation has to say so rather than read
          // as a clean finish.
          ended && ended.blockedUploadCount > 0
            ? `Sent to the server, except ${formatCount(ended.blockedUploadCount)} ${ended.blockedUploadCount === 1 ? 'record it refused' : 'records it refused'}. The server has been told the same. You can try those again from Settings.`
            : 'Everything was sent to the server.'
        }
        rows={ended ? manifestRows(ended) : []}
        footnote="Truck stock is cleared. Set the truck up again when you head back out."
        onClose={() => setEnded(null)}
      />
    </>
  );
}

/**
 * The manifest, as the lines the driver is shown.
 *
 * The same figures the server was just handed, which is the whole point of
 * showing them: the two sides can be compared out loud.
 */
function manifestRows(manifest: RunManifest): NoticeRow[] {
  return [
    { label: 'Receipts', value: formatCount(manifest.receiptCount) },
    { label: 'Inventory entries', value: formatCount(manifest.stockEntryCount) },
    // "added or edited" rather than a bare "Stores", because it counts what
    // this phone changed during the run, not how many stores exist or how
    // many were visited.
    { label: 'Stores added or edited', value: formatCount(manifest.customerCount) },
    { label: 'Sales', value: `₱${formatAmount(manifest.salesTotal)}` },
    { label: 'Returns', value: `₱${formatAmount(manifest.returnsTotal)}` },
    // Listed after the takings and never folded into them — the server is
    // handed the same two figures side by side. Only shown when there is
    // something to show: a zero here reads as a prompt to have recorded some,
    // and expenses are optional.
    ...(manifest.expenseCount > 0
      ? [{ label: 'Expenses recorded (not deducted)', value: `₱${formatAmount(manifest.expenseTotal)}` }]
      : []),
    // Same rule as expenses: most days have no GCash or cheque payment at all,
    // and a "0" here would read as a prompt to have photographed something.
    ...(manifest.paymentProofCount > 0
      ? [{ label: 'Payment photos', value: formatCount(manifest.paymentProofCount) }]
      : []),
  ];
}

/** One plain-language line for the card's state — counts, not jargon. */
function describeState({
  pending,
  lastSyncedAt,
}: {
  pending: SyncPending;
  lastSyncedAt: number | null;
}): string {
  if (pending.total === 0) {
    return lastSyncedAt
      ? `Everything sent. Last checked ${formatDeviceTime(lastSyncedAt)}.`
      : 'Nothing waiting to send.';
  }

  // Spelled out per kind rather than one number: "3 receipts" tells a driver
  // what is at stake in a way "3 items" doesn't. Comma-joined here because it
  // is a list after a colon, where the prose form's "and" would read oddly.
  return `Waiting to send: ${syncCountParts(pending).join(', ')}.`;
}

/**
 * The line for records the server refused.
 *
 * Says "couldn't be sent" rather than "failed to sync", and names the kinds for
 * the same reason describeState does — "2 receipts" is something a driver can
 * report to the server; "2 items" isn't.
 */
function describeBlocked(blocked: SyncBlocked): string {
  return `Couldn’t be sent: ${syncCountParts(blocked).join(', ')}. They’re saved on this phone — tell the server, or try again from Settings.`;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.three,
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerLabel: {
    flex: 1,
  },
  /**
   * A step down from `small` (14/20) for the two status lines under the
   * heading, so the card reads as a heading with a note under it rather than
   * two paragraphs of equal weight. Both lines take it: they are one status
   * block — what's on its way, and what the server refused — and sizing only
   * one would read as the other being a different kind of message.
   *
   * Line height is dropped with the font rather than left alone: these lines
   * wrap freely (nothing caps them, and "Waiting to send: …" is the state the
   * card is in most of the day), so the spacing between wrapped lines is as
   * much of the card's height as the size is.
   */
  statusLine: {
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  secondaryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  primaryButton: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
  },
});
