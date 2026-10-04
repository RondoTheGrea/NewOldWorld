import { SymbolView } from 'expo-symbols';
import { useCallback, useRef, useState } from 'react';
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { ThemedText } from '@/components/themed-text';
import { type Customer, type CustomerInput } from '@/context/customers';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useKeyboardSheet } from '@/hooks/use-keyboard-sheet';
import { useTheme } from '@/hooks/use-theme';
import { CustomerFieldLimits, sanitizeCustomerInput } from '@/lib/customer-types';
import { describeError, logError } from '@/lib/errors';
import { notifyFailure } from '@/lib/retry';

type CustomerFormModalProps = {
  visible: boolean;
  /** Present to edit an existing customer; null to create a new one. */
  editing: Customer | null;
  onClose: () => void;
  /**
   * Resolves true when the customer is saved. False means it failed and the
   * user chose not to retry — the form stays open with what they entered.
   */
  onSubmit: (input: CustomerInput) => Promise<boolean>;
};

const EMPTY: CustomerInput = {
  storeName: '',
  name: '',
  address: '',
  phone: '',
  schedule: '',
};

export function CustomerFormModal({ visible, editing, onClose, onSubmit }: CustomerFormModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Mounted fresh each time the modal opens, so its form state always
          starts from the customer being edited (or blank) instead of syncing
          via an effect. */}
      {visible && <CustomerFormBody editing={editing} onClose={onClose} onSubmit={onSubmit} />}
    </Modal>
  );
}

type CustomerFormBodyProps = {
  editing: Customer | null;
  onClose: () => void;
  onSubmit: (input: CustomerInput) => Promise<boolean>;
};

function CustomerFormBody({ editing, onClose, onSubmit }: CustomerFormBodyProps) {
  const theme = useTheme();
  const { overlap, onBackdropLayout, scrollProps } = useKeyboardSheet();
  const source = editing ?? EMPTY;
  const [name, setName] = useState(source.name);
  const [storeName, setStoreName] = useState(source.storeName);
  const [phone, setPhone] = useState(source.phone);
  const [schedule, setSchedule] = useState(source.schedule);
  const [address, setAddress] = useState(source.address);
  const [saving, setSaving] = useState(false);
  // An edit overwrites a store the whole route already sells to, so it asks
  // once before it writes — the same "is this right?" the expense form puts in
  // front of Add. A new store has nothing to overwrite and saves straight off.
  const [confirmingEdit, setConfirmingEdit] = useState(false);

  // Whether the "… is required" messages are on screen. False until the first
  // press of Save, so a form nobody has finished filling in yet isn't already
  // scolding the person filling it — every message then updates live as each
  // field is answered.
  const [showErrors, setShowErrors] = useState(false);

  // The Save button is never disabled for a half-filled form. A greyed-out
  // button is the one control that can't say why it won't work — the driver
  // presses it, nothing happens, and there is nothing on screen naming the
  // field that is missing. So it always presses, and answers with the list.
  //
  // Every field is required, as it was on the old app's "Add New Customer"
  // form this one copies. Checked *after* cleaning, not just trimmed: a paste
  // of zero-width spaces survives trim() and would otherwise pass as a name.
  const clean = sanitizeCustomerInput({ storeName, name, address, phone, schedule });
  const errors = {
    name: clean.name.length === 0 ? 'Name is required' : null,
    storeName: clean.storeName.length === 0 ? 'Store name is required' : null,
    phone: clean.phone.length === 0 ? 'Phone number is required' : null,
    schedule: clean.schedule.length === 0 ? 'Schedule is required' : null,
    address: clean.address.length === 0 ? 'Address is required' : null,
  };
  const complete = Object.values(errors).every((message) => message === null);

  /** The message to show for a field right now, or nothing while `showErrors` is off. */
  function errorFor(field: keyof typeof errors): string | undefined {
    return showErrors ? (errors[field] ?? undefined) : undefined;
  }

  // The hook owns the list's ref for its keyboard scrolling; this takes a
  // second reference to the same instance so a failed save can scroll the
  // messages into view. Both are set from one callback, memoized against the
  // hook's own (stable) ref setter — `scrollProps` is a fresh object every
  // render, so depending on it would hand React a new callback ref each time
  // and detach/re-attach both refs on every keystroke.
  const scrollRef = useRef<ScrollView | null>(null);
  const attachScroll = scrollProps.ref;
  const setScrollRef = useCallback(
    (instance: ScrollView | null) => {
      attachScroll(instance);
      scrollRef.current = instance;
    },
    [attachScroll],
  );

  /**
   * What the Save button does. An incomplete form shows what is missing and
   * goes no further; a complete edit asks for confirmation; a complete new
   * store saves.
   */
  function handleSavePress() {
    if (saving) return;
    if (!complete) {
      setShowErrors(true);
      Keyboard.dismiss();
      // Back to the top so the first message is in view — including when
      // Save was pressed from the bottom of a scrolled form.
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    if (editing) setConfirmingEdit(true);
    else void handleSubmit();
  }

  async function handleSubmit() {
    // Re-checked here rather than trusted from the caller: this is the only
    // path to a write, and both callers (the button and the confirm dialog)
    // can fire it.
    if (saving || !complete) return;
    // The confirm dialog is left up while the write runs — it is the thing
    // showing "Saving…", and closing it first would flash the form back into
    // view for as long as the save takes.
    setSaving(true);
    try {
      // customer-db sanitizes again on the way into SQLite; doing it here too
      // means what gets saved is exactly what this form validated.
      const saved = await onSubmit(clean);
      // Only close on success, so a failed save never discards the form.
      if (saved) onClose();
    } catch (error) {
      // onSubmit reports its own failures; this guards against an unexpected
      // throw leaving the button stuck on "Saving…".
      logError('customerForm.submit', error);
      notifyFailure('Could not save the customer', describeError(error));
    } finally {
      setSaving(false);
      setConfirmingEdit(false);
    }
  }

  // The sheet does not move when the keyboard opens — it stays centred at its
  // fixed size. Instead the form list is given extra bottom padding (`overlap`)
  // so it can scroll far enough for the focused field to clear the keyboard,
  // and `useKeyboardSheet` scrolls that field up as the keyboard arrives. The
  // KeyboardAvoidingView this once replaced did nothing on Android and only
  // padded the inside of a sheet whose bottom still sat behind the keyboard.
  return (
    // No tap-to-close on the backdrop: a half-typed store is too easy to lose
    // to a stray thumb on the dim edge. The ✕ and Cancel are both on screen the
    // whole time. Same rule in the other form sheets.
    <View style={styles.backdrop} onLayout={onBackdropLayout}>
      <View style={styles.sheetWrapper}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={styles.header}>
            <ThemedText type="subtitle">{editing ? 'Edit Customer' : 'Add New Customer'}</ThemedText>
            <Pressable
              onPress={onClose}
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

          <ScrollView
            {...scrollProps}
            ref={setScrollRef}
            style={styles.fill}
            contentContainerStyle={[styles.form, { paddingBottom: Spacing.four + overlap }]}
            keyboardShouldPersistTaps="handled">
            {/* maxLength on every field: React Native enforces it against
                pasted text as well as typing, so a pasted document is capped
                before it ever reaches the database or a receipt. */}
            <TextField
              label="Name"
              required
              errorText={errorFor('name')}
              value={name}
              onChangeText={setName}
              placeholder="Customer Name"
              editable={!saving}
              maxLength={CustomerFieldLimits.name}
            />
            <TextField
              label="Store Name"
              required
              errorText={errorFor('storeName')}
              value={storeName}
              onChangeText={setStoreName}
              placeholder="Store Name"
              editable={!saving}
              maxLength={CustomerFieldLimits.storeName}
            />
            <TextField
              label="Phone Number"
              required
              errorText={errorFor('phone')}
              value={phone}
              onChangeText={setPhone}
              placeholder="Phone Number"
              keyboardType="phone-pad"
              editable={!saving}
              maxLength={CustomerFieldLimits.phone}
            />
            <TextField
              label="Schedule"
              required
              errorText={errorFor('schedule')}
              value={schedule}
              onChangeText={setSchedule}
              placeholder="Delivery/Visit Schedule"
              editable={!saving}
              maxLength={CustomerFieldLimits.schedule}
            />
            <TextField
              label="Address"
              required
              errorText={errorFor('address')}
              value={address}
              onChangeText={setAddress}
              placeholder="Full Address"
              multiline
              editable={!saving}
              maxLength={CustomerFieldLimits.address}
            />
          </ScrollView>

          {/* Cancel beside Save, as on the old app's form. */}
          <View style={styles.buttonRow}>
            <Pressable
              onPress={onClose}
              disabled={saving}
              style={({ pressed }) => [
                styles.button,
                styles.cancelButton,
                { borderColor: theme.textSecondary, opacity: saving ? 0.4 : pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold">Cancel</ThemedText>
            </Pressable>
            <Pressable
              onPress={handleSavePress}
              disabled={saving}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: theme.text, opacity: saving ? 0.4 : pressed ? 0.8 : 1 },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.background }}>
                {saving ? 'Saving…' : 'Save'}
              </ThemedText>
            </Pressable>
          </View>
        </View>
      </View>

      {/* Answering "Go back" leaves every field exactly as it was typed — the
          sheet behind this is untouched. */}
      <ConfirmDialog
        visible={confirmingEdit}
        title="Save these changes?"
        message={`${clean.storeName} will be updated for everyone once it uploads.`}
        cancelLabel="Go back"
        confirmLabel="Save"
        busy={saving}
        busyLabel="Saving…"
        onCancel={() => setConfirmingEdit(false)}
        onConfirm={() => void handleSubmit()}
      />
    </View>
  );
}

type TextFieldProps = TextInputProps & {
  label: string;
  required?: boolean;
  /** "… is required", once Save has been pressed without this field filled in. */
  errorText?: string;
};

function TextField({ label, required, errorText, multiline, ...inputProps }: TextFieldProps) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {label}
        {required ? ' *' : ''}
      </ThemedText>
      <View
        style={[
          styles.fieldChrome,
          {
            backgroundColor: theme.backgroundElement,
            // The red outline is what's visible at a glance; the line under it
            // is what says which field and why. A hairline in red reads as a
            // slightly darker box, so the erroring field is drawn thicker.
            borderColor: errorText ? theme.danger : theme.border,
            borderWidth: errorText ? 1.5 : StyleSheet.hairlineWidth,
          },
        ]}>
        <TextInput
          multiline={multiline}
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, multiline && styles.inputMultiline, { color: theme.text }]}
          {...inputProps}
        />
      </View>
      {errorText ? (
        <ThemedText type="small" themeColor="danger">
          {errorText}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
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
    marginBottom: Spacing.three,
  },
  form: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  field: {
    gap: Spacing.one,
  },
  fieldChrome: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  input: {
    fontSize: 16,
    padding: 0,
  },
  inputMultiline: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginVertical: Spacing.three,
  },
  button: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
