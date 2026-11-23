// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  bucketForUrl,
  createRateLimitedFetch,
  MAX_PACING_PAUSE_MS,
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

  test('a slow response does not hold later file request launches behind it', async () => {
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let calls = 0;
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? firstResponse : new Response('{}', { status: 200 });
      },
      sleep: async () => {},
      bucketSpacingMs: { files: 1, general: 0, auth: 0, shares: 0, external: 0 },
    });

    const first = fetcher('https://api.beebeeb.io/api/v1/files/slow-list');
    const second = fetcher('https://api.beebeeb.io/api/v1/files/open-status');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeFirstSettled = calls;
    resolveFirst(new Response('{}', { status: 200 }));
    await Promise.all([first, second]);

    expect(callsBeforeFirstSettled).toBe(2);
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
      random: () => 0,
      sleep: async (ms) => { now += ms; },
      bucketSpacingMs: { files: 80, general: 0, auth: 0, shares: 0, external: 0 },
    });

    await fetcher('https://api.beebeeb.io/api/v1/files/a');
    await fetcher('https://api.beebeeb.io/api/v1/files/b');

    expect(calls).toEqual([5_000, 7_000]);
  });

  // Task 1593 (#141 review P2): a lockout-length Retry-After must still pace
  // the bucket — capped at MAX_PACING_PAUSE_MS, not dropped.
  test('caps a lockout-length Retry-After at MAX_PACING_PAUSE_MS instead of dropping the pause', async () => {
    let now = 5_000;
    const calls: number[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls.push(now);
        if (calls.length === 1) {
          return new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } });
        }
        return new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => { now += ms; },
      bucketSpacingMs: { files: 80, general: 0, auth: 0, shares: 0, external: 0 },
    });

    await fetcher('https://api.beebeeb.io/api/v1/files/a');
    now += MAX_PACING_PAUSE_MS - 2_000; // a longer wait is answered locally (08f)
    await fetcher('https://api.beebeeb.io/api/v1/files/b');

    // Paced for exactly the cap: not 0 (dropped), not 3_600_000 (the lockout).
    expect(calls[1] - calls[0]).toBe(MAX_PACING_PAUSE_MS);
  });

  test('adds 0-25 % jitter to a Retry-After pause', async () => {
    for (const [rnd, expected] of [[0, 10_000], [0.5, 11_250], [0.999, 12_497.5]]) {
      let now = 1_000;
      const calls: number[] = [];
      const fetcher = createRateLimitedFetch({
        fetchImpl: async () => {
          calls.push(now);
          return calls.length === 1
            ? new Response('{}', { status: 429, headers: { 'Retry-After': '10' } })
            : new Response('{}', { status: 200 });
        },
        now: () => now,
        sleep: async (ms) => { now += ms; },
        random: () => rnd,
        bucketSpacingMs: { files: 0, general: 80 },
      });
      await fetcher('https://api.beebeeb.io/api/v1/prefs');
      now += expected - 2_000; // a longer rest would be answered locally (08f)
      await fetcher('https://api.beebeeb.io/api/v1/prefs');
      expect(calls[1] - calls[0]).toBe(expected);
    }
  });

  test('honours a larger body retry_after', async () => {
    let now = 1_000;
    const calls: number[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls.push(now);
        return calls.length === 1
          ? new Response(JSON.stringify({ error: 'rate_limited', retry_after: 20 }), {
              status: 429, headers: { 'Retry-After': '5', 'content-type': 'application/json' } })
          : new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => { now += ms; },
      random: () => 0,
      bucketSpacingMs: { general: 80 },
    });
    await fetcher('https://api.beebeeb.io/api/v1/prefs');
    now += 18_000;
    await fetcher('https://api.beebeeb.io/api/v1/prefs');
    expect(calls[1] - calls[0]).toBe(20_000);
  });

  test('a ban keeps the unjittered path, and the body stays readable', async () => {
    let now = 1_000;
    const calls: number[] = [];
    let first: Response | undefined;
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls.push(now);
        return calls.length === 1
          ? new Response(JSON.stringify({ error: 'banned', retry_after: 30 }), {
              status: 429, headers: { 'Retry-After': '30', 'content-type': 'application/json' } })
          : new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => { now += ms; },
      random: () => 0.9,
      bucketSpacingMs: { general: 80 },
    });
    first = await fetcher('https://api.beebeeb.io/api/v1/prefs');
    expect((await first.json()).error).toBe('banned');
    now += 28_000;
    await fetcher('https://api.beebeeb.io/api/v1/prefs');
    expect(calls[1] - calls[0]).toBe(30_000);
  });

  test('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfterMs('3', 1_000)).toBe(3_000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 1_000)).toBe(9_000);
    expect(parseRetryAfterMs(null, 1_000)).toBe(null);
  });
});
