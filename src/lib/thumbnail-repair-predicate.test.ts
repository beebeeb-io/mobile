// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  DEGRADED_THUMBNAIL_BYTES_THRESHOLD,
  isDegradedThumbnail,
} from './thumbnail-repair-predicate';

const baseFile = {
  id: 'f1',
  name_encrypted: '{"cipher_suite":"V1Aes256Gcm","nonce":[],"ciphertext":[]}',
  size_bytes: 4_000_000,
  is_folder: false,
  is_uploading: false,
  chunk_count: 1,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  has_thumbnail: true,
};

describe('isDegradedThumbnail (task 0553)', () => {
  test('classifies tiny thumbnail bytes as degraded', () => {
    expect(isDegradedThumbnail({ ...baseFile, thumbnail_bytes: 12_000 })).toBe(true);
  });

  test('classifies blob ≥ threshold as not degraded', () => {
    expect(isDegradedThumbnail({ ...baseFile, thumbnail_bytes: DEGRADED_THUMBNAIL_BYTES_THRESHOLD })).toBe(false);
    expect(isDegradedThumbnail({ ...baseFile, thumbnail_bytes: 90_000 })).toBe(false);
  });

  test('treats missing thumbnail_bytes (server pre-0553) as degraded by default', () => {
    expect(isDegradedThumbnail({ ...baseFile, thumbnail_bytes: undefined })).toBe(true);
    expect(isDegradedThumbnail({ ...baseFile, thumbnail_bytes: null })).toBe(true);
  });

  test('skips folders and uploading files', () => {
    expect(isDegradedThumbnail({ ...baseFile, is_folder: true, thumbnail_bytes: 10_000 })).toBe(false);
    expect(isDegradedThumbnail({ ...baseFile, is_uploading: true, thumbnail_bytes: 10_000 })).toBe(false);
  });

  test('skips files without a thumbnail', () => {
    expect(isDegradedThumbnail({ ...baseFile, has_thumbnail: false, thumbnail_bytes: 10_000 })).toBe(false);
    expect(isDegradedThumbnail({ ...baseFile, has_thumbnail: undefined, thumbnail_bytes: 10_000 })).toBe(false);
  });
});
