// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { retryStartupGetMe } from './cold-start-owner';
import { createRateLimitedFetch } from './rate-limited-fetch';
import { decideStartupAuthUi, startupAuthStateForError } from './startup-auth';

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
  }
}
const is401 = (e: any) => e?.status === 401;
const fast = { delaysMs: [1, 1, 1], timeoutMs: 20, random: () => 0 };

describe('retryStartupGetMe with 429', () => {
  test('waits Retry-After (+jitter) then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const r = await retryStartupGetMe(async () => { if (n++ === 0) throw new ApiError(429, 'x', undefined, 10); return 'me'; }, is401,
      { ...fast, random: () => 0.5, sleep: async (ms) => { waits.push(ms); } });
    expect(r).toBe('me');
    expect(waits).toEqual([11250]);
  });
  test('Retry-After above 60 s throws the 429 at once', async () => {
    let n = 0;
    const err = await retryStartupGetMe(async () => { n++; throw new ApiError(429, 'x', undefined, 300); }, is401, fast).catch((e) => e);
    expect(err.status).toBe(429);
    expect(n).toBe(1);
  });
  test('429 remembered across later timeouts; thrown when attempts run out (4 retries)', async () => {
    let n = 0;
    const err = await retryStartupGetMe(async () => {
      if (n++ === 0) throw new ApiError(429, 'x', undefined, 1);
      return new Promise(() => {});
    }, is401, { ...fast, sleep: async () => {} }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(n).toBe(5);
  });
  test('network only still returns null; 401 still throws', async () => {
    expect(await retryStartupGetMe(async () => { throw new ApiError(0, 'net'); }, is401, { ...fast, sleep: async () => {} })).toBeNull();
    const e = await retryStartupGetMe(async () => { throw new ApiError(401, 'no'); }, is401, fast).catch((x) => x);
    expect(e.status).toBe(401);
  });
});

describe('startup-auth rate-limited', () => {
  test('429 maps to rate-limited, which keeps the session (never signs out)', () => {
    const s = startupAuthStateForError(new ApiError(429, 'x', undefined, 5), 'token-present');
    expect(s).toBe('rate-limited');
    expect(decideStartupAuthUi(s)).toBe('keep-restoring');
    expect(startupAuthStateForError(new ApiError(500, 'x'), 'token-present')).toBe('token-present');
  });
});

describe('rate-limited-fetch local 429', () => {
  test('a long pause is answered with 429 + Retry-After of the rest, without sleeping or sending', async () => {
    let t = 0;
    let sent = 0;
    const slept: number[] = [];
    const f = createRateLimitedFetch({
      fetchImpl: async () => { sent++; return new Response('{"error":"rate_limited","retry_after":60}', { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '60' } }); },
      now: () => t, sleep: async (ms) => { slept.push(ms); }, random: () => 0,
    });
    await f('https://a.test/api/v1/auth/me');
    t = 10_000;
    const res = await f('https://a.test/api/v1/auth/me');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('50');
    expect(sent).toBe(1);
    expect(slept).toEqual([]);
  });
  test('a short pause is still slept through', async () => {
    let t = 0;
    const slept: number[] = [];
    const f = createRateLimitedFetch({
      fetchImpl: async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '2' } }),
      now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, random: () => 0,
    });
    await f('https://a.test/api/v1/auth/me');
    await f('https://a.test/api/v1/auth/me');
    expect(slept.some((m) => m >= 1900)).toBe(true);
  });
});

describe('DiagnosticPanel / App source guards', () => {
  const panel = readFileSync(join(import.meta.dir, '..', 'components', 'DiagnosticPanel.tsx'), 'utf8');
  const app = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');
  test('copy and no Sign in while rate limited', () => {
    expect(panel).toContain("'Beebeeb is busy'");
    expect(panel).toContain('Too many requests from your network. Trying again in');
    expect(panel).toMatch(/\{!isRateLimited \? \(\s*<TouchableOpacity\s*onPress=\{onSignIn\}/);
  });
  test('App passes the 429 to the panel', () => {
    expect(app).toContain("startupAuthState === 'rate-limited'");
    expect(app).toContain('rateLimited={startupRateLimited ?? undefined}');
  });
});
