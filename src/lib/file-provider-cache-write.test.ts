// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * LD-0002 round 2 — the deferral queue on its own (`file-provider-cache-write.ts`,
 * no `react-native`): replacement by key, order, the cap, a throwing write, and
 * the answers a native build can give.
 */
import { describe, expect, test } from 'bun:test';
import { cacheWriteCount, createDeferredCacheWrites } from './file-provider-cache-write';

function queue(extra = {}) {
  const foreground: Array<() => void> = [];
  const deferred = createDeferredCacheWrites({ subscribeToForeground: (cb) => foreground.push(cb), ...extra });
  return { deferred, foreground };
}

describe('cacheWriteCount', () => {
  test('reads the typed answers and the bare ones of an older native build', () => {
    expect(cacheWriteCount({ status: 'ok', count: 4 })).toBe(4);
    expect(cacheWriteCount({ status: 'not_now' })).toBe('not_now');
    expect(cacheWriteCount(7)).toBe(7);
    expect(cacheWriteCount(true)).toBe(1);
    expect(cacheWriteCount(false)).toBe(0);
    expect(cacheWriteCount(undefined)).toBe(0);
    expect(cacheWriteCount({ status: 'ok' })).toBe(0);
  });
});

describe('createDeferredCacheWrites', () => {
  test('subscribes to the foreground once, on the first deferral', () => {
    const { deferred, foreground } = queue();
    expect(foreground.length).toBe(0);
    deferred.defer({ run: async () => true });
    deferred.defer({ run: async () => true });
    expect(foreground.length).toBe(1);
  });

  test('runs in order; a refused write stops the queue and stays', async () => {
    const { deferred } = queue();
    const ran: string[] = [];
    let secondAnswers = false;
    deferred.defer({ run: async () => { ran.push('a'); return true; } });
    deferred.defer({ run: async () => { ran.push('b'); return secondAnswers; } });
    deferred.defer({ run: async () => { ran.push('c'); return true; } });

    await deferred.replay();
    expect(ran).toEqual(['a', 'b']);
    expect(deferred.size).toBe(2);

    secondAnswers = true;
    await deferred.replay();
    expect(ran).toEqual(['a', 'b', 'b', 'c']);
    expect(deferred.size).toBe(0);
  });

  test('a write with the same key replaces the one before it, at the back of the queue', async () => {
    const { deferred } = queue();
    const ran: string[] = [];
    deferred.defer({ key: 'k', run: async () => { ran.push('k1'); return true; } });
    deferred.defer({ run: async () => { ran.push('x'); return true; } });
    deferred.defer({ key: 'k', run: async () => { ran.push('k2'); return true; } });
    await deferred.replay();
    expect(ran).toEqual(['x', 'k2']);
  });

  test('a write that throws is dropped, reported, and does not stop the ones behind it', async () => {
    const errors: unknown[] = [];
    const { deferred } = queue({ onReplayError: (e) => errors.push(e) });
    const ran: string[] = [];
    deferred.defer({ run: async () => { throw new Error('gate closed'); } });
    deferred.defer({ run: async () => { ran.push('after'); return true; } });
    await deferred.replay();
    expect(errors.length).toBe(1);
    expect(ran).toEqual(['after']);
    expect(deferred.size).toBe(0);
  });

  test('over the cap the oldest falls off the front and is reported, not dropped silently', () => {
    const dropped: unknown[] = [];
    const { deferred } = queue({ max: 3, onOverflow: (w) => dropped.push(w) });
    const writes = [1, 2, 3, 4, 5].map((n) => ({ run: async () => true, n }));
    for (const w of writes) deferred.defer(w);
    expect(deferred.size).toBe(3);
    expect(dropped.map((w) => w.n)).toEqual([1, 2]);
  });

  test('a foreground event during a replay is not lost: the queue is re-checked afterwards', async () => {
    const { deferred } = queue();
    const ran: string[] = [];
    let release: () => void = () => {};
    deferred.defer({ run: () => new Promise<boolean>((resolve) => { release = () => { ran.push('slow'); resolve(true); }; }) });
    const first = deferred.replay();
    deferred.defer({ run: async () => { ran.push('late'); return true; } });
    const second = deferred.replay();
    release();
    await Promise.all([first, second]);
    expect(ran).toEqual(['slow', 'late']);
  });

  test('cancel(key) removes the queued write for that key and nothing else', async () => {
    const { deferred } = queue();
    const ran: string[] = [];
    deferred.defer({ key: 'a', run: async () => { ran.push('a'); return true; } });
    deferred.defer({ key: 'b', run: async () => { ran.push('b'); return true; } });
    deferred.cancel('a');
    deferred.cancel('missing');
    await deferred.replay();
    expect(ran).toEqual(['b']);
  });

  test('clear() empties the queue', async () => {
    const { deferred } = queue();
    deferred.defer({ run: async () => true });
    deferred.defer({ run: async () => true });
    deferred.clear();
    expect(deferred.size).toBe(0);
  });

  test('a write deferred while the app is ALREADY foreground schedules its own replay (no later "active" event is coming)', async () => {
    const scheduled: Array<() => void> = [];
    const { deferred } = queue({ isForeground: () => true, scheduleReplay: (run) => scheduled.push(run) });
    let ran = 0;
    deferred.defer({ run: async () => { ran += 1; return true; } });
    expect(scheduled.length).toBe(1);
    scheduled[0]();
    await deferred.replay();
    expect(ran).toBe(1);
    expect(deferred.size).toBe(0);
  });

  test('in the background no replay is scheduled: only the foreground event runs the queue', () => {
    const scheduled: Array<() => void> = [];
    const { deferred } = queue({ isForeground: () => false, scheduleReplay: (run) => scheduled.push(run) });
    deferred.defer({ run: async () => true });
    expect(scheduled.length).toBe(0);
  });
});
