// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
// Task 1721 — guard the iOS DNG thumbnail path against returning to a
// full-size UIImage decode on Expo's shared default native queue.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const swiftSource = readFileSync(
  join(import.meta.dir, '../../modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'),
  'utf8',
);

const dngBlock = swiftSource.match(/AsyncFunction\("generateDngThumbnail"\)[\s\S]*?\.runOnQueue\(beebeebDngThumbnailQueue\)/)?.[0] ?? '';

describe('iOS DNG thumbnail native implementation', () => {
  test('uses ImageIO bounded thumbnail extraction instead of full UIImage file decode', () => {
    expect(swiftSource).toContain('import ImageIO');
    expect(dngBlock).toContain('CGImageSourceCreateWithURL');
    expect(dngBlock).toContain('CGImageSourceCreateThumbnailAtIndex');
    expect(dngBlock).toContain('kCGImageSourceThumbnailMaxPixelSize');
    expect(dngBlock).toContain('kCGImageSourceShouldCache: false');
    expect(dngBlock).not.toContain('UIImage(contentsOfFile:');
  });

  test('runs DNG thumbnail work away from Expo default queue and preserves size variants', () => {
    expect(swiftSource).toContain('private let beebeebDngThumbnailQueue = DispatchQueue(');
    expect(dngBlock).toContain('.runOnQueue(beebeebDngThumbnailQueue)');
    expect(dngBlock).toContain('min(maxSize, 1600)');
    expect(dngBlock).toContain('config = .large');
    expect(dngBlock).toContain('config = .medium');
    expect(dngBlock).toContain('config = .small');
  });
});
