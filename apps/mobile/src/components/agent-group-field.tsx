import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import type { AgentGroup } from '@/context/inventory';
import { useTheme } from '@/hooks/use-theme';

/**
 * Picks the **crew** that is aboard for the day.
 *
 * This replaced a multi-select of individual agents, and the difference is the
 * point rather than a re-skin: a truck is assigned a whole crew, so the driver
 * chooses one row instead of ticking people off a list. Who is in that crew is
 * the manager's business — it is maintained on the dashboard, and the run
 * records the members it found at the moment setup finished.
 *
 * The interaction is deliberately two steps:
 *
 * 1. **Tap a crew and it expands**, listing its people indented underneath.
 *    Only one is open at a time — the list answers "who is in this crew?", and
 *    two crews open at once turns it back into a wall of names.
 * 2. **Confirm appears once a crew is open**, and only then. Expanding is how
 *    the driver checks they picked the right crew, so the button that commits
 *    it can't be reachable before there is something to check.
 *
 * A crew with nobody in it can be opened but not confirmed: assigning it would
 * start a day with no agents recorded on it. The sheet says so and points at
 * the dashboard, because that is the only place it can be fixed.
 *
 * Chrome matches `dropdown-field.tsx` on purpose — this sits directly below the
 * Area and Truck pickers on the setup screen, and three fields that look like
 * three different controls would read as three different kinds of decision.
 */
export function AgentGroupField({
  label,
  placeholder,
  groups,
  loading,
  errorText,
  onOpen,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  groups: AgentGroup[];
  /** True only while there is nothing at all to show — not on every refresh. */
  loading?: boolean;
  /** Set only when the fetch failed with no saved copy to fall back on. */
  errorText?: string | null;
  /** Fires each time the sheet opens, so the crews can be fetched lazily. */
  onOpen?: () => void;
  value: string | null;
  onChange: (groupId: string) => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  // Which crew is expanded — and, while the sheet is open, which one Confirm
  // would assign. Kept separate from `value` so backing out of the sheet
  // without confirming changes nothing.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const selected = groups.find((group) => group.id === value) ?? null;
  const expanded = groups.find((group) => group.id === expandedId) ?? null;
  const canConfirm = !!expanded && expanded.agents.length > 0;

  function close() {
    setOpen(false);
  }

  function handleOpen() {
    // A crew already chosen opens expanded, so the sheet comes up showing the
    // current answer rather than making the driver find it again.
    setExpandedId(value);
    setOpen(true);
    onOpen?.();
  }

  function handleConfirm() {
    if (!expanded || !canConfirm) return;
    onChange(expanded.id);
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
        {selected ? (
          <View style={styles.triggerText}>
            <ThemedText type="default" style={styles.triggerPrimary} numberOfLines={1}>
              {selected.name}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.triggerSecondary} numberOfLines={1}>
              {selected.agents.map((agent) => agent.name).join(', ') || 'No agents in this crew'}
            </ThemedText>
          </View>
        ) : (
          <ThemedText type="default" themeColor="textSecondary" style={styles.triggerText} numberOfLines={1}>
            {placeholder}
          </ThemedText>
        )}
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
                  data={groups}
                  keyExtractor={(group) => group.id}
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                  initialNumToRender={20}
                  removeClippedSubviews={Platform.OS !== 'web'}
                  renderItem={({ item }) => (
                    <GroupRow
                      group={item}
                      expanded={expandedId === item.id}
                      chosen={value === item.id}
                      // Tapping the open crew closes it again, which also takes
                      // Confirm away — the button and the open list are the
                      // same state, so they can't disagree.
                      onPress={() => setExpandedId(expandedId === item.id ? null : item.id)}
                    />
                  )}
                  ListEmptyComponent={
                    <ThemedText type="small" themeColor="textSecondary" style={styles.centeredText}>
                      No crews downloaded. Add one on the dashboard, then try again with a connection.
                    </ThemedText>
                  }
                />
              )}

              {/* Only once a crew is open. Pinned below the list rather than
                  scrolling with it, so a long crew can't push it off screen. */}
              {expanded && (
                <View style={[styles.footer, { borderTopColor: theme.border }]}>
                  {expanded.agents.length === 0 && (
                    <ThemedText type="small" style={[styles.footerNote, { color: theme.warning }]}>
                      Nobody is in this crew, so it can’t be assigned. Add someone on the dashboard.
                    </ThemedText>
                  )}
                  <Pressable
                    onPress={handleConfirm}
                    disabled={!canConfirm}
                    style={({ pressed }) => [
                      styles.confirmButton,
                      { backgroundColor: theme.text, opacity: !canConfirm ? 0.4 : pressed ? 0.8 : 1 },
                    ]}>
                    <ThemedText type="smallBold" style={{ color: theme.background }}>
                      Confirm {expanded.name.trim() || 'this crew'}
                    </ThemedText>
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function GroupRow({
  group,
  expanded,
  chosen,
  onPress,
}: {
  group: AgentGroup;
  expanded: boolean;
  /** The crew currently assigned — a tick, so re-opening the sheet says what was picked. */
  chosen: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <View>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: expanded
              ? theme.backgroundSelected
              : pressed
                ? theme.backgroundElement
                : 'transparent',
          },
        ]}>
        <SymbolView
          name={
            expanded
              ? { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }
              : { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }
          }
          tintColor={theme.textSecondary}
          size={18}
        />
        <ThemedText type="default" style={styles.rowName} numberOfLines={1}>
          {group.name}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {group.agents.length === 1 ? '1 agent' : `${group.agents.length} agents`}
        </ThemedText>
        {chosen && (
          <SymbolView
            name={{ ios: 'checkmark', android: 'check', web: 'check' }}
            tintColor={theme.text}
            size={18}
          />
        )}
      </Pressable>

      {/* Indented under the crew name, so the nesting is readable without a
          second heading saying "agents in this crew". */}
      {expanded && (
        <View style={styles.members}>
          {group.agents.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              Nobody in this crew.
            </ThemedText>
          ) : (
            group.agents.map((agent) => (
              <ThemedText key={agent.id} type="small" style={styles.memberName}>
                {agent.name}
              </ThemedText>
            ))
          )}
        </View>
      )}
    </View>
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
    borderWidth: 1.5,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  triggerText: {
    flex: 1,
  },
  triggerPrimary: {
    fontWeight: '700',
  },
  triggerSecondary: {
    marginTop: Spacing.half / 2,
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
    marginBottom: Spacing.two,
  },
  headerText: {
    flex: 1,
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
    fontWeight: '700',
  },
  // The indent is what makes these read as "inside the crew above" rather than
  // as more crews. It lines up with the crew name, past the chevron.
  members: {
    paddingLeft: Spacing.two + 18 + Spacing.two,
    paddingRight: Spacing.two,
    paddingBottom: Spacing.two,
    gap: Spacing.half,
  },
  memberName: {
    lineHeight: 20,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.four,
    gap: Spacing.two,
  },
  footerNote: {
    textAlign: 'center',
  },
  confirmButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
