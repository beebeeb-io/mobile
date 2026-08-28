// @ts-nocheck
import { describe, expect, test, mock, beforeEach } from 'bun:test';

// thumbnail-cache.ts imports { Platform } from 'react-native'. Without this mock the real
// react-native entrypoint is parsed and its Flow `import typeof` syntax throws. This file used
// to pass only because another test file registered a react-native mock first (bun's
// mock.module registry is process-global) — see 0877.
// OS must be 'android': enqueueThumbnailLoad throws on any other platform by design
// (iOS routes through the BeebeebThumbnails native service instead).
mock.module('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'android' },
}));

mock.module('expo-file-system', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: async () => ({ exists: false }),
  readDirectoryAsync: async () => [],
  deleteAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => undefined,
  copyAsync: async () => undefined,
}));

const { enqueueThumbnailLoad, clearThumbnailQueue } = await import('./thumbnail-cache');

describe('enqueueThumbnailLoad concurrency + cancellation', () => {
  beforeEach(() => {
    clearThumbnailQueue();
  });

  test('caps concurrency at 6', async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 30 }, (_, i) => `id-${i}`);
    const loader = async (_id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return `uri://${_id}`;
    };
    const results = await Promise.all(ids.map((id) => enqueueThumbnailLoad(id, loader)));
    expect(results.every((u) => typeof u === 'string')).toBe(true);
    expect(peak).toBeLessThanOrEqual(6);
  });

  test('pending entry is dropped (resolves null) when its signal aborts before run', async () => {
    let started = 0;
    const slowLoader = async () => {
      started++;
      await new Promise((r) => setTimeout(r, 50));
      return 'done';
    };
    // First 6 fill the queue; remaining are pending.
    const blocking = Array.from({ length: 6 }, (_, i) =>
      enqueueThumbnailLoad(`block-${i}`, slowLoader),
    );

    const controller = new AbortController();
    const pending = enqueueThumbnailLoad('pending-1', slowLoader, controller.signal);
    controller.abort();

    expect(await pending).toBeNull();
    await Promise.all(blocking);
    expect(started).toBe(6); // pending-1 never started
  });

  test('in-flight loader receives signal and can short-circuit', async () => {
    let sawAbort = false;
    const loader = async (_id: string, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) {
        sawAbort = true;
        return null;
      }
      return 'uri';
    };
    const controller = new AbortController();
    const p = enqueueThumbnailLoad('running', loader, controller.signal);
    // Abort after the loader has started.
    setTimeout(() => controller.abort(), 1);
    const result = await p;
    expect(sawAbort).toBe(true);
    expect(result).toBeNull();
  });

  test('aborted signal at enqueue time resolves null without invoking loader', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const result = await enqueueThumbnailLoad('x', async () => {
      called = true;
      return 'uri';
    }, controller.signal);
    expect(called).toBe(false);
    expect(result).toBeNull();
  });
});
