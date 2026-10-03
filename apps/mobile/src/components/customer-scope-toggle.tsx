import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { type CustomerScope } from '@/lib/customer-scope';

type CustomerScopeToggleProps = {
  hasCrew: boolean;
  crewName: string | null;
  scope: CustomerScope;
  onChange: (scope: CustomerScope) => void;
};

/**
 * Switches a store list between "this run's crew" and "every store on the
 * phone" — the Customers tab and the receipt form's store picker both use
 * one of these, backed by `hooks/use-customer-scope.ts`.
 *
 * Only meaningful once a run is open: a crew is what the filter is *of*, so
 * with none open this renders a plain note instead of a control with nothing
 * to switch between — the note says so explicitly rather than the screen
 * silently showing every store with no explanation.
 */
export function CustomerScopeToggle({ hasCrew, crewName, scope, onChange }: CustomerScopeToggleProps) {
  const theme = useTheme();

  if (!hasCrew) {
    // The info glyph used to be a separate SymbolView beside the text, and a
    // narrow row (the receipt picker's header, in particular) squeezed the
    // icon down to nothing before wrapping the text — a fixed-size sibling
    // in a row that has to shrink loses the fight. Folding it into the
    // string keeps it inside the same wrapping paragraph, so it can never be
    // clipped independently of the words next to it.
    return (
      <ThemedText type="small" themeColor="textSecondary">
        ⓘ Showing stores from every crew. Finish truck setup to filter by your assigned crew.
      </ThemedText>
    );
  }

  return (
    <View style={[styles.track, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
      <SegmentButton label={crewName || 'My crew'} active={scope === 'crew'} onPress={() => onChange('crew')} />
      <SegmentButton label="All stores" active={scope === 'all'} onPress={() => onChange('all')} />
    </View>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={active}
      style={({ pressed }) => [
        styles.segment,
        { backgroundColor: active ? theme.text : 'transparent', opacity: !active && pressed ? 0.6 : 1 },
      ]}>
      {/* Fills the segment (via the parent's default `stretch`) and centres
          with `textAlign`, rather than shrink-wrapping under `alignItems:
          'center'` — a shrink-wrapped label has no width for `numberOfLines`
          to truncate against, so a long crew name overflows instead of
          ending in an ellipsis. */}
      <ThemedText
        type="smallBold"
        numberOfLines={1}
        style={[styles.segmentLabel, { color: active ? theme.background : theme.text }]}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    // No `alignItems: 'center'` — see the label comment above. Horizontal
    // padding keeps a truncated label off the segment's rounded edge.
    borderRadius: Spacing.two - 3,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.one,
    justifyContent: 'center',
  },
  segmentLabel: {
    textAlign: 'center',
  },
});
