import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { NoticeDialog } from '@/components/notice-dialog';
import { PaymentMethodModal } from '@/components/payment-method-modal';
import { PaymentProofViewModal } from '@/components/payment-proof-view-modal';
import { ReceiptPrintPreviewModal } from '@/components/receipt-print-preview-modal';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { NoOpenRunError, useInventory } from '@/context/inventory';
import {
  CannotVoidReceiptError,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  type ReceiptDetail,
  type ReceiptPaymentProof,
  type ReceiptSummary,
  InsufficientStockError,
  NotADraftError,
  stockUnsettledMessage,
  useReceipts,
} from '@/context/receipts';
import { useSync } from '@/context/sync';
import { useTheme } from '@/hooks/use-theme';
import { formatDeviceDateTime } from '@/lib/device-time';
import { logError } from '@/lib/errors';
import { formatAmount, formatCount } from '@/lib/money';
import { capturePaymentProof } from '@/lib/payment-proof';
import { notifyFailure, runWithRetry } from '@/lib/retry';

type ReceiptDetailModalProps = {
  /** Present to show the modal; null closes it. */
  receipt: ReceiptSummary | null;
  onClose: () => void;
  /**
   * Only ever called for a draft — opens ReceiptFormModal pre-filled to edit it.
   * Optional because the customer profile's Purchase History lists finalized
   * receipts only, so it never shows the Edit button.
   */
  onEdit?: (detail: ReceiptDetail) => void;
};


export function ReceiptDetailModal({ receipt, onClose, onEdit }: ReceiptDetailModalProps) {
  return (
    <Modal visible={!!receipt} transparent animationType="fade" onRequestClose={onClose}>
      {/* Mounted fresh each time a receipt is opened, so its fetched detail
          always matches the receipt being viewed instead of syncing via an effect. */}
      {receipt && <ReceiptDetailBody summary={receipt} onClose={onClose} onEdit={onEdit} />}
    </Modal>
  );
}

function ReceiptDetailBody({
  summary,
  onClose,
  onEdit,
}: {
  summary: ReceiptSummary;
  onClose: () => void;
  onEdit?: (detail: ReceiptDetail) => void;
}) {
  const theme = useTheme();
  const { getReceiptDetail, deleteDraft, finalize, voidReceipt, getPaymentProof, setPaymentProof } = useReceipts();
  const { runId } = useInventory();
  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  // Voiding asks twice: 'first' says what a void does, 'final' names the
  // receipt and is the only step that writes. One dialog whose wording changes,
  // not two stacked modals, so nothing flickers between the steps.
  const [voidStep, setVoidStep] = useState<'first' | 'final' | null>(null);
  const [voiding, setVoiding] = useState(false);

  // Both read the copy from disk once it lands, for the reason the draft-only
  // buttons below do: the list row can be a moment behind it.
  const current = detail ?? summary;
  const isVoided = current.voidedAt !== null;
  // The owner's rule, as a button: only a standing, finalized receipt from the
  // run that is open right now. voidReceipt checks the same three things again
  // from disk, so hiding the button is a courtesy and not the guard.
  const canVoid = current.status === 'finalized' && !isVoided && runId !== null && current.runId === runId;
  const [loadError, setLoadError] = useState(false);
  // Bumped by the "Try again" button to re-run the detail fetch below.
  const [loadToken, setLoadToken] = useState(0);
  const [confirming, setConfirming] = useState<'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickingPayment, setPickingPayment] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // Tapping the grayed Preview on a voided receipt explains itself rather than
  // doing nothing — a dead button can't say why it won't work.
  const [printBlocked, setPrintBlocked] = useState(false);

  const hasProofSection = summary.status === 'finalized' && (summary.paymentMethod === 'gcash' || summary.paymentMethod === 'cheque');
  const [proof, setProof] = useState<ReceiptPaymentProof | null>(null);
  const [viewingProof, setViewingProof] = useState(false);
  const [uploadingProof, setUploadingProof] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const subtotal = detail?.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) ?? 0;
  const returnsTotal = detail?.returns.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) ?? 0;

  useEffect(() => {
    let cancelled = false;
    getReceiptDetail(summary.id)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch((error: unknown) => {
        logError('receipts.getDetail', error);
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch keyed on the receipt id only
  }, [summary.id, loadToken]);

  // Re-read when the pending-photo count moves, which is what makes the "Waiting
  // to send" line below turn into "Sent to the server" while the modal is open,
  // rather than only on the next open. The count is the cheapest available
  // signal that the drain did something — no polling, no extra listener.
  const pendingProofCount = useSync().pending.paymentProofs;

  useEffect(() => {
    if (!hasProofSection) return;
    let cancelled = false;
    getPaymentProof(summary.id)
      .then((loaded) => {
        if (!cancelled) setProof(loaded);
      })
      // The photo is a nice-to-have on an already-finalized receipt: if the
      // lookup fails the section just offers "Add photo" as if none existed,
      // which is better than an alert the user can do nothing about.
      .catch((error: unknown) => logError('receipts.getPaymentProof', error));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch keyed on the receipt id only
  }, [summary.id, hasProofSection, pendingProofCount]);

  async function handleAddPhoto() {
    setUploadError(null);
    setUploadingProof(true);
    try {
      const captured = await capturePaymentProof(summary.id);
      if (!captured) return; // user cancelled the camera
      const saved = await setPaymentProof(summary.id, captured.fileName, captured.localUri);
      setProof(saved);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not save the photo.');
    } finally {
      setUploadingProof(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    const result = await runWithRetry(() => deleteDraft(summary.id), {
      scope: 'receipts.deleteDraft',
      title: 'Could not delete the draft',
      message: 'The draft is still here — nothing was deleted.',
      // The receipt was finalized (or removed) while this modal was open, so
      // there is no draft left to delete and a retry would say the same thing.
      // Nothing was deleted — the refusal happens before any row is touched.
      retryable: (error) => !(error instanceof NotADraftError),
    });
    setBusy(false);
    setConfirming(null);
    if (result.completed) onClose();
  }

  async function handleFinalize(paymentMethod: PaymentMethod, amountPaid?: number) {
    // Safe to retry as a whole: a second attempt re-reads the receipt from
    // disk, so it can neither finalize twice nor deduct stock twice — if the
    // first attempt got part way through, the retry finishes what's left.
    const result = await runWithRetry(() => finalize(summary.id, paymentMethod, amountPaid), {
      scope: 'receipts.finalize',
      title: 'Could not finalize the receipt',
      // Deliberately not "nothing was saved": the failure can land after the
      // receipt is already written, and telling the driver their receipt is
      // gone when it isn't is worse than telling them to tap the button again.
      message: 'The receipt may not have been fully saved. Tap “Try again” — repeating it is safe and can’t charge or deduct anything twice.',
      // Two walls a retry can only hit again, so both are reported once:
      // - NoOpenRunError: nothing to file the receipt under. The driver has to
      //   set the truck up first. Happens when a draft is left over from
      //   before "End the Day" cleared the setup.
      // - InsufficientStockError: the order is bigger than the load. Nothing
      //   was written, so the receipt is still an editable draft — the fix is
      //   Edit, lower the lines, then take the payment again.
      retryable: (error) => !(error instanceof NoOpenRunError) && !(error instanceof InsufficientStockError),
    });
    if (!result.completed) return;

    // The receipt is finalized either way; these are the cases where the truck
    // count hasn't caught up, and a driver who isn't told will find it at the
    // end of the day with nothing to explain it.
    //
    // Only 'run-closed' is reported here. 'skipped' means the user just
    // answered a prompt carrying this same wording — saying it twice reads as
    // two separate problems (see stockUnsettledMessage).
    if (result.value === 'run-closed') {
      notifyFailure('Truck stock not updated', stockUnsettledMessage('run-closed'));
    }

    setPickingPayment(false);
    onClose();
  }

  async function handleVoid() {
    setVoiding(true);
    // Safe to retry as a whole — see voidReceipt: a second attempt finds the
    // receipt already voided and only finishes what the first didn't reach.
    const result = await runWithRetry(() => voidReceipt(summary.id), {
      scope: 'receipts.void',
      title: 'Could not void the receipt',
      message: 'The receipt may not have been voided. Tap “Try again” — repeating it is safe and can’t put bread back on the truck twice.',
      // The run ended, or this receipt isn't from it: a retry gets the same no.
      retryable: (error) => !(error instanceof CannotVoidReceiptError),
    });
    setVoiding(false);
    setVoidStep(null);
    // 'skipped' needs nothing more: the prompt the driver just answered carried
    // the whole consequence (voidStockUnsettledMessage).
    if (result.completed) onClose();
  }

  return (
    <View style={styles.backdrop}>
      {/* Keep tap-to-close, but behind the card so scroll gestures inside
          the card are handled consistently by ScrollView. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.wrapper}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.background,
              borderColor: isVoided ? theme.danger : summary.status === 'finalized' ? theme.success : 'transparent',
              borderWidth: summary.status === 'finalized' ? 2 : 0,
            },
          ]}>
          <View style={styles.header}>
            <View style={styles.titleGroup}>
              {/* Same rule as the item names below — a store name and its
                  contact wrap rather than being cut. The receipts *list* still
                  truncates, where one line per row is the point. */}
              <ThemedText type="subtitle" style={styles.customerName}>
                {summary.customerName}
              </ThemedText>
              {!!summary.customerContactName && (
                <ThemedText type="small" themeColor="textSecondary">
                  {summary.customerContactName}
                </ThemedText>
              )}
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={Spacing.two}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={theme.text} size={24} />
            </Pressable>
          </View>

          <ThemedText type="small" themeColor="textSecondary">
            {formatDeviceDateTime(
              summary.status === 'finalized' && summary.finalizedAt ? summary.finalizedAt : summary.createdAt,
            )}
          </ThemedText>

          {/* Above the scroll, so it is the first thing read and can't be
              scrolled away from: every figure below is still the receipt as it
              was written, and none of it counts any more. */}
          {current.voidedAt !== null && (
            <View style={[styles.voidBanner, { backgroundColor: theme.backgroundDanger }]}>
              <ThemedText type="smallBold" style={{ color: theme.danger }}>
                Voided · {formatDeviceDateTime(current.voidedAt)}
              </ThemedText>
              <ThemedText type="small" style={{ color: theme.danger }}>
                Not counted in any total, and can’t be printed.
              </ThemedText>
            </View>
          )}

          {/* Everything below the header/date scrolls together as one unit,
              so a receipt with many items never pushes the totals/actions/proof
              section off the bottom of the fixed-height card. */}
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled">
            {!detail ? (
              loadError ? (
                <View style={styles.loadErrorBlock}>
                  <ThemedText type="small" style={styles.error}>
                    Could not load this receipt’s items.
                  </ThemedText>
                  <Pressable
                    onPress={() => {
                      setLoadError(false);
                      setLoadToken((token) => token + 1);
                    }}
                    style={({ pressed }) => [
                      styles.button,
                      styles.addPhotoButton,
                      { borderColor: theme.accent, opacity: pressed ? 0.6 : 1 },
                    ]}>
                    <ThemedText type="smallBold" style={{ color: theme.accent }}>
                      Try again
                    </ThemedText>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.loading}>
                  <ActivityIndicator size="small" color={theme.textSecondary} />
                </View>
              )
            ) : (
              <>
                <View style={[styles.sectionCard, { backgroundColor: theme.backgroundSuccess }]}>
                  <View style={styles.sectionHeader}>
                    <ThemedText type="smallBold" style={[styles.sectionHeaderText, { color: theme.success }]}>
                      Order items
                    </ThemedText>
                  </View>
                  <View style={styles.sectionRows}>
                    {detail.items.map((item) => (
                      <DetailLineRow
                        key={item.breadTypeId}
                        name={item.name}
                        unitPrice={item.unitPrice}
                        quantity={item.quantity}
                      />
                    ))}
                  </View>
                </View>

                {detail.returns.length > 0 && (
                  <View style={[styles.sectionCard, { backgroundColor: theme.backgroundDanger }]}>
                    <View style={styles.sectionHeader}>
                      <ThemedText type="smallBold" style={[styles.sectionHeaderText, { color: theme.danger }]}>
                        Returns items
                      </ThemedText>
                    </View>
                    <View style={styles.sectionRows}>
                      {detail.returns.map((line) => (
                        <DetailLineRow
                          key={line.returnedBreadTypeId}
                          name={line.name}
                          unitPrice={line.unitPrice}
                          quantity={line.quantity}
                          negative
                        />
                      ))}
                    </View>
                  </View>
                )}
              </>
            )}

            <View style={[styles.totals, { borderColor: theme.border }]}>
              {detail && <TotalRow label="Subtotal" value={subtotal} />}
              {detail && returnsTotal > 0 && <TotalRow label="Returns credit" value={-returnsTotal} />}
              <TotalRow label="Total" value={summary.total} emphasize />
              {summary.status === 'finalized' && summary.paymentMethod && (
                <>
                  <View style={styles.totalRow}>
                    <ThemedText type="small" themeColor="textSecondary">
                      Payment
                    </ThemedText>
                    <ThemedText type="smallBold">{PAYMENT_METHOD_LABELS[summary.paymentMethod]}</ThemedText>
                  </View>
                  {summary.paymentMethod === 'partial' && summary.amountPaid != null && (
                    <>
                      <View style={styles.totalRow}>
                        <ThemedText type="small" themeColor="textSecondary">
                          Paid
                        </ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          ₱{formatAmount(summary.amountPaid)}
                        </ThemedText>
                      </View>
                      <View style={styles.totalRow}>
                        <ThemedText type="small" themeColor="textSecondary">
                          Balance due
                        </ThemedText>
                        <ThemedText type="smallBold" style={{ color: theme.danger }}>
                          ₱{formatAmount(summary.total - summary.amountPaid)}
                        </ThemedText>
                      </View>
                    </>
                  )}
                </>
              )}
              {/* Under the payment block, on paper and here alike: who was on
                  the truck when this receipt was finalized — the names copied
                  onto the row at that moment. Left off entirely when the row has
                  none, which is every receipt finalized before it was recorded;
                  an "Agents —" row would read as a receipt nobody delivered. */}
              {!!summary.agentNames && (
                <View style={styles.totalRow}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Agents
                  </ThemedText>
                  <ThemedText type="smallBold" style={styles.agentNames}>
                    {summary.agentNames}
                  </ThemedText>
                </View>
              )}
            </View>

            {/* Gated on the freshly-read detail once it lands, falling back to
                the list row until then. Delete and Edit are draft-only for a
                reason — both half-apply to a finalized receipt (see
                applyFinalizedToList in context/receipts.tsx) — so the check
                prefers the copy that came from disk over the one the list is
                carrying, which can be a moment behind it. */}
            {(detail ?? summary).status === 'draft' &&
              (confirming === 'delete' ? (
                <View style={styles.confirmRow}>
                  <ThemedText type="small" style={styles.error}>
                    Delete this draft? This can’t be undone.
                  </ThemedText>
                  <View style={styles.actions}>
                    <Pressable
                      onPress={() => setConfirming(null)}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.button,
                        { borderColor: theme.textSecondary, opacity: pressed ? 0.6 : 1 },
                      ]}>
                      <ThemedText type="smallBold">Cancel</ThemedText>
                    </Pressable>
                    <Pressable
                      onPress={handleDelete}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.button,
                        { backgroundColor: theme.danger, borderColor: theme.danger },
                        { opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
                      ]}>
                      <ThemedText type="smallBold" style={{ color: '#ffffff' }}>
                        {busy ? 'Working…' : 'Delete'}
                      </ThemedText>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.actions}>
                  <Pressable
                    onPress={() => setConfirming('delete')}
                    style={({ pressed }) => [
                      styles.button,
                      styles.actionButtonCompact,
                      { backgroundColor: theme.danger, borderColor: theme.danger, opacity: pressed ? 0.6 : 1 },
                    ]}>
                    <ThemedText type="smallBold" numberOfLines={1} style={{ color: '#ffffff' }}>
                      Delete
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={() => detail && onEdit?.(detail)}
                    disabled={!detail}
                    style={({ pressed }) => [
                      styles.button,
                      styles.actionButtonCompact,
                      { backgroundColor: theme.warning, borderColor: theme.warning, opacity: !detail ? 0.4 : pressed ? 0.6 : 1 },
                    ]}>
                    <ThemedText type="smallBold" numberOfLines={1} style={{ color: '#ffffff' }}>
                      Edit
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={() => setPickingPayment(true)}
                    style={({ pressed }) => [
                      styles.button,
                      styles.actionButtonFlex,
                      { backgroundColor: theme.success, borderColor: theme.success, opacity: pressed ? 0.85 : 1 },
                    ]}>
                    <ThemedText type="smallBold" numberOfLines={1} style={{ color: theme.background }}>
                      Payment method
                    </ThemedText>
                  </Pressable>
                </View>
              ))}

            {hasProofSection && (
              <View style={styles.proofSection}>
                <ThemedText type="small" themeColor="textSecondary">
                  Proof of payment
                </ThemedText>
                {proof ? (
                  <>
                    <Pressable
                      onPress={() => setViewingProof(true)}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                      <ThemedText type="smallBold" numberOfLines={1} style={{ color: theme.accent }}>
                        {proof.fileName}
                      </ThemedText>
                    </Pressable>
                    {/* Whether the server has it. Said here rather than only in
                        the Home card's total, because this is the one photo the
                        person looking at this receipt can do something about —
                        and because a proof of payment nobody else can see is
                        worth knowing about before the store is out of sight. */}
                    <ThemedText
                      type="small"
                      themeColor={proof.syncState === 'synced' ? 'textSecondary' : undefined}
                      style={proof.syncState === 'blocked' ? styles.error : undefined}>
                      {describeProofSync(proof)}
                    </ThemedText>
                  </>
                ) : isVoided ? (
                  // A photo that was taken still shows above; there is no reason
                  // to start collecting proof for a sale that was cancelled.
                  <ThemedText type="small" themeColor="textSecondary">
                    No photo was added before this receipt was voided.
                  </ThemedText>
                ) : (
                  <Pressable
                    onPress={handleAddPhoto}
                    disabled={uploadingProof}
                    style={({ pressed }) => [
                      styles.button,
                      styles.addPhotoButton,
                      { borderColor: theme.textSecondary, opacity: uploadingProof ? 0.6 : pressed ? 0.6 : 1 },
                    ]}>
                    <ThemedText type="smallBold">{uploadingProof ? 'Opening camera…' : 'Add photo'}</ThemedText>
                  </Pressable>
                )}
                {!!uploadError && (
                  <ThemedText type="small" style={styles.error}>
                    {uploadError}
                  </ThemedText>
                )}
              </View>
            )}

            {/* Preview is the only way to print, and a customer's copy of a
                cancelled sale is exactly the paper that shouldn't exist. So a
                voided receipt keeps the button, grayed, and a tap says why
                instead of opening the preview. The preview modal refuses a
                voided receipt too, as the backstop. */}
            {summary.status === 'finalized' && (
              <>
              <View style={styles.finalizedActions}>
                {canVoid && (
                  <Pressable
                    onPress={() => setVoidStep('first')}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.button,
                      styles.voidButton,
                      { borderColor: theme.danger, opacity: pressed ? 0.6 : 1 },
                    ]}>
                    <ThemedText type="smallBold" style={{ color: theme.danger }}>
                      Void
                    </ThemedText>
                  </Pressable>
                )}
                {isVoided ? (
                  // Not `disabled`: it has to take the tap to explain itself.
                  <Pressable
                    onPress={() => setPrintBlocked(true)}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: true }}
                    style={({ pressed }) => [
                      styles.button,
                      styles.previewButton,
                      { backgroundColor: theme.backgroundElement, borderColor: theme.border, opacity: pressed ? 0.7 : 1 },
                    ]}>
                    <ThemedText type="smallBold" themeColor="textSecondary">
                      Preview
                    </ThemedText>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => setPreviewing(true)}
                    disabled={!detail}
                    style={({ pressed }) => [
                      styles.button,
                      styles.previewButton,
                      { backgroundColor: theme.accent, borderColor: theme.accent, opacity: !detail ? 0.4 : pressed ? 0.85 : 1 },
                    ]}>
                    <ThemedText type="smallBold" style={{ color: theme.background }}>
                      Preview
                    </ThemedText>
                  </Pressable>
                )}
              </View>
              {isVoided && (
                <ThemedText type="small" themeColor="textSecondary" style={styles.printNote}>
                  Voided receipts can’t be printed.
                </ThemedText>
              )}
              </>
            )}
          </ScrollView>
        </View>
      </View>

      <PaymentMethodModal
        visible={pickingPayment}
        customerName={summary.customerName}
        total={summary.total}
        onCancel={() => setPickingPayment(false)}
        onConfirm={handleFinalize}
      />
      <PaymentProofViewModal proof={viewingProof ? proof : null} onClose={() => setViewingProof(false)} />
      <ReceiptPrintPreviewModal detail={previewing ? detail : null} onClose={() => setPreviewing(false)} />
      <NoticeDialog
        visible={printBlocked}
        title="Can’t print this receipt"
        message="This receipt was voided, so it can’t be previewed or printed."
        onClose={() => setPrintBlocked(false)}
      />
      {/* Stays up while the void runs, like the store dialogs do, so the
          receipt behind it doesn't flash back into view mid-write. */}
      <ConfirmDialog
        visible={voidStep !== null}
        title={voidStep === 'final' ? 'Are you sure?' : 'Void this receipt?'}
        message={
          voidStep === 'final'
            ? `Void the ₱${formatAmount(summary.total)} receipt for ${summary.customerName}? There is no way to undo this.`
            : 'It stays on record marked Void but stops counting, and its bread goes back on the truck count. This can’t be undone.'
        }
        confirmLabel={voidStep === 'final' ? 'Slide to void' : 'Continue'}
        tone="danger"
        // The last step is dragged, not tapped: "Continue" sits exactly where a
        // "Yes" button would, so a double-tap could void a receipt by accident.
        slideToConfirm={voidStep === 'final'}
        cancelLabel={voidStep === 'final' ? 'No, keep this receipt' : 'Cancel'}
        busy={voiding}
        busyLabel="Voiding…"
        onCancel={() => setVoidStep(null)}
        onConfirm={voidStep === 'final' ? handleVoid : () => setVoidStep('final')}
      />
    </View>
  );
}

/**
 * One line for where the photo has got to.
 *
 * Deliberately about the *server*, not about "sync": a driver can act on "the
 * server doesn't have this yet", and can do nothing with "sync_state: pending".
 * `'legacy'` is grouped with blocked because from here they are the same fact —
 * this photo is not going to arrive on its own.
 */
function describeProofSync(proof: ReceiptPaymentProof): string {
  if (proof.syncState === 'synced') return 'Sent to the server.';
  if (proof.syncState === 'pending') return 'Waiting to send — it will go up on its own.';
  return 'Couldn\u2019t be sent. It\u2019s safe on this phone — try again from Settings.';
}

function DetailLineRow({
  name,
  unitPrice,
  quantity,
  negative,
}: {
  name: string;
  unitPrice: number;
  quantity: number;
  negative?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.rowLabel}>
        {/* Never ellipsised: this is the record of what a store was charged
            for, and two bread types whose names differ past the cut-off read
            as the same line. It wraps onto as many rows as it needs — the
            amount column keeps its own width either way. */}
        <ThemedText type="smallBold">{name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          ₱{formatAmount(unitPrice)} × {formatCount(quantity)}
        </ThemedText>
      </View>
      <ThemedText type="smallBold" style={negative ? { color: theme.danger } : undefined}>
        {negative ? '-' : ''}₱{formatAmount(unitPrice * quantity)}
      </ThemedText>
    </View>
  );
}

function TotalRow({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  const theme = useTheme();
  const sign = value < 0 ? '-' : '';
  return (
    <View style={styles.totalRow}>
      <ThemedText type={emphasize ? 'smallBold' : 'small'} themeColor={emphasize ? undefined : 'textSecondary'}>
        {label}
      </ThemedText>
      <ThemedText
        type={emphasize ? 'smallBold' : 'small'}
        themeColor={emphasize ? undefined : 'textSecondary'}
        style={emphasize ? { color: value < 0 ? theme.danger : theme.text } : undefined}>
        {sign}₱{formatAmount(Math.abs(value))}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: Spacing.four,
  },
  wrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
    maxHeight: '90%',
  },
  card: {
    // flexShrink (not flex:1): hug content when small, but yield to the
    // wrapper's maxHeight cap instead of overflowing it. flex:1 collapsed
    // this to zero height, since the wrapper itself has no defined height
    // for a flex-grow child to fill.
    flexShrink: 1,
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  titleGroup: {
    flex: 1,
    gap: 0,
  },
  customerName: {
    lineHeight: 34,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.one,
  },
  loading: {
    paddingVertical: Spacing.four,
    alignItems: 'center',
  },
  // Several names can outgrow the row, so they wrap on the right rather than
  // pushing the label off screen.
  agentNames: {
    flexShrink: 1,
    textAlign: 'right',
  },
  scrollArea: {
    flexShrink: 1,
  },
  scrollContent: {
    gap: Spacing.three,
    paddingVertical: Spacing.one,
  },
  sectionCard: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.two,
  },
  sectionHeaderText: {
    fontSize: 18,
    lineHeight: 24,
  },
  sectionRows: {
    gap: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  rowLabel: {
    flex: 1,
    gap: Spacing.half,
  },
  totals: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    marginTop: Spacing.one,
    gap: Spacing.half,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  confirmRow: {
    gap: Spacing.two,
  },
  proofSection: {
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  loadErrorBlock: {
    gap: Spacing.two,
    alignItems: 'flex-start',
  },
  addPhotoButton: {
    alignSelf: 'flex-start',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  button: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  // Payment method takes the leftover row width so Delete/Edit can stay
  // compact — all three used to be content-sized, which overflowed the
  // card on narrow screens and pushed Delete off the left edge.
  actionButtonFlex: {
    flex: 1,
    alignItems: 'center',
  },
  actionButtonCompact: {
    paddingHorizontal: Spacing.two,
  },
  finalizedActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  // Outline only, and kept narrow beside Preview: it is the rarer, destructive
  // action, so it shouldn't be the button a thumb finds first.
  voidButton: {
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
  },
  previewButton: {
    flex: 1,
    alignItems: 'center',
  },
  printNote: {
    textAlign: 'center',
    marginTop: Spacing.one,
  },
  voidBanner: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    gap: Spacing.half,
  },
  error: {
    color: '#e5484d',
  },
});
