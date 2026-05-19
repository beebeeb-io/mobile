// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { createPerfMarker } from './perf-mark';

describe('perf marker', () => {
  test('records elapsed time with stable labels', () => {
    let now = 1000;
    const logs: string[] = [];
    const marker = createPerfMarker({
      now: () => now,
      log: (line) => logs.push(line),
      enabled: true,
    });

    const end = marker.start('files.open', { folder: 'root' });
    now = 1242;
    end({ count: 12 });

    expect(logs).toEqual([
      '[BeebeebPerf] files.open 242ms folder=root count=12',
    ]);
  });

  test('does nothing when disabled', () => {
    const logs: string[] = [];
    const marker = createPerfMarker({
      now: () => 1000,
      log: (line) => logs.push(line),
      enabled: false,
    });

    marker.start('photos.open')();
    expect(logs).toEqual([]);
  });
});
