import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ErrorBoundary } from '@/components/error-boundary';
import { ReceiptDetailModal } from '@/components/receipt-detail-modal';
import { ReceiptFormModal } from '@/components/receipt-form-modal';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { type ThemeColor, Spacing } from '@/constants/theme';
import {
  DraftExistsError,
  InsufficientStockError,
  InvalidReceiptLineError,
  NotADraftError,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  type ReceiptDetail,
  type ReceiptDraftInput,
  type ReceiptSummary,
  useReceipts,
} from '@/context/receipts';
import { useStock } from '@/context/stock';
import { useTheme } from '@/hooks/use-theme';
import { formatDeviceDateTime } from '@/lib/device-time';
import { logError } from '@/lib/errors';
import { formatAmount } from '@/lib/money';
import { runWithRetry } from '@/lib/retry';

// Debounce so a fast typist doesn't fire a SQLite query per keystroke, while
// still feeling instant once they pause.
const SEARCH_DEBOUNCE_MS = 150;
const FLOATING_ACTIONS_SPACE = 150;


// A crash while rendering the receipt list takes only this tab down, not the
// whole app: the tab bar stays up and Inventory, Home and Customers keep
// working. See components/error-boundary.tsx.
export default function ReceiptsScreen() {
  return (
    <ErrorBoundary label="Receipts">
      <ReceiptsScreenContent />
    </ErrorBoundary>
  );
}

function ReceiptsScreenContent() {
  const theme = useTheme();
  const {
    receipts,
    receiptsLoading,
    receiptsError,
    reloadReceipts,
    loadingMore,
    loadMore,
    loadMoreFailed,
    receiptsRevision,
    findDraftReceipt,
    createDraft,
    updateDraft,
    searchReceipts,
  } = useReceipts();
  const stock = useStock();
  const [selected, setSelected] = useState<ReceiptSummary | null>(null);
  const [formState, setFormState] = useState<{ visible: boolean; editing: ReceiptDetail | null }>({
    visible: false,
    editing: null,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ReceiptSummary[]>([]);
  // Which query `searchResults` reflects — lets `searching` below be derived
  // instead of a separate state var the effect would need to set synchronously.
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  // Set when the search query itself failed, so an empty list can say which of
  // the two things happened. "No receipts match" over a lookup that broke tells
  // the user a receipt doesn't exist when nobody actually looked.
  const [searchFailed, setSearchFailed] = useState(false);
  // Bumped to re-run the search by hand, from the "Try again" below.
  const [searchRetryToken, setSearchRetry] = useState(0);
  const searchToken = useRef(0);

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;
  const searching = isSearching && resultsQuery !== trimmedQuery;

  useEffect(() => {
    if (!isSearching) return;

    const token = ++searchToken.current;
    const timer = setTimeout(() => {
      searchReceipts(trimmedQuery)
        .then((results) => {
          // Drop results from a stale keystroke that resolved after a newer one.
          if (searchToken.current !== token) return;
          setSearchResults(results);
          setResultsQuery(trimmedQuery);
          setSearchFailed(false);
        })
        // No alert — the user is typing, not waiting on a save — but the empty
        // list that follows has to say it couldn't look rather than that there
        // was nothing to find. The next keystroke retries on its own, and the
        // message carries a "Try again" for a query the user is happy with.
        .catch((error: unknown) => {
          logError('receipts.search', error);
          if (searchToken.current !== token) return;
          setSearchResults([]);
          setResultsQuery(trimmedQuery);
          setSearchFailed(true);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `receiptsRevision` changes whenever a receipt is created, edited, deleted
    // or finalized. Search results are a second list built by their own query,
    // and no writer can reach into it — so rather than duplicating every merge,
    // the query is simply re-run against the database, which is the one thing
    // guaranteed to agree with itself. Without this, finalizing a receipt found
    // through search leaves its row tagged "Draft", which puts the draft-only
    // Delete and Edit buttons back on screen for a receipt that is finalized
    // and already uploading. `resultsQuery` is unchanged by the re-run, so the
    // list refreshes in place rather than flashing "Searching…".
  }, [trimmedQuery, isSearching, searchReceipts, receiptsRevision, searchRetryToken]);

  if (receiptsLoading) {
    return <Screen />;
  }

  if (receiptsError) {
    return (
      <Screen scroll>
        <View style={styles.errorState}>
          <ThemedText type="default" themeColor="textSecondary" style={styles.errorText}>
            {receiptsError}
          </ThemedText>
          {/* Reading receipts can fail for reasons that pass (the database
              busy for a moment), so this offers a real retry rather than only
              telling the user to restart the app. */}
          <Pressable
            onPress={reloadReceipts}
            style={({ pressed }) => [styles.retryButton, { borderColor: theme.accent, opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText type="smallBold" style={{ color: theme.accent }}>
              Try again
            </ThemedText>
          </Pressable>
        </View>
      </Screen>
    );
  }

  async function openCreateForm() {
    // There's nothing to sell against until a truck stock count exists.
    if (stock.phase !== 'finalized') {
      Alert.alert('Inventory not finalized', 'Finalize your inventory before creating receipts.');
      return;
    }
    // Only one draft is allowed to exist at a time, so it must be finished
    // (or deleted) before a new one can be started. The lookup itself reads
    // the database, so it gets a retry rather than a tap that does nothing.
    const lookup = await runWithRetry(() => findDraftReceipt(), {
      scope: 'receipts.findDraft',
      title: 'Could not open a new receipt',
      message: 'The app couldn’t check whether a draft is already in progress.',
    });
    if (!lookup.completed) return;

    if (lookup.value) {
      Alert.alert(
        'Draft already in progress',
        `Finish or delete the draft for ${lookup.value.customerName} before creating a new receipt.`
      );
      return;
    }
    setSelected(null);
    setFormState({ visible: true, editing: null });
  }

  function openEditForm(detail: ReceiptDetail) {
    setSelected(null);
    setFormState({ visible: true, editing: detail });
  }

  function closeForm() {
    setFormState({ visible: false, editing: null });
  }

  /** Resolves true only if the draft is genuinely saved — the form stays open otherwise. */
  async function handleSubmit(input: ReceiptDraftInput): Promise<boolean> {
    const editing = formState.editing;
    const result = await runWithRetry(() => (editing ? updateDraft(editing.id, input) : createDraft(input)), {
      scope: editing ? 'receipts.updateDraft' : 'receipts.createDraft',
      title: 'Could not save the receipt',
      message: editing ? 'Your changes were not saved.' : 'The draft was not created.',
      // Two failures that a retry can only repeat, so both are reported once
      // instead of offered as "Try again":
      // - DraftExistsError backstops the openCreateForm check above (e.g. a
      //   double-tap): createDraft re-checks and throws if a draft snuck in.
      // - NotADraftError means the receipt being edited was finalized or
      //   removed while the form was open. Nothing was written — the edit is
      //   refused whole rather than half-applied.
      // - InsufficientStockError / InvalidReceiptLineError are about the
      //   numbers in the form, which a retry would submit unchanged. The form
      //   stays open with every quantity intact, so the fix is one tap away.
      retryable: (error) =>
        !(error instanceof DraftExistsError) &&
        !(error instanceof NotADraftError) &&
        !(error instanceof InsufficientStockError) &&
        !(error instanceof InvalidReceiptLineError),
    });
    return result.completed;
  }

  // There's nothing to sell against until a truck stock count exists.
  const canCreate = stock.phase === 'finalized';

  return (
    <Screen style={styles.screen}>
      <View style={[styles.searchField, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} tintColor={theme.textSecondary} size={18} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search by name or store"
          placeholderTextColor={theme.textSecondary}
          autoCorrect={false}
          style={[styles.searchInput, { color: theme.text }]}
        />
        {isSearching && searching && <ActivityIndicator size="small" color={theme.textSecondary} />}
        {!!searchQuery && !(isSearching && searching) && (
          <Pressable onPress={() => setSearchQuery('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={Spacing.two}>
            <SymbolView name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }} tintColor={theme.textSecondary} size={18} />
          </Pressable>
        )}
      </View>

      <FlatList
        data={isSearching ? searchResults : receipts}
        keyExtractor={(receipt) => receipt.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onEndReachedThreshold={0.4}
        onEndReached={isSearching ? undefined : loadMore}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListEmptyComponent={
          isSearching && searchFailed && !searching ? (
            // Not "No receipts match": nothing actually looked. Saying the
            // receipt isn't there would send someone off to write a second one
            // for a store they have already invoiced.
            <View style={styles.errorState}>
              <ThemedText type="default" themeColor="textSecondary" style={styles.errorText}>
                Could not search this phone’s receipts.
              </ThemedText>
              <Pressable
                onPress={() => setSearchRetry((token) => token + 1)}
                style={({ pressed }) => [styles.retryButton, { borderColor: theme.accent, opacity: pressed ? 0.6 : 1 }]}>
                <ThemedText type="smallBold" style={{ color: theme.accent }}>
                  Try again
                </ThemedText>
              </Pressable>
            </View>
          ) : (
            <ThemedText type="default" themeColor="textSecondary" style={styles.empty}>
              {isSearching ? (searching ? 'Searching…' : 'No receipts match.') : 'No receipts yet. Create one below.'}
            </ThemedText>
          )
        }
        renderItem={({ item }) => <ReceiptRow receipt={item} onPress={() => setSelected(item)} />}
        ListFooterComponent={
          isSearching ? null : loadingMore ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator size="small" color={theme.textSecondary} />
            </View>
          ) : loadMoreFailed ? (
            // The receipts above are fine and stay usable, so this is a footer
            // rather than an error screen. It has to be here at all because
            // `onEndReached` doesn't fire again until the user scrolls away and
            // back, so a failed page is otherwise indistinguishable from the
            // end of the list.
            <View style={styles.loadMoreError}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.errorText}>
                Could not load older receipts.
              </ThemedText>
              <Pressable
                onPress={loadMore}
                style={({ pressed }) => [styles.retryButton, { borderColor: theme.accent, opacity: pressed ? 0.6 : 1 }]}>
                <ThemedText type="smallBold" style={{ color: theme.accent }}>
                  Try again
                </ThemedText>
              </Pressable>
            </View>
          ) : null
        }
      />

      <View style={styles.bottomActions}>
        <Pressable
          onPress={openCreateForm}
          accessibilityRole="button"
          accessibilityLabel="New receipt"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.accent, opacity: !canCreate ? 0.4 : pressed ? 0.85 : 1 },
          ]}>
          <ThemedText type="smallBold" style={{ color: theme.background, fontSize: 18, lineHeight: 24 }}>
            New receipt
          </ThemedText>
        </Pressable>
      </View>

      <ReceiptDetailModal receipt={selected} onClose={() => setSelected(null)} onEdit={openEditForm} />

      <ReceiptFormModal visible={formState.visible} editing={formState.editing} onClose={closeForm} onSubmit={handleSubmit} />
    </Screen>
  );
}

// Which theme color reads each payment method at a glance in the list —
// partial gets the danger color since it's the one that still owes money.
const PAYMENT_METHOD_TAG_COLOR: Record<PaymentMethod, ThemeColor> = {
  cash: 'success',
  gcash: 'accent',
  cheque: 'warning',
  partial: 'danger',
  credit: 'textSecondary',
};

function ReceiptRow({ receipt, onPress }: { receipt: ReceiptSummary; onPress: () => void }) {
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
  screen: {
    // Screen's default bottom padding leaves a white gap between the button
    // and the tab bar; the tab bar already reserves its own safe-area space,
    // so this screen doesn't need the extra breathing room below the button.
    paddingBottom: 0,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.three,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    padding: 0,
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: Spacing.three,
    // Keep the last list items visible above the floating action button area.
    paddingBottom: FLOATING_ACTIONS_SPACE,
  },
  empty: {
    marginTop: Spacing.four,
    textAlign: 'center',
  },
  errorState: {
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.five,
  },
  errorText: {
    textAlign: 'center',
  },
  retryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingMore: {
    paddingVertical: Spacing.three,
  },
  loadMoreError: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
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
  bottomActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Spacing.four,
    gap: Spacing.two,
    alignItems: 'center',
  },
  button: {
    alignSelf: 'center',
    minWidth: '70%',
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.five,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
});
