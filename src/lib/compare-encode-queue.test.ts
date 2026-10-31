// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { createEncodeQueue } from './compare-encode-queue';

function harness() {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const pending = new Map<string, { resolve: (v: string) => void; reject: () => void }>();
  const results = new Map<string, string | 'failed'>();
  const q = createEncodeQueue<string>(
    (key) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(key);
      return new Promise<string>((resolve, reject) => {
        pending.set(key, {
          resolve: (v) => {
            active--;
            resolve(v);
          },
          reject: () => {
            active--;
            reject(new Error('x'));
          },
        });
      });
    },
    (key, o) => results.set(key, o.ok ? o.value : 'failed'),
  );
  const finish = async (key: string) => {
    pending.get(key)!.resolve(`r:${key}`);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { q, order, results, finish, pending, maxActive: () => maxActive };
}

describe('compare encode queue', () => {
  test('selected option is encoded first and only one runs at a time', async () => {
    const h = harness();
    for (const k of ['a', 'b', 'c', 'd']) h.q.enqueue(k);
    h.q.prioritize('c');
    expect(h.order).toEqual(['a']); // a was already running when c arrived
    await h.finish('a');
    expect(h.order).toEqual(['a', 'c']);
    await h.finish('c');
    await h.finish('b');
    await h.finish('d');
    expect(h.order).toEqual(['a', 'c', 'b', 'd']);
    expect(h.maxActive()).toBe(1);
  });

  test('rapid toggling never leaves a selected option without a result', async () => {
    const h = harness();
    h.q.prioritize('720');
    h.q.prioritize('1080');
    h.q.prioritize('2K');
    h.q.prioritize('720'); // already running: not re-queued
    h.q.prioritize('4K');
    h.q.prioritize('1080');
    expect(h.order).toEqual(['720']);
    expect(h.maxActive()).toBe(1);
    // the running one lands after the user moved on: result is still kept
    await h.finish('720');
    expect(h.results.get('720')).toBe('r:720');
    await h.finish('1080');
    await h.finish('4K');
    await h.finish('2K');
    for (const k of ['720', '1080', '2K', '4K']) expect(h.results.has(k)).toBe(true);
    expect(h.order).toEqual(['720', '1080', '4K', '2K']);
    expect(h.maxActive()).toBe(1);
  });

  test('finished keys are not run again; failures are reported and not retried', async () => {
    const h = harness();
    h.q.enqueue('a');
    h.pending.get('a')!.reject();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.results.get('a')).toBe('failed');
    h.q.prioritize('a');
    h.q.enqueue('a');
    expect(h.order).toEqual(['a']);
  });

  test('clear drops waiting keys but the running one still reports', async () => {
    const h = harness();
    h.q.enqueue('a');
    h.q.enqueue('b');
    h.q.clear();
    await h.finish('a');
    expect(h.results.get('a')).toBe('r:a');
    expect(h.order).toEqual(['a']);
    expect(h.q.waiting.length).toBe(0);
  });
});
