import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { RunHistoryModal } from '@/components/run-history-modal';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useRunHistory } from '@/context/run-history';
import { useTheme } from '@/hooks/use-theme';

/**
 * The Home card for looking back at finished runs — see
 * lib/run-history-types.ts for what's kept and why it's local-only.
 *
 * Unlike ExpensesCard and EndDayCard, this renders regardless of whether a run
 * is open: it's a review of past trips, not an action tied to the current one,
 * so there's no reason to hide it while a truck is set up.
 *
 * **The whole card is the button.** It used to carry a full-width "View past
 * runs" button of its own under the status line, as did Expenses — four rows
 * each, on a screen that also stacks the printer and "End the day" and was
 * running off the bottom of shorter phones. A card whose only action is "open
 * the thing it is describing" doesn't need a separate control to say so; the
 * chevron does. Cards with a *choice* to make (End the day, and the printer's
 * connect/test pair) keep their buttons — that is the line, not tidiness.
 */
export function RunHistoryCard() {
  const theme = useTheme();
  const { summaries, loading, error } = useRunHistory();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        // Nothing to open while the list failed to load — same as the old
        // button's disabled state, just moved out to the card.
        disabled={error !== null}
        accessibilityRole="button"
        accessibilityLabel="Run history. View past runs."
        style={({ pressed }) => [
          styles.card,
          {
            borderColor: theme.border,
            backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
            opacity: error ? 0.6 : 1,
          },
        ]}>
        <View style={styles.header}>
          <SymbolView
            name={{ ios: 'clock.arrow.circlepath', android: 'history', web: 'history' }}
            tintColor={theme.textSecondary}
            size={20}
          />
          <ThemedText type="smallBold" style={styles.headerLabel}>
            Run history
          </ThemedText>
          <SymbolView
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            tintColor={theme.textSecondary}
            size={16}
          />
        </View>

        <ThemedText type="small" themeColor={error ? 'danger' : 'textSecondary'}>
          {describeState({ error, loading, count: summaries.length })}
        </ThemedText>
      </Pressable>

      <RunHistoryModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function describeState({ error, loading, count }: { error: string | null; loading: boolean; count: number }): string {
  if (error) return error;
  if (loading) return 'Loading…';
  if (count === 0) return 'Nothing finished yet — this fills in after "End the day".';
  return `${count} finished ${count === 1 ? 'run' : 'runs'} saved on this phone.`;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.three,
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerLabel: {
    flex: 1,
  },
});
