import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { InventoryHistoryModal } from '@/components/inventory-history-modal';
import { InventoryStockModal } from '@/components/inventory-stock-modal';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useBreadTypes, type UnitLabel } from '@/context/bread-types';
import { useStock } from '@/context/stock';
import { useTheme } from '@/hooks/use-theme';
import { formatUnitHint } from '@/lib/bread-unit';
import { runWithRetry } from '@/lib/retry';

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/**
 * "Smart enough" search for a short bread-type list: exact/partial substring
 * match, then word-order-independent matching, then a typo-tolerant
 * subsequence fallback (letters of the query appear in order, not necessarily
 * together) — no fuzzy-search dependency needed for a handful of items.
 */
function matchesSearch(name: string, query: string): boolean {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;

  const normalizedName = normalize(name);
  if (normalizedName.includes(normalizedQuery)) return true;

  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((word) => normalizedName.includes(word))) return true;

  let i = 0;
  for (const char of normalizedName) {
    if (char === normalizedQuery[i]) i++;
  }
  return i === normalizedQuery.length;
}

function pluralizeUnit(unitLabel: UnitLabel, count: number): string {
  if (count === 1) return unitLabel;
  return unitLabel === 'box' ? 'boxes' : `${unitLabel}s`;
}

/** Flat total, e.g. "24 pcs". */
function formatQtyPcs(totalPieces: number): string {
  return `${totalPieces} pcs`;
}

/** Broken into whole packaging units plus any leftover pieces, e.g. "2 trays and 1 pcs". */
function formatQtyByUnit(totalPieces: number, unitSize: number, unitLabel: UnitLabel): string {
  if (unitLabel === 'piece' || unitSize <= 1) return formatQtyPcs(totalPieces);

  const wholeUnits = Math.floor(totalPieces / unitSize);
  const remainder = totalPieces % unitSize;
  if (wholeUnits === 0) return formatQtyPcs(remainder);

  const unitWord = `${wholeUnits} ${pluralizeUnit(unitLabel, wholeUnits)}`;
  return remainder === 0 ? unitWord : `${unitWord} and ${remainder} pcs`;
}

export function InventoryStockScreen() {
  const theme = useTheme();
  const { breadTypes, breadTypesLoading, breadTypesError, refreshBreadTypes } = useBreadTypes();
  const stock = useStock();
  const [modalVisible, setModalVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [search, setSearch] = useState('');
  const [qtyMode, setQtyMode] = useState<'unit' | 'pcs'>('pcs');

  if (stock.stockLoading) {
    return <Screen />;
  }

  if (stock.stockError) {
    return (
      <Screen scroll>
        <View style={styles.listState}>
          <ThemedText type="default" themeColor="textSecondary" style={styles.listStateText}>
            {stock.stockError}
          </ThemedText>
          {/* Reading the ledger can fail for reasons that pass (the database
              busy for a moment, storage briefly full), so this offers a real
              retry instead of only telling the user to restart the app. */}
          <Pressable
            onPress={stock.reloadStock}
            style={({ pressed }) => [
              styles.outlineButton,
              { borderColor: theme.accent, paddingHorizontal: Spacing.four, opacity: pressed ? 0.6 : 1 },
            ]}>
            <ThemedText type="smallBold" style={{ color: theme.accent }}>
              Try again
            </ThemedText>
          </Pressable>
        </View>
      </Screen>
    );
  }

  async function handleFinalize() {
    setFinalizing(true);
    const result = await runWithRetry(() => stock.finalize(), {
      scope: 'stock.finalize',
      title: 'Could not finalize inventory',
      message: 'Your counts are still saved as a draft — nothing was locked in.',
    });
    setFinalizing(false);
    // Left open if they gave up, so the counts and this dialog are still there
    // to try again once whatever went wrong is sorted out.
    if (result.completed) setConfirmingFinalize(false);
  }

  const modalMode = stock.phase === 'finalized' ? 'add' : 'set';
  const visibleBreadTypes = breadTypes.filter((breadType) => matchesSearch(breadType.name, search));

  return (
    <Screen>
      <View style={[styles.searchField, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <SymbolView
          name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
          tintColor={theme.textSecondary}
          size={18}
        />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search bread types"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.searchInput, { color: theme.text }]}
        />
        {search.length > 0 && (
          <Pressable
            onPress={() => setSearch('')}
            hitSlop={Spacing.two}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <SymbolView
              name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }}
              tintColor={theme.textSecondary}
              size={18}
            />
          </Pressable>
        )}
      </View>

      {stock.phase === 'finalized' && (
        <View style={styles.actionsRow}>

          <Pressable
            onPress={() => setHistoryVisible(true)}
            style={({ pressed }) => [
              styles.rowButtonOutline,
              { borderColor: theme.accent, opacity: pressed ? 0.6 : 1 },
            ]}>
            <ThemedText type="smallBold" style={{ color: theme.accent }}>
              Inventory history
            </ThemedText>
          </Pressable>
          <Pressable
            onPress={() => setModalVisible(true)}
            style={({ pressed }) => [
              styles.rowButtonFilled,
              { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
            ]}>
            <ThemedText type="smallBold" style={{ color: theme.background }}>
              Add batch
            </ThemedText>
          </Pressable>
        </View>
      )}

      <View style={[styles.tableHeader, { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText style={[styles.itemCol, styles.tableHeaderLabel]}>Item</ThemedText>
        <Pressable
          onPress={() => setQtyMode((mode) => (mode === 'unit' ? 'pcs' : 'unit'))}
          hitSlop={Spacing.two}
          accessibilityRole="button"
          accessibilityLabel="Switch quantity display between pieces and packaging units"
          style={({ pressed }) => [styles.qtyCol, styles.qtyHeader, { opacity: pressed ? 0.6 : 1 }]}>
          <ThemedText numberOfLines={1} style={[styles.tableHeaderLabel, { color: theme.accent }]}>
            Qty({qtyMode === 'pcs' ? 'pcs' : 'unit'})
          </ThemedText>
        </Pressable>
        <ThemedText style={[styles.priceCol, styles.tableHeaderLabel]}>Price</ThemedText>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        {/* The catalog comes from Firestore, so "nothing here" has three very
            different meanings — still downloading, couldn't download, or
            genuinely empty — and each gets its own answer. */}
        {breadTypesLoading ? (
          <View style={styles.listState}>
            <ActivityIndicator size="large" color={theme.textSecondary} />
            <ThemedText type="default" themeColor="textSecondary">
              Loading bread types…
            </ThemedText>
          </View>
        ) : breadTypesError ? (
          <View style={styles.listState}>
            <ThemedText type="default" themeColor="textSecondary" style={styles.listStateText}>
              {breadTypesError}
            </ThemedText>
            <Pressable
              onPress={() => void refreshBreadTypes()}
              style={({ pressed }) => [
                styles.outlineButton,
                { borderColor: theme.accent, paddingHorizontal: Spacing.four, opacity: pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.accent }}>
                Try again
              </ThemedText>
            </Pressable>
          </View>
        ) : breadTypes.length === 0 ? (
          // This list is drawn from the bread-type catalog, not from the
          // ledger — so "nothing here" means the *catalog* is empty, never
          // that stock has run out. It used to read "No inventory recorded
          // yet", which sent the reader looking at their stock instead of at
          // the dashboard where the actual problem is.
          <View style={styles.listState}>
            <ThemedText type="default" themeColor="textSecondary" style={styles.listStateText}>
              No bread types downloaded. Add them on the dashboard, then try again.
            </ThemedText>
            <Pressable
              onPress={() => void refreshBreadTypes()}
              style={({ pressed }) => [
                styles.outlineButton,
                { borderColor: theme.accent, paddingHorizontal: Spacing.four, opacity: pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.accent }}>
                Try again
              </ThemedText>
            </Pressable>
          </View>
        ) : visibleBreadTypes.length === 0 ? (
          <ThemedText type="default" themeColor="textSecondary" style={styles.empty}>
            No bread types match “{search}”.
          </ThemedText>
        ) : (
          visibleBreadTypes.map((breadType) => {
            // The ledger stores pieces directly (see stock.tsx) — no unit conversion needed here.
            const totalPieces = stock.displayStock[breadType.id] ?? 0;
            return (
              <View key={breadType.id} style={styles.listRow}>
                <View style={styles.itemCol}>
                  <ThemedText type="default" style={styles.itemName}>
                    {breadType.name}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.unitHint}>
                    ({formatUnitHint(breadType.unitSize, breadType.unitLabel)})
                  </ThemedText>
                </View>
                <ThemedText type="smallBold" style={[styles.qtyCol, styles.rowValue]}>
                  {qtyMode === 'pcs'
                    ? formatQtyPcs(totalPieces)
                    : formatQtyByUnit(totalPieces, breadType.unitSize, breadType.unitLabel)}
                </ThemedText>
                <ThemedText type="smallBold" numberOfLines={1} style={[styles.priceCol, styles.rowValue]}>
                  ₱{breadType.price.toFixed(2)}
                </ThemedText>
              </View>
            );
          })
        )}
      </ScrollView>

      {stock.phase === 'draft' && (
        <View style={styles.bottomActions}>
          <Pressable
            onPress={() => setModalVisible(true)}
            style={({ pressed }) => [styles.button, { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 }]}>
            <ThemedText type="smallBold" style={{ color: theme.background }}>
              Edit Inventory Draft
            </ThemedText>
          </Pressable>

          <Pressable
            onPress={() => setConfirmingFinalize(true)}
            style={({ pressed }) => [styles.button, { backgroundColor: theme.success, opacity: pressed ? 0.85 : 1 }]}>
            <ThemedText type="smallBold" style={{ color: theme.background }}>
              Finalize
            </ThemedText>
          </Pressable>
        </View>
      )}

      <Modal
        visible={confirmingFinalize}
        transparent
        animationType="fade"
        onRequestClose={() => !finalizing && setConfirmingFinalize(false)}>
        <Pressable style={styles.backdrop} onPress={() => !finalizing && setConfirmingFinalize(false)}>
          <Pressable onPress={() => {}} style={styles.confirmWrapper}>
            <View style={[styles.confirmCard, { backgroundColor: theme.background }]}>
              <ThemedText type="smallBold">Finalize inventory?</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                You won’t be able to freely edit counts after this — further stock is added as batches.
              </ThemedText>
              <View style={styles.confirmActions}>
                <Pressable
                  onPress={() => setConfirmingFinalize(false)}
                  disabled={finalizing}
                  style={({ pressed }) => [
                    styles.outlineButton,
                    styles.confirmButton,
                    { borderColor: theme.border, opacity: pressed ? 0.6 : 1 },
                  ]}>
                  <ThemedText type="smallBold">Cancel</ThemedText>
                </Pressable>
                <Pressable
                  onPress={handleFinalize}
                  disabled={finalizing}
                  style={({ pressed }) => [
                    styles.button,
                    styles.confirmButton,
                    { backgroundColor: theme.success, opacity: finalizing ? 0.4 : pressed ? 0.85 : 1 },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: theme.background }}>
                    {finalizing ? 'Finalizing…' : 'Finalize'}
                  </ThemedText>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <InventoryStockModal
        visible={modalVisible}
        mode={modalMode}
        breadTypes={breadTypes}
        currentStock={stock.displayStock}
        onClose={() => setModalVisible(false)}
        onSave={modalMode === 'set' ? stock.saveDraft : stock.addBatch}
      />

      <InventoryHistoryModal
        visible={historyVisible}
        batches={stock.batches}
        breadTypes={breadTypes}
        onClose={() => setHistoryVisible(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: {
    marginTop: Spacing.four,
  },
  listState: {
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.five,
  },
  listStateText: {
    textAlign: 'center',
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    height: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    fontSize: 16,
    paddingVertical: 0,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  rowButtonFilled: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowButtonOutline: {
    flex: 1,
    borderWidth: 2,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  tableHeaderLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: Spacing.three,
    paddingTop: Spacing.two,
  },
  listRow: {
    flexDirection: 'row',
    // Centered, not flex-start — otherwise a single-line Qty/Price sits
    // pinned to the top next to a two-line item name + unit hint instead of
    // sitting centered against that taller block.
    alignItems: 'center',
    gap: Spacing.three,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
    // Deliberately lighter than theme.border (used for input/card outlines) —
    // this is just a soft row separator, not a control boundary.
    borderColor: 'rgba(0, 0, 0, 0.10)',
  },
  // Proportional flex, not fixed pixel widths — so the ratio (and Qty/Price
  // centering) holds on any screen width. Item is deliberately the dominant
  // share; Qty/Price are just wide enough for their own content, not an even
  // three-way split.
  itemCol: {
    flex: 2,
    gap: Spacing.half,
  },
  itemName: {
    fontSize: 14,
    lineHeight: 18,
  },
  unitHint: {
    fontSize: 12,
    lineHeight: 16,
  },
  rowValue: {
    fontSize: 13,
    lineHeight: 18,
  },
  qtyCol: {
    flex: 1.2,
    textAlign: 'center',
  },
  qtyHeader: {
    alignItems: 'center',
  },
  priceCol: {
    flex: 1,
    textAlign: 'center',
  },
  bottomActions: {
    gap: Spacing.two,
    paddingTop: Spacing.three,
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: Spacing.four,
  },
  confirmWrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  confirmCard: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  confirmButton: {
    flex: 1,
  },
});
