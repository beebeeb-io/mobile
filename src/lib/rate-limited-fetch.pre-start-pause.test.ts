// @ts-nocheck
/**
 * Task 2233 round 2 (P3) — the pre-start 429 pause is read for the
 * `thumbnails` bucket ONLY.
 *
 * Round 1 added a gate for every zero-spacing bucket that waits out a
 * `nextAt` set by a previous 429. That was scoped to thumbnails; `billing` and
 * `external` must behave exactly as on main (start immediately, no pause gate).
 */
import { describe, expect, test } from 'bun:test';
import { bucketForUrl, createRateLimitedFetch } from './rate-limited-fetch';

const BILLING = 'https://api.beebeeb.io/api/v1/billing/subscription';
const EXTERNAL = 'https://example.com/widget';
const THUMB = 'https://api.beebeeb.io/api/v1/files/abc/thumbnail';

function harness() {
  let now = 1_000;
  const sleeps: number[] = [];
  const starts: Array<{ url: string; at: number }> = [];
  let rateLimitedOnce = true;
  const fetcher = createRateLimitedFetch({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    fetchImpl: async (input: any) => {
      const url = String(input);
      starts.push({ url, at: now });
      if (rateLimitedOnce) {
        rateLimitedOnce = false;
        return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
      }
      return new Response('{}', { status: 200 });
    },
  });
  return { fetcher, sleeps, starts, get now() { return now; } };
}

describe('task 2233 round 2 P3 — pre-start pause is thumbnails-only', () => {
  test('billing: a 429 + Retry-After does not delay the next billing request', async () => {
    const { fetcher, sleeps, starts } = harness();

    expect(bucketForUrl(BILLING)).toBe('billing');
    await fetcher(BILLING); // 429, pauses the billing bucket for 2 s
    await fetcher(BILLING);

    expect(sleeps).toEqual([]);
    expect(starts.map((s) => s.at)).toEqual([1_000, 1_000]);
  });

  test('external: a 429 + Retry-After does not delay the next external request', async () => {
    const { fetcher, sleeps, starts } = harness();

    expect(bucketForUrl(EXTERNAL)).toBe('external');
    await fetcher(EXTERNAL);
    await fetcher(EXTERNAL);

    expect(sleeps).toEqual([]);
    expect(starts.map((s) => s.at)).toEqual([1_000, 1_000]);
  });

  test('thumbnails: the pause still holds (round 1 scope unchanged)', async () => {
    const { fetcher, sleeps, starts } = harness();

    expect(bucketForUrl(THUMB)).toBe('thumbnails');
    await fetcher(THUMB);
    await fetcher(THUMB);

    expect(sleeps).toEqual([2_000]);
    expect(starts.map((s) => s.at)).toEqual([1_000, 3_000]);
  });
});
