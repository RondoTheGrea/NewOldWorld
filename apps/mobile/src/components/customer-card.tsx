import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { Badge } from '@/components/badge';
import { ThemedText } from '@/components/themed-text';
import { CustomerIcons } from '@/constants/customer-icons';
import { isNewCustomer, type Customer } from '@/context/customers';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type CustomerCardProps = {
  customer: Customer;
  onPress: () => void;
};

// A fixed height, tall enough for the worst case (a long schedule wrapping to
// 2 lines, plus the address) with icons stacked above
// their text — that stacking costs more vertical room per row than
// side-by-side did, which is why this is taller than it looks like it needs
// to be for a short card.
const CARD_HEIGHT = 220;
const META_ICON_SIZE = 19;

export function CustomerCard({ customer, onPress }: CustomerCardProps) {
  const theme = useTheme();
  const scheduleLabel = customer.schedule || 'No schedule set';

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border, opacity: pressed ? 0.7 : 1 },
      ]}>
      <View style={styles.storeRow}>
        <ThemedText style={styles.storeName} numberOfLines={1}>
          {customer.storeName}
        </ThemedText>
        {/* Only for a store this phone added in the last day. The card is
            fixed-height, so this rides on the store name's own line rather
            than adding a row that would eat into the meta list below. */}
        {isNewCustomer(customer) && <Badge label="New" />}
      </View>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
        {customer.name}
      </ThemedText>

      <View style={[styles.divider, { backgroundColor: theme.textSecondary }]} />

      <View style={styles.meta}>
        <MetaRow icon={CustomerIcons.schedule} text={scheduleLabel} lines={2} />
        {!!customer.address && <MetaRow icon={CustomerIcons.address} text={customer.address} lines={1} />}
      </View>
    </Pressable>
  );
}

function MetaRow({ icon, text, lines }: { icon: SymbolViewProps['name']; text: string; lines: number }) {
  const theme = useTheme();
  return (
    <View style={styles.metaRow}>
      <SymbolView name={icon} tintColor={theme.text} size={META_ICON_SIZE} />
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={lines}>
        {text}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    height: CARD_HEIGHT,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  storeName: {
    // Shrinkable, so a long store name truncates instead of pushing the "New"
    // tag off the edge of a card that is only half the screen wide.
    flexShrink: 1,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: 700,
  },
  divider: {
    height: 2,
    marginVertical: Spacing.two,
  },
  meta: {
    gap: Spacing.two,
  },
  metaRow: {
    flexDirection: 'column',
    // 'stretch' (not 'flex-start') so the text gets the row's full width to
    // wrap/truncate against — without a definite width, numberOfLines'
    // ellipsis has nothing to measure against and text can render at its
    // full natural width instead of clipping with "…".
    alignItems: 'stretch',
    gap: Spacing.half,
  },
});
