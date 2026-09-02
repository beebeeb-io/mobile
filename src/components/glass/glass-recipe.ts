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
  /**
   * Structural outline drawn ON the material boundary.
   *
   * This is what carries LIGHT mode. A specular white rim only reads against
   * darker content; over a pale grouped background it vanishes, and with it
   * the whole edge of the control. Dark mode sets this transparent at zero
   * width, because the canvas defines no outline there.
   */
  rimOuter: string;
  /** Thickness of that outline. Zero disables it entirely. */
  rimOuterWidth: number;
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
  /** Contact shadow — tight and close, defines where the material meets. */
  shadow: ViewStyle;
  /**
   * Wider ambient shadow under the contact shadow, or `null` for a single
   * layer. Two layers are what make a control read as FLOATING rather than
   * stuck on; the canvas needs only one because a dark ground already
   * separates the material.
   */
  ambientShadow: ViewStyle | null;
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
  /** Primary text colour ON glass (the canvas uses its own on-glass inks). */
  label: string;
  /** Secondary text colour on glass. */
  labelMuted: string;
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
  // The canvas draws no outline in dark mode; width 0 keeps the specular rim
  // exactly where it was, so dark rendering is untouched by the light fix.
  rimOuter: 'transparent',
  rimOuterWidth: 0,
  rimTop: 'rgba(255,255,255,0.30)',
  rimTopWidth: 0.75,
  rimSide: 'rgba(255,255,255,0.08)',
  rimBottom: 'rgba(255,255,255,0.05)',
  rimWidth: 0.5,
  shadow: cssShadow(12, 34, '#000000', 0.42),
  ambientShadow: null,
  sheen: ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.02)', 'rgba(255,255,255,0)'],
  sheenAngle: 118,
  bubbleFill: 'rgba(255,255,255,0.13)',
  bubbleRim: 'rgba(255,255,255,0.28)',
  bubbleShadow: cssShadow(2, 8, '#000000', 0.25),
  // ios26.py: INK, INK2 = '#F2F1EE', 'rgba(240,238,233,0.62)'
  label: '#F2F1EE',
  labelMuted: 'rgba(240,238,233,0.62)',
};

/**
 * Light material — DERIVED, not lifted. All eleven canvas artboards are dark,
 * so there is no light `.lg` rule to copy.
 *
 * ── Why this is not just the dark recipe inverted ─────────────────────────
 * The first attempt was, and it failed: measured off the simulator, a control
 * sat at luminance 251 on a 234 ground — a 15L step with no hairline and a
 * shadow so diffuse it darkened the ground by 3L. Over a plain light surface
 * the capsule, circles and sheet had no discernible edge; they read as
 * slightly different paint rather than floating material.
 *
 * The cause is structural, not a tuning error. The canvas material is legible
 * because its fill is DARK (`rgba(44,44,50,0.46)`) over dark or photographic
 * content. Invert that to a near-white fill and put it on a near-white ground
 * and it is invisible by construction — and adding fill opacity only converts
 * it into an opaque card, which then looks wrong the moment it floats over a
 * photo.
 *
 * So light mode defines the EDGE instead of the surface, which is what iOS
 * does:
 *   · rimOuter  — a real dark hairline ON the boundary. This is the load-
 *                 bearing change; it is what you actually see against a pale
 *                 ground, and it costs nothing over a photo.
 *   · shadow    — a TIGHT contact shadow (offset 4, blur 14) instead of the
 *                 diffuse 12/34, plus a wide low ambient beneath it. Tight
 *                 defines the edge; wide says it floats.
 *   · rims      — the white specular highlight stays, but INSIDE the outline,
 *                 where it does its real job over bright photo content.
 *   · sheen     — pulled back from 0.55 to 0.30: at 0.55 over an already pale
 *                 material it blew the top-left corner to white and was the
 *                 other half of the "milky" look.
 *   · fill      — deliberately NOT increased. It stays at 0.62.
 *
 * These are the values to re-check first when the canvas gains light artboards.
 */
const LIGHT_MATERIAL: GlassMaterial = {
  blurIntensity: intensityForCssBlur(26),
  cssBlurPx: 26,
  cssSaturate: 1.9,
  tint: 'light',
  fill: 'rgba(250,248,245,0.62)',
  rimOuter: 'rgba(42,37,32,0.22)',
  rimOuterWidth: 0.5,
  rimTop: 'rgba(255,255,255,0.85)',
  rimTopWidth: 0.75,
  rimSide: 'rgba(255,255,255,0.45)',
  rimBottom: 'rgba(42,37,32,0.05)',
  rimWidth: 0.5,
  shadow: cssShadow(4, 14, '#2a2520', 0.22),
  ambientShadow: cssShadow(14, 36, '#2a2520', 0.10),
  sheen: ['rgba(255,255,255,0.30)', 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0)'],
  sheenAngle: 118,
  bubbleFill: 'rgba(255,255,255,0.85)',
  bubbleRim: 'rgba(255,255,255,0.90)',
  bubbleShadow: cssShadow(2, 8, '#2a2520', 0.18),
  label: '#2a2520',
  labelMuted: 'rgba(42,37,32,0.62)',
};

/** Resolve the glass material for a colour scheme. */
export function glassMaterial(scheme: GlassScheme): GlassMaterial {
  return scheme === 'dark' ? DARK_MATERIAL : LIGHT_MATERIAL;
}

/**
 * The flat scrim behind a modal — the canvas's ONE backdrop sample.
 *
 * Ground truth: `design/ios26-canvas/ShareSheet.dc.html:82` — `rgba(6,6,8,0.5)`.
 * Four surfaces were each hand-rolling their own black alpha with no canvas
 * backing (ShareSheet 0.35, ConfirmActionPrompt 0.40, the Drive new-folder
 * modal 0.40, TrustDetailsSheet 0.45). They all read from here now, and the
 * delta is written down in `design/ios26-canvas/DEVIATIONS.md` rather than
 * silently absorbed.
 *
 * A GLASS backdrop — a blurred full-screen primitive instead of a flat fill —
 * was considered and DECLINED pending ruling #2. The canvas shows a flat
 * scrim here, and the redesign's rule is that glass is the floating CONTROL
 * layer, not a full-screen wash. If #2 rules the other way, this constant is
 * where that change starts.
 *
 * `light` is DERIVED, not lifted: the canvas is dark-only. Same honesty class
 * as `SCROLL_EDGE.lightTint` below — the warm `paper` RGB carried at the
 * canvas's own alpha, so a light page recedes toward paper rather than toward
 * black while both schemes veil by the same amount.
 */
export const MODAL_SCRIM = {
  dark: 'rgba(6,6,8,0.5)',
  light: 'rgba(250,248,245,0.5)',
} as const;

/** Resolve the modal backdrop scrim for a colour scheme. */
export function modalScrim(scheme: GlassScheme): string {
  return scheme === 'dark' ? MODAL_SCRIM.dark : MODAL_SCRIM.light;
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

/**
 * Heights of the stacked scroll-edge blur bands, tallest first.
 *
 * Each band is anchored at the top and blurs what is beneath it, so a point
 * near the top of the strip sits under EVERY band and accumulates the full
 * blur, while a point near the bottom sits under only the first. Heights run
 * from the full height down to `solidStop` × height, which reproduces the
 * canvas mask — solid blur through the first 52%, fading to nothing at 100%.
 */
export function scrollEdgeBandHeights(
  height: number,
  bands: number = SCROLL_EDGE.bands,
  solidStop: number = SCROLL_EDGE.solidStop,
): number[] {
  if (bands <= 1) return [height];
  const out: number[] = [];
  for (let i = 0; i < bands; i += 1) {
    const fade = 1 - i / (bands - 1);
    out.push(height * (solidStop + (1 - solidStop) * fade));
  }
  return out;
}
