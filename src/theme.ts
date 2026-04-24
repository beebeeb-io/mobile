/**
 * Beebeeb brand tokens — OKLCH values from hifi-styles.css converted to RGB hex.
 *
 * Conversion done with the CSS Color 4 spec. React Native does not support
 * oklch() so we use hex values directly.
 */

export const colors = {
  // Warm off-white backgrounds
  paper: '#faf8f5',
  paper2: '#f5f2ed',

  // Borders
  line: '#e6e0d6',
  line2: '#d9d1c4',

  // Ink -- warm darks
  ink: '#2a2520',
  ink2: '#5c564e',
  ink3: '#7d7770',
  ink4: '#A8A29C',

  // Amber -- the brand accent
  amber: '#f5b800',
  amberDeep: '#b8860b',
  amberBg: '#fef7e0',

  // Status
  green: '#4abe4a',
  red: '#d84040',

  // Dark surfaces (preview screen)
  darkBg: '#0C0C0D',
  darkOverlay: 'rgba(20,20,22,0.9)',

  // Transparent
  transparent: 'transparent',
  white: '#FFFFFF',
  black: '#000000',
} as const;

export const fonts = {
  sans: 'System', // Maps to SF Pro on iOS, Roboto on Android
  mono: 'SpaceMono', // Fallback; JetBrains Mono via expo-font later
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  '2xl': 36,
} as const;

export const radii = {
  sm: 4,
  md: 6,
  lg: 10,
  xl: 14,
  round: 999,
} as const;

export const shadows = {
  sm: {
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  lg: {
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 6,
  },
} as const;

export const theme = {
  colors,
  fonts,
  spacing,
  radii,
  shadows,
} as const;

export type Theme = typeof theme;
export default theme;
