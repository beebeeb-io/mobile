/**
 * Task 1579 — pure math + predicates behind the preview's pinch / double-tap
 * zoom (`src/components/preview/ZoomableImage.tsx`). Kept free of any
 * react-native import so it runs under `bun test` directly.
 *
 * Coordinate model: the zoomable content view is exactly the viewport's size
 * (the image sits inside it with `resizeMode="contain"`), so at 1x a tap's
 * `locationX/Y` on the content view IS a point in content coordinates, and
 * the rect handed to `scrollResponderZoomTo` is in those same coordinates.
 */

export const MIN_ZOOM_SCALE = 1;
export const MAX_ZOOM_SCALE = 5;
/** Double-tap from 1x lands here (iOS Photos uses a similar ~2-3x step). */
export const DOUBLE_TAP_ZOOM_SCALE = 2.5;
/**
 * UIScrollView reports fractional scales while a pinch settles back to 1x
 * (1.0000001 etc.) — anything under this counts as "not zoomed".
 */
export const ZOOMED_EPSILON = 0.01;

/** Two taps closer than this in time (ms) and space (pt) form a double-tap. */
export const DOUBLE_TAP_MAX_DELAY_MS = 280;
export const DOUBLE_TAP_MAX_DISTANCE = 40;
/** Same thresholds the photo pager already uses to tell a tap from a swipe. */
export const TAP_MAX_MOVEMENT = 10;
export const TAP_MAX_DURATION_MS = 500;

export interface ZoomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TapSample {
  x: number;
  y: number;
  t: number;
}

export function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_ZOOM_SCALE;
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale));
}

export function isZoomed(scale: number): boolean {
  return clampZoomScale(scale) > MIN_ZOOM_SCALE + ZOOMED_EPSILON;
}

/**
 * The photo pager must not page (and the header's swipe-down-to-close must
 * not fire) while the current image is zoomed: a horizontal drag belongs to
 * panning the zoomed image. At 1x everything behaves exactly as before.
 */
export function shouldBlockPaging(scale: number): boolean {
  return isZoomed(scale);
}

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The rect to zoom to for a double-tap.
 *
 * - Zoomed in (any scale above 1x): back to the whole content (1x).
 * - At 1x: a `DOUBLE_TAP_ZOOM_SCALE` rect centred on the tap point, shifted
 *   (not shrunk) so it stays inside the content — a tap near an edge zooms
 *   toward that edge instead of showing empty space past it.
 */
export function doubleTapZoomRect(input: {
  viewportWidth: number;
  viewportHeight: number;
  tapX: number;
  tapY: number;
  currentScale: number;
  targetScale?: number;
}): ZoomRect {
  const { viewportWidth: w, viewportHeight: h } = input;
  if (!(w > 0) || !(h > 0)) return { x: 0, y: 0, width: Math.max(0, w), height: Math.max(0, h) };
  if (isZoomed(input.currentScale)) return { x: 0, y: 0, width: w, height: h };
  const scale = clampZoomScale(input.targetScale ?? DOUBLE_TAP_ZOOM_SCALE);
  const width = w / scale;
  const height = h / scale;
  const tapX = clamp(input.tapX, 0, w);
  const tapY = clamp(input.tapY, 0, h);
  return {
    x: clamp(tapX - width / 2, 0, w - width),
    y: clamp(tapY - height / 2, 0, h - height),
    width,
    height,
  };
}

/** A touch that moved less than a few points and ended quickly is a tap. */
export function isTapGesture(start: TapSample, end: TapSample): boolean {
  return (
    Math.abs(end.x - start.x) < TAP_MAX_MOVEMENT
    && Math.abs(end.y - start.y) < TAP_MAX_MOVEMENT
    && end.t - start.t < TAP_MAX_DURATION_MS
  );
}

/** Whether `tap` completes a double-tap begun by `previous` (both tap ENDs). */
export function isDoubleTap(previous: TapSample | null, tap: TapSample): boolean {
  if (!previous) return false;
  const dt = tap.t - previous.t;
  if (dt < 0 || dt > DOUBLE_TAP_MAX_DELAY_MS) return false;
  return Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_MAX_DISTANCE;
}
