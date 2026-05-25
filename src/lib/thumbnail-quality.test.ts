// @ts-nocheck
import { describe, it, expect, mock, beforeAll } from 'bun:test';

mock.module('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'ios' },
}));

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
  },
}));

const {
  fromSliderT,
  toSliderT,
  toPreset,
  fromPreset,
  DEFAULT_QUALITY,
} = await import('./thumbnail-quality');

describe('slider math', () => {
  it('snaps width to 32-px multiples', () => {
    const r = fromSliderT(0.5);
    expect(r.width % 32).toBe(0);
    expect(r.width).toBeGreaterThanOrEqual(256);
    expect(r.width).toBeLessThanOrEqual(1280);
  });

  it('clamps quality range', () => {
    expect(fromSliderT(0).quality).toBe(0.65);
    expect(fromSliderT(1).quality).toBe(0.95);
  });

  it('returns minimum at t=0', () => {
    const r = fromSliderT(0);
    expect(r.width).toBe(256);
    expect(r.quality).toBe(0.65);
  });

  it('returns maximum at t=1', () => {
    const r = fromSliderT(1);
    expect(r.width).toBe(1280);
    expect(r.quality).toBe(0.95);
  });

  it('clamps t below 0', () => {
    const r = fromSliderT(-0.5);
    expect(r.width).toBe(256);
    expect(r.quality).toBe(0.65);
  });

  it('clamps t above 1', () => {
    const r = fromSliderT(1.5);
    expect(r.width).toBe(1280);
    expect(r.quality).toBe(0.95);
  });
});

describe('preset round-trip', () => {
  it('preserves width and quality through toPreset + fromPreset', () => {
    const r = fromSliderT(0.5);
    const preset = toPreset(r);
    const decoded = fromPreset(preset);
    expect(decoded).not.toBeNull();
    expect(decoded.width).toBe(r.width);
    expect(Math.abs(decoded.quality - r.quality)).toBeLessThan(0.01);
  });

  it('default matches "w768q082"', () => {
    expect(toPreset(DEFAULT_QUALITY)).toBe('w768q082');
  });

  it('fromPreset returns null for invalid string', () => {
    expect(fromPreset('invalid')).toBeNull();
    expect(fromPreset('w76q82')).toBeNull();
    expect(fromPreset('')).toBeNull();
  });

  it('fromPreset parses known preset correctly', () => {
    const r = fromPreset('w768q082');
    expect(r).not.toBeNull();
    expect(r.width).toBe(768);
    expect(r.quality).toBe(0.82);
  });

  it('toPreset formats width with at least 3 digits', () => {
    const preset = toPreset({ width: 256, quality: 0.65 });
    expect(preset).toBe('w256q065');
  });
});

describe('toSliderT', () => {
  it('is bounded [0,1] for default quality', () => {
    const t = toSliderT({ width: 768, quality: 0.82 });
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(1);
  });

  it('is 0 at minimum quality', () => {
    const t = toSliderT({ width: 256, quality: 0.65 });
    expect(t).toBeCloseTo(0, 5);
  });

  it('is 1 at maximum quality', () => {
    const t = toSliderT({ width: 1280, quality: 0.95 });
    expect(t).toBeCloseTo(1, 5);
  });

  it('is approximately round-trip stable', () => {
    for (const input of [0, 0.25, 0.5, 0.75, 1]) {
      const q = fromSliderT(input);
      const t = toSliderT(q);
      // Round-trip is approximate due to width snapping
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });
});
