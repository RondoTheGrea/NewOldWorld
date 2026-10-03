import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type QuantityStepperProps = {
  value: number;
  onChange: (value: number) => void;
  editable: boolean;
  /** Caps both the +1 button and typed input. Omit for no upper bound. */
  max?: number;
};

export function QuantityStepper({ value, onChange, editable, max }: QuantityStepperProps) {
  const theme = useTheme();

  function clamp(next: number) {
    const nonNegative = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
    return max === undefined ? nonNegative : Math.min(nonNegative, max);
  }

  function handleChangeText(text: string) {
    const digitsOnly = text.replace(/[^0-9]/g, '');
    onChange(digitsOnly === '' ? 0 : clamp(Number(digitsOnly)));
  }

  const atMax = max !== undefined && value >= max;

  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={() => onChange(clamp(value - 1))}
        disabled={!editable || value <= 0}
        hitSlop={Spacing.two}
        style={({ pressed }) => [
          styles.stepperButton,
          { backgroundColor: theme.backgroundElement, opacity: !editable || value <= 0 ? 0.4 : pressed ? 0.7 : 1 },
        ]}>
        <SymbolView name={{ ios: 'minus', android: 'remove', web: 'remove' }} tintColor={theme.text} size={16} />
      </Pressable>
      <TextInput
        value={String(value)}
        onChangeText={handleChangeText}
        editable={editable}
        keyboardType="number-pad"
        style={[styles.stepperInput, { color: theme.text }]}
        selectTextOnFocus
      />
      <Pressable
        onPress={() => onChange(clamp(value + 1))}
        disabled={!editable || atMax}
        hitSlop={Spacing.two}
        style={({ pressed }) => [
          styles.stepperButton,
          { backgroundColor: theme.backgroundElement, opacity: !editable || atMax ? 0.4 : pressed ? 0.7 : 1 },
        ]}>
        <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} tintColor={theme.text} size={16} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperInput: {
    minWidth: 36,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    padding: 0,
  },
});
