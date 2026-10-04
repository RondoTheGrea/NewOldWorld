import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import type { Agent } from '@/context/inventory';
import { useTheme } from '@/hooks/use-theme';

/**
 * Picks **each agent** who is aboard for the day, one tick at a time, from the
 * list the dashboard keeps.
 *
 * This replaced a crew picker (a truck used to be assigned a whole crew); crews
 * were removed on the owner's call, so the driver now says who is on the truck
 * person by person.
 *
 * Ticks are a **draft until Confirm**. Backing out of the sheet with the ✕ or a
 * tap outside changes nothing, so a driver who opened it to check can't lose
 * the answer already given. Confirm needs at least one person ticked: a day
 * with nobody recorded on it can't be fixed afterwards.
 *
 * Chrome matches `dropdown-field.tsx` on purpose — this sits directly below the
 * Area and Truck pickers on the setup screen, and three fields that look like
 * three different controls would read as three different kinds of decision.
 */
export function AgentsField({
  label,
  placeholder,
  agents,
  loading,
  errorText,
  onOpen,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  agents: Agent[];
  /** True only while there is nothing at all to show — not on every refresh. */
  loading?: boolean;
  /** Set only when the fetch failed with no saved copy to fall back on. */
  errorText?: string | null;
  /** Fires each time the sheet opens, so the list can be fetched lazily. */
  onOpen?: () => void;
  value: string[];
  onChange: (agentIds: string[]) => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);

  // In the list's order, so the trigger reads the same however they were ticked.
  // An id the list no longer holds (deleted on the dashboard) isn't shown here;
  // finalizeSetup refuses it with a message instead.
  const selected = agents.filter((agent) => value.includes(agent.id));
  const canConfirm = draft.length > 0;

  function close() {
    setOpen(false);
  }

  function handleOpen() {
    // Opens showing the current answer, so re-opening is a check, not a restart.
    setDraft(value);
    setOpen(true);
    onOpen?.();
  }

  function toggle(id: string) {
    setDraft((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  }

  function handleConfirm() {
    if (!canConfirm) return;
    // Only ids still on the list, in the list's order.
    onChange(agents.filter((agent) => draft.includes(agent.id)).map((agent) => agent.id));
    close();
  }

  return (
    <View style={styles.field}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {label}
      </ThemedText>

      <Pressable
        onPress={handleOpen}
        style={({ pressed }) => [
          styles.trigger,
          { backgroundColor: theme.backgroundElement, borderColor: theme.accent, opacity: pressed ? 0.8 : 1 },
        ]}>
        {/* Wraps rather than truncating: this is the record of who is on the
            truck, and a name cut in half is worse than a taller field. */}
        <ThemedText
          type="default"
          themeColor={selected.length > 0 ? undefined : 'textSecondary'}
          style={styles.triggerText}>
          {selected.length > 0 ? selected.map((agent) => agent.name).join(', ') : placeholder}
        </ThemedText>
        <SymbolView
          name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
          tintColor={theme.textSecondary}
          size={20}
        />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={styles.backdrop}>
          {/* Tap-to-close sits *behind* the sheet so the list above it still
              receives pointer and mouse-wheel scrolling — same arrangement as
              dropdown-field.tsx. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
          <View style={styles.sheetWrapper}>
            <View style={[styles.sheet, { backgroundColor: theme.background }]}>
              <View style={styles.header}>
                <ThemedText type="subtitle" style={styles.headerText}>
                  {label}
                </ThemedText>
                <Pressable
                  onPress={close}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={Spacing.two}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                  <SymbolView
                    name={{ ios: 'xmark', android: 'close', web: 'close' }}
                    tintColor={theme.text}
                    size={24}
                  />
                </Pressable>
              </View>

              <ThemedText type="small" themeColor="textSecondary" style={styles.subhead}>
                Tick everyone who is on the truck today.
              </ThemedText>

              {loading ? (
                <View style={styles.centered}>
                  <View
                    style={[
                      styles.loadingCard,
                      { backgroundColor: theme.backgroundElement, borderColor: theme.border },
                    ]}>
                    <ActivityIndicator size="small" color={theme.textSecondary} />
                    <ThemedText type="small" themeColor="textSecondary">
                      Loading…
                    </ThemedText>
                  </View>
                </View>
              ) : errorText ? (
                <View style={styles.centered}>
                  <ThemedText type="small" style={[styles.centeredText, { color: theme.danger }]}>
                    {errorText}
                  </ThemedText>
                </View>
              ) : (
                <FlatList
                  data={agents}
                  keyExtractor={(agent) => agent.id}
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                  initialNumToRender={20}
                  removeClippedSubviews={Platform.OS !== 'web'}
                  renderItem={({ item }) => (
                    <AgentRow agent={item} checked={draft.includes(item.id)} onPress={() => toggle(item.id)} />
                  )}
                  ListEmptyComponent={
                    <ThemedText type="small" themeColor="textSecondary" style={styles.centeredText}>
                      No agents downloaded. Add them on the dashboard, then try again with a connection.
                    </ThemedText>
                  }
                />
              )}

              {/* Pinned below the list rather than scrolling with it, so a long
                  list can't push it off screen. */}
              <View style={[styles.footer, { borderTopColor: theme.border }]}>
                <Pressable
                  onPress={handleConfirm}
                  disabled={!canConfirm}
                  style={({ pressed }) => [
                    styles.confirmButton,
                    { backgroundColor: theme.text, opacity: !canConfirm ? 0.4 : pressed ? 0.8 : 1 },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: theme.background }}>
                    {canConfirm
                      ? `Confirm ${draft.length === 1 ? '1 agent' : `${draft.length} agents`}`
                      : 'Tick at least one agent'}
                  </ThemedText>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function AgentRow({ agent, checked, onPress }: { agent: Agent; checked: boolean; onPress: () => void }) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: checked ? theme.backgroundSelected : pressed ? theme.backgroundElement : 'transparent',
        },
      ]}>
      <SymbolView
        name={
          checked
            ? { ios: 'checkmark.square.fill', android: 'check_box', web: 'check_box' }
            : { ios: 'square', android: 'check_box_outline_blank', web: 'check_box_outline_blank' }
        }
        tintColor={checked ? theme.text : theme.textSecondary}
        size={22}
      />
      <ThemedText type="default" style={styles.rowName} numberOfLines={1}>
        {agent.name}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: Spacing.one,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    borderWidth: 1.5,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  triggerText: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: Spacing.four,
  },
  sheetWrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
    height: '85%',
  },
  sheet: {
    flex: 1,
    borderRadius: Spacing.four,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  headerText: {
    flex: 1,
  },
  subhead: {
    marginTop: Spacing.one,
    marginBottom: Spacing.two,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredText: {
    textAlign: 'center',
    paddingVertical: Spacing.three,
  },
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: Spacing.two,
    gap: Spacing.half,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.one,
  },
  rowName: {
    flex: 1,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.four,
  },
  confirmButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
