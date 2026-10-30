// @ts-nocheck
/**
 * Task 1962 round 5 (P2.1) — an account epoch that advances during the apply
 * sequence must stop it before the first write. Round 4 checked only after
 * `seedLocalIdentifierMap`, which always writes local-id-map.json + the native
 * map, so a forced sign-out during `getRemoteToLocalMap()` still wrote the
 * outgoing account's identifiers.
 */
import { describe, expect, test } from 'bun:test';

import { seedAndEnqueueThumbnailApply } from './thumbnail-apply-sequence';

type Calls = { seeded: Array<Record<string, string>>; enqueued: Array<[string[], string]> };

function deps(overrides: Partial<any> = {}) {
  const calls: Calls = { seeded: [], enqueued: [] };
  let epoch = 7;
  const base = {
    capturedEpoch: epoch,
    getRemoteToLocalMap: async () => new Map([['remote-a', 'local-a']]),
    seedLocalIdentifierMap: async (map: Record<string, string>) => {
      calls.seeded.push(map);
    },
    enqueue: async (fileIds: string[], preset: string) => {
      calls.enqueued.push([fileIds, preset]);
    },
    isCurrentEpoch: (captured: number) => captured === epoch,
    advance: () => {
      epoch += 1;
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe('the epoch is checked before the first write (seed)', () => {
  test('epoch advances during getRemoteToLocalMap -> no seed, no enqueue', async () => {
    const { deps: d, calls } = deps();
    d.getRemoteToLocalMap = async () => {
      d.advance();
      return new Map([['remote-a', 'local-a']]);
    };
    const outcome = await seedAndEnqueueThumbnailApply(d, ['file-1'], 'medium');
    expect(outcome).toBe('epoch-advanced');
    expect(calls.seeded).toEqual([]);
    expect(calls.enqueued).toEqual([]);
  });

  test('epoch advances during the seed -> no enqueue', async () => {
    const { deps: d, calls } = deps();
    d.seedLocalIdentifierMap = async (map: Record<string, string>) => {
      calls.seeded.push(map);
      d.advance();
    };
    const outcome = await seedAndEnqueueThumbnailApply(d, ['file-1'], 'medium');
    expect(outcome).toBe('epoch-advanced');
    expect(calls.enqueued).toEqual([]);
  });

  test('a stable epoch seeds the same map then enqueues the ids', async () => {
    const { deps: d, calls } = deps();
    const outcome = await seedAndEnqueueThumbnailApply(d, ['file-1', 'file-2'], 'large');
    expect(outcome).toBe('applied');
    expect(calls.seeded).toEqual([{ 'remote-a': 'local-a' }]);
    expect(calls.enqueued).toEqual([[['file-1', 'file-2'], 'large']]);
  });
});
