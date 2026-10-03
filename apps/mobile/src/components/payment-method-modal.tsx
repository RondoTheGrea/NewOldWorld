import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/context/receipts';
import { useTheme } from '@/hooks/use-theme';
import { describeError, logError } from '@/lib/errors';
import { formatAmount } from '@/lib/money';
import { notifyFailure } from '@/lib/retry';

type PaymentMethodModalProps = {
  visible: boolean;
  /** Store name, shown on the confirmation step so the receipt being finalized is named. */
  customerName: string;
  total: number;
  onCancel: () => void;
  onConfirm: (paymentMethod: PaymentMethod, amountPaid?: number) => Promise<void>;
};

const METHODS: PaymentMethod[] = ['cash', 'gcash', 'cheque', 'partial', 'credit'];

/**
 * Two steps, not one: pick the payment method, then confirm.
 *
 * Finalizing is the one action on a receipt that can't be taken back — it locks
 * the lines, deducts the truck's stock and puts the receipt on the upload
 * queue — and until now a single tap did all of it, with the payment method
 * that decides what the store owes chosen on that same tap. The confirmation
 * step restates the store, the method and the money before anything is written.
 *
 * It changes nothing about how failures are handled. `onConfirm` is still
 * called exactly once per press and still owns its own reporting and retries
 * (see handleFinalize in receipt-detail-modal.tsx) — the step is in front of
 * that call, not around it.
 */
export function PaymentMethodModal({ visible, customerName, total, onCancel, onConfirm }: PaymentMethodModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      {/* Mounted fresh each time it opens, so selection always starts blank — same pattern as ReceiptFormModal. */}
      {visible && (
        <PaymentMethodBody customerName={customerName} total={total} onCancel={onCancel} onConfirm={onConfirm} />
      )}
    </Modal>
  );
}

function PaymentMethodBody({ customerName, total, onCancel, onConfirm }: Omit<PaymentMethodModalProps, 'visible'>) {
  const theme = useTheme();
  const [step, setStep] = useState<'select' | 'confirm'>('select');
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [amountPaidText, setAmountPaidText] = useState('');
  const [busy, setBusy] = useState(false);

  const amountPaid = Number(amountPaidText);
  const partialValid =
    amountPaidText.trim().length > 0 && Number.isFinite(amountPaid) && amountPaid > 0 && amountPaid <= total;
  const canContinue = !busy && !!method && (method !== 'partial' || partialValid);
  const canFinalize = step === 'confirm' && canContinue;

  async function handleFinalize() {
    if (!canFinalize || !method) return;
    setBusy(true);
    try {
      await onConfirm(method, method === 'partial' ? amountPaid : undefined);
    } catch (error) {
      // onConfirm reports and offers to retry its own failures; this only
      // stops an unexpected throw from leaving the button stuck on
      // "Finalizing…" with nothing said. The modal stays open either way, on
      // this same step, so the chosen method (and any amount typed) survives.
      logError('receipts.paymentMethod', error);
      notifyFailure('Could not finalize the receipt', describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.backdrop}>
      {/* A tap outside never closes this — same rule as the form sheets. On
          the confirmation step it steps back to the method list, which costs
          nothing; on the method list it does nothing at all. Cancel and the ✕
          are how it closes. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={!busy && step === 'confirm' ? () => setStep('select') : undefined}
      />
      <View style={styles.wrapper}>
        <View style={[styles.card, { backgroundColor: theme.background }]}>
          <View style={styles.header}>
            <ThemedText type="subtitle">{step === 'select' ? 'How was this paid?' : 'Finalize this receipt?'}</ThemedText>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={Spacing.two}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={theme.text} size={24} />
            </Pressable>
          </View>

          {step === 'select' ? (
            <>
              <View style={styles.options}>
                {METHODS.map((id) => {
                  const selected = method === id;
                  return (
                    <Pressable
                      key={id}
                      onPress={() => setMethod(id)}
                      style={({ pressed }) => [
                        styles.option,
                        {
                          borderColor: selected ? theme.accent : theme.border,
                          borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
                          backgroundColor: selected ? theme.backgroundSelected : theme.backgroundElement,
                          opacity: pressed ? 0.8 : 1,
                        },
                      ]}>
                      <ThemedText type="smallBold">{PAYMENT_METHOD_LABELS[id]}</ThemedText>
                    </Pressable>
                  );
                })}
              </View>

              {method === 'partial' && (
                <View style={styles.partialField}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Amount paid now
                  </ThemedText>
                  <View style={[styles.amountInputChrome, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                    <ThemedText type="default">₱</ThemedText>
                    <TextInput
                      value={amountPaidText}
                      onChangeText={setAmountPaidText}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      placeholderTextColor={theme.textSecondary}
                      style={[styles.amountInput, { color: theme.text }]}
                    />
                  </View>
                  <ThemedText type="small" themeColor="textSecondary">
                    Balance due: ₱{formatAmount(partialValid ? total - amountPaid : total)}
                  </ThemedText>
                </View>
              )}

              <View style={styles.actions}>
                <Pressable
                  onPress={onCancel}
                  style={({ pressed }) => [styles.cancelButton, { borderColor: theme.border, opacity: pressed ? 0.6 : 1 }]}>
                  <ThemedText type="smallBold">Cancel</ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => setStep('confirm')}
                  disabled={!canContinue}
                  style={({ pressed }) => [
                    styles.finalizeButton,
                    { backgroundColor: theme.accent, opacity: !canContinue ? 0.4 : pressed ? 0.85 : 1 },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: '#ffffff' }}>
                    Review
                  </ThemedText>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <View style={[styles.summary, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
                <SummaryRow label="Store" value={customerName} />
                <SummaryRow label="Paid by" value={method ? PAYMENT_METHOD_LABELS[method] : ''} />
                {method === 'partial' ? (
                  <>
                    <SummaryRow label="Receipt total" value={`₱${formatAmount(total)}`} />
                    <SummaryRow label="Paid now" value={`₱${formatAmount(amountPaid)}`} />
                    <SummaryRow label="Balance due" value={`₱${formatAmount(total - amountPaid)}`} emphasize />
                  </>
                ) : (
                  <SummaryRow label="Receipt total" value={`₱${formatAmount(total)}`} emphasize />
                )}
              </View>

              <ThemedText type="small" themeColor="textSecondary">
                Finalizing locks this receipt and takes the items off the truck. It can&apos;t be undone or edited
                afterwards.
              </ThemedText>

              <View style={styles.actions}>
                <Pressable
                  onPress={() => setStep('select')}
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.cancelButton,
                    { borderColor: theme.border, opacity: busy ? 0.4 : pressed ? 0.6 : 1 },
                  ]}>
                  <ThemedText type="smallBold">Back</ThemedText>
                </Pressable>
                <Pressable
                  onPress={handleFinalize}
                  disabled={!canFinalize}
                  style={({ pressed }) => [
                    styles.finalizeButton,
                    { backgroundColor: theme.success, opacity: !canFinalize ? 0.4 : pressed ? 0.85 : 1 },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: '#ffffff' }}>
                    {busy ? 'Finalizing…' : 'Finalize'}
                  </ThemedText>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function SummaryRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type={emphasize ? 'smallBold' : 'small'} style={styles.summaryValue} numberOfLines={2}>
        {value}
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
  },
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  options: {
    gap: Spacing.two,
  },
  option: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  partialField: {
    gap: Spacing.one,
  },
  summary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  summaryValue: {
    flexShrink: 1,
    textAlign: 'right',
  },
  amountInputChrome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  amountInput: {
    flex: 1,
    fontSize: 16,
    padding: 0,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  cancelButton: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  finalizeButton: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
