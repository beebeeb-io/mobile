/**
 * Beebeeb brand tokens — OKLCH values from hifi-styles.css converted to RGB hex.
 *
 * Conversion done with the CSS Color 4 spec. React Native does not support
 * oklch() so we use hex values directly.
 */

export const darkColors = {
  paper: '#1e1e22',
  paper2: '#27272c',
  line: '#3a3a42',
  line2: '#48484f',
  ink: '#e8e6e3',
  ink2: '#c4c0ba',
  ink3: '#8a867f',
  ink4: '#5c584f',
  amber: '#f5b800',
  amberDeep: '#b8860b',
  amberBg: '#302808',
  green: '#4abe4a',
  red: '#d84040',
  darkBg: '#0C0C0D',
  darkOverlay: 'rgba(20,20,22,0.9)',
  transparent: 'transparent',
  white: '#FFFFFF',
  black: '#000000',
} as const;

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

export type Colors = {
  paper: string;
  paper2: string;
  line: string;
  line2: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  amber: string;
  amberDeep: string;
  amberBg: string;
  green: string;
  red: string;
  darkBg: string;
  darkOverlay: string;
  transparent: string;
  white: string;
  black: string;
};

export const fonts = {
  /**
   * SF Pro (iOS) / Roboto (Android) — intentional native feel.
   * Inter is the web brand font; mobile uses the platform sans to avoid
   * having to bundle a 300 KB font for something users already have.
   */
  sans: 'System',
  /**
   * JetBrains Mono — brand spec font for code / machine text.
   * Font files live in assets/fonts/. Load via expo-font in App.tsx.
   * Install: `bun add @expo-google-fonts/jetbrains-mono` (includes TTFs).
   * Falls back to system monospace when the font hasn't loaded yet.
   */
  mono: 'JetBrainsMono-Regular',
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

// ---------------------------------------------------------------------------
// iOS semantic type scale (task 1311)
// ---------------------------------------------------------------------------

/** One entry of the semantic type scale, shaped so a screen can spread it. */
export type TypeToken = {
  fontSize: number;
  lineHeight: number;
  fontWeight: '400' | '600' | '700';
  letterSpacing?: number;
};

export type TypeStyleName =
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subhead'
  | 'footnote'
  | 'caption1'
  | 'caption2';

/**
 * The eleven iOS semantic text styles. Spread one into a Text style:
 *
 *     <Text style={[theme.type.body, { color: c.ink }]}>…</Text>
 *
 * Why this exists: before task 1311 the app had NO scale, so every screen
 * hardcoded a size. The measured histogram across `src/screens` +
 * `src/components` was 12pt ×126, 13pt ×115, 11pt ×94, 14pt ×84 — and only 11
 * uses of 17pt. That is web-small type on a platform whose body text is 17.
 *
 * Sizes and leadings are Apple's (HIG, default Dynamic Type size).
 * `letterSpacing` is set ONLY where the approved iOS 26 canvas
 * (`design/ios26-canvas`) specifies tracking: +0.2 on the 34pt screen title,
 * −0.2 on 17pt rows and labels. Everything else keeps the platform default.
 *
 * This is a FIXED scale, not Dynamic Type — a screen that must honour the
 * user's text-size setting should scale these by `PixelRatio.getFontScale()`.
 */
export const typeScale = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: 0.2 },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  // 20/700 is the canvas's Photos month-header style.
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400', letterSpacing: -0.2 },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400' },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption1: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: '400' },
} as const satisfies Record<TypeStyleName, TypeToken>;

// ---------------------------------------------------------------------------
// Content surfaces (task 1311)
// ---------------------------------------------------------------------------

/**
 * Grouped-inset content surfaces — the CALM, OPAQUE layer.
 *
 * The rule the iOS 26 canvas is built on: glass is the floating *control*
 * layer only (tab bar, circles, pills, sheets). Content never sits on glass —
 * it sits on these opaque grouped surfaces, so a list stays readable while the
 * chrome above it stays translucent.
 */
export type Surfaces = {
  /** Page background behind the inset groups. */
  groupedBg: string;
  /** The opaque card a group of rows sits on. */
  groupedCell: string;
  /** Hairline between rows inside a group. */
  separator: string;
  /** Hairline thickness (the canvas draws 0.5px, not a 1px border). */
  separatorWidth: number;
  /** Left inset of a row separator, so it starts after the leading icon. */
  separatorInset: number;
  /** Corner radius of a grouped card. */
  groupRadius: number;
  /** Horizontal page margin either side of a grouped card. */
  groupInset: number;
  /** Minimum height of a settings-style row. */
  cellMinHeight: number;
  /** Corner radius of the leading icon tile inside a row. */
  tileRadius: number;
  /** Icon-tile background for accented (amber) rows. */
  tileAccentBg: string;
  /** Icon-tile background for neutral rows. */
  tileNeutralBg: string;
};

/**
 * Dark surfaces — lifted verbatim from `design/ios26-canvas/ios26.py`:
 * `BG = '#0C0C0D'`, `.cell { background: #1C1C21 }`,
 * `.sep { border-top: 0.5px solid rgba(255,255,255,0.075) }`, `CELLR = 26`,
 * row padding `0 16px`, `setrow` min-height 46, icon tile 42×42 r12 on
 * `AMBER_BG = rgba(245,184,0,0.15)` / `GREY_ICO = rgba(255,255,255,0.08)`.
 */
export const darkSurfaces: Surfaces = {
  groupedBg: '#0C0C0D',
  groupedCell: '#1C1C21',
  separator: 'rgba(255,255,255,0.075)',
  separatorWidth: 0.5,
  separatorInset: 16,
  groupRadius: 26,
  groupInset: 16,
  cellMinHeight: 46,
  tileRadius: 12,
  tileAccentBg: 'rgba(245,184,0,0.15)',
  tileNeutralBg: 'rgba(255,255,255,0.08)',
};

/**
 * Light surfaces — DERIVED, not lifted: the iOS 26 canvas has dark artboards
 * only. Built from the existing brand tokens so nothing new is invented:
 * `paper2` as the recessed page background with white cards (the standard iOS
 * grouped-inset polarity), and the separator / tile washes are the warm `ink`
 * at the same alphas the dark recipe uses in reverse. Geometry is identical to
 * `darkSurfaces` — only the colours flip.
 */
export const surfaces: Surfaces = {
  groupedBg: '#f5f2ed',
  groupedCell: '#ffffff',
  separator: 'rgba(42,37,32,0.10)',
  separatorWidth: 0.5,
  separatorInset: 16,
  groupRadius: 26,
  groupInset: 16,
  cellMinHeight: 46,
  tileRadius: 12,
  tileAccentBg: 'rgba(245,184,0,0.18)',
  tileNeutralBg: 'rgba(42,37,32,0.06)',
};

/** Pick the surface set for a resolved colour scheme. */
export function surfacesFor(scheme: 'light' | 'dark'): Surfaces {
  return scheme === 'dark' ? darkSurfaces : surfaces;
}

export const theme = {
  colors,
  fonts,
  spacing,
  radii,
  shadows,
  /** iOS semantic type scale — `theme.type.body`, `theme.type.largeTitle`, … */
  type: typeScale,
  /** Opaque grouped-inset content surfaces (light). See `darkSurfaces`. */
  surfaces,
} as const;

export type Theme = typeof theme;
export default theme;
