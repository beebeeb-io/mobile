// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { mapInBatches } from './async-batch';

describe('async batch helpers', () => {
  test('runs work in bounded batches and yields between batches', async () => {
    const running: number[] = [];
    const maxRunning: number[] = [];
    let active = 0;
    let yields = 0;

    const results = await mapInBatches(
      [1, 2, 3, 4, 5],
      2,
      async (value) => {
        active++;
        running.push(value);
        maxRunning.push(active);
        active--;
        return value * 10;
      },
      async () => { yields++; },
    );

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(running).toEqual([1, 2, 3, 4, 5]);
    expect(Math.max(...maxRunning)).toBeLessThanOrEqual(2);
    expect(yields).toBe(2);
  });
});
