import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { ThemedText } from '@/components/themed-text';
import { WeekdayChips } from '@/components/weekday-chips';
import { CustomerIcons } from '@/constants/customer-icons';
import { type Customer } from '@/context/customers';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { describeError, logError } from '@/lib/errors';
import { notifyFailure } from '@/lib/retry';

type CustomerDetailModalProps = {
  customer: Customer | null;
  onClose: () => void;
  onEdit: (customer: Customer) => void;
  onDelete: (customer: Customer) => Promise<void>;
};

export function CustomerDetailModal({ customer, onClose, onEdit, onDelete }: CustomerDetailModalProps) {
  const theme = useTheme();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function handleClose() {
    setConfirmingDelete(false);
    onClose();
  }

  async function handleConfirmDelete() {
    if (!customer) return;
    setDeleting(true);
    try {
      await onDelete(customer);
    } catch (error) {
      // onDelete reports and retries its own failures; this only stops an
      // unexpected throw from leaving the button stuck on "Deleting…".
      logError('customers.deleteConfirm', error);
      notifyFailure('Could not delete the customer', describeError(error));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <Modal visible={!!customer} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <Pressable onPress={() => {}} style={styles.wrapper}>
          {customer && (
            <View style={[styles.card, { backgroundColor: theme.background }]}>
              <View style={styles.header}>
                <ThemedText type="subtitle" style={styles.title} numberOfLines={2}>
                  {customer.storeName}
                </ThemedText>
                <Pressable
                  onPress={handleClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={Spacing.two}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                  <SymbolView
                    name={{ ios: 'xmark', android: 'close', web: 'close' }}
                    tintColor={theme.text}
                    size={24}
                  />
                </Pressable>
              </View>

              <View style={[styles.divider, { backgroundColor: theme.border }]} />

              <View style={styles.fields}>
                <Field icon={CustomerIcons.contact} label="Contact person" value={customer.name} />

                <Field icon={CustomerIcons.deliveryDays} label="Delivery days">
                  <WeekdayChips selected={customer.deliveryDays} />
                </Field>

                {!!customer.address && (
                  <Field icon={CustomerIcons.address} label="Address" value={customer.address} />
                )}
                {!!customer.phone && (
                  <Field icon={CustomerIcons.phone} label="Phone number" value={customer.phone} />
                )}
                {!!customer.description && (
                  <Field icon={CustomerIcons.description} label="Description" value={customer.description} />
                )}
              </View>

              <View style={styles.actions}>
                <Pressable
                  onPress={() => setConfirmingDelete(true)}
                  disabled={deleting}
                  style={({ pressed }) => [
                    styles.button,
                    { borderColor: theme.textSecondary, opacity: deleting ? 0.4 : pressed ? 0.6 : 1 },
                  ]}>
                  <ThemedText type="smallBold">Delete</ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => onEdit(customer)}
                  disabled={deleting}
                  style={({ pressed }) => [
                    styles.button,
                    { backgroundColor: theme.text, opacity: deleting ? 0.4 : pressed ? 0.8 : 1 },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: theme.background }}>
                    Edit
                  </ThemedText>
                </Pressable>
              </View>
            </View>
          )}
        </Pressable>
      </Pressable>

      {/* Its own dialog rather than a line of red text inside this card. The
          card scrolls nothing and is as tall as the store's details, so on a
          store with an address and a description the question used to appear
          below the fold — a Delete button whose confirmation you have to go
          looking for. The dialog also names the store, so the answer doesn't
          depend on remembering which card is behind the dim. */}
      <ConfirmDialog
        visible={confirmingDelete && !!customer}
        title="Delete this customer?"
        message={customer ? `${customer.storeName} is removed from this phone and from the server. This can’t be undone.` : undefined}
        cancelLabel="Keep it"
        confirmLabel="Delete"
        tone="danger"
        busy={deleting}
        busyLabel="Deleting…"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void handleConfirmDelete()}
      />
    </Modal>
  );
}

type FieldProps = {
  icon: SymbolViewProps['name'];
  label: string;
} & ({ value: string; children?: never } | { value?: never; children: ReactNode });

// A label (small, uppercase, muted) over a value (larger, bold, full-strength
// text color) — the two need to read as clearly different roles at a glance,
// not just a slightly different shade of the same size.
function Field({ icon, label, value, children }: FieldProps) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <View style={styles.fieldLabelRow}>
        <SymbolView name={icon} tintColor={theme.textSecondary} size={13} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
          {label}
        </ThemedText>
      </View>
      {value !== undefined ? <ThemedText style={styles.fieldValue}>{value}</ThemedText> : children}
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
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  fields: {
    gap: Spacing.three,
  },
  field: {
    gap: Spacing.half,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  fieldLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  fieldValue: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 600,
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
});
