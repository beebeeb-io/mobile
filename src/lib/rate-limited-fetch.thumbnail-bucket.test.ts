// @ts-nocheck
/**
 * Task 2233 item 1 (A1, adversarial cases 6, 7, 10b).
 *
 * Thumbnail GETs (`/api/v1/files/{id}/thumbnail[/small|/large]`) used to share
 * the serialized `files` chain: one screen of 32 tiles was 32 sequential round
 * trips (120 ms + each response). They now have their own unpaced,
 * concurrency-bounded lane. Everything else on `/api/v1/files` must keep the
 * old serialized `files` bucket (uploads/previews do not regress).
 */
import { describe, expect, test } from 'bun:test';
import { bucketForUrl, createRateLimitedFetch } from './rate-limited-fetch';

const FILE = 'https://api.beebeeb.io/api/v1/files/abc';
const THUMB = 'https://api.beebeeb.io/api/v1/files/abc/thumbnail';
const LIST = 'https://api.beebeeb.io/api/v1/files/index';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('task 2233 A1 — thumbnail pacing lane', () => {
  test('thumbnail URLs get their own bucket; other files requests keep `files`', () => {
    expect(bucketForUrl(THUMB)).toBe('thumbnails');
    expect(bucketForUrl(`${THUMB}/small`)).toBe('thumbnails');
    expect(bucketForUrl(`${THUMB}/large`)).toBe('thumbnails');
    expect(bucketForUrl(FILE)).toBe('files');
    expect(bucketForUrl(`${FILE}/preview`)).toBe('files');
    expect(bucketForUrl(LIST)).toBe('files');
    expect(bucketForUrl('https://api.beebeeb.io/api/v1/uploads/init')).toBe('files');
  });

  test('case 7: 8 thumbnail GETs do not wait on a slow files list request', async () => {
    const slowList = deferred<Response>();
    const thumbCalls: string[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async (input: any) => {
        const url = String(input);
        if (url === LIST) return slowList.promise;
        thumbCalls.push(url);
        return new Response('{}', { status: 200 });
      },
    });

    const listPromise = fetcher(LIST);
    const thumbs = Array.from({ length: 8 }, (_, i) =>
      fetcher(`${THUMB}?n=${i}`),
    );
    // Let the microtask queue run; the list request is still unresolved.
    await new Promise((r) => setTimeout(r, 0));
    expect(thumbCalls.length).toBe(8);

    slowList.resolve(new Response('{}', { status: 200 }));
    await Promise.all([listPromise, ...thumbs]);
    expect(thumbCalls.length).toBe(8);
  });

  test('case 7 reverse: a slow thumbnail request does not delay a files request', async () => {
    const slowThumb = deferred<Response>();
    const order: string[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async (input: any) => {
        const url = String(input);
        order.push(url);
        if (url === THUMB) return slowThumb.promise;
        return new Response('{}', { status: 200 });
      },
    });

    const thumb = fetcher(THUMB);
    const list = fetcher(LIST);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([THUMB, LIST]);

    slowThumb.resolve(new Response('{}', { status: 200 }));
    await Promise.all([thumb, list]);
  });

  test('case 10b: non-thumbnail /api/v1/files requests still serialize at 120 ms', async () => {
    let now = 1_000;
    const calls: number[] = [];
    const sleeps: number[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async () => {
        calls.push(now);
        return new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });

    await Promise.all([
      fetcher('https://api.beebeeb.io/api/v1/files/a'),
      fetcher('https://api.beebeeb.io/api/v1/files/b'),
      fetcher('https://api.beebeeb.io/api/v1/uploads/init'),
    ]);

    expect(calls).toEqual([1_000, 1_120, 1_240]);
    expect(sleeps).toEqual([120, 120]);
  });

  test('case 6: 429 + Retry-After 2 holds new thumbnail GETs for 2 s, files unaffected', async () => {
    let now = 5_000;
    const thumbCalls: number[] = [];
    const fileCalls: number[] = [];
    const sleeps: number[] = [];
    const fetcher = createRateLimitedFetch({
      fetchImpl: async (input: any) => {
        const url = String(input);
        if (url === THUMB) {
          thumbCalls.push(now);
          if (thumbCalls.length === 1) {
            return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
          }
          return new Response('{}', { status: 200 });
        }
        fileCalls.push(now);
        return new Response('{}', { status: 200 });
      },
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });

    await fetcher(THUMB);
    await Promise.all([fetcher(THUMB), fetcher(FILE)]);

    // The thumbnail lane waited the full Retry-After once; the files request
    // got no pause from it.
    expect(thumbCalls).toEqual([5_000, 7_000]);
    expect(sleeps.filter((ms) => ms === 2_000).length).toBe(1);
    expect(fileCalls.length).toBe(1);
  });
});
