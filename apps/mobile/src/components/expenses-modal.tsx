import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
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

import { CashCountPanel, useRunCashSales } from '@/components/cash-count-panel';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useExpenses, type Expense } from '@/context/expenses';
import { useKeyboardSheet } from '@/hooks/use-keyboard-sheet';
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

/** Which half of the sheet is showing. */
export type CashExpensesTab = 'cash' | 'expenses';

/**
 * The sheet behind the Home "Breakdown & Expenses" card: the **cash count**
 * (components/cash-count-panel.tsx) and this run's **expenses**, one tab each.
 *
 * They share a sheet because they answer one question — where did the money go
 * — and the cash count's comparison takes expenses into account. Home was out of
 * room for a second card, and the owner asked for the two to be one.
 *
 * Unlike when it held expenses alone, it **does not close on a tap outside**:
 * the cash count is seven numbers typed from a stack of bills, so the rule in
 * CLAUDE.md's "Modals and the keyboard" applies, and closing over an unsaved
 * count asks first.
 *
 * The expenses half — this run's expenses, and the form that adds one:
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
export function ExpensesModal({
  visible,
  initialTab,
  onClose,
}: {
  visible: boolean;
  initialTab: CashExpensesTab;
  onClose: () => void;
}) {
  // Android's back button arrives here, outside the body, so the body hands up
  // its own close handler — the one that asks before dropping an unsaved count.
  const requestCloseRef = useRef(onClose);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => requestCloseRef.current()}>
      {/* Mounted fresh each time, so the form always starts blank rather than
          holding whatever a previous open left in it. */}
      {visible && <ExpensesBody initialTab={initialTab} onClose={onClose} requestCloseRef={requestCloseRef} />}
    </Modal>
  );
}

function ExpensesBody({
  initialTab,
  onClose,
  requestCloseRef,
}: {
  initialTab: CashExpensesTab;
  onClose: () => void;
  requestCloseRef: { current: () => void };
}) {
  const theme = useTheme();
  const { expenses, expenseTotal, expensesLoading, expensesError, reloadExpenses, removeExpense } =
    useExpenses();
  const { overlap, onBackdropLayout, scrollProps } = useKeyboardSheet();
  const { cashSales, cashSalesFailed } = useRunCashSales();
  const [tab, setTab] = useState<CashExpensesTab>(initialTab);
  const [countDirty, setCountDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const onCountDirtyChange = useCallback((dirty: boolean) => setCountDirty(dirty), []);
  const [adding, setAdding] = useState(false);
  // The expense whose Remove button was tapped, which is also what puts the
  // confirmation up — so the dialog can name it rather than asking about
  // "this expense" with the row itself behind a dimmed backdrop.
  const [removing, setRemoving] = useState<Expense | null>(null);

  function handleClose() {
    if (countDirty) setConfirmingDiscard(true);
    else onClose();
  }
  useEffect(() => {
    requestCloseRef.current = handleClose;
  });

  async function handleRemove(expense: Expense) {
    setRemoving(null);
    await runWithRetry(() => removeExpense(expense.id), {
      scope: 'expenses.remove',
      title: 'Could not remove the expense',
      message: 'It is still recorded on this phone — nothing was changed.',
    });
  }

  return (
    <View style={styles.backdrop} onLayout={onBackdropLayout}>
      <View style={styles.sheetWrapper}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.sheet, { backgroundColor: theme.background }]}>
            <View style={styles.header}>
              {/* One line, always: the title is long for a 32pt heading, so on
                  a narrow phone it shrinks to fit rather than wrapping. */}
              <ThemedText
                type="subtitle"
                style={styles.title}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.5}>
                Breakdown &amp; Expenses
              </ThemedText>
              <Pressable
                onPress={handleClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={Spacing.two}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={theme.text} size={24} />
              </Pressable>
            </View>

            {/* Hidden while the expense form is open — that form has its own
                Cancel, and switching away mid-expense would lose it. */}
            {!adding ? <TabSwitcher tab={tab} onChange={setTab} /> : null}

            {/* Kept mounted, only hidden, while the Expenses tab is showing —
                so a half-typed count survives a look at the expense list. */}
            <View style={[styles.fill, styles.tabBody, tab !== 'cash' && styles.hidden]}>
              <CashCountPanel
                cashSales={cashSales}
                cashSalesFailed={cashSalesFailed}
                onDirtyChange={onCountDirtyChange}
                overlap={overlap}
                scrollProps={scrollProps}
              />
            </View>

            {tab !== 'expenses' ? null : adding ? (
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

      <ConfirmDialog
        visible={confirmingDiscard}
        title="Close without saving the breakdown?"
        message="The breakdown you typed hasn't been saved."
        cancelLabel="Keep counting"
        confirmLabel="Close"
        tone="danger"
        preferCancel
        onCancel={() => setConfirmingDiscard(false)}
        onConfirm={() => {
          setConfirmingDiscard(false);
          onClose();
        }}
      />

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

/** Two equal halves, the selected one filled — the app's outline/filled button pair, side by side. */
function TabSwitcher({ tab, onChange }: { tab: CashExpensesTab; onChange: (tab: CashExpensesTab) => void }) {
  const theme = useTheme();
  const tabs: { key: CashExpensesTab; label: string }[] = [
    { key: 'cash', label: 'Breakdown' },
    { key: 'expenses', label: 'Expenses' },
  ];
  return (
    <View style={[styles.tabs, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
      {tabs.map(({ key, label }) => {
        const selected = key === tab;
        return (
          <Pressable
            key={key}
            onPress={() => onChange(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.tab,
              { backgroundColor: selected ? theme.text : 'transparent', opacity: pressed ? 0.8 : 1 },
            ]}>
            <ThemedText type="smallBold" style={{ color: selected ? theme.background : theme.text }}>
              {label}
            </ThemedText>
          </Pressable>
        );
      })}
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
  // ₱0 is allowed (the owner's call) — an expense can be noted with nothing
  // paid. But the field still has to hold a real number: a *blank* amount is
  // a forgotten one, not a zero, and Number('') would quietly read it as 0.
  const amountTyped = amount.trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) >= 0;
  const canSubmit = cleanTitle.length > 0 && amountTyped && !saving;

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
  tabs: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.half,
    gap: Spacing.half,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
  },
  tabBody: {
    gap: Spacing.two,
  },
  hidden: {
    display: 'none',
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
