// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, it } from 'bun:test';
import {
  BLUR_PX_AT_FULL_INTENSITY,
  GLASS_RADII,
  SCROLL_EDGE,
  cssShadow,
  glassMaterial,
  intensityForCssBlur,
  scrollEdgeBandHeights,
  scrollEdgeBandIntensity,
} from './glass-recipe';

describe('intensityForCssBlur', () => {
  it('maps the canvas control blur (26px) into the BlurView range', () => {
    expect(intensityForCssBlur(26)).toBe(76);
  });

  it('maps the canvas scroll-edge blur (18px) into the BlurView range', () => {
    expect(intensityForCssBlur(18)).toBe(53);
  });

  it('puts the calibration constant itself at full intensity', () => {
    expect(intensityForCssBlur(BLUR_PX_AT_FULL_INTENSITY)).toBe(100);
  });

  it('clamps to the 1-100 range expo-blur accepts', () => {
    expect(intensityForCssBlur(0)).toBe(1);
    expect(intensityForCssBlur(-5)).toBe(1);
    expect(intensityForCssBlur(500)).toBe(100);
  });
});

describe('cssShadow', () => {
  it('halves the CSS blur radius into an iOS shadowRadius', () => {
    // Canvas: 0 12px 34px rgba(0,0,0,0.42)
    expect(cssShadow(12, 34, '#000000', 0.42)).toEqual({
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.42,
      shadowRadius: 17,
      elevation: 12,
    });
  });
});

describe('glassMaterial', () => {
  it('carries the canvas dark fill and specular rim verbatim', () => {
    const m = glassMaterial('dark');
    expect(m.fill).toBe('rgba(44,44,50,0.46)');
    expect(m.rimTop).toBe('rgba(255,255,255,0.30)');
    expect(m.rimTopWidth).toBe(0.75);
    expect(m.bubbleFill).toBe('rgba(255,255,255,0.13)');
    expect(m.cssBlurPx).toBe(26);
    expect(m.cssSaturate).toBe(1.9);
    expect(m.sheenAngle).toBe(118);
  });

  it('gives each scheme its own blur tint', () => {
    expect(glassMaterial('dark').tint).toBe('dark');
    expect(glassMaterial('light').tint).toBe('light');
  });

  it('keeps geometry identical across schemes, changing only optics', () => {
    const dark = glassMaterial('dark');
    const light = glassMaterial('light');
    expect(light.rimWidth).toBe(dark.rimWidth);
    expect(light.rimTopWidth).toBe(dark.rimTopWidth);
    expect(light.blurIntensity).toBe(dark.blurIntensity);
    expect(light.sheenAngle).toBe(dark.sheenAngle);
    expect(light.fill).not.toBe(dark.fill);
  });

  it('exposes a three-stop sheen for both schemes', () => {
    for (const scheme of ['light', 'dark']) {
      expect(glassMaterial(scheme).sheen).toHaveLength(3);
    }
  });
});

describe('GLASS_RADII', () => {
  it('holds the canvas concentric ladder', () => {
    expect(GLASS_RADII).toEqual({
      capsule: 999,
      sheet: 38,
      card: 28,
      group: 26,
      tile: 18,
      inner: 13,
    });
  });

  it('descends monotonically below the capsule, so nesting stays concentric', () => {
    const nested = [GLASS_RADII.sheet, GLASS_RADII.card, GLASS_RADII.group, GLASS_RADII.tile, GLASS_RADII.inner];
    for (let i = 1; i < nested.length; i += 1) {
      expect(nested[i]).toBeLessThan(nested[i - 1]);
    }
  });
});

describe('scrollEdgeBandHeights', () => {
  it('starts at the full height so the whole strip gets one blur pass', () => {
    const h = scrollEdgeBandHeights(128);
    expect(h[0]).toBe(128);
  });

  it('ends at the canvas solid stop, so the top 52% gets every pass', () => {
    const h = scrollEdgeBandHeights(128);
    expect(h[h.length - 1]).toBeCloseTo(128 * SCROLL_EDGE.solidStop, 6);
  });

  it('returns one height per band, strictly decreasing', () => {
    const h = scrollEdgeBandHeights(128, 6, 0.52);
    expect(h).toHaveLength(6);
    for (let i = 1; i < h.length; i += 1) {
      expect(h[i]).toBeLessThan(h[i - 1]);
    }
  });

  it('degenerates safely to a single band', () => {
    expect(scrollEdgeBandHeights(128, 1)).toEqual([128]);
    expect(scrollEdgeBandHeights(128, 0)).toEqual([128]);
  });
});

describe('scrollEdgeBandIntensity', () => {
  it('stays inside the range expo-blur accepts', () => {
    for (let i = 0; i < SCROLL_EDGE.bands; i += 1) {
      const v = scrollEdgeBandIntensity(i, SCROLL_EDGE.bands);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('increases towards the top of the stack', () => {
    const first = scrollEdgeBandIntensity(0, SCROLL_EDGE.bands);
    const last = scrollEdgeBandIntensity(SCROLL_EDGE.bands - 1, SCROLL_EDGE.bands);
    expect(last).toBeGreaterThan(first);
  });
});
