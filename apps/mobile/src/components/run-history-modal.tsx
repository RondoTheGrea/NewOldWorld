import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useBreadTypes } from '@/context/bread-types';
import { useReturnedBreadTypes } from '@/context/returned-bread-types';
import { useRunHistory, type RunHistoryEntry, type RunHistorySummary } from '@/context/run-history';
import { useTheme } from '@/hooks/use-theme';
import { formatDeviceDate, formatDeviceDateTime, formatDeviceTime } from '@/lib/device-time';
import { formatAmount, formatCount } from '@/lib/money';
import type { RunHistoryLineItem, RunHistoryMoneyLineItem } from '@/lib/run-history-types';
import { buildOutcomeRows } from '@/lib/run-outcome';

/**
 * Past runs, kept on this phone only, so a trucker can see how much bread
 * moved on any trip that's already ended — see lib/run-history-types.ts.
 *
 * Two levels in one modal, the same shape as ExpensesModal: a list of
 * finished runs, and tapping one loads its full breakdown in place. Nothing
 * here is editable — it's a read-only local record, never uploaded.
 */
export function RunHistoryModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Mounted fresh each time, so the list is re-read from disk every open —
          this is the only signal the modal gets that "End the Day" may have
          written a new row since it last opened (see context/run-history.tsx). */}
      {visible && <RunHistoryBody onClose={onClose} />}
    </Modal>
  );
}


function RunHistoryBody({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const { summaries, loading, error, reload, loadDetail } = useRunHistory();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunHistoryEntry | null>(null);
  // Which run `detail` actually belongs to — the same masking pattern
  // context/expenses.tsx uses for `loadedRunId`, so switching to a different
  // run never renders the previous one's numbers under its name for a beat
  // while the new fetch is in flight.
  const [detailRunId, setDetailRunId] = useState<string | null>(null);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount; the modal is remounted fresh each open
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    loadDetail(selectedRunId).then((entry) => {
      if (cancelled) return;
      setDetail(entry);
      setDetailRunId(selectedRunId);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch keyed on the selected run id only
  }, [selectedRunId]);

  const detailLoading = selectedRunId !== null && detailRunId !== selectedRunId;
  const visibleDetail = detailRunId !== null && detailRunId === selectedRunId ? detail : null;

  function handleClose() {
    setSelectedRunId(null);
    onClose();
  }

  const selectedSummary = summaries.find((run) => run.runId === selectedRunId) ?? null;

  return (
    <View style={styles.backdrop}>
      {/* Keep tap-to-close behind the sheet so the details ScrollView owns
          pointer and wheel gestures inside the modal. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
      <View style={styles.sheetWrapper}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={styles.header}>
            {selectedRunId ? (
              <Pressable
                onPress={() => setSelectedRunId(null)}
                accessibilityRole="button"
                accessibilityLabel="Back to run list"
                hitSlop={Spacing.two}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                <SymbolView name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }} tintColor={theme.text} size={22} />
              </Pressable>
            ) : null}
            <ThemedText type="subtitle" style={styles.title}>
              {selectedRunId ? 'Run details' : 'Run history'}
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

          {/* Said on both screens: it's the whole point of the feature, and a
              trucker may only ever see one or the other. */}
          <ThemedText type="small" themeColor="textSecondary" style={styles.hidden}>
            Kept on this phone only — never sent to the server.
          </ThemedText>

          {selectedRunId ? (
            <RunDetailView summary={selectedSummary} detail={visibleDetail} loading={detailLoading} />
          ) : (
            <RunListView summaries={summaries} loading={loading} error={error} onReload={reload} onSelect={setSelectedRunId} />
          )}
        </View>
      </View>
    </View>
  );
}

function RunListView({
  summaries,
  loading,
  error,
  onReload,
  onSelect,
}: {
  summaries: RunHistorySummary[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onSelect: (runId: string) => void;
}) {
  const theme = useTheme();

  if (error) {
    return (
      <View style={styles.empty}>
        <ThemedText type="small" style={{ color: theme.danger }}>
          {error}
        </ThemedText>
        <Pressable
          onPress={onReload}
          accessibilityRole="button"
          style={({ pressed }) => [styles.outlineButton, { borderColor: theme.textSecondary, opacity: pressed ? 0.7 : 1 }]}>
          <ThemedText type="smallBold">Try again</ThemedText>
        </Pressable>
      </View>
    );
  }

  if (loading) {
    return (
      <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
        Loading…
      </ThemedText>
    );
  }

  if (summaries.length === 0) {
    return (
      <View style={styles.empty}>
        <ThemedText type="small" themeColor="textSecondary">
          No finished runs yet. A run is added here once “End the day” closes it.
        </ThemedText>
      </View>
    );
  }

  return (
    // A windowed FlatList, not a ScrollView + map — the same reasoning as
    // InventoryHistoryModal: this list has no natural cap (unlike Expenses,
    // scoped to one run), so it grows for the life of the app, a run or two a
    // day, and only the rows near the viewport should ever be mounted.
    <FlatList
      style={styles.fill}
      contentContainerStyle={styles.list}
      data={summaries}
      keyExtractor={(run) => run.runId}
      // Same tuning as inventory-stock-modal.tsx's FlatList: rows are simple
      // enough to render 20 at a time, and removeClippedSubviews is guarded to
      // native only — react-native-web has known bugs where clipped rows fail
      // to come back while scrolling, so it's left off there.
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={7}
      removeClippedSubviews={Platform.OS !== 'web'}
      renderItem={({ item: run }) => (
        <Pressable
          onPress={() => onSelect(run.runId)}
          style={({ pressed }) => [
            styles.runRow,
            { borderColor: theme.border, backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement },
          ]}>
          <View style={styles.runRowText}>
            <ThemedText type="smallBold">
              {run.truckName} · {run.areaName}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">{run.businessDay}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {formatCount(run.receiptCount)} {run.receiptCount === 1 ? 'receipt' : 'receipts'}
            </ThemedText>
          </View>
          <View style={styles.runRowMoney}>
            <ThemedText type="smallBold">₱{formatAmount(run.salesTotal - run.returnsTotal)}</ThemedText>
            <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} tintColor={theme.textSecondary} size={16} />
          </View>
        </Pressable>
      )}
    />
  );
}

function RunDetailView({
  summary,
  detail,
  loading,
}: {
  summary: RunHistorySummary | null;
  detail: RunHistoryEntry | null;
  loading: boolean;
}) {
  if (loading || !detail || !summary) {
    return (
      <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
        Loading…
      </ThemedText>
    );
  }

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.detailList}>
      <View style={styles.detailHeader}>
        <ThemedText type="smallBold">
          {detail.truckName} · {detail.areaName}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">{detail.businessDay}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Started {formatDeviceDateTime(detail.startedAt)} · Ended {formatDeviceDateTime(detail.closedAt)}
        </ThemedText>
      </View>

      <MoneySection detail={detail} />
      <InventoryTable
        initial={detail.initial}
        initialCreatedAt={detail.initialCreatedAt}
        batches={detail.additions}
        total={detail.totalInventory}
      />
      <RunOutcomeTable total={detail.totalInventory} sold={detail.sold} returned={detail.returned} />
      {/* The crew and its members, both named. The crew is what was assigned;
          the names are who it held that day, which stays true even after
          somebody is moved to another crew on the dashboard. */}
      <View style={styles.assignedAgents}>
        <ThemedText type="smallBold">Crew</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {detail.agentGroupName || 'No crew recorded'}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {detail.agentNames.length > 0 ? detail.agentNames.join(', ') : 'No agents recorded'}
        </ThemedText>
      </View>
    </ScrollView>
  );
}

type QuantityItem = RunHistoryLineItem | RunHistoryMoneyLineItem;

function quantitiesByBreadType(items: QuantityItem[]) {
  return new Map(items.map((item) => [item.breadTypeId, item.quantity]));
}

function namesByBreadType(groups: QuantityItem[][]) {
  const names = new Map<string, string>();
  groups.forEach((items) => {
    items.forEach((item) => names.set(item.breadTypeId, item.name));
  });
  return names;
}

/**
 * Row order for the Inventory table: the bread catalog's own manual order —
 * the same sequence the Inventory tab, the Add batch modal and the dashboard
 * list bread in — so a trucker reads down this table and the truck the same
 * way.
 *
 * Ordered here rather than in the saved snapshot (lib/run-history.ts sorts its
 * lines by name) so runs that ended before the catalog was reordered — or
 * before this existed — still read in today's order.
 *
 * Every inventory line has a real `breadTypeId`, so the id lookup answers
 * almost always; the name lookup is the fallback for a line whose bread type
 * has since been deleted and re-created. Anything the catalog no longer holds
 * sorts after everything it does, alphabetically among itself.
 *
 * The Run outcome table can't be ordered this way — it folds returns in, and
 * a returned line's id belongs to a different catalog entirely. It orders
 * itself by name; see `buildOutcomeRows`.
 */
function useBreadTypeRank() {
  const { breadTypes } = useBreadTypes();
  return useMemo(() => {
    const byId = new Map<string, number>();
    const byName = new Map<string, number>();
    breadTypes.forEach((type, index) => {
      byId.set(type.id, index);
      if (!byName.has(type.name)) byName.set(type.name, index);
    });
    return (id: string, name: string) => byId.get(id) ?? byName.get(name) ?? Infinity;
  }, [breadTypes]);
}

/**
 * `Infinity - Infinity` is `NaN`, which is falsy, so two uncatalogued rows
 * fall through to the name comparison rather than to an unstable sort.
 */
function orderRows(names: Map<string, string>, rank: (id: string, name: string) => number) {
  return Array.from(names).sort(
    ([aId, aName], [bId, bName]) => rank(aId, aName) - rank(bId, bName) || aName.localeCompare(bName)
  );
}

/** A load's date and time as two heading lines, or a dash when it isn't known. */
function loadedAtLines(timestamp: number | null): string[] {
  return timestamp === null ? ['—'] : [formatDeviceDate(timestamp), formatDeviceTime(timestamp)];
}

function InventoryTable({
  initial,
  initialCreatedAt,
  batches: savedBatches,
  total,
}: {
  initial: RunHistoryLineItem[];
  initialCreatedAt: number | null;
  batches: RunHistoryEntry['additions'];
  total: RunHistoryLineItem[];
}) {
  const theme = useTheme();
  const rank = useBreadTypeRank();
  // Hidden until asked for — one tap shows when each load went on, one more
  // hides it. Starts hidden every time a run is opened.
  const [showTimes, setShowTimes] = useState(false);
  // The snapshot stores additions newest first (lib/run-history.ts). Read left
  // to right, Batch 1 should be the first top-up, as on the dashboard — which
  // matters once the times are on screen beside the labels.
  const batches = [...savedBatches].sort((a, b) => a.createdAt - b.createdAt);
  const batchItems = batches.map((batch) => batch.items);
  const names = namesByBreadType([initial, ...batchItems, total]);
  const rows = orderRows(names, rank);
  const initialQuantities = quantitiesByBreadType(initial);
  const batchQuantities = batchItems.map(quantitiesByBreadType);
  const totalQuantities = quantitiesByBreadType(total);

  return (
    <View style={styles.tableSection}>
      <View style={styles.inventoryHeading}>
        <ThemedText type="smallBold">Inventory</ThemedText>
        <Pressable
          onPress={() => setShowTimes((shown) => !shown)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showTimes }}
          hitSlop={Spacing.two}
          style={({ pressed }) => [styles.timesToggle, { opacity: pressed ? 0.6 : 1 }]}>
          <ThemedText type="smallBold" style={{ color: theme.accent }}>
            {showTimes ? 'Hide dates & times' : 'Show dates & times'}
          </ThemedText>
          <SymbolView
            name={
              showTimes
                ? { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' }
                : { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }
            }
            tintColor={theme.accent}
            size={16}
          />
        </Pressable>
      </View>
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tableScrollContent}>
        <View style={styles.table}>
          <View style={[styles.tableRow, styles.tableHeaderRow]}>
            <TableCell label="Bread" header first />
            <TableCell label="Initial" header sublines={showTimes ? loadedAtLines(initialCreatedAt) : undefined} />
            {batches.map((batch, index) => (
              <TableCell
                key={batch.id}
                label={`Batch ${index + 1}`}
                header
                sublines={showTimes ? loadedAtLines(batch.createdAt) : undefined}
              />
            ))}
            <TableCell label="Total" header />
          </View>
          {rows.map(([id, name]) => (
            <View key={id} style={styles.tableRow}>
              <TableCell label={name} first />
              <TableCell label={String(initialQuantities.get(id) ?? 0)} />
              {batchQuantities.map((quantities, index) => (
                <TableCell key={`${id}-${index}`} label={String(quantities.get(id) ?? 0)} />
              ))}
              <TableCell label={String(totalQuantities.get(id) ?? 0)} emphasize />
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function RunOutcomeTable({
  total,
  sold,
  returned,
}: {
  total: RunHistoryLineItem[];
  sold: RunHistoryMoneyLineItem[];
  returned: RunHistoryMoneyLineItem[];
}) {
  const { breadTypes } = useBreadTypes();
  const { returnedBreadTypes } = useReturnedBreadTypes();
  // Folded together by name, because a return carries an id from the
  // returnedBreadTypes catalog that can never match a bread type's — see
  // buildOutcomeRows. The dashboard's Outcome tab is built by the same rules.
  const rows = useMemo(
    () => buildOutcomeRows({ total, sold, returned, breadTypes, returnedBreadTypes }),
    [total, sold, returned, breadTypes, returnedBreadTypes]
  );

  return (
    <View style={styles.tableSection}>
      <ThemedText type="smallBold">Run outcome</ThemedText>
      <ScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tableScrollContent}>
        <View style={styles.table}>
          <View style={[styles.tableRow, styles.tableHeaderRow]}>
            <TableCell label="Bread" header first />
            <TableCell label="Sold" header />
            <TableCell label="Returned" header />
            <TableCell label="Remaining" header />
          </View>
          {rows.map((row) => (
            <View key={row.name} style={styles.tableRow}>
              <TableCell label={row.name} first />
              <TableCell label={String(row.sold)} />
              <TableCell label={String(row.returned)} />
              <TableCell label={String(row.remaining)} emphasize />
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function TableCell({
  label,
  header = false,
  first = false,
  emphasize = false,
  sublines,
}: {
  label: string;
  header?: boolean;
  first?: boolean;
  emphasize?: boolean;
  /** Extra lines under the label, one per line — the Inventory table's load times. */
  sublines?: string[];
}) {
  const theme = useTheme();
  return (
    <View style={[styles.tableCell, first && styles.tableFirstCell, { borderColor: theme.border }]}>
      <ThemedText
        type={header || emphasize ? 'smallBold' : 'small'}
        numberOfLines={first ? undefined : 1}
        themeColor={header ? 'textSecondary' : undefined}>
        {label}
      </ThemedText>
      {sublines?.map((line, index) => (
        <ThemedText key={index} type="small" themeColor="textSecondary" numberOfLines={1}>
          {line}
        </ThemedText>
      ))}
    </View>
  );
}

// The former card-per-section renderers are kept below temporarily while the
// table layout rolls out, but are not part of the detail screen any more.
void LineItemSection;
void MoneyLineItemSection;
void BatchSection;

function MoneySection({ detail }: { detail: RunHistoryEntry }) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold">Collected</ThemedText>
      <MoneyRow label="Cash" value={detail.money.cash} />
      <MoneyRow label="GCash" value={detail.money.gcash} />
      <MoneyRow label="Cheque" value={detail.money.cheque} />
      <MoneyRow label="Partial total" value={detail.money.partial} />
      <MoneyRow label="Partial paid" value={detail.money.partialPaid} />
      <MoneyRow label="Credit" value={detail.money.credit} />
      <ThemedText type="small" themeColor="textSecondary" style={[styles.moneyNote, styles.hidden]}>
        Credit receipts aren’t counted — nothing is collected for those yet.
      </ThemedText>
    </View>
  );
}

function MoneyRow({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <View style={styles.moneyRow}>
      <ThemedText type={emphasize ? 'smallBold' : 'small'} themeColor={emphasize ? undefined : 'textSecondary'}>
        {label}
      </ThemedText>
      <ThemedText type={emphasize ? 'smallBold' : 'small'}>₱{formatAmount(value)}</ThemedText>
    </View>
  );
}

function LineItemSection({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: RunHistoryLineItem[];
  emptyLabel: string;
}) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold">{title}</ThemedText>
      {items.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          {emptyLabel}
        </ThemedText>
      ) : (
        items.map((item) => (
          <View key={item.breadTypeId} style={styles.itemRow}>
            <ThemedText type="small">{item.name}</ThemedText>
            <ThemedText type="smallBold">{formatCount(item.quantity)} pcs</ThemedText>
          </View>
        ))
      )}
    </View>
  );
}

function MoneyLineItemSection({
  title,
  items,
  emptyLabel,
  tint,
}: {
  title: string;
  items: RunHistoryMoneyLineItem[];
  emptyLabel: string;
  tint: string;
}) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold">{title}</ThemedText>
      {items.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          {emptyLabel}
        </ThemedText>
      ) : (
        items.map((item) => (
          <View key={item.breadTypeId} style={styles.itemRow}>
            <ThemedText type="small">{item.name}</ThemedText>
            <View style={styles.itemRowMoney}>
              <ThemedText type="smallBold" style={{ color: tint }}>
                {formatCount(item.quantity)} pcs
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                ₱{formatAmount(item.amount)}
              </ThemedText>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function BatchSection({ batches }: { batches: RunHistoryEntry['additions'] }) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold">Batches added</ThemedText>
      {batches.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          No batches added after the initial count.
        </ThemedText>
      ) : (
        batches.map((batch) => (
          <View key={batch.id} style={styles.batch}>
            <ThemedText type="small" themeColor="textSecondary">
              {formatDeviceDateTime(batch.createdAt)}
            </ThemedText>
            {batch.items.map((item) => (
              <View key={item.breadTypeId} style={styles.itemRow}>
                <ThemedText type="small">{item.name}</ThemedText>
                <ThemedText type="smallBold">+{formatCount(item.quantity)} pcs</ThemedText>
              </View>
            ))}
          </View>
        ))
      )}
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
    gap: Spacing.two,
  },
  title: {
    flex: 1,
  },
  list: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  detailList: {
    paddingVertical: Spacing.two,
  },
  empty: {
    gap: Spacing.two,
    alignItems: 'flex-start',
    paddingVertical: Spacing.two,
  },
  outlineButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  runRowText: {
    flex: 1,
    gap: Spacing.half,
  },
  runRowMoney: {
    alignItems: 'flex-end',
    gap: Spacing.one,
  },
  detailHeader: {
    gap: Spacing.one,
    paddingVertical: Spacing.three,
  },
  section: {
    paddingVertical: Spacing.three,
    gap: Spacing.one,
  },
  tableSection: {
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  tableScrollContent: {
    paddingRight: Spacing.four,
  },
  inventoryHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  timesToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tableHeaderRow: {
    backgroundColor: 'rgba(127, 127, 127, 0.12)',
  },
  tableCell: {
    width: 88,
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  tableFirstCell: {
    width: 150,
    alignItems: 'flex-start',
    borderLeftWidth: 0,
  },
  assignedAgents: {
    paddingVertical: Spacing.three,
    gap: Spacing.one,
  },
  hidden: {
    display: 'none',
  },
  moneyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  moneyNote: {
    marginTop: Spacing.half,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.one,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itemRowMoney: {
    alignItems: 'flex-end',
  },
  batch: {
    gap: Spacing.half,
    paddingVertical: Spacing.one,
  },
});
