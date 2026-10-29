// @ts-nocheck
/**
 * Task 2233 round 2 (P3, adversarial case 8) — a corrupt cache file that
 * `<Image>` cannot decode is invalidated and retried ONCE.
 *
 * Round 1 only called `invalidateCachedThumbnail` from the cache module's
 * test; the component itself just reported the tile unavailable forever.
 * Required: on `onError` of a `file://` cache URI, drop the corrupt entry and
 * reload once; a second error means genuinely unavailable.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const state = {
  uri: 'file:///doc/beebeeb-thumbnails-v3/x.medium.webp' as string | null,
  failed: false,
  reloadKeys: [] as number[],
  invalidated: [] as string[],
  memoryInvalidated: [] as string[],
};

mock.module('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'android', select: (opts: any) => opts.android },
  StyleSheet: {
    create: (styles: any) => styles,
    absoluteFill: {},
    absoluteFillObject: {},
  },
  View: 'View',
  Image: 'Image',
}));
mock.module('../lib/use-thumbnail', () => ({
  useThumbnail: (_fileId: string, options: any) => {
    state.reloadKeys.push(options?.reloadKey ?? 0);
    return { uri: state.uri, source: 'cache', failed: state.failed };
  },
}));
mock.module('../lib/thumbnail-cache', () => ({
  invalidateCachedThumbnail: async (fileId: string) => { state.invalidated.push(fileId); },
}));
mock.module('../lib/thumbnail', () => ({
  invalidateInMemoryThumbCache: (fileId: string) => { state.memoryInvalidated.push(fileId); },
}));
mock.module('../lib/runtime-trace', () => ({ recordRuntimeTrace: () => {} }));

const { ThumbnailImage } = await import('./ThumbnailImage');

function imageNode(renderer: any) {
  return renderer.root.findAllByType('Image')[0];
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

describe('task 2233 round 2 P3 — corrupt cache file retried once', () => {
  beforeEach(() => {
    state.uri = 'file:///doc/beebeeb-thumbnails-v3/x.medium.webp';
    state.failed = false;
    state.reloadKeys = [];
    state.invalidated = [];
    state.memoryInvalidated = [];
  });

  test('first <Image onError> invalidates the entry and reloads once; the second reports unavailable', async () => {
    const unavailable: string[] = [];
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThumbnailImage
          fileId="x"
          placeholderColor="#000"
          onUnavailable={(fileId: string) => unavailable.push(fileId)}
        />,
      );
    });
    await settle();

    expect(state.reloadKeys).toEqual([0]);
    expect(unavailable).toEqual([]);

    await act(async () => { imageNode(renderer).props.onError(); });
    await settle();

    // One invalidation (disk + in-memory) and one forced reload.
    expect(state.invalidated).toEqual(['x']);
    expect(state.memoryInvalidated).toEqual(['x']);
    expect(state.reloadKeys).toEqual([0, 1]);
    expect(unavailable).toEqual([]);

    // Still corrupt: a second error reports the tile unavailable and does not
    // invalidate/reload again.
    await act(async () => { imageNode(renderer).props.onError(); });
    await settle();
    expect(unavailable).toEqual(['x']);
    expect(state.invalidated).toEqual(['x']);
    expect(state.reloadKeys).toEqual([0, 1]);

    await act(async () => { renderer.unmount(); });
  });
});
