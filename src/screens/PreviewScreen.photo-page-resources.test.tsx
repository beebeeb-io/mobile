// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1669 Issue 1 (lead review finding B) — the photo pager's native-resource
 * bound, proven against the REAL `PhotoPage` component in PreviewScreen.tsx.
 *
 * The first cut of this fix unit-tested a pure helper (`reconcileLoadedPages`)
 * that no component ever called, so deleting the real release logic left the
 * suite green. This file instead imports `PhotoPage` from PreviewScreen.tsx and
 * renders it with react-test-renderer. Only the collaborators are faked:
 *
 *   - every module PreviewScreen.tsx imports is replaced by a stub GENERATED
 *     from PreviewScreen.tsx's own import list (so a new import cannot silently
 *     break the harness), with a few hand-written behaviours below;
 *   - `expo-video` is a counting fake that mimics expo's real `useVideoPlayer`
 *     (create on mount / on source change, release on unmount / source change).
 *     The real one builds a native AVPlayer even for a null source — which is
 *     exactly how an image page used to own one.
 *
 * What is measured is the number of LIVE fake AVPlayers and of mounted
 * full-resolution <Image>s across a whole pager of pages, while the "current
 * page" walks through the library.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const SRC = join(import.meta.dir, '..');
const SCREEN = join(SRC, 'screens/PreviewScreen.tsx');

// ── live-resource ledger ────────────────────────────────────────────────────
const ledger = {
  playersCreated: 0,
  playersReleased: 0,
  liveImages: new Set<string>(), // ids of mounted <Image>s that show a file:// URI
  imageMounts: 0,
  rawTempCreated: new Set<string>(), // decrypted RAW source temp files written
  rawTempDeleted: new Set<string>(), // ...and deleted via FileSystem.deleteAsync
};
const livePlayers = () => ledger.playersCreated - ledger.playersReleased;

// ── react-native (hand-written; only what PhotoPage + module init touch) ────
const overrides = new Map<string, Record<string, unknown>>();
const defineMock = (spec: string, factory: () => Record<string, unknown>) => { overrides.set(spec, factory()); };
const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
const AnimatedValue = class {
  v: number;
  constructor(v: number) { this.v = v; }
  setValue(v: number) { this.v = v; }
  interpolate() { return this; }
  addListener() { return 'l'; }
  removeListener() {}
  stopAnimation() {}
};
const anim = () => ({ start: (cb?: any) => cb?.({ finished: true }), stop() {}, reset() {} });
let imageSeq = 0;
const Image = (props: any) => {
  const uri = props?.source?.uri as string | undefined;
  const id = React.useRef(++imageSeq).current;
  React.useEffect(() => {
    if (uri && uri.startsWith('file://')) {
      ledger.imageMounts += 1;
      ledger.liveImages.add(`${id}:${uri}`);
      return () => { ledger.liveImages.delete(`${id}:${uri}`); };
    }
    return undefined;
  }, [uri, id]);
  return React.createElement('Image', props);
};
defineMock('react-native', () => ({
  View: host('View'), Text: host('Text'), Pressable: host('Pressable'), TouchableOpacity: host('TouchableOpacity'),
  ScrollView: host('ScrollView'), FlatList: host('FlatList'), ActivityIndicator: host('ActivityIndicator'),
  Image,
  Animated: {
    Value: AnimatedValue, View: host('AnimatedView'), Image, Text: host('AnimatedText'),
    timing: anim, loop: anim, sequence: anim, parallel: anim, spring: anim, delay: anim,
  },
  Easing: new Proxy({}, { get: () => () => () => 0 }),
  Alert: { alert() {} },
  Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
  Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove() {} }),
    announceForAccessibility() {},
  },
  StyleSheet: { create: (s: any) => s, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1, flatten: (s: any) => s },
  PixelRatio: { get: () => 3 },
}));

// ── expo-video: counting fake with expo's real lifecycle ────────────────────
defineMock('expo-video', () => ({
  useVideoPlayer: (source: any, setup?: (p: any) => void) => {
    const key = JSON.stringify(source ?? null);
    const player = React.useMemo(() => {
      ledger.playersCreated += 1; // `new NativeVideoModule.VideoPlayer(...)` — happens for a null source too
      const p = { source, loop: true };
      setup?.(p);
      return p;
    }, [key]);
    React.useEffect(() => () => { ledger.playersReleased += 1; }, [player]);
    return player;
  },
  VideoView: (props: any) => React.createElement('VideoView', props),
}));

// ── hand-written collaborators PhotoPage's effects actually call ────────────
const colors = new Proxy({}, { get: () => '#000' });
const themeValue = { colors };
defineMock('../lib/theme-context', () => ({ useTheme: () => themeValue }));
// Stable identities: PhotoPage's load effect lists these in its deps, so fresh
// functions per render would re-fire it forever (as the real context does not).
const cryptoValue = {
  isUnlocked: true,
  getFileKeyBytes: async () => new Uint8Array(32),
  getMasterKeyHandleId: () => 1,
};
defineMock('../lib/crypto-context', () => ({ useCrypto: () => cryptoValue }));
defineMock('../lib/photo-cache', () => ({
  // Video path: a cache hit returns the on-disk decrypted original immediately.
  getCachedPhotoWithExtension: async (id: string) => `file:///cache/${id}.mp4`,
  getCachedPhoto: async (id: string) => `file:///cache/${id}.jpg`,
  cachePhoto: async (_id: string, uri: string) => uri,
  cachePhotoWithExtension: async (_id: string, uri: string) => uri,
  mediaCacheExtension: () => 'mp4',
}));
defineMock('../lib/thumbnail-cache', () => ({
  // Image path: `loadNormalPreviewThumbnail` reads the cached MEDIUM thumbnail; that file is the
  // page's "loaded" full resource. The variant-less call (the grid-size placeholder <Image>)
  // returns null so it never counts as a live full-resolution image.
  getCachedThumbnail: async (id: string, variant?: string) => (variant === 'medium' ? `file:///cache/${id}.medium.webp` : null),
}));
defineMock('../lib/offline-manager', () => ({
  offlineManager: { init: async () => {}, isAvailable: () => false, getStatus: () => null },
  offlineFilePath: () => '',
}));
defineMock('../lib/device-performance', () => ({
  getDevicePerformanceProfile: async () => ({ tier: 'high' }),
  getPerformanceProfileForStorage: () => 'smooth',
  resolvePreviewProfile: () => 'smooth',
}));
defineMock('../lib/runtime-trace', () => ({ recordRuntimeTrace: () => null }));
defineMock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: true }) } }));
// ZoomableImage just renders its children so the full-res <Image> mounts.
defineMock('../lib/preview-cache-key', () => ({ extensionForMime: (m?: string) => (m && m.startsWith('video/') ? 'mp4' : 'jpg'), previewCacheName: (id: string) => id, previewDecryptExtension: () => 'jpg', previewDisplayName: (n: string) => n }));
defineMock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: async (uri: string) => { ledger.rawTempDeleted.add(uri); },
}));
defineMock('../lib/native-decrypt', () => ({
  // RAW path: decryptToTempFile writes a per-session temp SOURCE file the page owns.
  decryptToTempFile: async (id: string) => { const u = `file:///tmp/${id}-${ledger.rawTempCreated.size}.dng`; ledger.rawTempCreated.add(u); return u; },
  releasePreviewCopy: async () => true,
  invalidatePreviewCache: async () => {},
}));
defineMock('../lib/file-category', () => ({ fileCategory: (_m: unknown, name?: string) => (name?.endsWith('.dng') ? 'raw' : 'other') }));
defineMock('../lib/raw-format', () => ({ extensionForRaw: () => 'dng', rawFormatLabel: () => 'DNG' }));
defineMock('../components/glass', () => ({ glassMaterial: () => new Proxy({}, { get: () => '#000' }) }));
defineMock('../components/preview/ZoomableImage', () => ({ ZoomableImage: (p: any) => React.createElement('Zoomable', null, p.children) }));

// ── generated stubs for EVERY import in PreviewScreen.tsx, then overrides ───
// `PhotoPageVideo`, `../theme` and `../lib/preview-temp-file` are deliberately real (pure).
const realModules = new Set(['react', '../components/preview/PhotoPageVideo', '../theme', '../lib/preview-temp-file']);
const source = readFileSync(SCREEN, 'utf8');
const importRe = /^import\s+(?!type\b)([\s\S]*?)\s+from\s+'([^']+)';?$/gm;
const wanted = new Map<string, { named: Set<string>; hasDefault: boolean }>();
for (let m = importRe.exec(source); m; m = importRe.exec(source)) {
  const [, clause, spec] = m;
  if (realModules.has(spec)) continue;
  const entry = wanted.get(spec) ?? { named: new Set<string>(), hasDefault: false };
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ')) continue;
      entry.named.add(t.split(/\s+as\s+/)[0].trim());
    }
  }
  if (/^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim())) entry.hasDefault = true;
  wanted.set(spec, entry);
}
for (const spec of overrides.keys()) if (!wanted.has(spec)) wanted.set(spec, { named: new Set(), hasDefault: false });
// A stub that is callable and renders nothing.
const noop = (..._a: any[]) => null;
for (const [spec, { named, hasDefault }] of wanted) {
  const mod: Record<string, unknown> = {};
  for (const n of named) mod[n] = noop;
  if (hasDefault) mod.default = noop;
  Object.assign(mod, overrides.get(spec) ?? {});
  const resolved = spec.startsWith('.') ? join(SRC, 'screens', spec) : spec;
  mock.module(resolved, () => mod);
}

const { PhotoPage } = await import('./PreviewScreen');

// ── harness ─────────────────────────────────────────────────────────────────
const noopFn = () => {};
function entryFor(i: number, kind: 'video' | 'image' | 'raw') {
  return {
    id: `file-${i}`,
    name_encrypted: `n${i}`,
    display_name: kind === 'video' ? `clip-${i}.mp4` : kind === 'raw' ? `shot-${i}.dng` : `photo-${i}.jpg`,
    mime_type: kind === 'video' ? 'video/mp4' : kind === 'raw' ? 'image/x-adobe-dng' : 'image/jpeg',
    size_bytes: 1000,
    chunk_count: 1,
    thumbnail_uri: null,
    local_asset_id: null,
  };
}
function Pager({ total, current, kinds }: { total: number; current: number; kinds: Array<'video' | 'image' | 'raw'> }) {
  // Every page stays mounted (worst case for the pager's window), only the current one is active.
  return React.createElement(
    React.Fragment,
    null,
    Array.from({ length: total }, (_, i) =>
      React.createElement(PhotoPage, {
        key: i,
        entry: entryFor(i, kinds[i]),
        shouldLoadFull: i === current,
        isCurrent: i === current,
        width: 390,
        previewProfile: 'smooth',
        originalRequestNonce: 0,
        locked: false,
        unlocking: false,
        onRequestUnlock: noopFn,
      }),
    ),
  );
}
async function settle() {
  await act(async () => { for (let k = 0; k < 8; k += 1) await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  ledger.playersCreated = 0; ledger.playersReleased = 0; ledger.liveImages.clear(); ledger.imageMounts = 0; ledger.rawTempCreated.clear(); ledger.rawTempDeleted.clear();
});
afterEach(() => { mock.restore?.(); });

describe('PhotoPage native-resource bound (real component)', () => {
  test('harness sanity: the active video page loads and owns exactly 1 live player', async () => {
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total: 3, current: 0, kinds: ['video', 'video', 'video'] })); });
    await settle();
    expect(livePlayers()).toBe(1);
    await act(async () => { r.unmount(); });
    expect(livePlayers()).toBe(0);
  });

  test('IMAGE pages own 0 AVPlayers (before the fix every mounted page constructed one, even with a null source)', async () => {
    let r: TestRenderer.ReactTestRenderer;
    const kinds = Array.from({ length: 12 }, () => 'image' as const);
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total: 12, current: 0, kinds })); });
    await settle();
    expect(ledger.playersCreated).toBe(0);
    await act(async () => { r.unmount(); });
  });

  test('scrolling through 60 video pages never holds more than 1 live AVPlayer (08:41 jetsam had 14)', async () => {
    const total = 60;
    const kinds = Array.from({ length: total }, () => 'video' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    let peak = livePlayers();
    for (let cur = 1; cur < total; cur += 1) {
      await act(async () => { r.update(React.createElement(Pager, { total, current: cur, kinds })); });
      await settle();
      peak = Math.max(peak, livePlayers());
      expect(livePlayers()).toBeLessThanOrEqual(1);
    }
    expect(peak).toBe(1); // it really loaded (a bound met by loading nothing proves nothing)
    expect(ledger.playersCreated).toBeGreaterThanOrEqual(total); // and every page got its turn
    await act(async () => { r.unmount(); });
    expect(livePlayers()).toBe(0);
  });

  test('scrolling through 60 image pages never holds more than 1 mounted full-resolution image', async () => {
    const total = 60;
    const kinds = Array.from({ length: total }, () => 'image' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    let peak = ledger.liveImages.size;
    for (let cur = 1; cur < total; cur += 1) {
      await act(async () => { r.update(React.createElement(Pager, { total, current: cur, kinds })); });
      await settle();
      peak = Math.max(peak, ledger.liveImages.size);
      expect(ledger.liveImages.size).toBeLessThanOrEqual(1);
    }
    expect(peak).toBe(1);
    expect(ledger.imageMounts).toBeGreaterThanOrEqual(total);
    await act(async () => { r.unmount(); });
  });

  test('RAW pages: leaving a page deletes its decrypted source temp file (a reload would otherwise orphan it on disk)', async () => {
    const total = 20;
    const kinds = Array.from({ length: total }, () => 'raw' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    for (let cur = 1; cur < total; cur += 1) {
      await act(async () => { r.update(React.createElement(Pager, { total, current: cur, kinds })); });
      await settle();
      // at most the current page's temp file is still on disk
      const onDisk = [...ledger.rawTempCreated].filter((u) => !ledger.rawTempDeleted.has(u));
      expect(onDisk.length).toBeLessThanOrEqual(1);
    }
    expect(ledger.rawTempCreated.size).toBeGreaterThanOrEqual(total); // every page really decrypted
    await act(async () => { r.unmount(); });
  });
});
