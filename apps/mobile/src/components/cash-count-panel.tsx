import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useExpenses } from '@/context/expenses';
import { useInventory } from '@/context/inventory';
import type { KeyboardSheet } from '@/hooks/use-keyboard-sheet';
import { useTheme } from '@/hooks/use-theme';
import {
  BillDenominations,
  cashCountTotal,
  emptyBillCounts,
  normalizeBillCount,
  normalizeCoinAmount,
  type BillDenomination,
  type CashCountInput,
} from '@/lib/cash-count';
import { formatDeviceTime } from '@/lib/device-time';
import { logError } from '@/lib/errors';
import { formatAmount, formatCount } from '@/lib/money';
import { summarizeRunHistoryForRun } from '@/lib/receipt-db';
import { runWithRetry } from '@/lib/retry';

type BillDraft = Record<BillDenomination, string>;

/**
 * The "Breakdown" half of the Breakdown & Expenses sheet: how many of each bill the
 * driver is holding, plus coins as one amount, set against what the receipts
 * say should be there.
 *
 * The comparison is the reason the count shares a sheet with expenses. Cash in
 * the bag is *cash sales minus whatever was paid out of it*, so a ₱500 diesel
 * stop is exactly the kind of thing that makes the bag ₱500 light — and showing
 * the expenses line here is what lets a driver tell "I'm short" from "I paid
 * for fuel". It is arithmetic on this screen only: no receipt, no takings
 * figure and nothing the server keeps has an expense taken off it (see
 * lib/expense-types.ts — that rule still holds).
 *
 * A typed count is a draft until **Save count**, and saving overwrites the
 * run's one count rather than adding another (see lib/cash-count.ts). No
 * confirmation before saving, on the same reasoning as "Edit Inventory Draft":
 * it overwrites something that stays freely editable.
 */
/**
 * The cash the receipts say this run took in, read once when the sheet opens.
 * No receipt can be written while it is open, so there is nothing to keep it
 * live against. Called by the sheet, which hands it to both tabs.
 *
 * `cashSales` is null until it has loaded, so nothing briefly claims the
 * driver is ₱8,000 over.
 */
export function useRunCashSales(): { cashSales: number | null; cashSalesFailed: boolean } {
  const { runId } = useInventory();
  const [cashSales, setCashSales] = useState<number | null>(null);
  const [cashSalesFailed, setCashSalesFailed] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    summarizeRunHistoryForRun(runId)
      .then((summary) => {
        // A partial receipt's down payment is cash in the bag too; the rest of
        // that receipt, like a credit one, is still owed and isn't.
        if (!cancelled) setCashSales(summary.cashTotal + summary.partialPaidTotal);
      })
      .catch((error: unknown) => {
        logError('cashCount.loadCashSales', error);
        if (!cancelled) setCashSalesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return { cashSales, cashSalesFailed };
}

/** Cash from receipts minus expenses, to the centavo — what should be in hand. */
function cashAfterExpenses(cashSales: number, expenseTotal: number): number {
  return Math.round((cashSales - expenseTotal) * 100) / 100;
}

export function CashCountPanel({
  cashSales,
  cashSalesFailed,
  onDirtyChange,
  overlap,
  scrollProps,
}: {
  /** From useRunCashSales, via the sheet. */
  cashSales: number | null;
  cashSalesFailed: boolean;
  /** Told whenever the typed count stops (or starts) matching the saved one — the sheet asks before discarding it. */
  onDirtyChange: (dirty: boolean) => void;
  /** Extra bottom padding for the on-screen keyboard — see hooks/use-keyboard-sheet.ts. */
  overlap: number;
  scrollProps: KeyboardSheet['scrollProps'];
}) {
  const theme = useTheme();
  const { cashCount, saveCashCount, expenseTotal, expensesLoading, expensesError } = useExpenses();

  // Seeded from the saved count once, when the sheet opens — the sheet is
  // mounted fresh every time, so this always starts from what's on disk.
  const [bills, setBills] = useState<BillDraft>(() => billsToDraft(cashCount?.bills ?? emptyBillCounts()));
  const [coins, setCoins] = useState(() => (cashCount && cashCount.coins > 0 ? String(cashCount.coins) : ''));
  const [saving, setSaving] = useState(false);

  // The context finishes loading after the sheet can already be open (a
  // freshly started app). Re-seed once it arrives, but only if nothing has
  // been typed yet — never overwrite what the driver is in the middle of.
  const savedAt = cashCount?.updatedAt ?? null;
  const [seededFrom, setSeededFrom] = useState(savedAt);
  if (savedAt !== seededFrom) {
    setSeededFrom(savedAt);
    if (!saving && isBlank(bills, coins) && cashCount) {
      setBills(billsToDraft(cashCount.bills));
      setCoins(cashCount.coins > 0 ? String(cashCount.coins) : '');
    }
  }

  const draft = draftToInput(bills, coins);
  const counted = cashCountTotal(draft);
  const dirty = cashCount ? !sameCount(draft, cashCount) : counted > 0;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  async function handleSave() {
    setSaving(true);
    await runWithRetry(() => saveCashCount(draft), {
      scope: 'cashCount.save',
      title: 'Could not save the breakdown',
      message: 'Nothing was saved — the numbers you typed are still here.',
    });
    setSaving(false);
  }

  const expected = cashSales === null ? null : cashAfterExpenses(cashSales, expenseTotal);
  const unavailable = expensesError !== null;

  return (
    <>
      <ScrollView
        {...scrollProps}
        style={styles.fill}
        contentContainerStyle={[styles.list, { paddingBottom: Spacing.four + overlap }]}
        keyboardShouldPersistTaps="handled">
        {BillDenominations.map((denomination) => (
          <View key={denomination} style={[styles.countRow, { borderColor: theme.border }]}>
            <ThemedText type="smallBold" style={styles.denomination}>
              ₱{formatCount(denomination)}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              ×
            </ThemedText>
            <CountInput
              value={bills[denomination]}
              onChangeText={(text) => setBills((current) => ({ ...current, [denomination]: digitsOnly(text) }))}
              placeholder="0"
              keyboardType="number-pad"
              maxLength={4}
              editable={!saving && !unavailable}
              accessibilityLabel={`Number of ${formatCount(denomination)} peso bills`}
            />
            <ThemedText type="small" themeColor="textSecondary" style={styles.lineAmount}>
              ₱{formatAmount(denomination * draft.bills[denomination])}
            </ThemedText>
          </View>
        ))}

        <View style={[styles.countRow, { borderColor: theme.border }]}>
          <ThemedText type="smallBold" style={styles.denomination}>
            Coins
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            ₱
          </ThemedText>
          <CountInput
            value={coins}
            onChangeText={setCoins}
            placeholder="0.00"
            keyboardType="decimal-pad"
            maxLength={9}
            editable={!saving && !unavailable}
            accessibilityLabel="Total of all coins, in pesos"
            style={styles.coinInput}
          />
          <ThemedText type="small" themeColor="textSecondary" style={styles.lineAmount}>
            ₱{formatAmount(draft.coins)}
          </ThemedText>
        </View>

        <View style={styles.totalRow}>
          <ThemedText type="smallBold">Total</ThemedText>
          <ThemedText type="smallBold">₱{formatAmount(counted)}</ThemedText>
        </View>

        <Comparison
          cashSales={cashSales}
          cashSalesFailed={cashSalesFailed}
          expenseTotal={expenseTotal}
          expensesLoading={expensesLoading}
          expected={expected}
          counted={counted}
          // Before anything is counted there is nothing to compare — a big red
          // "Short by ₱8,000" on an empty form would only be noise.
          showResult={counted > 0 || cashCount !== null}
        />
      </ScrollView>

      {unavailable ? (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {expensesError}
        </ThemedText>
      ) : cashCount && !dirty ? (
        <ThemedText type="small" themeColor="textSecondary">
          Saved at {formatDeviceTime(cashCount.updatedAt)}.
        </ThemedText>
      ) : null}

      <Pressable
        onPress={() => void handleSave()}
        disabled={!dirty || saving || unavailable}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.primaryButton,
          { backgroundColor: theme.text, opacity: !dirty || saving || unavailable ? 0.4 : pressed ? 0.8 : 1 },
        ]}>
        <ThemedText type="smallBold" style={{ color: theme.background }}>
          {saving ? 'Saving…' : 'Save breakdown'}
        </ThemedText>
      </Pressable>
    </>
  );
}

/**
 * One centred number box on the Breakdown, with two Android quirks designed out:
 *
 * - **No `selectTextOnFocus`.** It was there so tapping a filled box let you
 *   retype it, but on Android it re-fires when an *empty* box gets its first
 *   digit — the digit is selected, and the second keypress overwrites it.
 * - **No grey hint while focused.** Android puts the cursor of a centred,
 *   empty box at the edge of its placeholder text rather than in the middle, so
 *   the hint is only shown when the box isn't being typed in.
 */
function CountInput({ placeholder, style, onFocus, onBlur, ...inputProps }: TextInputProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      {...inputProps}
      placeholder={focused ? undefined : placeholder}
      placeholderTextColor={theme.textSecondary}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={[
        styles.input,
        { color: theme.text, backgroundColor: theme.backgroundElement, borderColor: theme.border },
        style,
      ]}
    />
  );
}

/**
 * Cash from receipts, the expenses paid out of it, what that leaves
 * (Expected), and the breakdown total, then the verdict — Short by / Exact /
 * Over by — right-aligned underneath. Every number in the sum is on screen, so
 * the verdict can be checked by hand.
 */
function Comparison({
  cashSales,
  cashSalesFailed,
  expenseTotal,
  expensesLoading,
  expected,
  counted,
  showResult,
}: {
  cashSales: number | null;
  cashSalesFailed: boolean;
  expenseTotal: number;
  expensesLoading: boolean;
  expected: number | null;
  counted: number;
  showResult: boolean;
}) {
  const theme = useTheme();

  if (cashSalesFailed) {
    return (
      <View style={[styles.compare, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="small" style={{ color: theme.danger }}>
          Couldn&apos;t read today&apos;s receipts to compare against. Your count can still be saved.
        </ThemedText>
      </View>
    );
  }

  if (expected === null || cashSales === null || expensesLoading) {
    return (
      <View style={[styles.compare, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="small" themeColor="textSecondary">
          Loading today&apos;s receipts…
        </ThemedText>
      </View>
    );
  }

  const difference = Math.round((counted - expected) * 100) / 100;
  const result =
    difference === 0
      ? { text: 'Exact', color: theme.success }
      : difference < 0
        ? { text: `Short by ₱${formatAmount(-difference)}`, color: theme.danger }
        : { text: `Over by ₱${formatAmount(difference)}`, color: theme.warning };

  return (
    <View style={[styles.compare, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
      <CompareRow label="Cash from receipts" value={`₱${formatAmount(cashSales)}`} />
      <CompareRow label="Expense" value={`−₱${formatAmount(expenseTotal)}`} />
      {/* Without this row "Breakdown total" sat straight under "−₱450" and read
          as the answer to cash minus expense, when it is what was counted. */}
      <CompareRow label="Expected" value={signedAmount(expected)} />
      <CompareRow label="Breakdown total" value={`₱${formatAmount(counted)}`} />
      {/* Right-aligned, under the figures it is the verdict on. */}
      {showResult ? (
        <>
          {/* Solid and in the text colour, like the rule under a sum on paper —
              the owner wanted it to stand out from the rows above. */}
          <View style={[styles.divider, { backgroundColor: theme.text }]} />
          <ThemedText type="smallBold" style={[styles.result, { color: result.color }]}>
            {result.text}
          </ThemedText>
        </>
      ) : null}
    </View>
  );
}

/** Expenses can outrun cash sales on a slow day, so Expected can go below zero. */
function signedAmount(value: number): string {
  return value < 0 ? `−₱${formatAmount(-value)}` : `₱${formatAmount(value)}`;
}

function CompareRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.compareRow}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="small">{value}</ThemedText>
    </View>
  );
}

/** Bill counts are whole numbers — strips anything a paste or a stray key adds. */
function digitsOnly(text: string): string {
  return text.replace(/[^0-9]/g, '');
}

function billsToDraft(bills: Record<BillDenomination, number>): BillDraft {
  const draft = {} as BillDraft;
  for (const denomination of BillDenominations) {
    draft[denomination] = bills[denomination] > 0 ? String(bills[denomination]) : '';
  }
  return draft;
}

function draftToInput(bills: BillDraft, coins: string): CashCountInput {
  const counts = emptyBillCounts();
  for (const denomination of BillDenominations) {
    counts[denomination] = normalizeBillCount(Number(bills[denomination]));
  }
  return { bills: counts, coins: normalizeCoinAmount(Number(coins)) };
}

function isBlank(bills: BillDraft, coins: string): boolean {
  return coins === '' && BillDenominations.every((denomination) => bills[denomination] === '');
}

function sameCount(a: CashCountInput, b: CashCountInput): boolean {
  return a.coins === b.coins && BillDenominations.every((denomination) => a.bills[denomination] === b.bills[denomination]);
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  list: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  denomination: {
    width: 64,
  },
  input: {
    width: 72,
    fontSize: 16,
    textAlign: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  coinInput: {
    width: 96,
  },
  lineAmount: {
    flex: 1,
    textAlign: 'right',
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.one,
  },
  compare: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  compareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  result: {
    textAlign: 'right',
  },
  divider: {
    height: 2,
    marginVertical: Spacing.two,
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
