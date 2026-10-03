import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const VISIBLE_MS = 1800;
const FADE_MS = 200;

type ScopeToastProps = {
  message: string | null;
  /** A new value each time `useToast().show()` is called — restarts the fade even for a repeated message. */
  token: number;
};

/**
 * A short-lived pill confirming a state change without asking for a response
 * — used after the crew/all store toggle is tapped, on the Customers tab and
 * in the receipt form's store picker.
 *
 * Pinned to the bottom of its nearest positioned ancestor — a plain `View`'s
 * default `position` is already `relative` in React Native, so the caller
 * needs no wrapper — and untouchable (`pointerEvents="none"`), so it never
 * sits in front of whatever is underneath it: the store list on the
 * Customers tab, or the picker's own list in the receipt form.
 */
export function ScopeToast({ message, token }: ScopeToastProps) {
  const theme = useTheme();
  // Seeded via useState's lazy initializer rather than useRef — reading a
  // ref's `.current` during render is what the React Compiler's lint flags,
  // and this Animated.Value is never itself the thing React re-renders on;
  // only `shown` is.
  const [opacity] = useState(() => new Animated.Value(0));
  const [shown, setShown] = useState<string | null>(null);

  // Split from the animation effect below, and scheduled rather than called
  // straight from the body — same reason context/customers.tsx uses a timer:
  // React's lint (and the React Compiler) treat a setState reachable
  // synchronously from an effect body as a cascading render. token starts at
  // 0 and only advances from a real show(), which skips the toast flashing
  // on mount before anyone has touched the toggle.
  useEffect(() => {
    if (token === 0 || !message) return;
    const timer = setTimeout(() => setShown(message), 0);
    return () => clearTimeout(timer);
  }, [token, message]);

  // Runs the fade whenever there's something to show. Keyed on `shown` (not
  // `token`) so a message change mid-fade — a second toggle tap before the
  // first toast finished — cancels the old animation via this effect's own
  // cleanup and restarts clean rather than fighting it.
  useEffect(() => {
    if (!shown) return;
    opacity.setValue(0);
    const sequence = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: FADE_MS, useNativeDriver: true }),
      Animated.delay(VISIBLE_MS),
      Animated.timing(opacity, { toValue: 0, duration: FADE_MS, useNativeDriver: true }),
    ]);
    sequence.start(({ finished }) => {
      if (finished) setShown(null);
    });
    return () => sequence.stop();
  }, [shown, opacity]);

  if (!shown) return null;

  return (
    <Animated.View pointerEvents="none" style={[styles.wrap, { opacity }]}>
      <View style={[styles.pill, { backgroundColor: theme.text }]}>
        <ThemedText type="small" style={{ color: theme.background }} numberOfLines={1}>
          {shown}
        </ThemedText>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Spacing.four,
    alignItems: 'center',
  },
  pill: {
    borderRadius: Spacing.four,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
});
