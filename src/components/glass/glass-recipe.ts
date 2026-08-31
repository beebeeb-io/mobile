/**
 * Liquid Glass — the material recipe (task 1311).
 *
 * THIS IS THE ONE FILE TO CHANGE. Every glass primitive in this folder renders
 * from the tokens below, so swapping the implementation (see "Fidelity gaps")
 * is a single-file edit, not a sweep through the components.
 *
 * Every value here is lifted verbatim from the approved iOS 26 canvas at
 * `design/ios26-canvas/` (generator: `ios26.py`, identical `.lg` / `.bubble` /
 * `.topfade` rules across all eleven artboards). Where a value had to be
 * converted from CSS to React Native, or derived because the canvas is
 * dark-only, it is called out inline. Nothing here is invented silently.
 *
 * The canvas rule this encodes: glass is the floating CONTROL layer only —
 * tab bar, circles, pills, sheets. Content sits on the opaque grouped
 * surfaces in `theme.ts` (`surfaces` / `darkSurfaces`), never on glass.
 *
 * ── Fidelity gaps against the canvas (honest list) ─────────────────────────
 * 1. `saturate(1.6–1.9)` is NOT expressible with `expo-blur`. A `BlurView` has
 *    `intensity` and `tint` and no saturation control. iOS `UIVisualEffectView`
 *    system materials carry their own vibrancy, so some of the effect is
 *    inherent on-device, but it is not the canvas's exact 1.9. Closing this
 *    properly needs `expo-glass-effect` (refraction + real material), which
 *    ships canary-only for SDK 57/58 — see the decision recorded in task 1311.
 *    Switching `BLUR_TINT` below to `systemThinMaterialDark` /
 *    `systemThinMaterialLight` trades our exact canvas fill for the native
 *    material's built-in vibrancy; that is the one-line experiment.
 * 2. CSS blur is in pixels, `BlurView.intensity` is an unitless 1–100.
 *    `intensityForCssBlur()` below maps between them through a single
 *    calibration constant.
 * 3. RN has no `inset` box-shadow, so the specular rim is drawn as real
 *    hairline edges by `GlassSurface`, and no `mask-image`, so `ScrollEdgeBlur`
 *    fakes the progressive fade by stacking blur bands.
 */

import type { ViewStyle } from 'react-native';

export type GlassScheme = 'light' | 'dark';

/**
 * Concentric capsule radii from the canvas. Nesting rule: a child's radius is
 * the parent's minus its padding, so corners stay concentric.
 *
 *   capsule 999 — tab bar, pills, segmented controls, the active bubble
 *   sheet    38 — the floating share sheet
 *   card     28 — the Live-Activity-style upload card
 *   group    26 — a grouped content card (`CELLR` in ios26.py)
 *   tile     18 — the trust strip
 *   inner    13 — the logo tile inside the upload card
 */
export const GLASS_RADII = {
  capsule: 999,
  sheet: 38,
  card: 28,
  group: 26,
  tile: 18,
  inner: 13,
} as const;

export type GlassRadiusName = keyof typeof GLASS_RADII;

/**
 * CSS backdrop-blur pixels produced by a `BlurView` at `intensity={100}`.
 *
 * This is a CALIBRATION CONSTANT, not a canvas value — the canvas speaks in
 * CSS pixels and `expo-blur` speaks in an unitless 1–100 scale, so something
 * has to bridge them. 34 puts the canvas's `blur(26px)` control material at
 * intensity 76 and its `blur(18px)` scroll edge at 53, which reads on device
 * like the artboards. If the material ever looks too soft or too crisp against
 * the canvas, retune THIS NUMBER — not the per-primitive values.
 */
export const BLUR_PX_AT_FULL_INTENSITY = 34;

/** Map a canvas CSS blur radius (px) onto a `BlurView` intensity (1–100). */
export function intensityForCssBlur(px: number): number {
  const scaled = Math.round((px / BLUR_PX_AT_FULL_INTENSITY) * 100);
  return Math.min(100, Math.max(1, scaled));
}

/**
 * Convert a CSS drop shadow to iOS shadow props.
 *
 * A CSS blur radius is ~2× the Gaussian standard deviation that
 * `shadowRadius` takes, hence the halving. `elevation` is Android's single
 * knob; it approximates the same depth.
 */
export function cssShadow(
  offsetY: number,
  cssBlur: number,
  color: string,
  opacity: number,
): ViewStyle {
  return {
    shadowColor: color,
    shadowOffset: { width: 0, height: offsetY },
    shadowOpacity: opacity,
    shadowRadius: cssBlur / 2,
    elevation: Math.round(offsetY),
  };
}

/** The resolved material for one colour scheme. */
export type GlassMaterial = {
  /** `BlurView.intensity`, derived from the canvas's CSS blur radius. */
  blurIntensity: number;
  /** The canvas CSS blur radius this intensity stands in for (documentation). */
  cssBlurPx: number;
  /** The canvas `saturate()` factor — recorded, not renderable (gap 1 above). */
  cssSaturate: number;
  /** `BlurView.tint`. */
  tint: 'light' | 'dark';
  /** Fill painted over the blur. */
  fill: string;
  /** Specular top rim — the 1px inset highlight that makes it read as glass. */
  rimTop: string;
  /** Thickness of the top rim, in points. */
  rimTopWidth: number;
  /** Left/right inset rim. */
  rimSide: string;
  /** Bottom inset rim. */
  rimBottom: string;
  /** Thickness of the side and bottom rims, in points. */
  rimWidth: number;
  /** Soft drop shadow beneath the floating control. */
  shadow: ViewStyle;
  /** Diagonal specular sheen: [start, mid, end] colours at 0% / 34% / 58%. */
  sheen: readonly [string, string, string];
  /** Angle of the sheen sweep, in degrees. */
  sheenAngle: number;
  /** Fill of an ACTIVE segment bubble sitting inside a glass capsule. */
  bubbleFill: string;
  /** Specular top rim of that bubble. */
  bubbleRim: string;
  /** Drop shadow of that bubble. */
  bubbleShadow: ViewStyle;
};

/**
 * Dark material — lifted verbatim from the canvas `.lg` and `.bubble` rules:
 *
 *   background: rgba(44,44,50,0.46);
 *   backdrop-filter: blur(26px) saturate(1.9);
 *   box-shadow: inset 0 0.75px 0 rgba(255,255,255,0.30),
 *               inset 0.5px 0 0 rgba(255,255,255,0.08),
 *               inset -0.5px 0 0 rgba(255,255,255,0.08),
 *               inset 0 -0.5px 0 rgba(255,255,255,0.05),
 *               0 12px 34px rgba(0,0,0,0.42);
 *   .lg::after background: linear-gradient(118deg,
 *               rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 34%,
 *               transparent 58%);
 *   .bubble    background: rgba(255,255,255,0.13);
 *              box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.28),
 *                          0 2px 8px rgba(0,0,0,0.25);
 */
const DARK_MATERIAL: GlassMaterial = {
  blurIntensity: intensityForCssBlur(26),
  cssBlurPx: 26,
  cssSaturate: 1.9,
  tint: 'dark',
  fill: 'rgba(44,44,50,0.46)',
  rimTop: 'rgba(255,255,255,0.30)',
  rimTopWidth: 0.75,
  rimSide: 'rgba(255,255,255,0.08)',
  rimBottom: 'rgba(255,255,255,0.05)',
  rimWidth: 0.5,
  shadow: cssShadow(12, 34, '#000000', 0.42),
  sheen: ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.02)', 'rgba(255,255,255,0)'],
  sheenAngle: 118,
  bubbleFill: 'rgba(255,255,255,0.13)',
  bubbleRim: 'rgba(255,255,255,0.28)',
  bubbleShadow: cssShadow(2, 8, '#000000', 0.25),
};

/**
 * Light material — DERIVED, not lifted. All eleven canvas artboards are dark,
 * so there is no light `.lg` rule to copy. The derivation keeps every
 * *geometric* value identical and flips only the optics:
 *
 *   · fill      — the warm `paper` white at 0.62 rather than 0.46. Light glass
 *                 needs more fill than dark glass to stay legible over a photo,
 *                 because a light scrim has less contrast against bright content.
 *   · rims      — the specular highlight stays WHITE in both schemes (a
 *                 highlight is light hitting an edge); the bottom rim becomes a
 *                 warm ink shade instead of a white one, which is what an edge
 *                 in shadow does on a light material.
 *   · shadow    — warm ink at a much lower opacity: a light control floating on
 *                 a light page casts a far weaker shadow than 0.42 black.
 *   · sheen     — unchanged; the diagonal specular sweep is white in both.
 *
 * These are the values to re-check first when the canvas gains light artboards.
 */
const LIGHT_MATERIAL: GlassMaterial = {
  blurIntensity: intensityForCssBlur(26),
  cssBlurPx: 26,
  cssSaturate: 1.9,
  tint: 'light',
  fill: 'rgba(250,248,245,0.62)',
  rimTop: 'rgba(255,255,255,0.75)',
  rimTopWidth: 0.75,
  rimSide: 'rgba(255,255,255,0.35)',
  rimBottom: 'rgba(42,37,32,0.06)',
  rimWidth: 0.5,
  shadow: cssShadow(12, 34, '#2a2520', 0.16),
  sheen: ['rgba(255,255,255,0.55)', 'rgba(255,255,255,0.12)', 'rgba(255,255,255,0)'],
  sheenAngle: 118,
  bubbleFill: 'rgba(255,255,255,0.85)',
  bubbleRim: 'rgba(255,255,255,0.90)',
  bubbleShadow: cssShadow(2, 8, '#2a2520', 0.14),
};

/** Resolve the glass material for a colour scheme. */
export function glassMaterial(scheme: GlassScheme): GlassMaterial {
  return scheme === 'dark' ? DARK_MATERIAL : LIGHT_MATERIAL;
}

/**
 * The progressive scroll-edge blur, from the canvas `.topfade` rule:
 *
 *   height: 128px;
 *   backdrop-filter: blur(18px) saturate(1.6);
 *   mask-image: linear-gradient(#000 0%, #000 52%, transparent 100%);
 *   background: rgba(12,12,13,0.30);
 *
 * RN has no `mask-image`, so `ScrollEdgeBlur` stacks `bands` blur layers of
 * decreasing height: every band blurs what is under it, so the top of the
 * strip accumulates the most blur and the bottom the least. `solidStop` is
 * the canvas's 52% — the fraction of the height that stays fully blurred
 * before the fade begins.
 */
export const SCROLL_EDGE = {
  height: 128,
  cssBlurPx: 18,
  cssSaturate: 1.6,
  solidStop: 0.52,
  bands: 6,
  darkTint: 'rgba(12,12,13,0.30)',
  /** DERIVED (canvas is dark-only): the warm `paper` at the same 0.30 alpha. */
  lightTint: 'rgba(250,248,245,0.30)',
} as const;

/** `BlurView.intensity` for one band of the scroll-edge stack. */
export function scrollEdgeBandIntensity(band: number, bands: number): number {
  const full = intensityForCssBlur(SCROLL_EDGE.cssBlurPx);
  // Bands compound, so each carries a share of the total rather than all of it.
  return Math.min(100, Math.max(1, Math.round(full / bands) + band));
}
