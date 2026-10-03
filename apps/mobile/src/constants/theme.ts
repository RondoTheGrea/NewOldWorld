/**
 * The app's colors.
 *
 * There is one palette and it is white — no dark mode. A POS is used under
 * fixed shop lighting where a screen that flips to black on the cashier
 * depending on their phone settings is a liability, not a feature.
 *
 * `background` is pure white. The two greys are deliberate and are still part
 * of a white theme: they are what makes an input box or a selected row visible
 * at all. Painting those white too would leave fields with no edges.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  /** Near-black, for body text. */
  text: '#000000',
  /** The page. */
  background: '#ffffff',
  /** Input fills, cards — just off white, so edges read against the page. */
  backgroundElement: '#F0F0F3',
  /** A pressed or selected row. */
  backgroundSelected: '#E0E1E6',
  /** Labels, hints, placeholder text. */
  textSecondary: '#60646C',
  /** Hairlines around inputs and cards. */
  border: '#D8D9E0',
  /** Primary actions — already used ad hoc for links (themed-text.tsx). */
  accent: '#3c87f7',
  /** Positive / completing actions, e.g. finalizing inventory. */
  success: '#30a46c',
  /** Destructive actions and error text. */
  danger: '#e5484d',
  /** Caution actions, e.g. editing a draft. */
  warning: '#e2a336',
  /** Light green fill — order items lists/headers. */
  backgroundSuccess: '#CDF0DD',
  /** Light red fill — returns lists/headers. */
  backgroundDanger: '#F8D3D3',
} as const;

export type ThemeColor = keyof typeof Colors;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const MaxContentWidth = 800;
