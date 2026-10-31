// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  MAX_THUMB_BYTES,
  THUMB_CACHE_DIR_NAME,
  THUMB_VARIANTS,
  THUMB_VARIANTS_BY_SIZE,
  THUMB_WIDTH,
} from './thumbnail-policy';

const swiftSource = readFileSync(
  new URL('../../modules/beebeeb-crypto/ios/ThumbnailGenerator.swift', import.meta.url),
  'utf8',
);

/** Reads `public static let <name> = Config(ladder: [ (w, q), ... ]` from the Swift source. */
function swiftLadder(name: string): { width: number; quality: number }[] {
  const match = new RegExp(`static let ${name} = Config\\(\\s*ladder: \\[([\\s\\S]*?)\\],\\s*targetBytes`).exec(swiftSource);
  if (!match) throw new Error(`ladder not found: ${name}`);
  return [...match[1].matchAll(/\((\d+),\s*([\d.]+)\)/g)].map((m) => ({
    width: Number(m[1]),
    quality: Number(m[2]),
  }));
}

describe('thumbnail policy', () => {
  test('medium is 768px, capped at 100KB, fixed quality 0.35', () => {
    expect(THUMB_WIDTH).toBe(768);
    expect(MAX_THUMB_BYTES).toBe(100 * 1024);
    expect(THUMB_VARIANTS[0]).toEqual({ width: 768, quality: 0.35 });
    expect(THUMB_VARIANTS.every((variant) => variant.quality === 0.35)).toBe(true);
  });

  test('small and medium ladders degrade by width only, at the same quality', () => {
    expect(THUMB_VARIANTS_BY_SIZE.small[0]).toEqual({ width: 384, quality: 0.35 });
    for (const variant of ['small', 'medium'] as const) {
      const ladder = THUMB_VARIANTS_BY_SIZE[variant];
      expect(ladder.every((step) => step.quality === 0.35)).toBe(true);
      const widths = ladder.map((step) => step.width);
      expect(widths).toEqual([...widths].sort((a, b) => b - a));
    }
  });

  test('the Swift small and medium ladders match the JS ladders', () => {
    expect(swiftLadder('medium')).toEqual([...THUMB_VARIANTS_BY_SIZE.medium]);
    expect(swiftLadder('small')).toEqual([...THUMB_VARIANTS_BY_SIZE.small]);
  });

  test('the native grid takes its variant from the tested policy and upgrades small cells', () => {
    const grid = readFileSync(
      new URL('../../modules/beebeeb-crypto/ios/NativePhotosGridView.swift', import.meta.url),
      'utf8',
    );
    expect(grid).toContain('ThumbnailVariantPolicy.variant(forColumns: columns)');
    expect(grid).toContain('ThumbnailVariantPolicy.needsUpgrade(');
    expect(grid).toContain('variant: variant)');
  });

  test('bumps the persistent cache directory for regenerated thumbnails', () => {
    expect(THUMB_CACHE_DIR_NAME).toBe('beebeeb-thumbnails-v3');
  });
});
