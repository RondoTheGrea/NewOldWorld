import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  visible: boolean;
  /** Plain-language names of what didn't come back, e.g. ["Bread types"]. */
  failed: string[];
  /**
   * True when every failed item has a copy saved on this device. False means
   * at least one has never downloaded, and there is nothing to fall back to —
   * the truck has to get online before it can start the day.
   */
  canUseCache: boolean;
  onRetry: () => void;
  /** Only reachable when `canUseCache` — continues on the saved copies. */
  onUseCache: () => void;
  /** Dismissed by tapping outside the card (or Android back) — returns to the setup form. */
  onDismiss: () => void;
};

/**
 * Shown when finishing truck setup can't reach Firestore. Tapping outside the
 * card (or Android back) returns to the setup form, so the user is never
 * trapped — it's the only way out other than the buttons, since the explicit
 * "Back to setup" link was removed. If a retry fails, this comes straight
 * back, which is the intent.
 *
 * "Use saved copy" is the filled yellow button: continuing on prices the app
 * can't confirm is the choice with a consequence, so it reads as a caution
 * rather than hiding in an outline next to a blue Retry.
 */
export function CatalogFetchAlert({ visible, failed, canUseCache, onRetry, onUseCache, onDismiss }: Props) {
  const theme = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      {/* The backdrop is the dismiss target; the card below swallows its own
          presses so a tap inside doesn't close the alert. */}
      <Pressable style={styles.backdrop} onPress={onDismiss} accessibilityLabel="Close">
        <Pressable style={styles.wrapper} onPress={() => {}} accessible={false}>
          <View style={[styles.card, { backgroundColor: theme.background }]}>
            <ThemedText type="smallBold">
              {canUseCache ? 'Couldn’t get the latest info' : 'This phone needs internet to start'}
            </ThemedText>

            <ThemedText type="small" themeColor="textSecondary">
              {canUseCache
                ? 'The app couldn’t reach the server, so it can’t confirm these are up to date:'
                : 'This phone has never downloaded these, so there’s no saved copy to fall back on:'}
            </ThemedText>

            <View style={styles.list}>
              {failed.map((label) => (
                <ThemedText key={label} type="small" themeColor="textSecondary">
                  • {label}
                </ThemedText>
              ))}
            </View>

            <ThemedText type="small" themeColor="textSecondary">
              {canUseCache
                ? 'You can try again, or continue with the copy already saved on this device — prices may be out of date.'
                : 'The first setup on a phone has to be done online. Connect to the internet and try again — after that, this phone can start the day without a connection.'}
            </ThemedText>

            {/* The one thing a saved copy cannot tell the driver: whether it is
                still right. The app can't know either — it never reached the
                server — so the only person who can answer is the server, and
                this line is what sends the driver to ask them rather than
                tapping the yellow button because it is the bigger one. */}
            {canUseCache && (
              <ThemedText type="smallBold" themeColor="warning">
                If the server told you a price, a bread type or a store changed today, don’t use the
                saved copy — get online first, or that change won’t be on this phone.
              </ThemedText>
            )}

            <View style={styles.actions}>
              {canUseCache ? (
                <>
                  <Pressable
                    onPress={onRetry}
                    style={({ pressed }) => [
                      styles.outlineButton,
                      styles.action,
                      { borderColor: theme.border, opacity: pressed ? 0.6 : 1 },
                    ]}>
                    <ThemedText type="smallBold">Retry</ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={onUseCache}
                    style={({ pressed }) => [
                      styles.button,
                      styles.action,
                      { backgroundColor: theme.warning, opacity: pressed ? 0.85 : 1 },
                    ]}>
                    <ThemedText type="smallBold" style={{ color: theme.text }}>
                      Use saved copy
                    </ThemedText>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  onPress={onRetry}
                  style={({ pressed }) => [
                    styles.button,
                    styles.action,
                    { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: theme.background }}>
                    Retry
                  </ThemedText>
                </Pressable>
              )}
            </View>
          </View>
        </Pressable>
      </Pressable>
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
  wrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  list: {
    gap: Spacing.half,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  action: {
    flex: 1,
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
