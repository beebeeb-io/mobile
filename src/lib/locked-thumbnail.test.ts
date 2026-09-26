// @ts-nocheck
// Flow "iOS core journeys" issue 3 (P2) — after "Lock file", the Photos tab
// tile still rendered the full thumbnail. The native iOS grid cell loads the
// thumbnail itself by file id (ThumbnailService), and the RN fallback cell
// renders the PhotoKit asset / server thumbnail / blurhash — so the item that
// PhotosScreen hands to either grid must say "hide this" for a locked id and
// carry no image source at all.
import { describe, expect, test } from 'bun:test';
import { lockAwareThumbnailFields } from './locked-thumbnail';

const source = {
  thumbnailUri: 'file:///cache/beebeeb-thumbnails-v3/23d09f31.medium.webp',
  localAssetId: 'ph-asset-1/L0/001',
  blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
};

describe('lockAwareThumbnailFields', () => {
  test('an unlocked photo keeps every image source (control)', () => {
    expect(lockAwareThumbnailFields('p1', source, new Set(['other']), true)).toEqual({
      ...source,
      hideThumbnail: false,
      isLocked: false,
    });
  });

  test('a locked photo carries no image source and is marked locked + hidden', () => {
    expect(lockAwareThumbnailFields('p1', source, new Set(['p1']), true)).toEqual({
      thumbnailUri: null,
      localAssetId: null,
      blurhash: null,
      hideThumbnail: true,
      isLocked: true,
    });
  });

  test('before the lock list has loaded, every thumbnail is hidden (fail closed) without claiming it is locked', () => {
    expect(lockAwareThumbnailFields('p1', source, new Set(), false)).toEqual({
      thumbnailUri: null,
      localAssetId: null,
      blurhash: null,
      hideThumbnail: true,
      isLocked: false,
    });
  });
});
