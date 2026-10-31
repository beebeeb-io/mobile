// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  MAX_SCALE,
  baseSize,
  fitViewport,
  fullResTransform,
  oneToOneScale,
  panBy,
  pixelZoomPercent,
  viewportForResize,
  zoomAt,
  zoomLabel,
  type Viewport,
} from './compare-viewport';

// A point in image units (fraction of the fitted image) under a pane coordinate.
function imagePointAt(v: Viewport, px: number, py: number) {
  return { u: (px - v.x) / v.scale, w: (py - v.y) / v.scale };
}

describe('zoomAt', () => {
  test('keeps the focal point fixed', () => {
    const v: Viewport = { scale: 1.5, x: 20, y: -30 };
    const before = imagePointAt(v, 120, 200);
    const next = zoomAt(v, 120, 200, 2);
    const after = imagePointAt(next, 120, 200);
    expect(next.scale).toBeCloseTo(3);
    expect(after.u).toBeCloseTo(before.u);
    expect(after.w).toBeCloseTo(before.w);
  });

  test('clamps to min and max', () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0, 0, 0.1).scale).toBe(1);
    expect(zoomAt({ scale: 5, x: 0, y: 0 }, 0, 0, 1e9, 1, 8).scale).toBe(8);
    expect(zoomAt({ scale: 5, x: 0, y: 0 }, 0, 0, 1e9).scale).toBe(MAX_SCALE);
  });
});

describe('baseSize / fitViewport', () => {
  test('fits a wide image to the width and a tall one to the height', () => {
    expect(baseSize({ w: 400, h: 300 }, 2)).toEqual({ w: 400, h: 200 });
    expect(baseSize({ w: 400, h: 300 }, 0.5)).toEqual({ w: 150, h: 300 });
  });
  test('centres the fitted image', () => {
    expect(fitViewport({ w: 400, h: 300 }, { w: 400, h: 200 })).toEqual({ scale: 1, x: 0, y: 50 });
  });
});

describe('viewportForResize', () => {
  test('keeps the same image point at the centre', () => {
    const oldBox = { w: 400, h: 300 };
    const newBox = { w: 400, h: 700 };
    const aspect = 1.5;
    // A point well inside the image, so keeping it centred needs no clamp.
    const v: Viewport = { scale: 3, x: -250, y: -250 };
    const ob = baseSize(oldBox, aspect);
    const nb = baseSize(newBox, aspect);
    const cBefore = {
      u: (oldBox.w / 2 - v.x) / v.scale / ob.w,
      w: (oldBox.h / 2 - v.y) / v.scale / ob.h,
    };
    const next = viewportForResize(v, oldBox, newBox, aspect);
    const cAfter = {
      u: (newBox.w / 2 - next.x) / next.scale / nb.w,
      w: (newBox.h / 2 - next.y) / next.scale / nb.h,
    };
    expect(cAfter.u).toBeCloseTo(cBefore.u);
    expect(cAfter.w).toBeCloseTo(cBefore.w);
  });

  test('fit stays fit', () => {
    const aspect = 1.5;
    const oldBox = { w: 400, h: 300 };
    const newBox = { w: 400, h: 700 };
    const fitOld = fitViewport(oldBox, baseSize(oldBox, aspect));
    const next = viewportForResize(fitOld, oldBox, newBox, aspect);
    const fitNew = fitViewport(newBox, baseSize(newBox, aspect));
    expect(next.x).toBeCloseTo(fitNew.x);
    expect(next.y).toBeCloseTo(fitNew.y);
    expect(next.scale).toBe(1);
  });
});

describe('oneToOneScale', () => {
  test('one image pixel per device pixel', () => {
    // 4000 px original shown 400 pt wide on a 3x screen: 4000/400/3
    expect(oneToOneScale(4000, 400, 3)).toBeCloseTo(3.3333, 3);
  });
  test('never below 1 for small originals', () => {
    expect(oneToOneScale(300, 400, 3)).toBe(1);
  });
});

describe('panBy', () => {
  test('moves and keeps the image covering the pane when zoomed', () => {
    const box = { w: 400, h: 300 };
    const base = { w: 400, h: 300 };
    const v: Viewport = { scale: 2, x: 0, y: 0 };
    expect(panBy(v, 50, 50, box, base)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panBy(v, -50, -20, box, base)).toEqual({ scale: 2, x: -50, y: -20 });
    expect(panBy(v, -9999, 0, box, base).x).toBe(-400);
  });
  test('centres when the image is smaller than the pane', () => {
    const box = { w: 400, h: 700 };
    const base = { w: 400, h: 267 };
    const v = panBy({ scale: 1, x: 10, y: 10 }, 0, 0, box, base);
    expect(v.x).toBe(0);
    expect(v.y).toBeCloseTo((700 - 267) / 2);
  });
});

describe('fullResTransform', () => {
  // The visible rect of a centre-scaled element: centre = layout/2 + translate, size = layout * scale.
  const visible = (t: ReturnType<typeof fullResTransform>, layout: { w: number; h: number }) => ({
    left: layout.w / 2 + t.translateX - (layout.w * t.scaleX) / 2,
    top: layout.h / 2 + t.translateY - (layout.h * t.scaleY) / 2,
    width: layout.w * t.scaleX,
    height: layout.h * t.scaleY,
  });

  test('a full-resolution layout covers exactly the rect the fitted image would', () => {
    const base = { w: 390, h: 260 };
    for (const v of [
      { scale: 1, x: 0, y: 70 },
      { scale: 3.5, x: -420, y: -300 },
      { scale: 40, x: -9000, y: -4000 },
    ]) {
      for (const layout of [{ w: 1280, h: 853.3 }, { w: 853.3, h: 568.9 }]) {
        const r = visible(fullResTransform(v, base, layout), layout);
        expect(r.left).toBeCloseTo(v.x, 6);
        expect(r.top).toBeCloseTo(v.y, 6);
        expect(r.width).toBeCloseTo(base.w * v.scale, 6);
        expect(r.height).toBeCloseTo(base.h * v.scale, 6);
      }
    }
  });

  test('images of different pixel size land on the same rect (panes stay aligned)', () => {
    const base = { w: 400, h: 300 };
    const v = { scale: 6, x: -700, y: -500 };
    const a = visible(fullResTransform(v, base, { w: 1280, h: 960 }), { w: 1280, h: 960 });
    const b = visible(fullResTransform(v, base, { w: 853, h: 640 }), { w: 853, h: 640 });
    expect(a.left).toBeCloseTo(b.left, 6);
    expect(a.width).toBeCloseTo(b.width, 6);
  });

  test('1:1 maps one image pixel to one device pixel', () => {
    const base = { w: 400, h: 300 };
    const ratio = 3;
    const layout = { w: 3840 / ratio, h: 2880 / ratio };
    const s = oneToOneScale(3840, base.w, ratio);
    const t = fullResTransform({ scale: s, x: 0, y: 0 }, base, layout);
    // Rendered points per image pixel = layout / pixel * scaleX = 1 / ratio.
    expect((layout.w / 3840) * t.scaleX).toBeCloseTo(1 / ratio, 9);
  });
});

describe('two images of different pixel sizes across modes', () => {
  // Portrait original copy 2560x3840 and a 720p preview 853x1280 of the same photo,
  // on a 3x screen; Stacked panes are half the height of the Wipe / Hold pane.
  const ratio = 3;
  const original = { w: 2560, h: 3840 };
  const preview = { w: 853, h: 1280 };
  const aspect = original.w / original.h;
  const wipeBox = { w: 440, h: 676 };
  const stackBox = { w: 440, h: (676 - 4) / 2 };
  const layoutOf = (px: { w: number; h: number }) => ({ w: px.w / ratio, h: px.h / ratio });
  // Where an image point (fractions of the image) lands in the pane for an image laid out at `px`.
  const landing = (v: Viewport, box: { w: number; h: number }, px: { w: number; h: number }, u: number, w: number) => {
    const base = baseSize(box, aspect);
    const layout = layoutOf(px);
    const t = fullResTransform(v, base, layout);
    const cx = layout.w / 2 + t.translateX;
    const cy = layout.h / 2 + t.translateY;
    return { x: cx + (u * layout.w - layout.w / 2) * t.scaleX, y: cy + (w * layout.h - layout.h / 2) * t.scaleY };
  };
  const points = [[0.1, 0.2], [0.5, 0.5], [0.73, 0.91]];

  test('1:1 in Stacked stays 1:1 in Wipe (same size on screen), label reads 1:1 in both', () => {
    const sb = baseSize(stackBox, aspect);
    const s = oneToOneScale(original.w, sb.w, ratio);
    const stacked = panBy(zoomAt(fitViewport(stackBox, sb), stackBox.w / 2, stackBox.h / 2, s), 0, 0, stackBox, sb);
    expect(zoomLabel(stacked.scale, sb.w, original.w, ratio)).toBe('1:1');

    const wipe = viewportForResize(stacked, stackBox, wipeBox, aspect);
    const wb = baseSize(wipeBox, aspect);
    expect(zoomLabel(wipe.scale, wb.w, original.w, ratio)).toBe('1:1');
    expect(pixelZoomPercent(wipe.scale, wb.w, original.w, ratio)).toBe(100);
    // Points per original pixel are the same before and after the switch.
    expect((wb.w * wipe.scale) / original.w).toBeCloseTo((sb.w * stacked.scale) / original.w, 9);
    // And it is exactly one device pixel per original pixel.
    expect(((wb.w * wipe.scale) / original.w) * ratio).toBeCloseTo(1, 2);
  });

  test('both images put every image point on the same pane point, in every mode and zoom', () => {
    for (const box of [stackBox, wipeBox]) {
      const base = baseSize(box, aspect);
      for (const v of [
        fitViewport(box, base),
        { scale: oneToOneScale(original.w, base.w, ratio), x: -300, y: -500 },
        { scale: 12, x: -2000, y: -3000 },
      ]) {
        for (const [u, w] of points) {
          const a = landing(v, box, original, u, w);
          const b = landing(v, box, preview, u, w);
          expect(b.x).toBeCloseTo(a.x, 6);
          expect(b.y).toBeCloseTo(a.y, 6);
        }
      }
    }
  });

  test('a mode switch keeps the centre point, and Wipe and Hold share one viewport', () => {
    const sb = baseSize(stackBox, aspect);
    const v = { scale: 5, x: -600, y: -900 };
    const centreBefore = { u: (stackBox.w / 2 - v.x) / v.scale / sb.w, w: (stackBox.h / 2 - v.y) / v.scale / sb.h };
    const next = viewportForResize(v, stackBox, wipeBox, aspect);
    const wb = baseSize(wipeBox, aspect);
    const centre = landing(next, wipeBox, preview, centreBefore.u, centreBefore.w);
    expect(centre.x).toBeCloseTo(wipeBox.w / 2, 6);
    expect(centre.y).toBeCloseTo(wipeBox.h / 2, 6);
    expect(wb.w * next.scale).toBeCloseTo(sb.w * v.scale, 6);
  });
});

describe('zoomLabel', () => {
  test('Fit at scale 1, 1:1 at one original pixel per device pixel, else a percentage of the original pixels', () => {
    expect(zoomLabel(1, 400, 4000, 3)).toBe('Fit');
    expect(zoomLabel(4000 / 400 / 3, 400, 4000, 3)).toBe('1:1');
    expect(zoomLabel((2 * 4000) / 400 / 3, 400, 4000, 3)).toBe('200%');
    expect(zoomLabel(1.5, 400, 4000, 3)).toBe('45%');
  });
  test('never a factor relative to Fit', () => {
    // The e2e case: 1:1 in a 224 pt wide Stacked fit reads 1:1, not 380%.
    expect(zoomLabel(2560 / 224 / 3, 224, 2560, 3)).toBe('1:1');
  });
});

describe('viewportForResize keeps the image inside the pane', () => {
  const { viewportForResize, panBy, baseSize } = require('./compare-viewport');

  test('zoomed into a corner in Wipe, switching to Stacked leaves no empty edge', () => {
    const wipe = { w: 440, h: 800 };
    const stacked = { w: 440, h: 390 };
    const aspect = 2 / 3;
    const wb = baseSize(wipe, aspect);
    // Panned to the bottom-right corner at 4x.
    const corner = panBy({ scale: 4, x: 0, y: 0 }, -1e6, -1e6, wipe, wb);
    const next = viewportForResize(corner, wipe, stacked, aspect);
    const sb = baseSize(stacked, aspect);
    expect(panBy(next, 0, 0, stacked, sb)).toEqual(next);
  });
});

test('zoomed into a corner in Stacked, switching to Wipe leaves no empty edge', () => {
  const { viewportForResize, panBy, baseSize } = require('./compare-viewport');
  const wipe = { w: 440, h: 800 };
  const stacked = { w: 440, h: 390 };
  const aspect = 2 / 3;
  const corner = panBy({ scale: 3, x: 0, y: 0 }, -1e6, -1e6, stacked, baseSize(stacked, aspect));
  const next = viewportForResize(corner, stacked, wipe, aspect);
  expect(panBy(next, 0, 0, wipe, baseSize(wipe, aspect))).toEqual(next);
});
