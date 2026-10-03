import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Here's what happened" in the app's own card, in place of a one-button
 * `Alert.alert`.
 *
 * The sibling of `confirm-dialog.tsx`, and separate from it on purpose: this
 * one states an outcome rather than asking a question, so it has a single
 * button and no cancel. It is also allowed the thing `ConfirmDialog`
 * deliberately refuses — a short list of figures — because the one screen that
 * needs it is the "Day ended" read-back, where the numbers *are* the
 * confirmation: they're the same ones the server was just handed, so a driver
 * asked "what did it say?" can answer. `rows` renders them label-left,
 * value-right, which the platform alert's centred monospace-less text could
 * never do.
 *
 * Still not for failures. Those go through `lib/retry.ts` and a real `Alert`,
 * which is the only dialog guaranteed to appear over a screen that has just
 * crashed.
 */
export type NoticeRow = { label: string; value: string };

export type NoticeDialogProps = {
  visible: boolean;
  title: string;
  /** The lead sentence. One or two lines. */
  message?: string;
  /** Figures to read back, one per line. */
  rows?: NoticeRow[];
  /** A closing line under the figures, in the quieter colour. */
  footnote?: string;
  confirmLabel?: string;
  onClose: () => void;
};

/** Matches ConfirmDialog: a notice shouldn't span a tablet either. */
const DialogMaxWidth = 420;

export function NoticeDialog({
  visible,
  title,
  message,
  rows,
  footnote,
  confirmLabel = 'OK',
  onClose,
}: NoticeDialogProps) {
  const theme = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* Tapping outside dismisses, like the alert this replaces: there is
            nothing to answer and nothing behind it to lose. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
          {/* The body scrolls and the button doesn't, so a long read-back on a
              short phone can never push "OK" off the bottom of the card. */}
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            <ThemedText type="subtitle">{title}</ThemedText>

            {message ? (
              <ThemedText type="default" themeColor="textSecondary">
                {message}
              </ThemedText>
            ) : null}

            {rows && rows.length > 0 ? (
              <View style={[styles.rows, { borderColor: theme.border }]}>
                {rows.map((row) => (
                  <View key={row.label} style={styles.row}>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.rowLabel}>
                      {row.label}
                    </ThemedText>
                    <ThemedText type="smallBold">{row.value}</ThemedText>
                  </View>
                ))}
              </View>
            ) : null}

            {footnote ? (
              <ThemedText type="small" themeColor="textSecondary">
                {footnote}
              </ThemedText>
            ) : null}
          </ScrollView>

          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.text, opacity: pressed ? 0.85 : 1 },
            ]}>
            <ThemedText type="smallBold" style={{ color: theme.background }}>
              {confirmLabel}
            </ThemedText>
          </Pressable>
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
    maxHeight: '80%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.four,
  },
  body: {
    gap: Spacing.two,
  },
  rows: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.two,
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  rowLabel: {
    flexShrink: 1,
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
