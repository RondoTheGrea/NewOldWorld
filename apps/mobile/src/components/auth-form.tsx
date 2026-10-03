import { SymbolView } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { friendlyAuthError } from '@/lib/auth-errors';

type AuthFormProps = {
  title: string;
  submitLabel: string;
  onSubmit: (email: string, password: string) => Promise<void>;
  /**
   * True on the sign-up screen. It tells the OS keychain / password manager to
   * offer a *new* strong password instead of autofilling an existing one.
   */
  newPassword?: boolean;
  /** Link shown under the button to switch between login and sign-up. */
  footer: ReactNode;
};

export function AuthForm({
  title,
  submitLabel,
  onSubmit,
  newPassword = false,
  footer,
}: AuthFormProps) {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(email, password);
      // On success the auth guard swaps screens for us — nothing to do here.
    } catch (err) {
      setError(friendlyAuthError(err));
      setSubmitting(false);
    }
  }

  const fieldChrome = [
    styles.fieldChrome,
    { backgroundColor: theme.backgroundElement, borderColor: theme.border },
  ];

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ThemedView style={styles.content}>
            <ThemedText type="title" style={styles.title}>
              {title}
            </ThemedText>

            <View style={styles.field}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                Email
              </ThemedText>
              <View style={fieldChrome}>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={theme.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  keyboardType="email-address"
                  inputMode="email"
                  editable={!submitting}
                  style={[styles.input, { color: theme.text }]}
                />
              </View>
            </View>

            <View style={styles.field}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                Password
              </ThemedText>
              <View style={fieldChrome}>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  // A plain-text hint, not bullet characters: the bullets a
                  // font draws are a different size to the OS's own mask, so a
                  // "••••••••" placeholder visibly jumps the moment you type.
                  placeholder="Your password"
                  placeholderTextColor={theme.textSecondary}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  // Keeps Android off the suggestion strip and stops it
                  // re-deciding the keyboard type mid-word, which is what makes
                  // the masking stutter.
                  autoCorrect={false}
                  spellCheck={false}
                  autoComplete={newPassword ? 'new-password' : 'current-password'}
                  textContentType={newPassword ? 'newPassword' : 'password'}
                  editable={!submitting}
                  onSubmitEditing={handleSubmit}
                  returnKeyType="go"
                  style={[styles.input, { color: theme.text }]}
                />

                <Pressable
                  onPress={() => setShowPassword((shown) => !shown)}
                  disabled={submitting}
                  hitSlop={Spacing.two}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  style={({ pressed }) => [styles.eyeButton, { opacity: pressed ? 0.5 : 1 }]}>
                  <SymbolView
                    name={
                      showPassword
                        ? { ios: 'eye.slash.fill', android: 'visibility_off', web: 'visibility_off' }
                        : { ios: 'eye.fill', android: 'visibility', web: 'visibility' }
                    }
                    tintColor={theme.textSecondary}
                    size={20}
                  />
                </Pressable>
              </View>
            </View>

            {error && (
              <ThemedText type="small" style={styles.error}>
                {error}
              </ThemedText>
            )}

            <Pressable
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: theme.text, opacity: !canSubmit ? 0.4 : pressed ? 0.8 : 1 },
              ]}>
              {submitting ? (
                <ActivityIndicator color={theme.background} />
              ) : (
                <ThemedText type="smallBold" style={{ color: theme.background }}>
                  {submitLabel}
                </ThemedText>
              )}
            </Pressable>

            <View style={styles.footer}>{footer}</View>
          </ThemedView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  title: {
    marginBottom: Spacing.two,
  },
  field: {
    gap: Spacing.one,
  },
  /**
   * The box around a field. A fixed height is the point of it: Android swaps
   * the typeface when a field goes in and out of password mode, and without a
   * set height that re-measures the row and nudges everything below it. Pinning
   * the height means showing or hiding the password can't move the layout.
   */
  fieldChrome: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  input: {
    flex: 1,
    height: '100%',
    fontSize: 16,
    // Android centres text oddly inside a fixed-height input without this.
    paddingVertical: 0,
  },
  eyeButton: {
    paddingLeft: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    color: '#e5484d',
  },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.one,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
});
