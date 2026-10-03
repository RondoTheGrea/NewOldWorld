import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useBreadTypes } from '@/context/bread-types';
import { useBusinessSettings } from '@/context/business-settings';
import { useReturnedBreadTypes } from '@/context/returned-bread-types';
import { useTheme } from '@/hooks/use-theme';
import { combineCatalogSources, describeCatalogSource } from '@/lib/catalog-source';

/**
 * The strip along the bottom of the Inventory tab that answers one question:
 * "are the prices on this screen what the dashboard says right now, or a copy
 * saved on this phone?" — and when either was last true.
 *
 * It is a read-only label: one combined line across all three dashboard-owned
 * catalogs, with no tap-to-expand breakdown and no "Update" action. Combining
 * takes the worst kind, so it can never overstate how current the data is —
 * see lib/catalog-source.ts.
 *
 * It sits *outside* <Screen>, as a sibling above the tab bar, so it stays
 * pinned while the inventory list scrolls. It is only rendered once that list
 * is showing — not during loading or truck setup, where nothing on screen is
 * priced from these catalogs yet (see src/app/(app)/inventory.tsx).
 */
export function CatalogSourceIndicator() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { breadTypesSource, breadTypesLoading } = useBreadTypes();
  const { returnedBreadTypesSource, returnedBreadTypesLoading } = useReturnedBreadTypes();
  const { businessSettingsSource, businessSettingsLoading } = useBusinessSettings();

  const combined = combineCatalogSources([breadTypesSource, returnedBreadTypesSource, businessSettingsSource]);
  // Each *Loading flag is already "downloading and nothing to show yet", so
  // this is the app-just-opened window — say so rather than accusing the
  // device of never having downloaded anything.
  const firstLoad = breadTypesLoading || returnedBreadTypesLoading || businessSettingsLoading;
  // Grey while that's still in flight — a dot rather than a spinner keeps the
  // row exactly the same width, so the text doesn't jump when it resolves.
  const dotColor = firstLoad
    ? theme.textSecondary
    : combined.kind === 'fresh'
      ? theme.success
      : combined.kind === 'cache'
        ? theme.warning
        : theme.danger;

  const summaryText = firstLoad ? 'Checking for updates…' : describeCatalogSource(combined);

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.background,
          borderTopColor: theme.border,
          paddingLeft: insets.left + Spacing.four,
          paddingRight: insets.right + Spacing.four,
        },
      ]}>
      <View style={styles.content}>
        <View style={styles.summary} accessibilityLabel={`Data source: ${summaryText}`}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.summaryLabel}>
            {summaryText}
          </ThemedText>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.two,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  summaryLabel: {
    flexShrink: 1,
  },
});
