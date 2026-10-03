import { Colors } from '@/constants/theme';

/**
 * The app's colors. There is only the one white palette (see constants/theme),
 * so this ignores the device's light/dark setting on purpose.
 *
 * It stays a hook so every component already reads colours the same way — if a
 * theme switch is ever wanted, this is the single place it goes.
 */
export function useTheme() {
  return Colors;
}
