// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const engine = readFileSync(
  new URL('../../modules/beebeeb-crypto/ios/NativeBackupEngine.swift', import.meta.url),
  'utf8',
);
const filesScreen = readFileSync(new URL('../screens/FilesScreen.tsx', import.meta.url), 'utf8');

describe('uploads create the small thumbnail variant', () => {
  test('native backup PUTs medium, then small, then large from one source', () => {
    const medium = engine.indexOf('config: .medium)');
    const small = engine.indexOf('config: .small)');
    const large = engine.indexOf('config: .large)');
    expect(medium).toBeGreaterThan(-1);
    expect(small).toBeGreaterThan(medium);
    expect(large).toBeGreaterThan(small);
    expect(engine).toContain('variant: "small"');
    expect(engine).toContain('maxBytes: ThumbnailGenerator.Config.small.maxBytes + 28');
    expect(engine.match(/fetchPhotoSourceImage\(phAssetId: phAssetId\)/g)?.length).toBe(1);
  });

  test('small carries no blurhash', () => {
    const block = engine.slice(engine.indexOf('variant: "small"'), engine.indexOf('config: .large)'));
    expect(block).toContain('blurhash: nil');
  });

  test('every JS manual-upload site queues medium, small and large', () => {
    const mediums = filesScreen.match(/generateAndUploadThumbnail\([^\n]*getFileKeyBytes\)\)/g) ?? [];
    const smalls = filesScreen.match(/getFileKeyBytes, 'small'\)\)/g) ?? [];
    const larges = filesScreen.match(/getFileKeyBytes, 'large'\)\)/g) ?? [];
    expect(mediums.length).toBe(3);
    expect(smalls.length).toBe(3);
    expect(larges.length).toBe(3);
  });
});
