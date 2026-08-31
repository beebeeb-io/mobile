/**
 * Minimal CSS-gradient maths for the glass primitives (task 1311).
 *
 * Why this exists instead of `expo-linear-gradient`: that is a NATIVE module,
 * and adding one forces a dev-client / prebuild rebuild across the team for a
 * 0.10-alpha specular sheen. The canvas gradients are all low-alpha and
 * short-ranged, so a stepped approximation (a stack of flat bands) is
 * indistinguishable at these opacities and costs nothing but a few Views.
 *
 * Pure functions only — no React, no react-native. Unit-tested.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** A gradient stop: `pos` is 0–1 along the gradient axis. */
export type Stop = { pos: number; color: string };

const RGB_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parse `rgb()`, `rgba()` or a 3/6/8-digit hex colour.
 * Throws on anything else — a silently-wrong colour is a bug we want loud.
 */
export function parseColor(css: string): Rgba {
  const input = css.trim();

  const rgb = RGB_RE.exec(input);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }

  const hex = HEX_RE.exec(input);
  if (hex) {
    let body = hex[1];
    if (body.length === 3) body = body.replace(/./g, (ch) => ch + ch);
    const int = parseInt(body, 16);
    if (body.length === 8) {
      return {
        r: (int >>> 24) & 0xff,
        g: (int >>> 16) & 0xff,
        b: (int >>> 8) & 0xff,
        a: (int & 0xff) / 255,
      };
    }
    return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff, a: 1 };
  }

  throw new Error(`parseColor: unsupported colour "${css}"`);
}

/** Format back to an `rgba()` string React Native accepts. */
export function formatRgba(c: Rgba): string {
  const round = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const alpha = Math.max(0, Math.min(1, c.a));
  return `rgba(${round(c.r)}, ${round(c.g)}, ${round(c.b)}, ${Number(alpha.toFixed(4))})`;
}

/**
 * Sample a piecewise-linear gradient at `t` (0–1).
 *
 * Stops must be sorted by `pos`. Before the first stop and after the last the
 * gradient holds that stop's colour, which is exactly how CSS behaves.
 */
export function sampleStops(stops: readonly Stop[], t: number): string {
  if (stops.length === 0) throw new Error('sampleStops: no stops');

  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t <= first.pos) return formatRgba(parseColor(first.color));
  if (t >= last.pos) return formatRgba(parseColor(last.color));

  // Walk to the last segment that starts at or before `t`. Advancing past any
  // segment whose END is also <= t is what makes coincident stops a hard
  // break: the later duplicate wins, exactly as CSS renders it.
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1].pos <= t) i += 1;

  const a = stops[i];
  const b = stops[i + 1];
  const span = b.pos - a.pos;
  const f = span === 0 ? 1 : (t - a.pos) / span;
  const ca = parseColor(a.color);
  const cb = parseColor(b.color);
  return formatRgba({
    r: ca.r + (cb.r - ca.r) * f,
    g: ca.g + (cb.g - ca.g) * f,
    b: ca.b + (cb.b - ca.b) * f,
    a: ca.a + (cb.a - ca.a) * f,
  });
}

/**
 * Flatten a gradient into `count` bands, each sampled at its own midpoint.
 *
 * Midpoint rather than leading edge so the banded approximation has no bias
 * against the true gradient — the average error is centred on zero.
 */
export function bandColors(stops: readonly Stop[], count: number): string[] {
  if (count < 1) throw new Error('bandColors: count must be >= 1');
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(sampleStops(stops, (i + 0.5) / count));
  }
  return out;
}

/**
 * Rotation to apply to a top-to-bottom band stack so it reads as a CSS
 * gradient at `angle` degrees.
 *
 * CSS 0deg points up and increases clockwise, so a plain downward stack is
 * already 180deg; the element only needs the difference.
 */
export function rotationForCssAngle(angle: number): string {
  return `${angle - 180}deg`;
}
