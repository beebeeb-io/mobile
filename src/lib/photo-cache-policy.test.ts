// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  planPhotoCacheEvictions,
  type PhotoCacheDiskEntry,
} from './photo-cache-policy';

function entry(fileId: string, sizeBytes: number, modifiedAt: number): PhotoCacheDiskEntry {
  return { fileId, uri: `/cache/${fileId}`, sizeBytes, modifiedAt };
}

describe('photo preview cache policy', () => {
  test('evicts entries older than the TTL', () => {
    const evictions = planPhotoCacheEvictions(
      [
        entry('fresh', 10, 9_000),
        entry('expired', 10, 1_000),
      ],
      10_000,
      { maxItems: 10, maxBytes: 1_000, ttlMs: 5_000 },
    );

    expect([...evictions]).toEqual(['expired']);
  });

  test('keeps newest entries when count is over the limit', () => {
    const evictions = planPhotoCacheEvictions(
      [
        entry('old', 10, 1_000),
        entry('newest', 10, 3_000),
        entry('middle', 10, 2_000),
      ],
      4_000,
      { maxItems: 2, maxBytes: 1_000, ttlMs: 10_000 },
    );

    expect([...evictions]).toEqual(['old']);
  });

  test('keeps newest entries within the byte budget', () => {
    const evictions = planPhotoCacheEvictions(
      [
        entry('old', 80, 1_000),
        entry('middle', 80, 2_000),
        entry('newest', 80, 3_000),
      ],
      4_000,
      { maxItems: 10, maxBytes: 160, ttlMs: 10_000 },
    );

    expect([...evictions]).toEqual(['old']);
  });
});
