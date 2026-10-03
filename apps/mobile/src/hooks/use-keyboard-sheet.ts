import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  TextInput,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

/** Breathing room left between the focused field and the top of the keyboard. */
const FocusMargin = 12;

/**
 * Long enough for the extra bottom padding to reach the layout engine before the
 * scroll is attempted. Scrolling first would be clamped against content that
 * can't yet reach past the keyboard and land short.
 */
const ResizeSettleMs = 100;

export type KeyboardSheet = {
  /**
   * How many pixels of extra `paddingBottom` the scrolling list needs so a
   * field near its bottom can be scrolled clear of the on-screen keyboard.
   * Spread onto the list's `contentContainerStyle`. 0 when there is no
   * keyboard, and 0 on any platform where the window has already been resized
   * for it (see below).
   *
   * It is the full on-screen keyboard height rather than the exact slice of
   * the list the keyboard covers — measuring that slice would mean measuring
   * the list itself, and the difference is only the pinned footer's height.
   * Slightly generous padding just lets the last field scroll to the very top
   * of the keyboard, which is what's wanted anyway.
   */
  overlap: number;
  /** True while a keyboard is on screen, whether or not it overlaps anything. */
  keyboardVisible: boolean;
  /** Goes on the modal's full-screen backdrop. */
  onBackdropLayout: (event: LayoutChangeEvent) => void;
  /** Spread onto the sheet's one scrolling list (`<ScrollView {...scrollProps}>`). */
  scrollProps: {
    ref: (instance: unknown) => void;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    scrollEventThrottle: number;
  };
};

/**
 * Keeps the field being typed into visible when a keyboard opens over a centred
 * modal sheet — *without moving the sheet itself*. The sheet stays exactly where
 * and what size it was; only the list inside it scrolls.
 *
 * Two outputs do that together:
 *
 * - `overlap` is added as bottom padding to the scrolling list, so its content
 *   can scroll far enough that a field at the very bottom clears the keyboard
 *   (the list's own frame still runs behind the keyboard — that's fine, the
 *   content just needs somewhere to go).
 * - `scrollProps` wires up the list so this hook can scroll the focused field
 *   back above the keyboard as it arrives.
 *
 * The overlap is a *comparison*, not "the keyboard is N pixels tall", because
 * whether the window shrinks for a keyboard is not something this app can rely
 * on: on iOS it never does, and on Android it depends on the soft-input mode and
 * on edge-to-edge, which Expo turns on. So the backdrop's own measured bottom
 * edge is compared against the top of the keyboard in screen coordinates:
 *
 * - Window did not resize -> the backdrop still reaches past the keyboard, and
 *   the difference is how much scroll room the list needs.
 * - Window did resize -> the backdrop already ends at or above the top of the
 *   keyboard, the difference is negative, and the result is 0: the sheet is
 *   already shorter than the space above the keyboard, so nothing is hidden and
 *   no extra padding is wanted.
 *
 * On web no keyboard events fire, so this stays at 0 and nothing moves.
 */
export function useKeyboardSheet(): KeyboardSheet {
  // The top of the keyboard in screen coordinates, or null when it's away.
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [backdropHeight, setBackdropHeight] = useState(0);
  const scrollableRef = useRef<unknown>(null);
  const scrollOffsetRef = useRef(0);
  const keyboardTopRef = useRef<number | null>(null);

  useEffect(() => {
    // iOS fires the "will" events alongside the keyboard's own animation, so
    // the scroll keeps pace with it. Android only has the "did" pair.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    let settle: ReturnType<typeof setTimeout> | undefined;

    const show = Keyboard.addListener(showEvent, (event) => {
      const top = event.endCoordinates.screenY;
      // Only scroll the focused field up when the keyboard is genuinely
      // *arriving*. On Android the show event re-fires whenever focus moves
      // between fields — or lands on one that's already focused — while the
      // keyboard stays up, and re-running the scroll then shoves the list for
      // a field the user can already see. The keyboard's size is settled by
      // the first show, so a repeat has nothing to do.
      const arriving = keyboardTopRef.current === null;
      keyboardTopRef.current = top;
      setKeyboardTop(top);
      if (!arriving) return;
      // Wait for the extra bottom padding to land so the list can actually
      // scroll the focused field clear; scrolling before it does lands short.
      clearTimeout(settle);
      settle = setTimeout(scrollFocusedFieldIntoView, ResizeSettleMs);
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      keyboardTopRef.current = null;
      setKeyboardTop(null);
      clearTimeout(settle);
    });

    function scrollFocusedFieldIntoView() {
      const input = TextInput.State.currentlyFocusedInput();
      const top = keyboardTopRef.current;
      const scrollable = scrollableRef.current;
      if (!input || top === null || !scrollable) return;
      // The sheet didn't move, so a field low in the list may now sit behind
      // the keyboard. Measure where it actually is and scroll it back up.
      input.measureInWindow((_x, y, _width, height) => {
        const below = y + height + FocusMargin - top;
        if (below > 1) scrollBy(scrollable, scrollOffsetRef.current + below);
      });
    }

    return () => {
      show.remove();
      hide.remove();
      clearTimeout(settle);
    };
  }, []);

  // Applying the overlap as padding *inside* the backdrop doesn't change the
  // backdrop's own laid-out height, so this can't feed back on itself.
  const onBackdropLayout = useCallback((event: LayoutChangeEvent) => {
    setBackdropHeight(event.nativeEvent.layout.height);
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const setScrollable = useCallback((instance: unknown) => {
    scrollableRef.current = instance;
  }, []);

  const overlap =
    keyboardTop === null || backdropHeight === 0 ? 0 : Math.max(0, Math.round(backdropHeight - keyboardTop));

  return {
    overlap,
    keyboardVisible: keyboardTop !== null,
    onBackdropLayout,
    scrollProps: { ref: setScrollable, onScroll, scrollEventThrottle: 16 },
  };
}

/** ScrollView and FlatList scroll through differently named methods. */
function scrollBy(scrollable: unknown, y: number) {
  const target = scrollable as {
    scrollToOffset?: (options: { offset: number; animated: boolean }) => void;
    scrollTo?: (options: { y: number; animated: boolean }) => void;
  };
  if (typeof target.scrollToOffset === 'function') target.scrollToOffset({ offset: y, animated: true });
  else if (typeof target.scrollTo === 'function') target.scrollTo({ y, animated: true });
}
