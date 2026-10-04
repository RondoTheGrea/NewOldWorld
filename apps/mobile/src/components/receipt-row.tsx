import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { type ThemeColor, Spacing } from '@/constants/theme';
import { PAYMENT_METHOD_LABELS, type PaymentMethod, type ReceiptSummary } from '@/context/receipts';
import { useTheme } from '@/hooks/use-theme';
import { formatDeviceDateTime } from '@/lib/device-time';
import { formatAmount } from '@/lib/money';

/**
 * One receipt as a tappable card — the Receipts tab's list row, shared with the
 * customer profile's Purchase History so the two lists look and read the same.
 */

// Which theme color reads each payment method at a glance in the list —
// partial gets the danger color since it's the one that still owes money.
const PAYMENT_METHOD_TAG_COLOR: Record<PaymentMethod, ThemeColor> = {
  cash: 'success',
  gcash: 'accent',
  cheque: 'warning',
  partial: 'danger',
  credit: 'textSecondary',
};

export function ReceiptRow({ receipt, onPress }: { receipt: ReceiptSummary; onPress: () => void }) {
  const theme = useTheme();
  const voided = receipt.voidedAt !== null;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          borderColor: voided ? theme.danger : receipt.status === 'finalized' ? theme.success : theme.warning,
          borderWidth: 2,
          // Dashed reads as "still in progress" for a draft; solid reads as "done" once finalized.
          borderStyle: receipt.status === 'finalized' ? 'solid' : 'dashed',
          backgroundColor: pressed ? theme.backgroundSelected : theme.background,
        },
      ]}>
      <View style={styles.rowLabel}>
        <ThemedText type="default" style={styles.customerName} numberOfLines={1}>
          {receipt.customerName}
        </ThemedText>
        {!!receipt.customerContactName && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {receipt.customerContactName}
          </ThemedText>
        )}
        <ThemedText type="small" themeColor="textSecondary">
          {formatDeviceDateTime(receipt.createdAt)}
        </ThemedText>
      </View>
      <View style={styles.rowRight}>
        {/* Struck through rather than hidden: the amount is still what was
            written, it just no longer counts. */}
        <ThemedText
          type="smallBold"
          style={[
            styles.amount,
            receipt.total < 0 && { color: theme.danger },
            voided && { color: theme.textSecondary, textDecorationLine: 'line-through' },
          ]}>
          {receipt.total < 0 ? '-' : ''}₱{formatAmount(Math.abs(receipt.total))}
        </ThemedText>
        {/* Draft / payment / void share the same tag slot — a receipt is always
            exactly one of them, so the right column reads consistently. Void
            takes the payment tag's place because it overrides it: a voided cash
            receipt collected nothing. */}
        {voided ? (
          <View style={[styles.tag, { borderColor: theme.danger }]}>
            <ThemedText type="small" style={{ color: theme.danger }}>
              Void
            </ThemedText>
          </View>
        ) : receipt.status === 'draft' ? (
          <View style={[styles.tag, { borderColor: theme.warning }]}>
            <ThemedText type="small" style={{ color: theme.warning }}>
              Draft
            </ThemedText>
          </View>
        ) : (
          receipt.paymentMethod && (
            <View style={[styles.tag, { borderColor: theme[PAYMENT_METHOD_TAG_COLOR[receipt.paymentMethod]] }]}>
              <ThemedText
                type="small"
                numberOfLines={1}
                style={{ color: theme[PAYMENT_METHOD_TAG_COLOR[receipt.paymentMethod]] }}>
                {PAYMENT_METHOD_LABELS[receipt.paymentMethod]}
              </ThemedText>
            </View>
          )
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    // A soft card shadow instead of the old flat grey fill, so rows read as
    // distinct tappable cards against the screen's white background.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  rowLabel: {
    flex: 1,
    gap: Spacing.half,
  },
  customerName: {
    fontWeight: '700',
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: Spacing.one,
  },
  amount: {
    fontSize: 17,
    lineHeight: 22,
  },
  tag: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
  },
});
