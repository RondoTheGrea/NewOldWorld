import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { WEEKDAYS, type Weekday } from '@/context/customers';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type WeekdayChipsProps = {
  selected: Weekday[];
  /** Omit for a read-only display (detail modal); pass to make chips tappable (form). */
  onToggle?: (day: Weekday) => void;
};

export function WeekdayChips({ selected, onToggle }: WeekdayChipsProps) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      {WEEKDAYS.map((day) => {
        const active = selected.includes(day);
        const chip = (
          <View
            style={[
              styles.chip,
              {
                borderColor: active ? theme.text : theme.border,
                backgroundColor: active ? theme.text : 'transparent',
              },
            ]}>
            <ThemedText type="small" style={{ color: active ? theme.background : theme.text }}>
              {day}
            </ThemedText>
          </View>
        );

        if (!onToggle) {
          return <View key={day}>{chip}</View>;
        }

        return (
          <Pressable key={day} onPress={() => onToggle(day)} hitSlop={Spacing.one}>
            {chip}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.four,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
  },
});
