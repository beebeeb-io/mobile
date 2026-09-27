/**
 * WCAG contrast math — pure, RN-free (task 1563 round 4, "preview chrome
 * legibility").
 *
 * Why this exists: the Preview screen's floating glass bars sit over
 * ARBITRARY content (a white PDF page, a black photo, a mid-grey image) —
 * unlike the rest of the app's glass, which floats over KNOWN, themed
 * surfaces (`glass-recipe.ts`'s own doc comment on `GlassMaterial`). "Looks
 * fine on the simulator" is not evidence for that claim; a computed WCAG
 * contrast ratio against the WORST case ground is. See
 * `glass-recipe.ts`'s `PREVIEW_CHROME_MATERIAL` for the material this
 * verifies, and `contrast.test.ts` for the mutation proof.
 */

export type RGB = { r: number; g: number; b: number };

/** WCAG 2.x's AA threshold for normal-weight text. */
export const WCAG_AA_NORMAL_TEXT = 4.5;

export const WHITE: RGB = { r: 255, g: 255, b: 255 };
export const BLACK: RGB = { r: 0, g: 0, b: 0 };
export const MID_GREY: RGB = { r: 128, g: 128, b: 128 };

/** The three grounds Preview's chrome is required to stay legible over. */
export const PREVIEW_WORST_CASE_GROUNDS: readonly RGB[] = [WHITE, BLACK, MID_GREY];

function parseHexColor(input: string): RGB {
  const hex = input.replace('#', '').trim();
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const num = Number.parseInt(full.slice(0, 6), 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function parseRgbaColor(input: string): { rgb: RGB; alpha: number } {
  const match = input.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/,
  );
  if (!match) {
    throw new Error(`contrast.ts: not a recognized rgb()/rgba() color: "${input}"`);
  }
  return {
    rgb: { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) },
    alpha: match[4] !== undefined ? Number(match[4]) : 1,
  };
}

/** Parse a `#rgb`/`#rrggbb` or `rgb()`/`rgba()` CSS color string. */
export function parseColor(input: string): { rgb: RGB; alpha: number } {
  return input.trim().startsWith('#')
    ? { rgb: parseHexColor(input), alpha: 1 }
    : parseRgbaColor(input);
}

/** Alpha-composite a (possibly translucent) foreground over an OPAQUE background. */
export function blendOver(fg: { rgb: RGB; alpha: number }, bg: RGB): RGB {
  const a = fg.alpha;
  return {
    r: fg.rgb.r * a + bg.r * (1 - a),
    g: fg.rgb.g * a + bg.g * (1 - a),
    b: fg.rgb.b * a + bg.b * (1 - a),
  };
}

function srgbToLinear(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB color, 0 (black) – 1 (white). */
export function relativeLuminance(rgb: RGB): number {
  return (
    0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b)
  );
}

/** WCAG contrast ratio between two sRGB colors, 1 (none) – 21 (max). */
export function contrastRatio(a: RGB, b: RGB): number {
  const lA = relativeLuminance(a);
  const lB = relativeLuminance(b);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The WORST (lowest) contrast ratio a translucent bar `fill` achieves for a
 * (possibly also translucent) `label` color, across every ground in
 * `grounds` — the label itself is composited over the ALREADY-composited bar
 * background per ground, matching how two stacked semi-transparent layers
 * actually render (a `labelMuted` token is rarely fully opaque).
 */
export function worstCaseBarContrast(fill: string, label: string, grounds: readonly RGB[]): number {
  const parsedFill = parseColor(fill);
  const parsedLabel = parseColor(label);
  let worst = Infinity;
  for (const ground of grounds) {
    const barBg = blendOver(parsedFill, ground);
    const renderedLabel = blendOver(parsedLabel, barBg);
    const ratio = contrastRatio(renderedLabel, barBg);
    if (ratio < worst) worst = ratio;
  }
  return worst;
}
