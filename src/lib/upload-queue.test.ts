// @ts-nocheck
// Task 1685 fix 4 — RED-first tests for the bounded upload-side job queue.
//
// Bulk photo uploads fired `void Promise.allSettled([mediumThumb, largeThumb])`
// PER asset with no cap: 64 images → up to 128 concurrent full-image decodes +
// blurhash encodes → jetsam (the 1669 crash class). The limiter here is the
// crash fix; these tests must prove the cap, FIFO fairness, and that one
// failing job never stalls the queue.
import { describe, expect, test } from 'bun:test';
import { createBoundedQueue, THUMBNAIL_UPLOAD_CONCURRENCY } from './upload-queue';

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createBoundedQueue', () => {
  test('never runs more than `concurrency` jobs at once', async () => {
    const queue = createBoundedQueue(2);
    let active = 0;
    let peak = 0;

    const jobs = Array.from({ length: 12 }, (_, i) =>
      queue.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(10);
        active -= 1;
        return i;
      }),
    );

    const results = await Promise.all(jobs);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(peak).toBe(2);
  });

  test('runs jobs in FIFO order (queue, not a race)', async () => {
    const queue = createBoundedQueue(1);
    const order: number[] = [];
    const jobs = [1, 2, 3, 4, 5].map((n) =>
      queue.run(async () => {
        await tick(10 - n); // later jobs finish FASTER — FIFO must still hold
        order.push(n);
        return n;
      }),
    );
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  test('a rejecting job does not stall the queue; later jobs still run', async () => {
    const queue = createBoundedQueue(2);
    let ran = 0;

    const boom = queue.run(async () => {
      ran += 1;
      throw new Error('decode failed');
    }).catch((err) => `caught:${err.message}`);

    const ok = queue.run(async () => {
      ran += 1;
      return 'ok';
    });

    expect(await boom).toBe('caught:decode failed');
    expect(await ok).toBe('ok');
    expect(ran).toBe(2);
  });

  test('queued (not yet started) jobs can be observed for the crash guard', async () => {
    const queue = createBoundedQueue(1);
    const release: Array<() => void> = [];
    const gate = () => new Promise<void>((resolve) => release.push(resolve));

    const first = queue.run(async () => {
      await gate();
      return 'first';
    });
    const second = queue.run(async () => 'second');

    await tick();
    expect(queue.pendingCount()).toBe(1); // second is waiting, not running

    release[0]();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(queue.pendingCount()).toBe(0);
  });

  test('the shared thumbnail queue is capped at 2 concurrent decodes', () => {
    // The per-asset pair (medium + large) means one queued slot per variant —
    // 2 concurrent keeps worst-case decode pressure at 2 images at a time.
    expect(THUMBNAIL_UPLOAD_CONCURRENCY).toBe(2);
  });
});