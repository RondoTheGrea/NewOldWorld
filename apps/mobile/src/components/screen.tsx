import { type PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ScreenProps = PropsWithChildren<{
  /**
   * Turn on for content that can grow taller than the screen (product lists,
   * receipt history, long forms). The content then scrolls *inside* the area
   * above the tab bar, so the last row is never stuck underneath it.
   */
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}>;

/**
 * The frame every tab screen sits in.
 *
 * Why screens don't add their own bottom spacing: the tab bar is a sibling of
 * the screen, not a floating overlay. The navigator measures the bar (its
 * height already includes the phone's bottom safe-area inset) and hands the
 * screen only the space that's left. So a screen is *already* sized to stop
 * where the tab bar starts, and anything that overflows scrolls within that
 * area. Adding a bottom inset here would just leave a second empty gap.
 *
 * The top and side insets are ours to claim, because the tab navigator's own
 * header is turned off — see src/app/(app)/_layout.tsx.
 */
export function Screen({ children, scroll = false, style }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const frame = {
    paddingTop: insets.top + Spacing.three,
    paddingLeft: insets.left + Spacing.four,
    paddingRight: insets.right + Spacing.four,
  };

  if (scroll) {
    return (
      <ScrollView
        style={[styles.fill, { backgroundColor: theme.background }]}
        contentContainerStyle={[styles.content, styles.grow, frame, style]}
        keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: theme.background }]}>
      <View style={[styles.content, styles.fill, frame, style]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  grow: {
    flexGrow: 1,
  },
  // Caps the line length on tablets and on the web build; on a phone this is
  // just full width.
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
});
