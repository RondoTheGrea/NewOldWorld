import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * A small filled pill sitting next to a title — currently only the "New" tag
 * on a store the driver just added (see `isNewCustomer` in
 * lib/customer-types.ts).
 *
 * One component rather than a pill styled twice, because the tag appears in two
 * places that a driver reads within seconds of each other: the Customers tab's
 * cards and the receipt form's store picker. Two slightly different pills would
 * read as two different things.
 *
 * `flexShrink: 0` is the load-bearing part. It sits beside a store name that is
 * allowed to be long and truncates with an ellipsis, on a card less than half
 * the screen wide — without it the pill is what gets squeezed, and the tag ends
 * up as a sliver of blue with no word in it.
 */
export function Badge({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: theme.accent }]}>
      <ThemedText style={[styles.text, { color: theme.background }]}>{label}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexShrink: 0,
    borderRadius: Spacing.one,
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.half / 2,
  },
  text: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
  },
});
