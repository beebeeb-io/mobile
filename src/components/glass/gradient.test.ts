// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, it } from 'bun:test';
import {
  bandColors,
  formatRgba,
  parseColor,
  rotationForCssAngle,
  sampleStops,
  type Stop,
} from './gradient';

describe('parseColor', () => {
  it('parses rgba() with a fractional alpha', () => {
    expect(parseColor('rgba(255,255,255,0.30)')).toEqual({ r: 255, g: 255, b: 255, a: 0.3 });
  });

  it('parses rgb() as fully opaque', () => {
    expect(parseColor('rgb(44, 44, 50)')).toEqual({ r: 44, g: 44, b: 50, a: 1 });
  });

  it('parses 6-digit hex', () => {
    expect(parseColor('#1C1C21')).toEqual({ r: 28, g: 28, b: 33, a: 1 });
  });

  it('parses 3-digit hex by doubling each nibble', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('parses 8-digit hex with alpha', () => {
    const c = parseColor('#0C0C0D80');
    expect(c.r).toBe(12);
    expect(c.b).toBe(13);
    expect(c.a).toBeCloseTo(0.502, 2);
  });

  it('throws rather than silently returning a wrong colour', () => {
    expect(() => parseColor('oklch(0.82 0.17 84)')).toThrow();
  });
});

describe('sampleStops', () => {
  // The canvas sheen: linear-gradient(118deg, rgba(255,255,255,0.10) 0%,
  // rgba(255,255,255,0.02) 34%, transparent 58%)
  const sheen: Stop[] = [
    { pos: 0, color: 'rgba(255,255,255,0.10)' },
    { pos: 0.34, color: 'rgba(255,255,255,0.02)' },
    { pos: 0.58, color: 'rgba(255,255,255,0)' },
  ];

  it('holds the first stop before the gradient starts', () => {
    expect(sampleStops(sheen, 0)).toBe('rgba(255, 255, 255, 0.1)');
    expect(sampleStops(sheen, -1)).toBe('rgba(255, 255, 255, 0.1)');
  });

  it('holds the last stop past the end, as CSS does', () => {
    expect(sampleStops(sheen, 0.58)).toBe('rgba(255, 255, 255, 0)');
    expect(sampleStops(sheen, 1)).toBe('rgba(255, 255, 255, 0)');
  });

  it('interpolates alpha linearly between two stops', () => {
    // Halfway from 0% to 34% => halfway from 0.10 to 0.02 => 0.06
    expect(parseColor(sampleStops(sheen, 0.17)).a).toBeCloseTo(0.06, 4);
  });

  it('interpolates rgb channels, not just alpha', () => {
    const ramp: Stop[] = [
      { pos: 0, color: 'rgb(0,0,0)' },
      { pos: 1, color: 'rgb(100,200,50)' },
    ];
    expect(parseColor(sampleStops(ramp, 0.5))).toEqual({ r: 50, g: 100, b: 25, a: 1 });
  });

  it('treats coincident stops as a hard colour break', () => {
    const hard: Stop[] = [
      { pos: 0, color: 'rgb(0,0,0)' },
      { pos: 0.5, color: 'rgb(0,0,0)' },
      { pos: 0.5, color: 'rgb(255,255,255)' },
      { pos: 1, color: 'rgb(255,255,255)' },
    ];
    expect(parseColor(sampleStops(hard, 0.5)).r).toBe(255);
  });

  it('throws on an empty stop list', () => {
    expect(() => sampleStops([], 0.5)).toThrow();
  });
});

describe('bandColors', () => {
  const sheen: Stop[] = [
    { pos: 0, color: 'rgba(255,255,255,0.10)' },
    { pos: 0.34, color: 'rgba(255,255,255,0.02)' },
    { pos: 0.58, color: 'rgba(255,255,255,0)' },
  ];

  it('returns exactly the requested number of bands', () => {
    expect(bandColors(sheen, 16)).toHaveLength(16);
  });

  it('samples midpoints, so no band sits on an endpoint', () => {
    const [first] = bandColors(sheen, 2);
    // Midpoint of the first of two bands is t=0.25, alpha ~0.0412 -- not 0.10.
    expect(parseColor(first).a).toBeCloseTo(0.0412, 3);
  });

  it('decreases monotonically in alpha for the sheen ramp', () => {
    const alphas = bandColors(sheen, 12).map((c) => parseColor(c).a);
    for (let i = 1; i < alphas.length; i += 1) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1]);
    }
  });

  it('rejects a zero band count', () => {
    expect(() => bandColors(sheen, 0)).toThrow();
  });
});

describe('formatRgba', () => {
  it('clamps out-of-range channels', () => {
    expect(formatRgba({ r: -5, g: 300, b: 12, a: 2 })).toBe('rgba(0, 255, 12, 1)');
  });
});

describe('rotationForCssAngle', () => {
  it('maps a downward stack (180deg) to no rotation', () => {
    expect(rotationForCssAngle(180)).toBe('0deg');
  });

  it('maps the canvas 118deg sheen to -62deg', () => {
    expect(rotationForCssAngle(118)).toBe('-62deg');
  });
});
