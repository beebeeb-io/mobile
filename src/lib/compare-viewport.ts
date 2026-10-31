/**
 * Pure viewport math for the photo preview compare view.
 *
 * Every image is drawn at the same "base" size (the original's aspect fitted
 * into the pane), then transformed by one shared viewport: the image's top-left
 * sits at (x, y) in pane coordinates and it is magnified by `scale`. Because
 * the same viewport is applied to a downsampled original and to an encoded
 * preview, both show exactly the same spot whatever their pixel dimensions.
 */

export type Viewport = { scale: number; x: number; y: number };
export type Box = { w: number; h: number };

export const MIN_SCALE = 1;
export const MAX_SCALE = 40;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Size of the image fitted into a box (contain), for an aspect ratio width / height. */
export function baseSize(box: Box, aspect: number): Box {
  if (box.w <= 0 || box.h <= 0 || !(aspect > 0)) return { w: Math.max(box.w, 0), h: Math.max(box.h, 0) };
  return box.w / box.h > aspect ? { w: box.h * aspect, h: box.h } : { w: box.w, h: box.w / aspect };
}

/** Scale 1, image centred in the box. */
export function fitViewport(box: Box, base: Box): Viewport {
  return { scale: 1, x: (box.w - base.w) / 2, y: (box.h - base.h) / 2 };
}

/** Multiply the scale by `factor`, keeping the pane point (focalX, focalY) over the same image point. */
export function zoomAt(
  v: Viewport,
  focalX: number,
  focalY: number,
  factor: number,
  min: number = MIN_SCALE,
  max: number = MAX_SCALE,
): Viewport {
  const scale = clamp(v.scale * factor, min, max);
  const k = scale / v.scale;
  return { scale, x: focalX - (focalX - v.x) * k, y: focalY - (focalY - v.y) * k };
}

/**
 * Scale at which one image pixel covers one device pixel. `displayedWidth` is
 * the fitted (scale 1) width in points. Never below fit (1).
 */
export function oneToOneScale(originalWidth: number, displayedWidth: number, pixelRatio: number): number {
  if (!(displayedWidth > 0) || !(pixelRatio > 0)) return 1;
  return Math.max(1, originalWidth / displayedWidth / pixelRatio);
}

/** Zoom to `scale` around the centre of the box (used for fit <-> 1:1). */
export function zoomToScaleAtCentre(v: Viewport, box: Box, scale: number): Viewport {
  return zoomAt(v, box.w / 2, box.h / 2, scale / v.scale, MIN_SCALE, Math.max(MAX_SCALE, scale));
}

/**
 * Transform for an image laid out at its full pixel size in points
 * (`pixel / PixelRatio`, so the platform decodes every pixel) that must look
 * exactly like the fitted `base` image magnified by `v`. Transforms run about
 * the element's centre, so the fit factor is folded into the scale and the
 * translation moves the centre to where the scaled fitted image's centre sits.
 */
export function fullResTransform(
  v: Viewport,
  base: Box,
  layout: Box,
): { translateX: number; translateY: number; scaleX: number; scaleY: number } {
  if (layout.w <= 0 || layout.h <= 0) return { translateX: v.x, translateY: v.y, scaleX: v.scale, scaleY: v.scale };
  return {
    translateX: v.x + (base.w * v.scale - layout.w) / 2,
    translateY: v.y + (base.h * v.scale - layout.h) / 2,
    scaleX: (base.w / layout.w) * v.scale,
    scaleY: (base.h / layout.h) * v.scale,
  };
}

/**
 * Keep the image covering the box (or centred on an axis where it is smaller).
 * Also applies a pan delta first.
 */
export function panBy(v: Viewport, dx: number, dy: number, box: Box, base: Box): Viewport {
  const w = base.w * v.scale;
  const h = base.h * v.scale;
  const axis = (pos: number, size: number, boxSize: number) =>
    size <= boxSize ? (boxSize - size) / 2 : clamp(pos, boxSize - size, 0);
  return { scale: v.scale, x: axis(v.x + dx, w, box.w), y: axis(v.y + dy, h, box.h) };
}

/**
 * Zoom as a percentage of the original's own pixels: 100 means one original
 * pixel per device pixel (1:1). `displayedWidth` is the fitted (scale 1) width
 * in points, so the same image pixels per device pixel read the same number in
 * every mode, whatever the pane size.
 */
export function pixelZoomPercent(scale: number, displayedWidth: number, originalWidth: number, pixelRatio: number): number {
  if (!(originalWidth > 0) || !(displayedWidth > 0) || !(pixelRatio > 0)) return Math.round(scale * 100);
  return Math.round(((scale * displayedWidth * pixelRatio) / originalWidth) * 100);
}

/** Label for the zoom readout: "Fit", "1:1" at one original pixel per device pixel, else that percentage. */
export function zoomLabel(scale: number, displayedWidth: number, originalWidth: number, pixelRatio: number): string {
  if (scale <= 1.01) return 'Fit';
  const pct = pixelZoomPercent(scale, displayedWidth, originalWidth, pixelRatio);
  return Math.abs(pct - 100) <= 1 ? '1:1' : `${pct}%`;
}

/**
 * The box changed (mode switch): keep the image point at the centre of the
 * pane at the centre, at the same size on screen (points per image pixel), so
 * 1:1 in Stacked is still 1:1 in Wipe and Hold to flip. Fit stays fit, the
 * result is never smaller than fit, and the image still covers the pane.
 */
export function viewportForResize(v: Viewport, oldBox: Box, newBox: Box, aspect: number): Viewport {
  const ob = baseSize(oldBox, aspect);
  const nb = baseSize(newBox, aspect);
  if (ob.w <= 0 || ob.h <= 0 || nb.w <= 0 || nb.h <= 0) return v;
  if (v.scale <= 1 + 1e-9) return fitViewport(newBox, nb);
  const scale = Math.max(MIN_SCALE, (v.scale * ob.w) / nb.w);
  const cu = (oldBox.w / 2 - v.x) / v.scale / ob.w;
  const cw = (oldBox.h / 2 - v.y) / v.scale / ob.h;
  return panBy({ scale, x: newBox.w / 2 - cu * nb.w * scale, y: newBox.h / 2 - cw * nb.h * scale }, 0, 0, newBox, nb);
}
