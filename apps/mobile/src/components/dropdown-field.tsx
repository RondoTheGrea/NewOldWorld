import { SymbolView } from 'expo-symbols';
import { useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Badge } from '@/components/badge';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { runWithRetry } from '@/lib/retry';

export type DropdownOption = {
  id: string;
  label: string;
  sublabel?: string;
  /**
   * A short word shown as a filled pill beside the label in the list — the
   * receipt form's store picker tags a store the driver just added with "New".
   *
   * Deliberately a plain string rather than a flag: this component is used by
   * every picker in the app and has no business knowing what a customer is.
   * It is not shown on the closed trigger — the trigger already names the
   * chosen store, and the tag is there to help *find* one.
   */
  badge?: string;
};

type DropdownFieldBase = {
  label: string;
  placeholder: string;
  options: DropdownOption[];
  /** Shows a floating loading card in place of the list. */
  loading?: boolean;
  errorText?: string | null;
  /** Fires each time the dropdown opens — e.g. to lazily fetch options. */
  onOpen?: () => void;
  /**
   * Renders one extra row at the end of the list that switches this same
   * modal into a small "add" form, rather than opening a second <Modal>.
   * Two RN Modals open back-to-back (one closing as another opens) is a known
   * source of focus/keyboard bugs — staying inside one modal avoids that.
   */
  onAddNew?: { label: string; fieldLabel: string; onSubmit: (name: string) => Promise<void> };
  /** Hides the label above the trigger — `label` still titles the picker modal. */
  hideLabel?: boolean;
  /**
   * Appends the ` *` marker the text fields use to the label above the trigger.
   * The picker modal's own title is left alone — the asterisk is a note to the
   * person filling the form in, not part of the list's name.
   */
  required?: boolean;
  /**
   * One line under the trigger, saying something about *this* field's current
   * state that the placeholder can't — the customer form uses it both to point
   * out an area or crew an older store was saved without, and to say the field
   * is required once Save has been pressed without one.
   *
   * Not the same thing as `errorText`, which is the picker's own *fetch*
   * failure and shows inside the open list.
   */
  hint?: string;
  /** `'danger'` paints the hint red — for one the user has to act on to continue. */
  hintTone?: 'muted' | 'danger';
  /** Shows a search box in the picker that filters by label/sublabel — for lists that can grow large (e.g. customers). */
  searchable?: boolean;
  /**
   * What to say when there are no options at all (not when a search matched
   * nothing — that always reads "No matches").
   *
   * The default, "Nothing here yet", is only honest for a list the user fills
   * in themselves. For one that is *downloaded*, it points at the wrong thing
   * entirely: an empty store list on a truck almost never means the business
   * has no stores, it means this phone hasn't got them — and the fix is at the
   * depot, not in this modal. Same rule as the Inventory tab's "No bread types
   * downloaded" wording (see CLAUDE.md).
   */
  emptyText?: string;
  /** Makes the picker sheet taller (85% vs 60%) — pair with `searchable` for long lists. */
  tall?: boolean;
  /**
   * By default a tap on the dim area outside the picker closes it. Pass false
   * for a picker whose in-progress state is worth protecting from a stray thumb
   * on that strip — the ✕ in the header is then the only way out (Android back
   * still works). Same reasoning as the form sheets in CLAUDE.md's "Modals and
   * the keyboard".
   */
  closeOnBackdropPress?: boolean;
  /**
   * Extra content rendered inside the picker sheet, below the title row and
   * above the search box (or list) — e.g. the receipt form's crew/all store
   * scope toggle. Every other caller omits it.
   */
  header?: ReactNode;
  /**
   * A short-lived, non-interactive overlay pinned to the bottom of the picker
   * sheet — e.g. `components/scope-toast.tsx` confirming a scope change. The
   * caller is responsible for making it untouchable (`pointerEvents="none"`)
   * so it never blocks the list underneath it.
   */
  toast?: ReactNode;
  /**
   * The selected option's data, used only to label the trigger when `value`
   * points at something the caller has deliberately kept out of `options` — the
   * receipt form's store picker hides a store that sits outside the crew filter
   * from the list, but the receipt is still for that store and the trigger has
   * to keep saying so. It is never added to the list itself. Ignored when
   * `multiple`.
   */
  pinnedSelection?: DropdownOption;
};

type SingleDropdownField = DropdownFieldBase & {
  multiple?: false;
  value: string | null;
  onChange: (id: string) => void;
};

type MultiDropdownField = DropdownFieldBase & {
  multiple: true;
  value: string[];
  onChange: (ids: string[]) => void;
};

export type DropdownFieldProps = SingleDropdownField | MultiDropdownField;

export function DropdownField(props: DropdownFieldProps) {
  const {
    label,
    placeholder,
    options,
    loading,
    errorText,
    onOpen,
    onAddNew,
    hideLabel,
    required,
    hint,
    hintTone = 'muted',
    searchable,
    tall,
    closeOnBackdropPress,
    emptyText,
    header,
    toast,
    pinnedSelection,
  } = props;
  const theme = useTheme();
  // The tone only means anything while there is a hint to paint. `hintTone` is
  // usually a fixed prop and `hint` the one that comes and goes, so reading the
  // tone on its own turned the outline red on a field with nothing wrong with
  // it.
  const showingError = hintTone === 'danger' && !!hint;
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  const filteredOptions = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) => option.label.toLowerCase().includes(q) || option.sublabel?.toLowerCase().includes(q),
    );
  }, [options, searchable, query]);

  const listSelected = props.multiple
    ? options.filter((o) => props.value.includes(o.id))
    : options.filter((o) => o.id === props.value);
  // A single selection the caller has filtered out of `options` on purpose
  // still names the trigger, via `pinnedSelection` (see its docs).
  const selectedOptions =
    !props.multiple && listSelected.length === 0 && pinnedSelection && pinnedSelection.id === props.value
      ? [pinnedSelection]
      : listSelected;
  const selectedLabels = selectedOptions.map((o) => o.label);
  // Only a single selection can show the label/sublabel pair — a multi-select
  // chip list falls back to a plain comma-joined line.
  const singleSelected = !props.multiple && selectedOptions.length === 1 ? selectedOptions[0] : null;

  function close() {
    setOpen(false);
    setAdding(false);
    setNewName('');
    setQuery('');
  }

  function handleOpen() {
    setOpen(true);
    onOpen?.();
  }

  function handleSelect(option: DropdownOption) {
    if (props.multiple) {
      const next = props.value.includes(option.id)
        ? props.value.filter((id) => id !== option.id)
        : [...props.value, option.id];
      props.onChange(next);
      return;
    }
    props.onChange(option.id);
    close();
  }

  async function handleSubmitAdd() {
    const name = newName.trim();
    if (!name || saving || !onAddNew) return;
    setSaving(true);
    const result = await runWithRetry(() => onAddNew.onSubmit(name), {
      scope: 'dropdown.addNew',
      title: `Could not add “${name}”`,
      message: 'It was not saved, so it hasn’t been added to the list.',
    });
    setSaving(false);
    // Giving up leaves the typed name in the box to try again or edit.
    if (!result.completed) return;

    // Single-select: the new item is now the selection, so the whole
    // dropdown can close. Multi-select: drop back to the list so more can
    // be picked (or another one added).
    if (props.multiple) {
      setAdding(false);
      setNewName('');
    } else {
      close();
    }
  }

  return (
    <View style={styles.field}>
      {!hideLabel && (
        <ThemedText type="smallBold" themeColor="textSecondary">
          {label}
          {required ? ' *' : ''}
        </ThemedText>
      )}
      <Pressable
        onPress={handleOpen}
        style={({ pressed }) => [
          styles.trigger,
          {
            backgroundColor: theme.backgroundElement,
            // A red outline as well as red text: the trigger is the thing to
            // tap, and the message under it is easy to read past.
            borderColor: showingError ? theme.danger : theme.accent,
            opacity: pressed ? 0.8 : 1,
          },
        ]}>
        {singleSelected && singleSelected.sublabel ? (
          <View style={styles.triggerText}>
            <ThemedText type="default" style={styles.triggerPrimary} numberOfLines={1}>
              {singleSelected.label}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.triggerSecondary} numberOfLines={1}>
              {singleSelected.sublabel}
            </ThemedText>
          </View>
        ) : (
          <ThemedText
            type="default"
            themeColor={selectedLabels.length > 0 ? 'text' : 'textSecondary'}
            style={styles.triggerText}
            numberOfLines={1}>
            {selectedLabels.length > 0 ? selectedLabels.join(', ') : placeholder}
          </ThemedText>
        )}
        <SymbolView
          name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
          tintColor={theme.textSecondary}
          size={20}
        />
      </Pressable>
      {hint ? (
        <ThemedText type="small" themeColor={showingError ? 'danger' : 'textSecondary'}>
          {hint}
        </ThemedText>
      ) : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={styles.backdrop}>
          {/* Sits behind the picker (not wrapping it) so its virtualized
              FlatList still receives pointer and mouse-wheel scrolling. Closes
              on press unless the caller opted out — the element stays either
              way so the layering is unchanged. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeOnBackdropPress === false ? undefined : close}
          />
          <View style={[styles.sheetWrapper, tall && styles.sheetWrapperTall]}>
            <View style={[styles.sheet, { backgroundColor: theme.background }]}>
              <View style={styles.header}>
                {adding && (
                  <Pressable
                    onPress={() => setAdding(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    hitSlop={Spacing.two}
                    disabled={saving}
                    style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                    <SymbolView
                      name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                      tintColor={theme.text}
                      size={22}
                    />
                  </Pressable>
                )}
                <ThemedText type="subtitle" style={styles.headerText}>
                  {adding ? onAddNew?.label : label}
                </ThemedText>
                <Pressable
                  onPress={close}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={Spacing.two}
                  disabled={saving}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                  <SymbolView
                    name={{ ios: 'xmark', android: 'close', web: 'close' }}
                    tintColor={theme.text}
                    size={24}
                  />
                </Pressable>
              </View>

              {header && !adding && <View style={styles.headerExtra}>{header}</View>}

              {searchable && !adding && (
                <View
                  style={[styles.searchChrome, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                  <SymbolView
                    name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
                    tintColor={theme.textSecondary}
                    size={18}
                  />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search"
                    placeholderTextColor={theme.textSecondary}
                    autoCorrect={false}
                    autoCapitalize="none"
                    style={[styles.input, styles.searchInput, { color: theme.text }]}
                  />
                  {query.length > 0 && (
                    <Pressable
                      onPress={() => setQuery('')}
                      accessibilityRole="button"
                      accessibilityLabel="Clear search"
                      hitSlop={Spacing.two}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                      <SymbolView
                        name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }}
                        tintColor={theme.textSecondary}
                        size={18}
                      />
                    </Pressable>
                  )}
                </View>
              )}

              {adding && onAddNew ? (
                <KeyboardAvoidingView
                  style={styles.fill}
                  behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                  <View style={styles.addForm}>
                    <ThemedText type="smallBold" themeColor="textSecondary">
                      {onAddNew.fieldLabel}
                    </ThemedText>
                    <View
                      style={[
                        styles.fieldChrome,
                        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
                      ]}>
                      <TextInput
                        value={newName}
                        onChangeText={setNewName}
                        autoFocus
                        editable={!saving}
                        placeholderTextColor={theme.textSecondary}
                        style={[styles.input, { color: theme.text }]}
                        onSubmitEditing={handleSubmitAdd}
                      />
                    </View>
                    <Pressable
                      onPress={handleSubmitAdd}
                      disabled={!newName.trim() || saving}
                      style={({ pressed }) => [
                        styles.saveButton,
                        {
                          backgroundColor: theme.text,
                          opacity: !newName.trim() || saving ? 0.4 : pressed ? 0.8 : 1,
                        },
                      ]}>
                      <ThemedText type="smallBold" style={{ color: theme.background }}>
                        {saving ? 'Saving…' : 'Add'}
                      </ThemedText>
                    </Pressable>
                  </View>
                </KeyboardAvoidingView>
              ) : loading ? (
                <View style={styles.loadingWrap}>
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
                <View style={styles.loadingWrap}>
                  <ThemedText type="small" style={styles.error}>
                    {errorText}
                  </ThemedText>
                </View>
              ) : (
                <FlatList
                  data={filteredOptions}
                  keyExtractor={(option) => option.id}
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                  keyboardShouldPersistTaps="handled"
                  initialNumToRender={20}
                  maxToRenderPerBatch={20}
                  windowSize={7}
                  removeClippedSubviews={Platform.OS !== 'web'}
                  renderItem={({ item }) => (
                    <OptionRow
                      option={item}
                      selected={props.multiple ? props.value.includes(item.id) : props.value === item.id}
                      multiple={!!props.multiple}
                      onPress={() => handleSelect(item)}
                    />
                  )}
                  ListEmptyComponent={
                    <ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>
                      {query.trim() ? 'No matches.' : (emptyText ?? 'Nothing here yet.')}
                    </ThemedText>
                  }
                  ListFooterComponent={
                    onAddNew ? (
                      <Pressable
                        onPress={() => setAdding(true)}
                        style={({ pressed }) => [
                          styles.row,
                          styles.addRow,
                          { backgroundColor: pressed ? theme.backgroundSelected : 'transparent' },
                        ]}>
                        <SymbolView
                          name={{ ios: 'plus', android: 'add', web: 'add' }}
                          tintColor={theme.text}
                          size={18}
                        />
                        <ThemedText type="smallBold">{onAddNew.label}</ThemedText>
                      </Pressable>
                    ) : null
                  }
                />
              )}

              {toast}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function OptionRow({
  option,
  selected,
  multiple,
  onPress,
}: {
  option: DropdownOption;
  selected: boolean;
  multiple: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: selected ? theme.backgroundSelected : pressed ? theme.backgroundElement : 'transparent' },
      ]}>
      <View style={styles.rowText}>
        <View style={styles.rowPrimaryLine}>
          <ThemedText type="default" style={styles.rowPrimary} numberOfLines={1}>
            {option.label}
          </ThemedText>
          {!!option.badge && <Badge label={option.badge} />}
        </View>
        {option.sublabel && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.rowSecondary} numberOfLines={1}>
            {option.sublabel}
          </ThemedText>
        )}
      </View>
      {selected && (
        <SymbolView
          name={{ ios: 'checkmark', android: 'check', web: 'check' }}
          tintColor={theme.text}
          size={18}
        />
      )}
      {!selected && multiple && <View style={styles.rowSpacer} />}
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
    height: '60%',
  },
  sheetWrapperTall: {
    height: '85%',
  },
  sheet: {
    flex: 1,
    borderRadius: Spacing.four,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
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
  headerExtra: {
    marginBottom: Spacing.two,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
  error: {
    color: '#e5484d',
    textAlign: 'center',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: Spacing.four,
    gap: Spacing.half,
  },
  emptyText: {
    paddingVertical: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.one,
  },
  rowText: {
    flex: 1,
    flexShrink: 1,
  },
  rowPrimaryLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  rowPrimary: {
    // Shrinkable so a long label truncates rather than squeezing the badge.
    flexShrink: 1,
    fontWeight: '700',
  },
  rowSecondary: {
    marginTop: Spacing.half / 2,
  },
  rowSpacer: {
    width: 18,
  },
  addRow: {
    gap: Spacing.two,
    justifyContent: 'flex-start',
    marginTop: Spacing.one,
  },
  addForm: {
    gap: Spacing.two,
  },
  fieldChrome: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  searchChrome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.two,
  },
  searchInput: {
    flex: 1,
  },
  input: {
    fontSize: 16,
    padding: 0,
  },
  saveButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.one,
  },
});
