// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 (#141 review P2) — one in-flight decrypt per preview cache path,
 * with per-caller cancellation. Mutation evidence: task 1593 Notes.
 */
import { describe, expect, test } from 'bun:test';
import { createInFlightShare } from './inflight-share';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createInFlightShare', () => {
  test('a second caller for the same key joins the first job (one start)', async () => {
    const share = createInFlightShare<string>();
    const d = deferred<string>();
    let starts = 0;
    const start = () => { starts += 1; return d.promise; };
    const a = share.run('k', start);
    const b = share.run('k', start);
    d.resolve('path');
    expect(await a).toEqual({ value: 'path', joined: false });
    expect(await b).toEqual({ value: 'path', joined: true });
    expect(starts).toBe(1);
    expect(share.size()).toBe(0);
  });

  test('different keys run separately', async () => {
    const share = createInFlightShare<string>();
    let starts = 0;
    const start = async () => { starts += 1; return 'x'; };
    await Promise.all([share.run('a', start), share.run('b', start)]);
    expect(starts).toBe(2);
  });

  test('one caller aborting rejects only that caller; the shared job keeps running', async () => {
    const share = createInFlightShare<string>();
    const d = deferred<string>();
    let jobSignal: AbortSignal | null = null;
    const start = (signal) => { jobSignal = signal; return d.promise; };
    const ca = new AbortController();
    const a = share.run('k', start, ca.signal);
    const b = share.run('k', start);
    ca.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(jobSignal.aborted).toBe(false);
    d.resolve('p');
    expect((await b).value).toBe('p');
  });

  test('the shared job is aborted once EVERY caller has aborted', async () => {
    const share = createInFlightShare<string>();
    let jobSignal: AbortSignal | null = null;
    const start = (signal) => {
      jobSignal = signal;
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
      });
    };
    const ca = new AbortController();
    const cb = new AbortController();
    const a = share.run('k', start, ca.signal);
    const b = share.run('k', start, cb.signal);
    ca.abort();
    expect(jobSignal.aborted).toBe(false);
    cb.abort();
    expect(jobSignal.aborted).toBe(true);
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a caller arriving after the job was abandoned starts fresh, AFTER the doomed job settles', async () => {
    const share = createInFlightShare<string>();
    const order: string[] = [];
    const doomed = deferred<string>();
    const ca = new AbortController();
    const a = share.run('k', () => doomed.promise, ca.signal);
    ca.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const b = share.run('k', async () => { order.push('fresh-start'); return 'fresh'; });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]); // still waiting on the doomed job's cleanup
    order.push('doomed-settled');
    doomed.reject(new Error('aborted'));
    expect(await b).toEqual({ value: 'fresh', joined: false });
    expect(order).toEqual(['doomed-settled', 'fresh-start']);
  });

  test('abortAll aborts every job and resolves when they have settled', async () => {
    const share = createInFlightShare<string>();
    const signals: AbortSignal[] = [];
    const start = (signal) => {
      signals.push(signal);
      return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const a = share.run('a', start).catch((e) => e);
    const b = share.run('b', start).catch((e) => e);
    await share.abortAll();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect(share.size()).toBe(0);
    await a; await b;
  });
});

describe('task 1593 round 3 — with a plaintext gate (#141 Codex P1)', () => {
  test('a purge aborts the job, and a caller arriving during it is refused instead of queued', async () => {
    const { createPlaintextGate } = await import('./plaintext-gate');
    const gate = createPlaintextGate();
    const share = createInFlightShare<string>({ gate, label: 'test' });
    const d = deferred<string>();
    let starts = 0;
    let firstSignal;
    const start = (signal) => { starts += 1; firstSignal ??= signal; return d.promise; };
    const a = share.run('k', start).catch((e) => e);
    let release;
    const purge = gate.purge(() => new Promise((r) => { release = r; }));
    expect(firstSignal.aborted).toBe(true);
    const b = await share.run('k', start).catch((e) => e);
    expect(b.name).toBe('AbortError');
    d.reject(Object.assign(new Error('x'), { name: 'AbortError' }));
    await a;
    await new Promise((r) => setTimeout(r, 0));
    release();
    await purge;
    expect(starts).toBe(1);
    expect(gate.held()).toBe(0); // the job's lease was released when it settled
  });
});
