import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { CustomerScopeToggle } from '@/components/customer-scope-toggle';
import { DropdownField } from '@/components/dropdown-field';
import { QuantityStepper } from '@/components/quantity-stepper';
import { ScopeToast } from '@/components/scope-toast';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { type BreadType, useBreadTypes } from '@/context/bread-types';
import { isNewCustomer, useCustomers } from '@/context/customers';
import { type ReceiptDetail, type ReceiptDraftInput, type ReceiptItem, type ReceiptReturnItem } from '@/context/receipts';
import { type ReturnedBreadType, useReturnedBreadTypes } from '@/context/returned-bread-types';
import { useStock } from '@/context/stock';
import { useCustomerScope } from '@/hooks/use-customer-scope';
import { useKeyboardSheet } from '@/hooks/use-keyboard-sheet';
import { useTheme } from '@/hooks/use-theme';
import { useToast } from '@/hooks/use-toast';
import { type CustomerScope, describeCustomerScope } from '@/lib/customer-scope';
import { describeError, logError } from '@/lib/errors';
import { formatAmount, formatCount } from '@/lib/money';
import { notifyFailure } from '@/lib/retry';

type ReceiptFormModalProps = {
  visible: boolean;
  /** Present to edit an existing draft; null to create a new one. */
  editing: ReceiptDetail | null;
  onClose: () => void;
  /**
   * Resolves true when the draft is saved. False means it failed and the user
   * chose not to retry — the form stays open with everything they entered, so
   * a bad moment on the truck never costs a re-typed receipt.
   */
  onSubmit: (input: ReceiptDraftInput) => Promise<boolean>;
};

export function ReceiptFormModal({ visible, editing, onClose, onSubmit }: ReceiptFormModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Mounted fresh each time the modal opens, so its quantities always
          start from the draft being edited (or blank) instead of syncing via
          an effect — same pattern as CustomerFormModal. */}
      {visible && <ReceiptFormBody editing={editing} onClose={onClose} onSubmit={onSubmit} />}
    </Modal>
  );
}

type ReceiptFormBodyProps = Omit<ReceiptFormModalProps, 'visible'>;

function ReceiptFormBody({ editing, onClose, onSubmit }: ReceiptFormBodyProps) {
  const theme = useTheme();
  const { overlap, onBackdropLayout, scrollProps } = useKeyboardSheet();
  const { customers, loading: customersLoading, error: customersError } = useCustomers();
  const { breadTypes } = useBreadTypes();
  const { returnedBreadTypes, returnedBreadTypesLoading } = useReturnedBreadTypes();
  const stock = useStock();
  const customerScope = useCustomerScope(customers);
  const scopeToast = useToast();

  const [showReturns, setShowReturns] = useState((editing?.returns?.length ?? 0) > 0);
  const [customerId, setCustomerId] = useState<string | null>(editing?.customerId ?? null);
  const [itemQuantities, setItemQuantities] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const item of editing?.items ?? []) map[item.breadTypeId] = item.quantity;
    return map;
  });
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const line of editing?.returns ?? []) map[line.returnedBreadTypeId] = line.quantity;
    return map;
  });
  const [saving, setSaving] = useState(false);

  // The picker's list is exactly the current scope — nothing is forced into it.
  // A store from outside the run's crew (picked while "All stores" was on, or
  // carried by a draft opened for editing) is left out of the list under the
  // crew filter on purpose: it isn't a store for that crew. It stays the
  // selection, though — `pinnedSelection` below keeps the trigger showing it,
  // and switching to "crew" hides it from the list without unpicking it.
  const selectedCustomer = customers.find((c) => c.id === customerId);
  const customerOptions = customerScope.visibleCustomers;

  // The scope toggle is not a sticky setting. Every time the store picker opens
  // it snaps back to where the current selection sits: "All stores" only when a
  // store from outside this run's crew is already chosen — the one case the
  // crew filter would otherwise hide the current pick — and "crew" for anything
  // else, a fresh receipt with no selection included. So a picker session that
  // flicked to "All stores" to browse and then closed without choosing an
  // outside store doesn't leave the toggle flipped for the next receipt, while
  // re-opening on a store that really is outside the crew still shows it.
  const scopeForSelection: CustomerScope =
    selectedCustomer && selectedCustomer.agentGroupId !== customerScope.crewId ? 'all' : 'crew';

  function handleScopeChange(scope: 'crew' | 'all') {
    customerScope.setScope(scope);
    scopeToast.show(describeCustomerScope(scope, customerScope.crewName));
  }

  // Only bread types currently on the truck are sellable — plus, if editing a
  // draft, whatever it already has a quantity for even if stock has since run
  // out, so an existing line can still be seen and reduced (never increased
  // past what's actually on the truck).
  const eligibleBreadTypes = breadTypes.filter((breadType) => {
    const available = stock.displayStock[breadType.id] ?? 0;
    return available > 0 || (itemQuantities[breadType.id] ?? 0) > 0;
  });

  const items: ReceiptItem[] = breadTypes
    .filter((breadType) => (itemQuantities[breadType.id] ?? 0) > 0)
    .map((breadType) => ({
      breadTypeId: breadType.id,
      name: breadType.name,
      unitPrice: breadType.price,
      quantity: itemQuantities[breadType.id],
    }));

  const returns: ReceiptReturnItem[] = returnedBreadTypes
    .filter((returnedType) => (returnQuantities[returnedType.id] ?? 0) > 0)
    .map((returnedType) => ({
      returnedBreadTypeId: returnedType.id,
      name: returnedType.name,
      unitPrice: returnedType.price,
      quantity: returnQuantities[returnedType.id],
    }));

  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const returnsTotal = returns.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const total = subtotal - returnsTotal;

  // Lines asking for more than the truck holds. The stepper caps typing and
  // tapping at what's available, so this is only ever non-empty for a draft
  // that was written against a *different* load — a draft is not scoped to a
  // run, so one saved yesterday opens today against whatever is on board now.
  //
  // Shown rather than silently clamped: the quantity on screen is a number the
  // driver agreed with a store, and rewriting it behind their back is how a
  // delivery goes out short with nobody noticing. Save is blocked until they
  // lower it themselves, and every row that needs lowering says so.
  const overStock = items.filter((item) => item.quantity > (stock.displayStock[item.breadTypeId] ?? 0));

  const canSubmit = !!customerId && (items.length > 0 || returns.length > 0) && overStock.length === 0 && !saving;

  function setItemQuantity(breadTypeId: string, quantity: number) {
    setItemQuantities((current) => ({ ...current, [breadTypeId]: quantity }));
  }

  function setReturnQuantity(returnedBreadTypeId: string, quantity: number) {
    setReturnQuantities((current) => ({ ...current, [returnedBreadTypeId]: quantity }));
  }

  async function handleSubmit() {
    if (!canSubmit || !customerId) return;
    const customer = selectedCustomer;
    // The selected store is no longer in the list. Reachable rather than
    // paranoid: finishing truck setup pulls other phones' stores, and a
    // *deletion* made on another handset drops the row from this list the
    // moment it lands. The receipt copies the store's name and contact at save
    // time, so there is nothing to write.
    //
    // This used to be a bare `return` — the one shape of failure this app is
    // least willing to ship. The driver presses Save on a full receipt and
    // absolutely nothing happens: no message, no spinner, no closed modal, and
    // pressing harder doesn't help. Say it, and clear the selection so the
    // picker is the obvious next tap.
    if (!customer) {
      setCustomerId(null);
      notifyFailure(
        'That store is no longer on this phone',
        'It was removed while this receipt was open, so nothing was saved. Pick the store again — everything else you entered is still here.'
      );
      return;
    }

    setSaving(true);
    try {
      const saved = await onSubmit({
        customerId,
        customerName: customer.storeName,
        customerContactName: customer.name,
        items,
        returns,
      });
      if (saved) onClose();
    } catch (error) {
      // onSubmit reports its own failures, so this is only a guard against an
      // unexpected throw leaving the form stuck on "Saving…" with no message.
      logError('receiptForm.submit', error);
      notifyFailure('Could not save the receipt', describeError(error));
    } finally {
      setSaving(false);
    }
  }

  // The sheet stays put when the keyboard opens — same centred size and
  // position. The item list is given extra bottom padding (`overlap`) so it can
  // scroll far enough for the line being typed into to clear the keyboard, and
  // `useKeyboardSheet` scrolls that line up as the keyboard arrives. The totals
  // and action buttons below the list sit behind the keyboard while it is up.
  return (
    <View style={styles.backdrop} onLayout={onBackdropLayout}>
      {/* Deliberately no tap-to-close on the backdrop. A receipt is typed a
          line at a time with a keyboard up and the sheet taking most of the
          screen, so the dim strip around it is exactly where a thumb lands by
          accident — and losing a half-entered receipt to that costs the driver
          the whole thing again. Closing is the ✕ and Cancel, which are both on
          screen the entire time. Same rule in the other form sheets. */}
      <View style={styles.sheetWrapper}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={[styles.header, styles.sheetPadding]}>
            <ThemedText type="subtitle">{editing ? 'Edit draft' : 'New receipt'}</ThemedText>
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

          <View style={[styles.customerField, styles.sheetPadding]}>
            {/* The picker used to be handed the list and nothing else, so a
                store list that failed to read off this phone — or that never
                downloaded — looked exactly like a business with no stores:
                an empty sheet reading "Nothing here yet", while the Customers
                tab two taps away was showing the real error. All three states
                are the context's to report, so all three are passed on. */}
            <DropdownField
              label="Customer"
              placeholder="Select a customer"
              // Sorted by the customers context, which lifts a store added on
              // this phone in the last day to the front — the tag and the
              // position are one feature, so the driver finds the store they
              // just typed in without searching for it.
              options={customerOptions.map((c) => ({
                id: c.id,
                label: c.storeName,
                sublabel: c.name,
                badge: isNewCustomer(c) ? 'New' : undefined,
              }))}
              value={customerId}
              onChange={setCustomerId}
              // Keeps the trigger naming the chosen store even when the crew
              // filter is hiding it from the list (it's outside this crew).
              pinnedSelection={
                selectedCustomer
                  ? { id: selectedCustomer.id, label: selectedCustomer.storeName, sublabel: selectedCustomer.name }
                  : undefined
              }
              // The toggle isn't remembered between openings — it resets to
              // match the current selection each time the picker opens.
              onOpen={() => customerScope.setScope(scopeForSelection)}
              loading={customersLoading}
              errorText={customersError}
              emptyText="No stores on this phone. Finish truck setup to download them, or add one in the Customers tab."
              hideLabel
              searchable
              tall
              // A stray thumb on the dim edge shouldn't drop the driver back
              // to a half-typed receipt — the ✕ is the way out. Same rule as
              // the form sheets.
              closeOnBackdropPress={false}
              header={
                <CustomerScopeToggle
                  hasCrew={customerScope.hasCrew}
                  crewName={customerScope.crewName}
                  scope={customerScope.scope}
                  onChange={handleScopeChange}
                />
              }
              toast={<ScopeToast message={scopeToast.message} token={scopeToast.token} />}
            />
          </View>

          <ScrollView
            {...scrollProps}
            style={styles.fill}
            contentContainerStyle={[styles.list, styles.sheetPadding, { paddingBottom: Spacing.four + overlap }]}
            keyboardShouldPersistTaps="handled">
            <View style={[styles.sectionCard, { backgroundColor: theme.backgroundSuccess }]}>
              <View style={styles.sectionHeader}>
                <ThemedText type="smallBold" style={[styles.sectionHeaderText, { color: theme.success }]}>
                  Order items
                </ThemedText>
              </View>

              {eligibleBreadTypes.length === 0 ? (
                <ThemedText type="default" themeColor="textSecondary" style={styles.empty}>
                  Nothing in stock to sell. Finalize inventory or add a batch first.
                </ThemedText>
              ) : (
                // Plain mapped rows, not a nested FlatList — a VirtualizedList
                // inside the outer ScrollView re-runs its windowing/clipping on
                // every focus and scroll, which jumps the list. The catalog is
                // a few dozen rows at most, so there is nothing to virtualize.
                <View style={styles.sectionRows}>
                  {eligibleBreadTypes.map((breadType, index) => (
                    <OrderItemRow
                      key={breadType.id}
                      breadType={breadType}
                      available={stock.displayStock[breadType.id] ?? 0}
                      quantity={itemQuantities[breadType.id] ?? 0}
                      onChange={(quantity) => setItemQuantity(breadType.id, quantity)}
                      editable={!saving}
                      showDivider={index < eligibleBreadTypes.length - 1}
                    />
                  ))}
                </View>
              )}
            </View>

            <View style={[styles.sectionCard, { backgroundColor: theme.backgroundDanger }]}>
              <Pressable
                onPress={() => setShowReturns((current) => !current)}
                disabled={saving}
                style={({ pressed }) => [
                  styles.sectionHeader,
                  styles.returnsToggle,
                  showReturns && styles.returnsToggleOpen,
                  { opacity: saving ? 0.4 : pressed ? 0.7 : 1 },
                ]}>
                <ThemedText type="smallBold" style={[styles.sectionHeaderText, { color: theme.danger }]}>
                  {returns.length > 0 ? `Returns items (${returns.length})` : 'Returns items'}
                </ThemedText>
                <SymbolView
                  name={{
                    ios: showReturns ? 'chevron.up' : 'chevron.down',
                    android: showReturns ? 'expand_less' : 'expand_more',
                    web: showReturns ? 'expand_less' : 'expand_more',
                  }}
                  tintColor={theme.danger}
                  size={18}
                />
              </Pressable>

              {showReturns &&
                (returnedBreadTypesLoading && returnedBreadTypes.length === 0 ? (
                  <ThemedText type="default" themeColor="textSecondary" style={styles.empty}>
                    Loading…
                  </ThemedText>
                ) : returnedBreadTypes.length === 0 ? (
                  <ThemedText type="default" themeColor="textSecondary" style={styles.empty}>
                    No returned bread types yet. Add them from the dashboard first.
                  </ThemedText>
                ) : (
                  <View style={styles.sectionRows}>
                    {returnedBreadTypes.map((returnedType, index) => (
                      <ReturnItemRow
                        key={returnedType.id}
                        returnedBreadType={returnedType}
                        quantity={returnQuantities[returnedType.id] ?? 0}
                        onChange={(quantity) => setReturnQuantity(returnedType.id, quantity)}
                        editable={!saving}
                        showDivider={index < returnedBreadTypes.length - 1}
                      />
                    ))}
                  </View>
                ))}
            </View>
          </ScrollView>

          {/* A disabled Save with nothing explaining it is the failure this app
              refuses to ship (see handleSubmit's missing-store branch). The
              red row notes can be scrolled out of view; this line can't. */}
          {overStock.length > 0 && (
            <ThemedText type="small" themeColor="danger" style={[styles.overStockNotice, styles.sheetPadding]}>
              {overStock.length === 1
                ? `${overStock[0].name} is over what the truck is carrying. Lower it to save.`
                : `${overStock.length} items are over what the truck is carrying. Lower them to save.`}
            </ThemedText>
          )}

          <View style={[styles.totals, styles.sheetPadding, { borderColor: theme.border }]}>
            <TotalRow label="Subtotal" value={subtotal} />
            {returnsTotal > 0 && <TotalRow label="Return TotalM" value={-returnsTotal} />}
            <TotalRow label="Total" value={total} emphasize />
          </View>

          <View style={[styles.actions, styles.sheetPadding]}>
            <Pressable
              onPress={onClose}
              disabled={saving}
              style={({ pressed }) => [styles.cancelButton, { borderColor: theme.border, opacity: pressed ? 0.6 : 1 }]}>
              <ThemedText type="smallBold">Cancel</ThemedText>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.saveButton,
                { backgroundColor: theme.text, opacity: !canSubmit ? 0.4 : pressed ? 0.8 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.background }}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create draft'}
              </ThemedText>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function OrderItemRow({
  breadType,
  available,
  quantity,
  onChange,
  editable,
  showDivider,
}: {
  breadType: BreadType;
  available: number;
  quantity: number;
  onChange: (quantity: number) => void;
  editable: boolean;
  showDivider: boolean;
}) {
  const theme = useTheme();
  const over = quantity > available;

  return (
    <View style={[styles.row, showDivider ? { borderBottomWidth: 1.25, borderBottomColor: theme.border } : null]}>
      <View style={styles.leftColumn}>
        <ThemedText type="smallBold">{breadType.name}</ThemedText>
        <View style={styles.rowMeta}>
          <ThemedText type="small" themeColor={over ? 'danger' : 'textSecondary'}>
            {formatCount(available)} pcs
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            ₱{formatAmount(breadType.price)}
          </ThemedText>
        </View>
        {over && (
          <ThemedText type="small" themeColor="danger">
            Only {formatCount(available)} on the truck — lower this line to save.
          </ThemedText>
        )}
      </View>
      <View style={styles.rightColumn}>
        {/* Capped at what is on the truck, full stop. An existing line that is
            already over (a draft carried across runs) still renders its real
            quantity — the cap only applies to a change — so one tap on the
            minus button brings it down to what's available. */}
        <QuantityStepper value={quantity} onChange={onChange} editable={editable} max={available} />
      </View>
    </View>
  );
}

function ReturnItemRow({
  returnedBreadType,
  quantity,
  onChange,
  editable,
  showDivider,
}: {
  returnedBreadType: ReturnedBreadType;
  quantity: number;
  onChange: (quantity: number) => void;
  editable: boolean;
  showDivider: boolean;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.row, showDivider ? { borderBottomWidth: 1.25, borderBottomColor: theme.background } : null]}>
      <View style={styles.leftColumn}>
        <ThemedText type="smallBold">{returnedBreadType.name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          ₱{formatAmount(returnedBreadType.price)}
        </ThemedText>
      </View>
      <QuantityStepper value={quantity} onChange={onChange} editable={editable} />
    </View>
  );
}

function TotalRow({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  const theme = useTheme();
  const sign = value < 0 ? '-' : '';
  return (
    <View style={styles.totalRow}>
      <ThemedText type={emphasize ? 'smallBold' : 'small'} themeColor={emphasize ? undefined : 'textSecondary'}>
        {label}
      </ThemedText>
      <ThemedText
        type={emphasize ? 'smallBold' : 'small'}
        themeColor={emphasize ? undefined : 'textSecondary'}
        style={emphasize ? { color: value < 0 ? theme.danger : theme.text } : undefined}>
        {sign}₱{formatAmount(Math.abs(value))}
      </ThemedText>
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
    height: '90%',
  },
  sheet: {
    flex: 1,
    borderRadius: Spacing.four,
    paddingTop: Spacing.three,
    overflow: 'hidden',
  },
  // Everything that isn't a scrollable list gets this instead of the sheet
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
  customerField: {
    marginBottom: Spacing.four,
  },
  sectionCard: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.two,
  },
  // The toggle reaches out over the card's own padding (negative margin, the
  // same amount back as padding) so a tap anywhere on the red strip opens it,
  // not just a tap on the one line of text. Collapsed, it covers the whole card.
  returnsToggle: {
    margin: -Spacing.three,
    // Spelled out: sectionHeader's own marginBottom would beat the shorthand.
    marginBottom: -Spacing.three,
    padding: Spacing.three,
  },
  // Open, the bottom edge stops where the rows begin: no negative margin, and
  // only the usual header gap as padding.
  returnsToggleOpen: {
    marginBottom: 0,
    paddingBottom: Spacing.two,
  },
  sectionHeaderText: {
    fontSize: 18,
    lineHeight: 24,
  },
  sectionRows: {
    gap: Spacing.three,
  },
  empty: {
    textAlign: 'center',
  },
  overStockNotice: {
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  // Horizontal padding lives here (applied via a style array at the call
  // site) rather than on `sheet`, and deliberately not on `fill` either —
  // padding on the ScrollView's own box would still inset the scroll
  // indicator with it. Putting it on the content container pads what's
  // inside while leaving the ScrollView's frame — and so its indicator —
  // flush with the sheet.
  list: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingBottom: Spacing.two,
  },
  leftColumn: {
    flex: 1,
    gap: Spacing.half,
  },
  rightColumn: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 116,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  totals: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    gap: Spacing.half,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
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
