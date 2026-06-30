// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  bucketForUrl,
  createRateLimitedFetch,
  parseRetryAfterMs,
} from './rate-limited-fetch';

describe('rate-limited fetch', () => {
  test('classifies Beebeeb routes into pacing buckets', () => {
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/files')).toBe('files');
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/uploads/init')).toBe('files');
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/auth/login')).toBe('auth');
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/shares/token/download')).toBe('shares');
    expect(bucketForUrl('https://example.com/pixel.png')).toBe('external');
  });

  test('routes billing reads into their own bucket, not the shared general lane', () => {
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/billing/subscription')).toBe('billing');
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/billing/plans')).toBe('billing');
    // A non-billing /api/ route still falls through to the catch-all bucket.
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/preferences/theme')).toBe('general');
    // Files stay on the files lane (the billing rule must not steal them).
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/files/usage')).toBe('files');
  });

  test('runs the two billing reads concurrently (zero-spacing bucket, no serialization)', async () => {
    let now = 2_000;
    const calls: number[] = [];
    const sleeps: number[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls.push(now);
        return new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      // Default billing spacing is 0; assert the concurrent behaviour explicitly.
    });

    await Promise.all([
      fetcher('https://api.beebeeb.io/api/v1/billing/subscription'),
      fetcher('https://api.beebeeb.io/api/v1/billing/plans'),
    ]);

    // Both fire at the same logical instant — no queue wait was inserted.
    expect(calls).toEqual([2_000, 2_000]);
    expect(sleeps).toEqual([]);
  });

  test('paces concurrent file requests through one queue', async () => {
    let now = 1_000;
    const calls: number[] = [];
    const sleeps: number[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls.push(now);
        return new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      bucketSpacingMs: { files: 80, general: 0, auth: 0, shares: 0, external: 0 },
    });

    await Promise.all([
      fetcher('https://api.beebeeb.io/api/v1/files/a'),
      fetcher('https://api.beebeeb.io/api/v1/files/b'),
      fetcher('https://api.beebeeb.io/api/v1/uploads/init'),
    ]);

    expect(calls).toEqual([1_000, 1_080, 1_160]);
    expect(sleeps).toEqual([80, 80]);
  });

  test('honors Retry-After before the next request in the bucket', async () => {
    let now = 5_000;
    const calls: number[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls.push(now);
        if (calls.length === 1) {
          return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
        }
        return new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => { now += ms; },
      bucketSpacingMs: { files: 80, general: 0, auth: 0, shares: 0, external: 0 },
    });

    await fetcher('https://api.beebeeb.io/api/v1/files/a');
    await fetcher('https://api.beebeeb.io/api/v1/files/b');

    expect(calls).toEqual([5_000, 7_000]);
  });

  test('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfterMs('3', 1_000)).toBe(3_000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 1_000)).toBe(9_000);
    expect(parseRetryAfterMs(null, 1_000)).toBe(null);
  });
});
