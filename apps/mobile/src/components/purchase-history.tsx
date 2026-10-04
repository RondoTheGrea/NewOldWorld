import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useReceipts, type ReceiptDetail, type ReceiptSummary } from '@/context/receipts';
import { useTheme } from '@/hooks/use-theme';
import { formatBusinessDate } from '@/lib/business-day';
import { describeError, logError } from '@/lib/errors';
import { formatAmount, formatCount } from '@/lib/money';

/**
 * The "Purchase History" section of the customer profile, copied from the old
 * (OldWorld) app: the store's receipts newest first, ten at a time with a
 * "Load More" under them, each one tapping open to its order lines, returns and
 * totals.
 *
 * It reads the receipts **on this phone** — the ones this handset finalized.
 * Old receipts were deliberately not migrated from OldWorld (only the customer
 * profiles were), so a migrated store starts with an empty history here. The
 * dashboard's Stores tab is where every truck's receipts for a store are seen
 * together.
 */

/** Matches the old app's RECEIPTS_PER_PAGE. */
const PageSize = 10;

export function PurchaseHistory({ customerId }: { customerId: string }) {
  const { loadCustomerReceipts, getReceiptDetail, receiptsRevision } = useReceipts();
  const theme = useTheme();
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Line items are fetched only when a receipt is opened, and kept once read —
  // the same "summaries in the list, detail on demand" split the Receipts tab
  // uses, so a store with years of history doesn't load every line up front.
  const [details, setDetails] = useState<Record<string, ReceiptDetail>>({});

  // Fetches one page more than shown to learn whether a "Load More" is owed,
  // without a separate count query.
  const fetchPage = useCallback(
    (after: ReceiptSummary | null) =>
      loadCustomerReceipts(customerId, after ? { createdAt: after.createdAt, id: after.id } : null, PageSize + 1),
    [customerId, loadCustomerReceipts],
  );

  // Reloads from the top whenever a receipt is
  // finalized or voided elsewhere in the app (`receiptsRevision`), so an open
  // profile never shows a stale history.
  useEffect(() => {
    let cancelled = false;
    fetchPage(null).then(
      (rows) => {
        if (cancelled) return;
        setError(null);
        setReceipts(rows.slice(0, PageSize));
        setHasMore(rows.length > PageSize);
      },
      (err: unknown) => {
        if (cancelled) return;
        logError('purchaseHistory.load', err);
        setError(describeError(err));
        setReceipts([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchPage, receiptsRevision]);

  async function handleLoadMore() {
    if (!receipts || loadingMore) return;
    setLoadingMore(true);
    try {
      const rows = await fetchPage(receipts[receipts.length - 1] ?? null);
      setReceipts((current) => [...(current ?? []), ...rows.slice(0, PageSize)]);
      setHasMore(rows.length > PageSize);
    } catch (err) {
      logError('purchaseHistory.loadMore', err);
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggle(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (details[id]) return;
    try {
      const detail = await getReceiptDetail(id);
      setDetails((current) => ({ ...current, [id]: detail }));
    } catch (err) {
      logError('purchaseHistory.detail', err);
      setError(describeError(err));
      setExpandedId(null);
    }
  }

  return (
    <View style={styles.section}>
      <ThemedText type="smallBold">Purchase History</ThemedText>

      {receipts === null ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.text} />
          <ThemedText type="small" themeColor="textSecondary">
            Loading purchase history...
          </ThemedText>
        </View>
      ) : receipts.length === 0 && !error ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
          No purchase history
        </ThemedText>
      ) : (
        receipts.map((receipt) => (
          <HistoryRow
            key={receipt.id}
            receipt={receipt}
            expanded={expandedId === receipt.id}
            detail={details[receipt.id] ?? null}
            onPress={() => void toggle(receipt.id)}
          />
        ))
      )}

      {error && (
        <ThemedText type="small" themeColor="danger">
          Could not load purchase history: {error}
        </ThemedText>
      )}

      {hasMore && (
        <Pressable
          onPress={() => void handleLoadMore()}
          disabled={loadingMore}
          style={({ pressed }) => [styles.loadMore, { opacity: pressed ? 0.6 : 1 }]}>
          {loadingMore ? <ActivityIndicator color={theme.text} /> : <ThemedText type="smallBold">Load More</ThemedText>}
        </Pressable>
      )}
    </View>
  );
}

function HistoryRow({
  receipt,
  expanded,
  detail,
  onPress,
}: {
  receipt: ReceiptSummary;
  expanded: boolean;
  detail: ReceiptDetail | null;
  onPress: () => void;
}) {
  const theme = useTheme();
  const voided = receipt.voidedAt !== null;
  const pieces = detail?.items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: theme.backgroundElement,
          borderColor: theme.border,
          borderLeftColor: expanded ? theme.text : theme.textSecondary,
          opacity: pressed ? 0.8 : 1,
        },
      ]}>
      <View style={styles.rowHeader}>
        <SymbolView
          name={{ ios: 'doc.text', android: 'receipt_long', web: 'receipt_long' }}
          tintColor={theme.textSecondary}
          size={20}
        />
        <View style={styles.rowTitle}>
          {/* The Manila business day — the one rule for "which day was
              this?" (lib/business-day.ts), not the phone's own calendar. */}
          <ThemedText type="smallBold">{formatBusinessDate(receipt.createdAt)}</ThemedText>
          <ThemedText type="small" themeColor={voided ? 'danger' : 'textSecondary'}>
            {voided
              ? 'Voided'
              : pieces !== undefined
                ? `${formatCount(pieces)} item${pieces !== 1 ? 's' : ''}`
                : 'Tap for details'}
          </ThemedText>
        </View>
        <ThemedText type="smallBold" style={voided && styles.struck}>
          {money(receipt.total)}
        </ThemedText>
        <SymbolView
          name={
            expanded
              ? { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' }
              : { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }
          }
          tintColor={theme.textSecondary}
          size={18}
        />
      </View>

      {expanded &&
        (detail === null ? (
          <ActivityIndicator color={theme.text} style={styles.detailLoading} />
        ) : (
          <View style={styles.detail}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.detailHeading}>
              Order Details
            </ThemedText>
            <View style={[styles.rule, { backgroundColor: theme.border }]} />
            {detail.items.map((item, index) => (
              <Line
                key={`${item.breadTypeId}-${index}`}
                name={item.name}
                quantity={item.quantity}
                unitPrice={item.unitPrice}
              />
            ))}

            {detail.returns.length > 0 && (
              <>
                <ThemedText type="small" themeColor="textSecondary" style={styles.detailHeading}>
                  Returns
                </ThemedText>
                <View style={[styles.rule, { backgroundColor: theme.border }]} />
                {detail.returns.map((item, index) => (
                  <Line
                    key={`${item.returnedBreadTypeId}-${index}`}
                    name={item.name}
                    quantity={item.quantity}
                    unitPrice={item.unitPrice}
                    negative
                  />
                ))}
                <Total label="Input Total:" value={money(detail.subtotal)} />
                <Total label="Returns Total:" value={`-${money(detail.returnsTotal)}`} />
              </>
            )}

            <View style={[styles.rule, { backgroundColor: theme.border }]} />
            <Total label="Final Total:" value={money(detail.total)} strong />
          </View>
        ))}
    </Pressable>
  );
}

function Line({
  name,
  quantity,
  unitPrice,
  negative,
}: {
  name: string;
  quantity: number;
  unitPrice: number;
  negative?: boolean;
}) {
  return (
    <View style={styles.line}>
      <View style={styles.lineLeft}>
        <ThemedText type="small">{name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {formatCount(quantity)} × {money(unitPrice)}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor={negative ? 'danger' : undefined}>
        {negative ? '-' : ''}
        {money(quantity * unitPrice)}
      </ThemedText>
    </View>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.line}>
      <ThemedText type={strong ? 'smallBold' : 'small'}>{label}</ThemedText>
      <ThemedText type={strong ? 'smallBold' : 'small'}>{value}</ThemedText>
    </View>
  );
}

/** `₱1,234.50`, or `-₱50.00` for a receipt whose returns outweigh its sales. */
function money(value: number): string {
  return `${value < 0 ? '-' : ''}₱${formatAmount(Math.abs(value))}`;
}

const styles = StyleSheet.create({
  section: {
    gap: Spacing.two,
  },
  centered: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  empty: {
    paddingVertical: Spacing.two,
  },
  row: {
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 4,
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rowTitle: {
    flex: 1,
  },
  struck: {
    textDecorationLine: 'line-through',
  },
  detailLoading: {
    marginTop: Spacing.three,
  },
  detail: {
    marginTop: Spacing.three,
    gap: Spacing.one,
  },
  detailHeading: {
    fontWeight: 700,
    marginTop: Spacing.one,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.one,
  },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  lineLeft: {
    flex: 1,
  },
  loadMore: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
  },
});
