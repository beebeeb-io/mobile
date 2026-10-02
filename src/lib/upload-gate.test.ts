// @ts-nocheck
// Task 1685 review should-fix 1+2 — RED-first tests for the upload gate.
//
// Oracle finding 1: a second pick during a running batch started a SECOND
// concurrent serial loop — two writers on the single `upload` card state
// (either loop's setUpload(null) could vanish the other's card) and 2
// concurrent encrypted streams. The gate serializes: a pick made while busy
// WAITS behind the running loop.
//
// Oracle finding 2: handlePendingUpload offered Resume for a row that was
// uploading RIGHT NOW → duplicate chunk PUTs / double finalize. canOfferResume
// is the pure decision: pointer present AND nothing in flight AND not the
// active row itself.
import { describe, expect, test } from 'bun:test';
import { canOfferResume, createUploadGate } from './upload-gate';

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createUploadGate', () => {
  test('serializes: a second submitted task starts only after the first settles', async () => {
    const gate = createUploadGate();
    const events: string[] = [];

    const first = gate.run(async () => {
      events.push('first:start');
      await tick(20);
      events.push('first:end');
      return 'a';
    });
    const second = gate.run(async () => {
      events.push('second:start');
      await tick(5);
      events.push('second:end');
      return 'b';
    });

    expect(await first).toBe('a');
    expect(await second).toBe('b');
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  test('isBusy is true while work is submitted-but-not-settled, false after', async () => {
    const gate = createUploadGate();
    const release: Array<() => void> = [];
    const wait = () => new Promise<void>((resolve) => release.push(resolve));

    const first = gate.run(async () => { await wait(); return 1; });
    const second = gate.run(async () => 2);

    await tick();
    expect(gate.isBusy()).toBe(true); // first running, second queued

    release[0]();
    await first;
    expect(gate.isBusy()).toBe(true); // second still queued/running — NOT reset by the first settling

    await second;
    expect(gate.isBusy()).toBe(false);
  });

  test('a rejecting task neither stalls the chain nor breaks later tasks', async () => {
    const gate = createUploadGate();
    let ran = 0;

    const boom = gate.run(async () => {
      ran += 1;
      throw new Error('batch failed');
    });
    const next = gate.run(async () => {
      ran += 1;
      return 'ok';
    });

    await expect(boom).rejects.toThrow('batch failed');
    expect(await next).toBe('ok');
    expect(ran).toBe(2);
    expect(gate.isBusy()).toBe(false); // the chain itself never hangs
  });
});

describe('canOfferResume', () => {
  const pointer = { fileId: 'row-1', resumeKey: 'k', sourceUri: 'file:///a', name: 'a.jpg', parentId: null, mimeType: null, plaintextSizeBytes: 1 };

  test('no resume pointer → never offer', () => {
    expect(canOfferResume(null, null, 'row-1', false)).toBe(false);
  });

  test('the row IS the active upload → never offer (duplicate PUTs / double finalize)', () => {
    expect(canOfferResume(pointer, 'row-1', 'row-1', false)).toBe(false);
  });

  test('any upload in flight → never offer (the active id may not even be known yet)', () => {
    expect(canOfferResume(pointer, null, 'row-1', true)).toBe(false);
    expect(canOfferResume(pointer, 'other-row', 'row-1', true)).toBe(false);
  });

  test('pointer + nothing in flight + different row → offer', () => {
    expect(canOfferResume(pointer, null, 'row-1', false)).toBe(true);
    expect(canOfferResume(pointer, 'row-2', 'row-1', false)).toBe(true);
  });
});