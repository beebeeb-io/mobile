// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { estimateTotals, pickSampleIds } from './photo-preview-estimate';

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`);

describe('pickSampleIds', () => {
  test('returns at most n unique ids drawn from the input', () => {
    const all = ids(100);
    const picked = pickSampleIds(all, 10, seeded(1));
    expect(picked.length).toBe(10);
    expect(new Set(picked).size).toBe(10);
    for (const p of picked) expect(all).toContain(p);
  });

  test('default n is 10', () => {
    expect(pickSampleIds(ids(50), undefined, seeded(2)).length).toBe(10);
  });

  test('a small library returns every photo once', () => {
    const picked = pickSampleIds(['a', 'b', 'c'], 10, seeded(3));
    expect([...picked].sort()).toEqual(['a', 'b', 'c']);
  });

  test('duplicates in the input are not picked twice', () => {
    const picked = pickSampleIds(['a', 'a', 'b'], 10, seeded(4));
    expect([...picked].sort()).toEqual(['a', 'b']);
  });

  test('empty input and n of 0 give nothing', () => {
    expect(pickSampleIds([], 10)).toEqual([]);
    expect(pickSampleIds(ids(5), 0)).toEqual([]);
  });

  test('same seed gives the same sample, a different seed another', () => {
    const all = ids(200);
    expect(pickSampleIds(all, 10, seeded(7))).toEqual(pickSampleIds(all, 10, seeded(7)));
    expect(pickSampleIds(all, 10, seeded(7))).not.toEqual(pickSampleIds(all, 10, seeded(8)));
  });

  test('does not modify the input', () => {
    const all = ids(20);
    const copy = [...all];
    pickSampleIds(all, 10, seeded(9));
    expect(all).toEqual(copy);
  });
});

describe('estimateTotals', () => {
  const MB = 1_000_000;

  test('everything fits', () => {
    expect(estimateTotals(1 * MB, 2000, 20_000 * MB)).toEqual({ totalBytes: 2000 * MB, fitsAll: true, fitCount: 2000 });
  });

  test('exactly at the limit still fits', () => {
    expect(estimateTotals(1 * MB, 100, 100 * MB)).toEqual({ totalBytes: 100 * MB, fitsAll: true, fitCount: 100 });
  });

  test('partial fit counts whole photos', () => {
    expect(estimateTotals(1 * MB, 2000, 1500 * MB + 1)).toEqual({ totalBytes: 2000 * MB, fitsAll: false, fitCount: 1500 });
  });

  test('zero photos', () => {
    expect(estimateTotals(1 * MB, 0, 10 * MB)).toEqual({ totalBytes: 0, fitsAll: true, fitCount: 0 });
  });

  test('zero or invalid average does not divide by zero', () => {
    expect(estimateTotals(0, 10, 10 * MB)).toEqual({ totalBytes: 0, fitsAll: true, fitCount: 10 });
    expect(estimateTotals(NaN, 10, 10 * MB)).toEqual({ totalBytes: 0, fitsAll: true, fitCount: 10 });
  });

  test('zero limit fits nothing', () => {
    expect(estimateTotals(1 * MB, 10, 0)).toEqual({ totalBytes: 10 * MB, fitsAll: false, fitCount: 0 });
  });
});

describe('estimate state per setting', () => {
  const { estimateEntryFromResult, shouldStartEstimate, estimateView, storageToAdd } = require('./photo-preview-estimate');

  test('a result with nothing measured is a failure, not a 0 B estimate', () => {
    expect(estimateEntryFromResult({ averageBytes: 0, sampled: 0 })).toEqual({ status: 'failed' });
    expect(estimateEntryFromResult({ averageBytes: 500_000, sampled: 10 })).toEqual({ status: 'done', avgBytes: 500_000, sampled: 10 });
  });

  test('one measurement per key at a time; done is kept; failed is retried', () => {
    expect(shouldStartEstimate(undefined, false)).toBe(true);
    expect(shouldStartEstimate({ status: 'loading' }, true)).toBe(false);
    expect(shouldStartEstimate({ status: 'done', avgBytes: 1, sampled: 1 }, false)).toBe(false);
    expect(shouldStartEstimate({ status: 'failed' }, false)).toBe(true);
    // A loading entry whose run was dropped (screen re-mounted) starts again.
    expect(shouldStartEstimate({ status: 'loading' }, false)).toBe(true);
  });

  test('the card shows exactly one state', () => {
    expect(estimateView(undefined, false)).toEqual({ kind: 'no-photos' });
    expect(estimateView(undefined, true)).toEqual({ kind: 'measuring' });
    expect(estimateView({ status: 'loading' }, true)).toEqual({ kind: 'measuring' });
    expect(estimateView({ status: 'failed' }, true)).toEqual({ kind: 'unavailable' });
    expect(estimateView({ status: 'done', avgBytes: 2, sampled: 3 }, true)).toEqual({ kind: 'ready', avgBytes: 2, sampled: 3 });
  });

  test('after a finished Apply (nothing left to do) the storage line is + 0 B, not a dash', () => {
    expect(storageToAdd({ kind: 'measuring' }, 0)).toBe(0);
    expect(storageToAdd({ kind: 'unavailable' }, 0)).toBe(0);
    expect(storageToAdd({ kind: 'measuring' }, 5)).toBeNull();
    expect(storageToAdd({ kind: 'ready', avgBytes: 1000, sampled: 10 }, 5)).toBe(5000);
  });

  test('a run that finishes while the estimate is still measuring settles on the result for the current key', () => {
    // Simulates the screen: entries keyed by format:size, results stored by their own key.
    const entries = new Map();
    const inFlight = new Set();
    const ask = (key) => {
      if (shouldStartEstimate(entries.get(key), inFlight.has(key))) {
        inFlight.add(key);
        entries.set(key, { status: 'loading' });
      }
    };
    const land = (key, r) => {
      inFlight.delete(key);
      entries.set(key, estimateEntryFromResult(r));
    };
    ask('heic:3840');
    ask('heic:3840'); // photo list re-read after the run: reuses the running measurement
    expect(inFlight.size).toBe(1);
    ask('jpeg:1280'); // user switched setting meanwhile
    land('heic:3840', { averageBytes: 1_200_000, sampled: 10 });
    ask('heic:3840'); // and back
    expect(estimateView(entries.get('heic:3840'), true)).toEqual({ kind: 'ready', avgBytes: 1_200_000, sampled: 10 });
    land('jpeg:1280', { averageBytes: 0, sampled: 0 });
    expect(estimateView(entries.get('jpeg:1280'), true)).toEqual({ kind: 'unavailable' });
  });
});

describe('pickSampleAsset', () => {
  const { pickSampleAsset } = require('./photo-preview-estimate');

  test('skips screenshots and takes the newest real photo', () => {
    const assets = [
      { id: 'shot1', mediaSubtypes: ['screenshot'] },
      { id: 'shot2', mediaSubtypes: ['screenshot'] },
      { id: 'photo', mediaSubtypes: ['hdr'] },
      { id: 'older' },
    ];
    expect(pickSampleAsset(assets)?.id).toBe('photo');
  });

  test('a photo without subtypes counts as a real photo', () => {
    expect(pickSampleAsset([{ id: 'a' }, { id: 'b', mediaSubtypes: ['screenshot'] }])?.id).toBe('a');
  });

  test('only screenshots: falls back to the newest one', () => {
    expect(pickSampleAsset([{ id: 's1', mediaSubtypes: ['screenshot'] }, { id: 's2', mediaSubtypes: ['screenshot'] }])?.id).toBe('s1');
  });

  test('no photos: undefined', () => {
    expect(pickSampleAsset([])).toBeUndefined();
  });
});
