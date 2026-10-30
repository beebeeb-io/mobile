// @ts-nocheck
/**
 * Task 2233 round 3 (N6) — the round-2 invalidate-and-retry-once path must
 * run ONLY on Android.
 *
 * On iOS a `file://` thumbnail URI can be a PhotoKit render or a file the
 * native ThumbnailService owns. `invalidateCachedThumbnail` deletes the JS
 * cache files but cannot clear the native in-memory cache, so the reload
 * returns the same URL and the tile ends up unavailable. On iOS `onError`
 * must behave exactly as on main: report the tile unavailable.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const platform = { OS: 'android' };

const state = {
  uri: 'file:///doc/beebeeb-thumbnails-v3/x.medium.webp' as string | null,
  failed: false,
  reloadKeys: [] as number[],
  invalidated: [] as string[],
  memoryInvalidated: [] as string[],
};

mock.module('react-native', () => ({
  NativeModules: {},
  Platform: platform,
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

async function render(fileId: string, unavailable: string[]): Promise<any> {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <ThumbnailImage
        fileId={fileId}
        placeholderColor="#000"
        onUnavailable={(id: string) => unavailable.push(id)}
      />,
    );
  });
  await settle();
  return renderer;
}

describe('task 2233 round 3 N6 — retry path is Android-only', () => {
  beforeEach(() => {
    platform.OS = 'android';
    state.uri = 'file:///doc/beebeeb-thumbnails-v3/x.medium.webp';
    state.failed = false;
    state.reloadKeys = [];
    state.invalidated = [];
    state.memoryInvalidated = [];
  });

  test('iOS: onError does not invalidate or delete anything and reports unavailable', async () => {
    platform.OS = 'ios';
    const unavailable: string[] = [];
    const renderer = await render('ios-x', unavailable);

    await act(async () => { imageNode(renderer).props.onError(); });
    await settle();

    expect(state.invalidated).toEqual([]);
    expect(state.memoryInvalidated).toEqual([]);
    expect(state.reloadKeys).toEqual([0]);
    expect(unavailable).toEqual(['ios-x']);

    await act(async () => { renderer.unmount(); });
  });

  test('Android: onError still invalidates once and retries once', async () => {
    const unavailable: string[] = [];
    const renderer = await render('android-x', unavailable);

    await act(async () => { imageNode(renderer).props.onError(); });
    await settle();

    expect(state.invalidated).toEqual(['android-x']);
    expect(state.memoryInvalidated).toEqual(['android-x']);
    expect(state.reloadKeys).toEqual([0, 1]);
    expect(unavailable).toEqual([]);

    await act(async () => { imageNode(renderer).props.onError(); });
    await settle();

    expect(unavailable).toEqual(['android-x']);
    expect(state.invalidated).toEqual(['android-x']);
    expect(state.reloadKeys).toEqual([0, 1]);

    await act(async () => { renderer.unmount(); });
  });
});
