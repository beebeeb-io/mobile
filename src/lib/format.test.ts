// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { formatBytes, formatThroughput } from './format';

describe('formatBytes — SI units + carry', () => {
  test('zero and sub-kB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  test('kB (SI lowercase symbol, whole)', () => {
    expect(formatBytes(1_000)).toBe('1 kB');
    expect(formatBytes(1_500)).toBe('2 kB'); // rounds
    expect(formatBytes(999_499)).toBe('999 kB'); // rounds down, stays kB
  });

  test('MB (whole)', () => {
    expect(formatBytes(1_000_000)).toBe('1 MB');
    expect(formatBytes(2_400_000)).toBe('2 MB');
  });

  test('GB / TB (one decimal)', () => {
    expect(formatBytes(5_000_000_000)).toBe('5.0 GB');
    expect(formatBytes(1_000_000_000_000)).toBe('1.0 TB');
    expect(formatBytes(2_500_000_000_000)).toBe('2.5 TB');
  });

  test('carry at unit boundaries (the bug A10 fixed)', () => {
    // 999,500 B rounds to 1000 kB → must promote to "1 MB", not "1000 kB".
    expect(formatBytes(999_500)).toBe('1 MB');
    // 999.5 MB → "1.0 GB", not "1000 MB".
    expect(formatBytes(999_500_000)).toBe('1.0 GB');
    // 999.95 GB → "1.0 TB", not "1000.0 GB".
    expect(formatBytes(999_950_000_000)).toBe('1.0 TB');
  });

  test('negatives keep their sign (delta displays)', () => {
    expect(formatBytes(-1)).toBe('-1 B');
    expect(formatBytes(-1_500)).toBe('-2 kB');
    expect(formatBytes(-5_000_000_000)).toBe('-5.0 GB');
  });
});

describe('formatThroughput — SI rate', () => {
  test('kB/s below 1000, MB/s above', () => {
    expect(formatThroughput(0)).toBe('0 kB/s');
    expect(formatThroughput(500)).toBe('500 kB/s');
    expect(formatThroughput(1000)).toBe('1000 kB/s');
    expect(formatThroughput(1_500)).toBe('1.5 MB/s');
  });
});
