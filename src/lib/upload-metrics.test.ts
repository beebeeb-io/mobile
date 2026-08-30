// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { RateMeter, formatRate, formatEta, etaSeconds, ringRotations } from './upload-metrics';

describe('RateMeter', () => {
  test('needs two samples before reporting a rate', () => {
    const m = new RateMeter();
    expect(m.sample(0, 1000)).toBeNull();
    expect(m.sample(4_000_000, 2000)).not.toBeNull();
  });

  test('converges to a steady rate', () => {
    const m = new RateMeter();
    let rate: number | null = null;
    for (let i = 0; i <= 20; i++) {
      rate = m.sample(i * 4_000_000, i * 1000); // 4 MB/s steady
    }
    expect(rate).not.toBeNull();
    expect(rate!).toBeGreaterThan(3_500_000);
    expect(rate!).toBeLessThan(4_500_000);
  });

  test('EMA smooths a single outlier instead of jumping to it', () => {
    const m = new RateMeter();
    for (let i = 0; i <= 10; i++) m.sample(i * 4_000_000, i * 1000);
    const before = m.rate()!;
    m.sample(10 * 4_000_000 + 40_000_000, 11_000); // one 40 MB/s spike
    const after = m.rate()!;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(40_000_000 * 0.6); // nowhere near the raw spike
  });

  test('counter restart (new file) resets the baseline without going negative', () => {
    const m = new RateMeter();
    m.sample(0, 0);
    m.sample(8_000_000, 1000);
    const steady = m.rate()!;
    m.sample(0, 2000); // next file in batch starts at 0
    expect(m.rate()).toBe(steady); // keeps last estimate, no negative rate
    m.sample(4_000_000, 3000);
    expect(m.rate()!).toBeGreaterThan(0);
  });

  test('ignores zero/negative time deltas', () => {
    const m = new RateMeter();
    m.sample(0, 1000);
    m.sample(4_000_000, 2000);
    const r = m.rate();
    expect(m.sample(8_000_000, 2000)).toBe(r);
  });
});

describe('formatRate', () => {
  test('SI formatting per magnitude', () => {
    expect(formatRate(412_000_000)).toBe('412 MB/s');
    expect(formatRate(11_840_000)).toBe('11.8 MB/s');
    expect(formatRate(850_000)).toBe('850 kB/s');
    expect(formatRate(120)).toBe('1 kB/s');
  });
  test('null/invalid → null', () => {
    expect(formatRate(null)).toBeNull();
    expect(formatRate(0)).toBeNull();
    expect(formatRate(-5)).toBeNull();
    expect(formatRate(Infinity)).toBeNull();
  });
});

describe('formatEta', () => {
  test('coarse buckets', () => {
    expect(formatEta(0.4)).toBe('~1s');
    expect(formatEta(24)).toBe('~24s');
    expect(formatEta(23.2)).toBe('~24s');
    expect(formatEta(300)).toBe('~5m');
    expect(formatEta(7200)).toBe('~2h');
  });
  test('null/invalid → null', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(-1)).toBeNull();
    expect(formatEta(Infinity)).toBeNull();
  });
});

describe('etaSeconds', () => {
  test('remaining / rate', () => {
    expect(etaSeconds(48_000_000, 4_000_000)).toBe(12);
  });
  test('no rate or nothing remaining → null', () => {
    expect(etaSeconds(48_000_000, null)).toBeNull();
    expect(etaSeconds(48_000_000, 0)).toBeNull();
    expect(etaSeconds(0, 4_000_000)).toBeNull();
  });
});

describe('ringRotations', () => {
  test('0% — both layers parked out of view', () => {
    expect(ringRotations(0)).toEqual({ right: -180, left: -180 });
  });
  test('25% — right layer sweeps 90°, left parked', () => {
    expect(ringRotations(0.25)).toEqual({ right: -90, left: -180 });
  });
  test('50% — right layer fully swept', () => {
    expect(ringRotations(0.5)).toEqual({ right: 0, left: -180 });
  });
  test('75% — left layer sweeps 90°', () => {
    expect(ringRotations(0.75)).toEqual({ right: 0, left: -90 });
  });
  test('100% — both fully swept', () => {
    expect(ringRotations(1)).toEqual({ right: 0, left: 0 });
  });
  test('clamps out-of-range and NaN', () => {
    expect(ringRotations(1.4)).toEqual({ right: 0, left: 0 });
    expect(ringRotations(-2)).toEqual({ right: -180, left: -180 });
    expect(ringRotations(NaN)).toEqual({ right: -180, left: -180 });
  });
});
