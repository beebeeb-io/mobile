// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  MAX_THUMB_BYTES,
  THUMB_CACHE_DIR_NAME,
  THUMB_VARIANTS,
  THUMB_WIDTH,
} from './thumbnail-policy';

describe('thumbnail policy', () => {
  test('uses one medium-sized thumbnail tier capped at 50KB', () => {
    expect(THUMB_WIDTH).toBe(768);
    expect(MAX_THUMB_BYTES).toBe(50 * 1024);
    expect(THUMB_VARIANTS.every((variant) => variant.width === THUMB_WIDTH)).toBe(true);
    expect(Math.min(...THUMB_VARIANTS.map((variant) => variant.quality))).toBeGreaterThanOrEqual(0.5);
  });

  test('bumps the persistent cache directory for regenerated thumbnails', () => {
    expect(THUMB_CACHE_DIR_NAME).toBe('beebeeb-thumbnails-v3');
  });
});
