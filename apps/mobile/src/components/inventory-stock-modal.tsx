import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { FlatList, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { QuantityStepper } from '@/components/quantity-stepper';
import { ThemedText } from '@/components/themed-text';
import { type BreadType } from '@/context/bread-types';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useKeyboardSheet } from '@/hooks/use-keyboard-sheet';
import { useTheme } from '@/hooks/use-theme';
import { formatUnitHint } from '@/lib/bread-unit';
import { generateId } from '@/lib/id';
import { runWithRetry } from '@/lib/retry';

type InventoryStockModalProps = {
  visible: boolean;
  /** 'set' freely overwrites quantities (pre-finalize draft). 'add' only records a delta on top of the current total (post-finalize batch). */
  mode: 'set' | 'add';
  breadTypes: BreadType[];
  /** In 'set' mode, the values to seed the steppers from. In 'add' mode, the current totals shown read-only. */
  currentStock: Record<string, number>;
  onClose: () => void;
  /**
   * 'set': the full replacement quantities. 'add': positive deltas only.
   *
   * `entryId` identifies one press of Save. 'add' writes a new ledger entry
   * every time it is called, so without it a retry after a save that had
   * actually committed would put the same delivery on the truck twice; reusing
   * one id across the retries of a single press makes them all the same entry.
   * 'set' overwrites the whole draft and so ignores it.
   */
  onSave: (values: Record<string, number>, entryId: string) => Promise<void>;
};

export function InventoryStockModal({ visible, mode, breadTypes, currentStock, onClose, onSave }: InventoryStockModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Mounted fresh each open, so its quantities always start from the
          current values instead of syncing via an effect. */}
      {visible && (
        <InventoryStockModalBody mode={mode} breadTypes={breadTypes} currentStock={currentStock} onClose={onClose} onSave={onSave} />
      )}
    </Modal>
  );
}

type BodyProps = Omit<InventoryStockModalProps, 'visible'>;

function InventoryStockModalBody({ mode, breadTypes, currentStock, onClose, onSave }: BodyProps) {
  const theme = useTheme();
  const { overlap, onBackdropLayout, scrollProps } = useKeyboardSheet();
  const [values, setValues] = useState<Record<string, number>>(() => {
    if (mode === 'set') return { ...currentStock };
    const zeros: Record<string, number> = {};
    for (const breadType of breadTypes) zeros[breadType.id] = 0;
    return zeros;
  });
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // What the batch actually puts on the truck: addBatch keeps positive deltas
  // only, so a row left at 0 is not part of this batch.
  const additions = mode === 'add' ? breadTypes.filter((breadType) => (values[breadType.id] ?? 0) > 0) : [];
  const totalPieces = additions.reduce((sum, breadType) => sum + (values[breadType.id] ?? 0), 0);
  // In 'add' mode an all-zero batch is an empty ledger entry — nothing to
  // confirm and nothing to record. 'set' is a draft overwrite, where zero
  // everywhere is a legitimate thing to save.
  const canSubmit = !saving && breadTypes.length > 0 && (mode === 'set' || additions.length > 0);

  function setQuantity(breadTypeId: string, quantity: number) {
    setValues((current) => ({ ...current, [breadTypeId]: quantity }));
  }

  async function handleSave() {
    setConfirming(false);
    setSaving(true);
    // Minted here rather than inside the action, so every "Try again" in the
    // prompt below reuses it — that is what makes one press of Save produce at
    // most one ledger entry. A second press mints a second id and is a second,
    // genuine batch.
    const entryId = generateId();
    const result = await runWithRetry(() => onSave(values, entryId), {
      scope: mode === 'set' ? 'stock.saveDraft' : 'stock.addBatch',
      title: mode === 'set' ? 'Could not save the counts' : 'Could not add the batch',
      message:
        mode === 'set'
          ? 'Your inventory draft is unchanged — nothing was saved.'
          : 'The batch was not added, so truck stock is unchanged.',
    });
    setSaving(false);
    // Only close on success. Giving up keeps every quantity the user typed on
    // screen, so nothing has to be re-entered from memory.
    if (result.completed) onClose();
  }

  // The sheet stays put when the keyboard opens — same centred size and
  // position. The list is given extra bottom padding (`overlap`) so it can
  // scroll far enough for the row being typed into to clear the keyboard, and
  // `useKeyboardSheet` scrolls that row up as the keyboard arrives.
  return (
    <View style={styles.backdrop} onLayout={onBackdropLayout}>
      {/* Deliberately no tap-to-close on the backdrop. Counting a truck's worth
          of bread is dozens of taps on steppers that sit close to the sheet's
          edge, and a single stray one on the dim strip used to throw the lot
          away. Closing is the ✕ and Cancel. Same rule in the other form
          sheets. */}
      <View style={styles.sheetWrapper}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={[styles.header, styles.sheetPadding]}>
            <ThemedText type="subtitle">{mode === 'set' ? 'Edit Inventory Draft' : 'Add batch'}</ThemedText>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={Spacing.two}
              disabled={saving}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={theme.text} size={24} />
            </Pressable>
          </View>

          {breadTypes.length === 0 ? (
            // Same sentence the Inventory tab shows behind this modal, on
            // purpose: both are the one condition "the bread-type catalog is
            // empty", and two different wordings read as two different faults.
            <ThemedText type="default" themeColor="textSecondary" style={[styles.empty, styles.sheetPadding]}>
              No bread types downloaded. Add them on the dashboard, then reopen the Inventory tab and tap Try again.
            </ThemedText>
          ) : (
            <FlatList
              {...scrollProps}
              data={breadTypes}
              keyExtractor={(breadType) => breadType.id}
              style={styles.fill}
              contentContainerStyle={[styles.list, styles.sheetPadding, { paddingBottom: Spacing.four + overlap }]}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={20}
              maxToRenderPerBatch={20}
              windowSize={7}
              removeClippedSubviews={Platform.OS !== 'web'}
              renderItem={({ item: breadType }) => (
                <View style={styles.row}>
                  <View style={styles.rowLabel}>
                    <ThemedText type="smallBold">{breadType.name}</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {mode === 'add'
                        ? `Current: ${currentStock[breadType.id] ?? 0} pcs`
                        : formatUnitHint(breadType.unitSize, breadType.unitLabel)}
                    </ThemedText>
                  </View>
                  <QuantityStepper
                    value={values[breadType.id] ?? 0}
                    onChange={(quantity) => setQuantity(breadType.id, quantity)}
                    editable={!saving}
                  />
                </View>
              )}
            />
          )}

          <View style={[styles.actions, styles.sheetPadding]}>
            <Pressable
              onPress={onClose}
              disabled={saving}
              style={({ pressed }) => [styles.cancelButton, { borderColor: theme.border, opacity: pressed ? 0.6 : 1 }]}>
              <ThemedText type="smallBold">Cancel</ThemedText>
            </Pressable>
            <Pressable
              // 'add' appends a permanent ledger entry, and nothing but a sale
              // ever lowers stock again — so it asks first. 'set' overwrites a
              // draft that is still freely editable, so it saves straight off
              // with nothing to warn about.
              onPress={mode === 'set' ? handleSave : () => setConfirming(true)}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.saveButton,
                { backgroundColor: theme.text, opacity: !canSubmit ? 0.4 : pressed ? 0.8 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.background }}>
                {saving ? 'Saving…' : mode === 'set' ? 'Save changes' : 'Add'}
              </ThemedText>
            </Pressable>
          </View>
        </View>
      </View>

      {/* Answering "Go back" only closes this — the sheet behind it keeps every
          stepper exactly as it was set. */}
      <ConfirmDialog
        visible={confirming}
        title="Add this batch?"
        message={`${totalPieces} pcs across ${additions.length} ${
          additions.length === 1 ? 'bread type' : 'bread types'
        } goes on the truck.`}
        cancelLabel="Go back"
        confirmLabel="Continue"
        onCancel={() => setConfirming(false)}
        onConfirm={handleSave}
      />
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
    paddingTop: Spacing.three,
    overflow: 'hidden',
  },
  // Everything that isn't the scrollable list gets this instead of the sheet
  // carrying the padding itself — the list needs the full, unpadded width so
  // its native scroll indicator draws flush against the sheet's true right
  // edge rather than inset by the padding (see `list` below).
  sheetPadding: {
    paddingHorizontal: Spacing.four,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
  },
  empty: {
    marginTop: Spacing.four,
    textAlign: 'center',
  },
  // Horizontal padding lives here (applied via a style array at the call
  // site), not on `sheet` or on `fill` — padding on the FlatList's own box
  // would still inset the scroll indicator with it. Putting it on the
  // content container pads the rows while leaving the FlatList's frame, and
  // so its indicator, flush with the sheet.
  list: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  rowLabel: {
    flex: 1,
    gap: Spacing.half,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginVertical: Spacing.three,
  },
  cancelButton: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButton: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
