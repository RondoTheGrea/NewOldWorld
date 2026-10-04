import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { SlideToConfirm } from '@/components/slide-to-confirm';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * A yes/no question in the app's own card, in place of `Alert.alert`.
 *
 * `Alert` is the platform's dialog and cannot be styled at all — no colours, no
 * fonts, no button shapes — so on Android it lands as a grey Material box in
 * the middle of a white app, and the two dialogs a driver sees most often look
 * like they belong to a different program. This is the same card as every other
 * sheet here: white, hairline-bordered, the outline/filled button pair the
 * forms already use.
 *
 * It is only for questions. Failures still go through `lib/retry.ts`, which
 * uses a real `Alert` on purpose — an error has to interrupt whatever is on
 * screen, including a screen that has just crashed, and the platform dialog is
 * the one thing guaranteed to be able to.
 *
 * Deliberately no scrolling and no long body: if a confirmation needs a list of
 * what is about to happen, it wants a step inside the sheet it came from (see
 * `payment-method-modal.tsx`), not a taller dialog.
 */
export type ConfirmDialogProps = {
  visible: boolean;
  title: string;
  /** One line, occasionally two. Anything longer belongs on the screen behind it. */
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** `'danger'` paints the confirm button red — for anything that removes or destroys. */
  tone?: 'default' | 'danger';
  /** Locks both buttons and swaps the confirm label while the action runs. */
  busy?: boolean;
  busyLabel?: string;
  /**
   * Swaps the confirm button for a slider the driver has to drag across
   * (`slide-to-confirm.tsx`), with Cancel underneath. For the last step of
   * something that can't be undone; `confirmLabel` becomes the track's text.
   */
  slideToConfirm?: boolean;
  /**
   * Flips which button is the big one: Cancel becomes the filled green button
   * on the right, and Confirm an outline on the left in the tone's colour. For
   * questions where *not* going ahead is the answer we want to be easy — "Keep
   * counting" over "Close and lose it". What each button does is unchanged, so
   * a tap outside still answers Cancel, the safe way.
   */
  preferCancel?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Narrower than the form sheets: a two-button question shouldn't span a tablet. */
const DialogMaxWidth = 420;

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  busyLabel = 'Working…',
  slideToConfirm = false,
  preferCancel = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const theme = useTheme();
  const confirmColor = tone === 'danger' ? theme.danger : theme.text;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? () => {} : onCancel}>
      <View style={styles.backdrop}>
        {/* Tapping outside answers "no", which is what the Alert this replaces
            did on Android and costs nothing — unlike the form sheets, there is
            no typed work behind it to lose. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onCancel} />
        <View style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <View style={styles.text}>
            <ThemedText type="subtitle">{title}</ThemedText>
            {message ? (
              <ThemedText type="default" themeColor="textSecondary">
                {message}
              </ThemedText>
            ) : null}
          </View>

          {slideToConfirm ? (
            <View style={styles.slideActions}>
              <SlideToConfirm
                label={confirmLabel}
                busyLabel={busyLabel}
                busy={busy}
                tone={tone}
                onConfirm={onConfirm}
              />
              <Pressable
                onPress={onCancel}
                disabled={busy}
                accessibilityRole="button"
                // A solid button as tall as the slider, not a hairline outline:
                // next to a big red track, the way out has to be just as easy to find.
                style={({ pressed }) => [
                  styles.slideCancel,
                  {
                    backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
                    borderColor: theme.textSecondary,
                    opacity: busy ? 0.4 : 1,
                  },
                ]}>
                <ThemedText type="default" style={styles.slideCancelText}>
                  {cancelLabel}
                </ThemedText>
              </Pressable>
            </View>
          ) : preferCancel ? (
          <View style={styles.actions}>
            <Pressable
              onPress={onConfirm}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                { borderColor: theme.border, opacity: busy ? 0.4 : pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: confirmColor }}>
                {busy ? busyLabel : confirmLabel}
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                styles.confirmButton,
                { backgroundColor: theme.success, opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.background }}>
                {cancelLabel}
              </ThemedText>
            </Pressable>
          </View>
          ) : (
          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                { borderColor: theme.border, opacity: busy ? 0.4 : pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold">{cancelLabel}</ThemedText>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                styles.confirmButton,
                { backgroundColor: confirmColor, opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.background }}>
                {busy ? busyLabel : confirmLabel}
              </ThemedText>
            </Pressable>
          </View>
          )}
        </View>
      </View>
    </Modal>
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
  card: {
    width: '100%',
    maxWidth: DialogMaxWidth,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.four,
  },
  text: {
    gap: Spacing.two,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  slideActions: {
    gap: Spacing.three,
  },
  slideCancel: {
    height: 56,
    borderWidth: 1,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slideCancelText: {
    fontWeight: '700',
  },
  button: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButton: {
    borderColor: 'transparent',
  },
});
