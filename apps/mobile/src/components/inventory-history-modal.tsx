import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { type BreadType } from '@/context/bread-types';
import { type Batch } from '@/context/stock';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDeviceDateTime } from '@/lib/device-time';

type InventoryHistoryModalProps = {
  visible: boolean;
  batches: Batch[];
  breadTypes: BreadType[];
  onClose: () => void;
};

/** Above this many pages the dot row is replaced by an "n of m" counter. */
const MaxDots = 12;


export function InventoryHistoryModal({ visible, batches, breadTypes, onClose }: InventoryHistoryModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {visible && <InventoryHistoryModalBody batches={batches} breadTypes={breadTypes} onClose={onClose} />}
    </Modal>
  );
}

function InventoryHistoryModalBody({
  batches,
  breadTypes,
  onClose,
}: Omit<InventoryHistoryModalProps, 'visible'>) {
  const theme = useTheme();
  const breadTypeById = new Map(breadTypes.map((breadType) => [breadType.id, breadType]));
  const [pageWidth, setPageWidth] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const listRef = useRef<FlatList<Batch>>(null);

  function goToPage(index: number) {
    const clamped = Math.max(0, Math.min(index, batches.length - 1));
    listRef.current?.scrollToIndex({ index: clamped, animated: true });
    setPageIndex(clamped);
  }

  function handleMomentumScrollEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    if (pageWidth === 0) return;
    setPageIndex(Math.round(event.nativeEvent.contentOffset.x / pageWidth));
  }

  return (
    <View style={styles.backdrop}>
      {/* Keep backdrop tap-to-close behind the sheet so scroll gestures
          inside the sheet stay with its ScrollViews. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.sheetWrapper}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={styles.header}>
            <ThemedText type="subtitle">Inventory history</ThemedText>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={Spacing.two}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={theme.text} size={24} />
            </Pressable>
          </View>

          <View style={styles.pager} onLayout={(e) => setPageWidth(e.nativeEvent.layout.width)}>
            {/* A FlatList, not a plain horizontal ScrollView: every batch used
                to be mounted at once, each with its own nested ScrollView, so
                opening this modal after a few hundred restocks meant building
                the entire history before the first page could be shown. Only
                the pages either side of the current one are mounted now. */}
            {pageWidth > 0 && (
              <FlatList
                ref={listRef}
                data={batches}
                keyExtractor={(batch) => batch.id}
                horizontal
                pagingEnabled
                nestedScrollEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={handleMomentumScrollEnd}
                // Pages are exactly one screen wide, so their positions are
                // known without measuring — this is what lets the arrow
                // buttons jump straight to a page that isn't mounted yet.
                getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
                initialNumToRender={1}
                maxToRenderPerBatch={2}
                windowSize={3}
                removeClippedSubviews={Platform.OS !== 'web'}
                renderItem={({ item: batch }) => (
                  <View style={[styles.page, { width: pageWidth }]}>
                    <ThemedText type="smallBold">
                      {batch.kind === 'initial' ? 'Initial inventory' : 'Batch added'}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.pageDate}>
                      {formatDeviceDateTime(batch.createdAt)}
                    </ThemedText>
                    <ScrollView style={styles.pageList} contentContainerStyle={styles.pageListContent} nestedScrollEnabled>
                      {batch.items.length === 0 ? (
                        <ThemedText type="default" themeColor="textSecondary">
                          Nothing recorded in this batch.
                        </ThemedText>
                      ) : (
                        batch.items.map((item) => {
                          const breadType = breadTypeById.get(item.breadTypeId);
                          return (
                            <View key={item.breadTypeId} style={styles.itemRow}>
                              <ThemedText type="default">{breadType?.name ?? 'Unknown bread type'}</ThemedText>
                              <ThemedText type="smallBold">
                                {batch.kind === 'addition' ? `+${item.quantity}` : item.quantity} pcs
                              </ThemedText>
                            </View>
                          );
                        })
                      )}
                    </ScrollView>
                  </View>
                )}
              />
            )}
          </View>

          <View style={styles.pagerControls}>
            <Pressable
              onPress={() => goToPage(pageIndex - 1)}
              disabled={pageIndex <= 0}
              hitSlop={Spacing.two}
              style={({ pressed }) => ({ opacity: pageIndex <= 0 ? 0.3 : pressed ? 0.6 : 1 })}>
              <SymbolView name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }} tintColor={theme.text} size={22} />
            </Pressable>
            {/* A dot per page only while they're still countable at a glance.
                Past that they stop being a position indicator and become a
                grey smear — and one node per batch to build besides — so a
                plain counter takes over. */}
            {batches.length <= MaxDots ? (
              <View style={styles.dots}>
                {batches.map((batch, index) => (
                  <View
                    key={batch.id}
                    style={[
                      styles.dot,
                      { backgroundColor: index === pageIndex ? theme.text : theme.border },
                    ]}
                  />
                ))}
              </View>
            ) : (
              <ThemedText type="small" themeColor="textSecondary">
                {pageIndex + 1} of {batches.length}
              </ThemedText>
            )}
            <Pressable
              onPress={() => goToPage(pageIndex + 1)}
              disabled={pageIndex >= batches.length - 1}
              hitSlop={Spacing.two}
              style={({ pressed }) => ({ opacity: pageIndex >= batches.length - 1 ? 0.3 : pressed ? 0.6 : 1 })}>
              <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} tintColor={theme.text} size={22} />
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
  },
  pager: {
    flex: 1,
  },
  page: {
    // Each swiped page must fill the pager so its nested ScrollView has a
    // bounded viewport to scroll within, rather than growing with its rows.
    flex: 1,
    paddingBottom: Spacing.three,
  },
  pageDate: {
    marginBottom: Spacing.three,
  },
  pageList: {
    flex: 1,
  },
  pageListContent: {
    gap: Spacing.two,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pagerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    marginVertical: Spacing.three,
  },
  dots: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
