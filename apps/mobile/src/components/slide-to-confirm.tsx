import { useEffect, useMemo, useState } from 'react';
import { Animated, PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const TrackHeight = 56;
const TrackPadding = Spacing.one;
const ThumbSize = TrackHeight - TrackPadding * 2;
/** How far along the track counts as "all the way" — a thumb dropped a hair short still confirms. */
const ConfirmFraction = 0.9;

type SlideToConfirmProps = {
  /** Shown in the track, e.g. "Slide to void". */
  label: string;
  /** Replaces the label while the action runs. */
  busyLabel?: string;
  busy?: boolean;
  /** `'danger'` paints the thumb red. */
  tone?: 'default' | 'danger';
  onConfirm: () => void;
};

/**
 * A confirm that has to be dragged, not tapped.
 *
 * For the last step of something that can't be undone. A button can be hit by
 * accident — a thumb landing where "Continue" just was on the step before, a
 * phone in a pocket — but dragging the knob across the whole track can't happen
 * by chance. Let go before the end and it springs back and nothing happens.
 *
 * Built on React Native's own `PanResponder` and `Animated`, not
 * react-native-gesture-handler: gesture-handler needs its own root view inside
 * every `Modal` on Android, and this always lives in one.
 *
 * Once confirmed the knob stays at the end with `busyLabel` in the track, and
 * slides back only if `busy` clears while it is still on screen (the action
 * failed and the dialog stayed up).
 */
export function SlideToConfirm({ label, busyLabel, busy = false, tone = 'default', onConfirm }: SlideToConfirmProps) {
  const theme = useTheme();
  const fillColor = tone === 'danger' ? theme.danger : theme.text;

  // Lazy useState rather than useRef for the same reason as scope-toast.tsx:
  // these are never read during render, only handed to Animated.
  const [x] = useState(() => new Animated.Value(0));
  const [trackWidth, setTrackWidth] = useState(0);

  // True from a completed slide until the action it started has finished.
  const [confirmed, setConfirmed] = useState(false);

  // busy going true → false after a slide means the action is over. Adjusted
  // during render (React's pattern for reacting to a prop change) rather than
  // in an effect, which the React Compiler lint flags as a cascading render.
  const [prevBusy, setPrevBusy] = useState(busy);
  if (busy !== prevBusy) {
    setPrevBusy(busy);
    if (!busy) setConfirmed(false);
  }

  // Not confirmed means the knob belongs at the start. This is what gives it
  // back when the action failed and the dialog stayed up; at rest it's a no-op.
  useEffect(() => {
    if (!confirmed) Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
  }, [confirmed, x]);

  const travel = Math.max(0, trackWidth - ThumbSize - TrackPadding * 2);
  const locked = busy || confirmed;

  // Rebuilt when what it reads changes, instead of reading refs — none of these
  // change mid-drag, and the responder picks up the new handlers regardless.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !locked,
        onMoveShouldSetPanResponder: () => !locked,
        // Don't let a scroll view or the modal take the drag away half-way across.
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_event, gesture) => {
          x.setValue(Math.min(Math.max(gesture.dx, 0), travel));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (travel > 0 && gesture.dx >= travel * ConfirmFraction) {
            setConfirmed(true);
            Animated.timing(x, { toValue: travel, duration: 100, useNativeDriver: false }).start();
            onConfirm();
          } else {
            Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
        },
      }),
    [locked, travel, x, onConfirm],
  );

  function handleLayout(event: LayoutChangeEvent) {
    setTrackWidth(event.nativeEvent.layout.width);
  }

  // The light red fill follows the knob, behind the label.
  const fillWidth = Animated.add(x, ThumbSize);

  return (
    <View
      onLayout={handleLayout}
      style={[styles.track, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={busy && busyLabel ? busyLabel : label}
      accessibilityHint="Slide all the way to the right to confirm"
      accessibilityState={{ disabled: busy, busy }}
      // Screen readers can't drag; a double-tap stands in for the slide.
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate' && !locked) onConfirm();
      }}>
      <Animated.View
        pointerEvents="none"
        style={[styles.fill, { width: fillWidth, backgroundColor: fillColor, opacity: 0.2 }]}
      />
      {/* Stays fully visible the whole slide — the owner asked that it not fade. */}
      <View pointerEvents="none" style={styles.labelWrap}>
        <ThemedText type="smallBold" style={{ color: fillColor }}>
          {busy && busyLabel ? busyLabel : label}
        </ThemedText>
      </View>
      <Animated.View
        {...pan.panHandlers}
        style={[
          styles.thumb,
          { backgroundColor: fillColor, opacity: busy ? 0.6 : 1, transform: [{ translateX: x }] },
        ]}>
        <ThemedText type="subtitle" style={[styles.arrow, { color: theme.background }]}>
          ›
        </ThemedText>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: TrackHeight,
    borderRadius: TrackHeight / 2,
    borderWidth: StyleSheet.hairlineWidth,
    padding: TrackPadding,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    left: TrackPadding,
    top: TrackPadding,
    bottom: TrackPadding,
    borderRadius: ThumbSize / 2,
  },
  labelWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    width: ThumbSize,
    height: ThumbSize,
    borderRadius: ThumbSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrow: {
    lineHeight: ThumbSize,
    includeFontPadding: false,
  },
});
