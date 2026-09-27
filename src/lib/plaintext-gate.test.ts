// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 round 3 (#141 Codex P1 x3) — the plaintext-writer gate: a purge
 * closes it, drains every held lease (bounded), sweeps, and keeps it closed
 * until a new session opens it. Mutation evidence: task 1593 Notes (round 3).
 */
import { describe, expect, test } from 'bun:test';
import { createPlaintextGate, gatedPlaintextWrite, isPlaintextGateClosed, withPlaintextLease } from './plaintext-gate';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('createPlaintextGate', () => {
  test('purge waits for a held lease to be released before sweeping', async () => {
    const gate = createPlaintextGate({ drainTimeoutMs: 5_000 });
    const lease = gate.acquire('writer');
    const order = [];
    const purged = gate.purge(async () => { order.push('sweep'); });
    await sleep(20);
    expect(order).toEqual([]); // still draining
    expect(lease.valid).toBe(false); // the purge invalidated it at once
    expect(lease.signal.aborted).toBe(true);
    order.push('writer settled');
    lease.release();
    await purged;
    expect(order).toEqual(['writer settled', 'sweep']);
  });

  test('a lease still held past the drain bound: purge sweeps anyway and the late write discards itself', async () => {
    const gate = createPlaintextGate({ drainTimeoutMs: 30 });
    const disk = new Set();
    const fs = { deleteAsync: async (uri) => { disk.delete(uri); } };
    let finishWrite;
    const write = gatedPlaintextWrite('slow', 'file:///c/x', fs, () => new Promise((r) => {
      finishWrite = () => { disk.add('file:///c/x'); r(); };
    }), gate);
    await sleep(0);
    await gate.purge(async () => { disk.clear(); });
    expect(gate.held()).toBe(1); // past the bound, still running
    finishWrite();
    const err = await write.catch((e) => e);
    expect(isPlaintextGateClosed(err)).toBe(true);
    expect(disk.size).toBe(0);
  });

  test('after a purge the gate REFUSES new writers until open()', async () => {
    const gate = createPlaintextGate();
    await gate.purge(async () => {});
    expect(gate.isOpen()).toBe(false);
    expect(() => gate.acquire('late')).toThrow();
    let ran = false;
    const err = await withPlaintextLease('late', async () => { ran = true; }, gate).catch((e) => e);
    expect(isPlaintextGateClosed(err)).toBe(true);
    expect(err.name).toBe('AbortError');
    expect(ran).toBe(false);
    gate.open();
    expect(gate.acquire('new session').valid).toBe(true);
  });

  test('open() during a purge takes effect only when the purge has finished', async () => {
    const gate = createPlaintextGate();
    let release;
    const purged = gate.purge(() => new Promise((r) => { release = r; }));
    await sleep(0);
    gate.open();
    expect(gate.isOpen()).toBe(false);
    let idle = false;
    void gate.idle().then(() => { idle = true; });
    await sleep(0);
    expect(idle).toBe(false);
    release();
    await purged;
    await sleep(0);
    expect(idle).toBe(true);
    expect(gate.isOpen()).toBe(true);
  });

  test('a lease taken after open() is not invalidated by the previous purge', async () => {
    const gate = createPlaintextGate();
    await gate.purge(async () => {});
    gate.open();
    const lease = gate.acquire('fresh');
    expect(lease.valid).toBe(true);
    expect(lease.signal.aborted).toBe(false);
  });
});
