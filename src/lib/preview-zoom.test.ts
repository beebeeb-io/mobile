// @ts-nocheck
/**
 * Task 1579 — preview pinch / double-tap zoom helpers.
 */
import { describe, expect, test } from 'bun:test';
import {
  DOUBLE_TAP_MAX_DELAY_MS,
  DOUBLE_TAP_ZOOM_SCALE,
  MAX_ZOOM_SCALE,
  clampZoomScale,
  doubleTapZoomRect,
  isDoubleTap,
  isTapGesture,
  isZoomed,
  shouldBlockPaging,
} from './preview-zoom';

const W = 400;
const H = 800;

describe('clampZoomScale', () => {
  test('keeps the scale inside 1x..100x', () => {
    expect(MAX_ZOOM_SCALE).toBe(100);
    expect(clampZoomScale(0.4)).toBe(1);
    expect(clampZoomScale(3)).toBe(3);
    expect(clampZoomScale(9)).toBe(9);
    expect(clampZoomScale(50)).toBe(50);
    expect(clampZoomScale(100)).toBe(100);
    expect(clampZoomScale(150)).toBe(100);
  });
  test('treats a non-finite scale as 1x', () => {
    expect(clampZoomScale(Number.NaN)).toBe(1);
    expect(clampZoomScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('zoomed -> block paging predicate', () => {
  test('1x (and settle noise just above it) does not block paging', () => {
    expect(shouldBlockPaging(1)).toBe(false);
    expect(shouldBlockPaging(1.000001)).toBe(false);
    expect(shouldBlockPaging(0.8)).toBe(false);
  });
  test('any real zoom blocks paging', () => {
    expect(shouldBlockPaging(1.2)).toBe(true);
    expect(shouldBlockPaging(2.5)).toBe(true);
    expect(shouldBlockPaging(5)).toBe(true);
    expect(isZoomed(1.2)).toBe(true);
  });
});

describe('doubleTapZoomRect', () => {
  test('at 1x zooms to 2.5x centred on the tap point', () => {
    const r = doubleTapZoomRect({ viewportWidth: W, viewportHeight: H, tapX: 200, tapY: 400, currentScale: 1 });
    expect(r.width).toBeCloseTo(W / DOUBLE_TAP_ZOOM_SCALE);
    expect(r.height).toBeCloseTo(H / DOUBLE_TAP_ZOOM_SCALE);
    expect(r.x + r.width / 2).toBeCloseTo(200);
    expect(r.y + r.height / 2).toBeCloseTo(400);
  });

  test('an off-centre tap keeps the tap point in the middle of the rect', () => {
    const r = doubleTapZoomRect({ viewportWidth: W, viewportHeight: H, tapX: 150, tapY: 300, currentScale: 1 });
    expect(r.x).toBeCloseTo(150 - 80);
    expect(r.y).toBeCloseTo(300 - 160);
  });

  test('a tap near the top-left edge shifts the rect inside the content, never past it', () => {
    const r = doubleTapZoomRect({ viewportWidth: W, viewportHeight: H, tapX: 5, tapY: 5, currentScale: 1 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBeCloseTo(160);
  });

  test('a tap near the bottom-right edge shifts the rect inside the content', () => {
    const r = doubleTapZoomRect({ viewportWidth: W, viewportHeight: H, tapX: 399, tapY: 799, currentScale: 1 });
    expect(r.x + r.width).toBeCloseTo(W);
    expect(r.y + r.height).toBeCloseTo(H);
  });

  test('when zoomed, a double-tap returns to the full 1x rect', () => {
    const r = doubleTapZoomRect({ viewportWidth: W, viewportHeight: H, tapX: 50, tapY: 60, currentScale: 3 });
    expect(r).toEqual({ x: 0, y: 0, width: W, height: H });
  });

  test('a target scale above the max is clamped to 100x', () => {
    const r = doubleTapZoomRect({ viewportWidth: W, viewportHeight: H, tapX: 200, tapY: 400, currentScale: 1, targetScale: 150 });
    expect(r.width).toBeCloseTo(W / 100);
    expect(r.height).toBeCloseTo(H / 100);
  });

  test('an unmeasured viewport yields an empty rect instead of NaN', () => {
    const r = doubleTapZoomRect({ viewportWidth: 0, viewportHeight: 0, tapX: 10, tapY: 10, currentScale: 1 });
    expect(r).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('tap classification', () => {
  test('a short, still touch is a tap; a drag or a long press is not', () => {
    expect(isTapGesture({ x: 10, y: 10, t: 0 }, { x: 13, y: 12, t: 120 })).toBe(true);
    expect(isTapGesture({ x: 10, y: 10, t: 0 }, { x: 60, y: 12, t: 120 })).toBe(false);
    expect(isTapGesture({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 900 })).toBe(false);
  });
  test('two nearby taps inside the window are a double-tap', () => {
    expect(isDoubleTap({ x: 100, y: 100, t: 1000 }, { x: 110, y: 104, t: 1200 })).toBe(true);
  });
  test('no previous tap, a slow second tap, or a distant second tap is not a double-tap', () => {
    expect(isDoubleTap(null, { x: 100, y: 100, t: 0 })).toBe(false);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 100, y: 100, t: DOUBLE_TAP_MAX_DELAY_MS + 1 })).toBe(false);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 250, y: 100, t: 100 })).toBe(false);
  });
});
