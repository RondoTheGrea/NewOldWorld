import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ReceiptDetailModal } from '@/components/receipt-detail-modal';
import { ReceiptRow } from '@/components/receipt-row';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useReceipts, type ReceiptSummary } from '@/context/receipts';
import { useTheme } from '@/hooks/use-theme';
import { describeError, logError } from '@/lib/errors';

/**
 * The "Purchase History" section of the customer profile, copied from the old
 * (OldWorld) app: the store's receipts newest first, ten at a time with a
 * "Load More" under them.
 *
 * Each row is the Receipts tab's own `ReceiptRow`, and tapping one opens the
 * same `ReceiptDetailModal` the Receipts tab opens — items, returns, totals,
 * proof photo, Preview/print and (for the open run) Void — so a receipt looks
 * and behaves the same whichever list it was found in.
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
  const { loadCustomerReceipts, receiptsRevision } = useReceipts();
  const theme = useTheme();
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReceiptSummary | null>(null);

  // Fetches one page more than shown to learn whether a "Load More" is owed,
  // without a separate count query.
  const fetchPage = useCallback(
    (after: ReceiptSummary | null) =>
      loadCustomerReceipts(customerId, after ? { createdAt: after.createdAt, id: after.id } : null, PageSize + 1),
    [customerId, loadCustomerReceipts],
  );

  // Reloads from the top whenever a receipt is
  // finalized or voided elsewhere in the app (`receiptsRevision`), so an open
  // profile never shows a stale history — including a void made from the
  // detail modal opened right here.
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
        receipts.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} onPress={() => setSelected(receipt)} />)
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

      {/* No onEdit: the history lists finalized receipts only, and Edit is a
          draft-only button, so it never appears here. */}
      <ReceiptDetailModal receipt={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    // Matches the Receipts tab's gap between rows.
    gap: Spacing.three,
  },
  centered: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  empty: {
    paddingVertical: Spacing.two,
  },
  loadMore: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
  },
});
