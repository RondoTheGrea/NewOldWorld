import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ExpensesModal } from '@/components/expenses-modal';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useExpenses } from '@/context/expenses';
import { useInventory } from '@/context/inventory';
import { useTheme } from '@/hooks/use-theme';
import { formatAmount, formatCount } from '@/lib/money';

/**
 * The Home card for what this trip has spent.
 *
 * Sits beside "Today's upload" because it belongs to the same question — how is
 * this trip out going — and because Home is the one tab that is about the *run*
 * rather than about a job (counting stock, writing a receipt, editing a store).
 *
 * Renders nothing before setup is finished: expenses are scoped to a run, so
 * with no run open there is nothing to show and nothing that could be recorded.
 * That is also why the card empties itself at the end of a day — the next run
 * has no expenses yet, and not one row was deleted to make that true.
 *
 * **The whole card is the button** — see run-history-card.tsx for why the
 * separate full-width button under the status line went away. The modal behind
 * it is the same one whether there is anything recorded yet or not, so there
 * was never a choice for a button to offer.
 */
export function ExpensesCard() {
  const theme = useTheme();
  const { setup } = useInventory();
  const { expenses, expenseTotal, expensesLoading, expensesError } = useExpenses();
  const [open, setOpen] = useState(false);

  if (!setup.complete) return null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={
          expenses.length === 0 ? 'Expenses. Record an expense.' : 'Expenses. Add or review expenses.'
        }
        style={({ pressed }) => [
          styles.card,
          {
            borderColor: theme.border,
            backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
          },
        ]}>
        <View style={styles.header}>
          <SymbolView
            name={{ ios: 'banknote', android: 'payments', web: 'payments' }}
            tintColor={theme.textSecondary}
            size={20}
          />
          <ThemedText type="smallBold" style={styles.headerLabel}>
            Expenses
          </ThemedText>
          <ThemedText type="smallBold">₱{formatAmount(expenseTotal)}</ThemedText>
          <SymbolView
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            tintColor={theme.textSecondary}
            size={16}
          />
        </View>

        <ThemedText type="small" themeColor={expensesError ? 'danger' : 'textSecondary'}>
          {describeState({ error: expensesError, loading: expensesLoading, count: expenses.length })}
        </ThemedText>
      </Pressable>

      <ExpensesModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * One plain line for the card's state.
 *
 * The "not counted" half is said here as well as inside the modal, on purpose:
 * this is the surface someone glances at, and a peso figure sitting under the
 * day's takings invites exactly the assumption the feature does not make.
 *
 * The empty state doubles as the card's call to action now that there is no
 * "Record an expense" button under it — hence "Tap to record one", which the
 * old wording didn't need to say.
 */
function describeState({
  error,
  loading,
  count,
}: {
  error: string | null;
  loading: boolean;
  count: number;
}): string {
  if (error) return error;
  if (loading) return 'Loading…';
  if (count === 0) return 'Nothing recorded for this trip yet. Tap to record one.';
  return `${formatCount(count)} recorded this trip — kept as a record, not taken off sales.`;
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
});
