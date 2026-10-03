import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useExpenses, type Expense } from '@/context/expenses';
import { useTheme } from '@/hooks/use-theme';
import {
  ExpenseFieldLimits,
  normalizeExpenseAmount,
  sanitizeExpenseInput,
} from '@/lib/expense-types';
import { formatDeviceTime } from '@/lib/device-time';
import { generateId } from '@/lib/id';
import { formatAmount } from '@/lib/money';
import { runWithRetry } from '@/lib/retry';
import { sanitizeSingleLine } from '@/lib/text-input';

/**
 * The whole expense feature on the phone: this run's expenses, and the form
 * that adds one.
 *
 * One modal rather than a tab, and deliberately so. An expense is recorded a
 * handful of times a trip — fuel, a toll, lunch — which does not earn a fifth
 * seat in the tab bar next to Home, Inventory, Receipts and Customers, all of
 * which are worked continuously. It lives behind the Home card instead, beside
 * "Today's upload" and "End the day", because those three are the same subject:
 * how this trip out is going.
 *
 * The list is only ever *this run's*, and it empties when the day is ended —
 * not because anything is deleted, but because the next run has no expenses yet
 * (see context/expenses.tsx).
 */
export function ExpensesModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Mounted fresh each time, so the form always starts blank rather than
          holding whatever a previous open left in it. */}
      {visible && <ExpensesBody onClose={onClose} />}
    </Modal>
  );
}

function ExpensesBody({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const { expenses, expenseTotal, expensesLoading, expensesError, reloadExpenses, removeExpense } =
    useExpenses();
  const [adding, setAdding] = useState(false);
  // The expense whose Remove button was tapped, which is also what puts the
  // confirmation up — so the dialog can name it rather than asking about
  // "this expense" with the row itself behind a dimmed backdrop.
  const [removing, setRemoving] = useState<Expense | null>(null);

  async function handleRemove(expense: Expense) {
    setRemoving(null);
    await runWithRetry(() => removeExpense(expense.id), {
      scope: 'expenses.remove',
      title: 'Could not remove the expense',
      message: 'It is still recorded on this phone — nothing was changed.',
    });
  }

  return (
    <View style={styles.backdrop}>
      {/* Keep tap-to-close behind the sheet so the expense list's ScrollView
          owns pointer and wheel gestures inside the modal. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.sheetWrapper}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.sheet, { backgroundColor: theme.background }]}>
            <View style={styles.header}>
              <ThemedText type="subtitle" style={styles.title}>
                Expenses
              </ThemedText>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={Spacing.two}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={theme.text} size={24} />
              </Pressable>
            </View>

            {adding ? (
              <ExpenseForm onDone={() => setAdding(false)} />
            ) : (
              <>
                <View style={[styles.totalRow, { borderColor: theme.border }]}>
                  <ThemedText type="smallBold" themeColor="textSecondary">
                    Spent this trip
                  </ThemedText>
                  <ThemedText type="smallBold">₱{formatAmount(expenseTotal)}</ThemedText>
                </View>

                {/* Said plainly and in one place, because it is the whole point
                    of the feature: these numbers are a record, not a deduction.
                    Nothing on the phone or the dashboard takes them off sales. */}
                <ThemedText type="small" themeColor="textSecondary">
                  Kept for the server as a record of the trip. Expenses are never taken off sales or the truck&apos;s
                  takings.
                </ThemedText>

                <ScrollView style={styles.fill} contentContainerStyle={styles.list}>
                  {expensesError ? (
                    <View style={styles.empty}>
                      <ThemedText type="small" style={{ color: theme.danger }}>
                        {expensesError}
                      </ThemedText>
                      <Pressable
                        onPress={reloadExpenses}
                        accessibilityRole="button"
                        style={({ pressed }) => [
                          styles.outlineButton,
                          { borderColor: theme.textSecondary, opacity: pressed ? 0.7 : 1 },
                        ]}>
                        <ThemedText type="smallBold">Try again</ThemedText>
                      </Pressable>
                    </View>
                  ) : expensesLoading ? (
                    <ThemedText type="small" themeColor="textSecondary">
                      Loading…
                    </ThemedText>
                  ) : expenses.length === 0 ? (
                    <View style={styles.empty}>
                      <ThemedText type="small" themeColor="textSecondary">
                        Nothing recorded yet for this trip. Fuel, tolls, parking, food — anything the truck spent on
                        the way round.
                      </ThemedText>
                    </View>
                  ) : (
                    expenses.map((expense) => (
                      <ExpenseRow key={expense.id} expense={expense} onDelete={() => setRemoving(expense)} />
                    ))
                  )}
                </ScrollView>

                <Pressable
                  onPress={() => setAdding(true)}
                  disabled={expensesError !== null}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.primaryButton,
                    { backgroundColor: theme.text, opacity: expensesError ? 0.4 : pressed ? 0.8 : 1 },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: theme.background }}>
                    Record an expense
                  </ThemedText>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>

      {/* Names the expense and shows its amount, so the question can be
          answered without the row behind the dimmed backdrop. */}
      <ConfirmDialog
        visible={removing !== null}
        title="Remove this expense?"
        message={
          removing
            ? `“${removing.title}” — ₱${formatAmount(removing.amount)}`
            : undefined
        }
        cancelLabel="Keep it"
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void handleRemove(removing);
        }}
      />
    </View>
  );
}

function ExpenseRow({ expense, onDelete }: { expense: Expense; onDelete: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
      <View style={styles.rowText}>
        <ThemedText type="smallBold">{expense.title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {/* The device's own clock, like every other cosmetic timestamp in the
              app — nothing is filed by it (see lib/device-time.ts). */}
          {formatDeviceTime(expense.createdAt)}
        </ThemedText>
        {expense.notes ? (
          <ThemedText type="small" themeColor="textSecondary">
            {expense.notes}
          </ThemedText>
        ) : null}
      </View>

      <ThemedText type="smallBold">₱{formatAmount(expense.amount)}</ThemedText>

      <Pressable
        onPress={onDelete}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${expense.title}`}
        hitSlop={Spacing.two}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
        <SymbolView name={{ ios: 'trash', android: 'delete', web: 'delete' }} tintColor={theme.danger} size={18} />
      </Pressable>
    </View>
  );
}

/**
 * Title, amount, notes — and nothing else.
 *
 * The Add button mints one id and reuses it for every retry of that press, so a
 * save that committed and *then* reported failure can't be recorded twice. Two
 * presses are two expenses; one press retried five times is one. See
 * insertExpense in lib/expense-db.ts.
 */
function ExpenseForm({ onDone }: { onDone: () => void }) {
  const theme = useTheme();
  const { addExpense } = useExpenses();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Checked *after* sanitizing rather than with trim(): a paste of zero-width
  // spaces survives trim() and would otherwise enable the button and then save
  // an expense with a blank title.
  const cleanTitle = sanitizeSingleLine(title, ExpenseFieldLimits.title);
  const cleanAmount = normalizeExpenseAmount(Number(amount));
  const canSubmit = cleanTitle.length > 0 && cleanAmount > 0 && !saving;

  async function handleSave() {
    setConfirming(false);
    setSaving(true);
    const entryId = generateId();
    const result = await runWithRetry(
      () => addExpense(sanitizeExpenseInput({ title, amount: Number(amount), notes }), entryId),
      {
        scope: 'expenses.add',
        title: 'Could not save the expense',
        message: 'Nothing was saved — what you typed is still here.',
      },
    );
    setSaving(false);
    // Only leave the form on success, so a failure the user backed out of never
    // costs them what they typed.
    if (result.completed) onDone();
  }

  return (
    <>
      <ScrollView style={styles.fill} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Field
          label="What was it for"
          required
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Diesel, toll, lunch"
          editable={!saving}
          maxLength={ExpenseFieldLimits.title}
        />
        <Field
          label="Amount (₱)"
          required
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          keyboardType="decimal-pad"
          editable={!saving}
        />
        <Field
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Optional"
          editable={!saving}
          multiline
          maxLength={ExpenseFieldLimits.notes}
        />

        <View style={styles.formActions}>
          <Pressable
            onPress={onDone}
            disabled={saving}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.outlineButton,
              { borderColor: theme.textSecondary, opacity: saving ? 0.4 : pressed ? 0.7 : 1 },
            ]}>
            <ThemedText type="smallBold">Cancel</ThemedText>
          </Pressable>
          <Pressable
            onPress={() => setConfirming(true)}
            disabled={!canSubmit}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primaryButton,
              styles.formPrimary,
              { backgroundColor: theme.text, opacity: !canSubmit ? 0.4 : pressed ? 0.8 : 1 },
            ]}>
            <ThemedText type="smallBold" style={{ color: theme.background }}>
              {saving ? 'Saving…' : 'Add expense'}
            </ThemedText>
          </Pressable>
        </View>
      </ScrollView>

      {/* One "is this right?" before it is recorded. The amount is typed on a
          phone in a moving truck and goes straight to the server, and the only
          way back from a wrong one is the Remove button — which the server is
          also told about. Answering Cancel leaves every typed value in place. */}
      <ConfirmDialog
        visible={confirming}
        title="Add this expense?"
        message={`“${cleanTitle}” — ₱${formatAmount(cleanAmount)}`}
        confirmLabel="Add"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void handleSave()}
      />
    </>
  );
}

function Field({ label, required, multiline, ...inputProps }: TextInputProps & { label: string; required?: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {label}
        {required ? ' *' : ''}
      </ThemedText>
      <View style={[styles.fieldChrome, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <TextInput
          multiline={multiline}
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, multiline && styles.inputMultiline, { color: theme.text }]}
          {...inputProps}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: Spacing.four,
  },
  sheetWrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
    height: '85%',
  },
  sheet: {
    flex: 1,
    borderRadius: Spacing.four,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: Spacing.two,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.two,
  },
  list: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  empty: {
    gap: Spacing.two,
    alignItems: 'flex-start',
    paddingVertical: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  form: {
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  field: {
    gap: Spacing.one,
  },
  fieldChrome: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  input: {
    fontSize: 16,
    padding: 0,
  },
  inputMultiline: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  formActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  formPrimary: {
    flex: 1,
  },
  outlineButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  primaryButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.three,
  },
});
