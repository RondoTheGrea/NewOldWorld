import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ExpensesModal, type CashExpensesTab } from '@/components/expenses-modal';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useExpenses } from '@/context/expenses';
import { useInventory } from '@/context/inventory';
import { useTheme } from '@/hooks/use-theme';
import { cashCountTotal } from '@/lib/cash-count';
import { formatAmount } from '@/lib/money';

/**
 * The Home card for the trip's money: the **cash count** (the bills the driver
 * is actually holding) and the **expenses** (what was paid out on the way).
 *
 * One card for both because Home had no room for another, and because they are
 * one subject — the cash count's comparison is "cash sales minus expenses", so
 * the two figures sit next to each other here and in the sheet behind it.
 *
 * Renders nothing before setup is finished: both are scoped to a run, so with no
 * run open there is nothing to show and nothing that could be recorded. That is
 * also why the card empties itself at the end of a day — the next run has no
 * count and no expenses yet, and not one row was deleted to make that true.
 *
 * **Each row is its own button**, opening the sheet on its own tab, with a
 * chevron each. The card used to be one big button when it only held expenses
 * (see run-history-card.tsx for why); with two things in it, one tap target
 * would always land on the wrong half half the time.
 */
export function ExpensesCard() {
  const theme = useTheme();
  const { setup } = useInventory();
  const { expenses, expenseTotal, expensesLoading, expensesError, cashCount } = useExpenses();
  const [openTab, setOpenTab] = useState<CashExpensesTab | null>(null);

  if (!setup.complete) return null;

  const status = expensesError ? expensesError : expensesLoading ? 'Loading…' : null;

  return (
    <>
      <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
        <View style={styles.header}>
          <SymbolView
            name={{ ios: 'banknote', android: 'payments', web: 'payments' }}
            tintColor={theme.textSecondary}
            size={20}
          />
          <ThemedText type="smallBold" style={styles.headerLabel}>
            Breakdown &amp; Expenses
          </ThemedText>
        </View>

        {status ? (
          // Still a button on a failed load: the Expenses tab behind it is
          // where "Try again" lives.
          <Pressable
            onPress={() => setOpenTab('expenses')}
            disabled={!expensesError}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <ThemedText type="small" themeColor={expensesError ? 'danger' : 'textSecondary'}>
              {status}
            </ThemedText>
          </Pressable>
        ) : (
          <>
            <CardRow
              label="Breakdown"
              value={cashCount ? `₱${formatAmount(cashCountTotal(cashCount))}` : 'Not yet — tap to count'}
              accessibilityLabel={
                cashCount ? 'Breakdown. Review or count again.' : 'Breakdown. Count the cash in hand.'
              }
              onPress={() => setOpenTab('cash')}
            />
            <CardRow
              label="Expenses"
              value={
                expenses.length === 0
                  ? 'None yet — tap to add'
                  : `₱${formatAmount(expenseTotal)}`
              }
              accessibilityLabel={
                expenses.length === 0 ? 'Expenses. Record an expense.' : 'Expenses. Add or review expenses.'
              }
              onPress={() => setOpenTab('expenses')}
            />
          </>
        )}
      </View>

      <ExpensesModal visible={openTab !== null} initialTab={openTab ?? 'cash'} onClose={() => setOpenTab(null)} />
    </>
  );
}

function CardRow({
  label,
  value,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  value: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.row,
        { borderColor: theme.border, backgroundColor: pressed ? theme.backgroundSelected : 'transparent' },
      ]}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.rowLabel}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
      <SymbolView
        name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
        tintColor={theme.textSecondary}
        size={16}
      />
    </Pressable>
  );
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
  },
  rowLabel: {
    flex: 1,
  },
});
