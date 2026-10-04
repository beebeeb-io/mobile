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
 * full-resolution <Image>s / RAW temp files across a whole pager of pages, while
 * the "current page" walks through the library. The bounds are the lead's round-2
 * rulings: image + RAW resources stay loaded for current +-1 (at most 3 pages,
 * PHOTO_PAGE_LOAD_RADIUS = 1, matching the pager's windowSize=3) and are released
 * beyond that; an AVPlayer is bounded to the CURRENT page only (at most 1), except
 * that a player in Picture in Picture is held until PiP ends.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PHOTO_PAGE_LOAD_RADIUS, activePhotoPageIndices } from '../lib/photo-viewer-window';

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
  previewReleases: [] as Array<{ id: string; ext: string }>,
  // Per-file LOAD counters (what a swipe back must not repeat):
  imageLoads: new Map<string, number>(), // reads of the cached medium thumbnail (the page's image resource)
  rawDecrypts: new Map<string, number>(), // decryptToTempFile calls (a real decrypt of the RAW source)
  largeRequests: new Map<string, number>(), // large-preview upgrade requests (getCachedThumbnail(id, 'large'))
  videoViews: new Map<string, any>(), // latest props of each rendered VideoView, keyed by source uri
};
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
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
  VideoView: (props: any) => {
    // Remember the latest props (incl. onPictureInPictureStart/Stop) so a test can simulate the
    // native PiP events exactly as expo-video's VideoView would fire them.
    ledger.videoViews.set(String(props.player?.source), props);
    return React.createElement('VideoView', props);
  },
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
  getCachedPhotoWithExtension: async (id: string) => (id.includes('stream') ? null : `file:///cache/${id}.mp4`),
  getCachedPhoto: async (id: string) => `file:///cache/${id}.jpg`,
  cachePhoto: async (_id: string, uri: string) => uri,
  cachePhotoWithExtension: async (_id: string, uri: string) => uri,
  mediaCacheExtension: () => 'mp4',
}));
defineMock('../lib/thumbnail-cache', () => ({
  // Image path: `loadNormalPreviewThumbnail` reads the cached MEDIUM thumbnail; that file is the
  // page's "loaded" full resource. The variant-less call (the grid-size placeholder <Image>)
  // returns null so it never counts as a live full-resolution image.
  getCachedThumbnail: async (id: string, variant?: string) => {
    if (variant === 'large') bump(ledger.largeRequests, id);
    if (variant === 'medium') bump(ledger.imageLoads, id);
    return variant === 'medium' ? `file:///cache/${id}.medium.webp` : null;
  },
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
  decryptToTempFile: async (id: string, _key: unknown, ext: string) => {
    if (ext === 'mp4') return `http://127.0.0.1:49640/stream/${id}`;
    bump(ledger.rawDecrypts, id);
    const u = `file:///tmp/${id}-${ledger.rawTempCreated.size}.dng`;
    ledger.rawTempCreated.add(u);
    return u;
  },
  releasePreviewCopy: async (id: string, ext: string) => {
    ledger.previewReleases.push({ id, ext });
    if (ext === 'dng') {
      for (const uri of ledger.rawTempCreated) {
        if (uri.includes(`/${id}-`)) ledger.rawTempDeleted.add(uri);
      }
    }
    return true;
  },
  invalidatePreviewCache: async () => {},
}));
defineMock('../lib/video-stream', () => ({
  isLoopbackStreamUri: (uri: string | null | undefined) => typeof uri === 'string' && uri.startsWith('http://127.0.0.1:'),
  streamBufferPctFromEvent: () => undefined,
}));
defineMock('../lib/file-category', () => ({ fileCategory: (_m: unknown, name?: string) => (name?.endsWith('.dng') ? 'raw' : 'other') }));
defineMock('../lib/raw-format', () => ({ extensionForRaw: () => 'dng', rawFormatLabel: () => 'DNG' }));
defineMock('../components/glass', () => ({ glassMaterial: () => new Proxy({}, { get: () => '#000' }) }));
defineMock('../components/preview/ZoomableImage', () => ({ ZoomableImage: (p: any) => React.createElement('Zoomable', null, p.children) }));

// ── generated stubs for EVERY import in PreviewScreen.tsx, then overrides ───
// `PhotoPageVideo`, `../theme`, `../lib/preview-temp-file` and `../lib/photo-viewer-window` are deliberately real (pure).
const realModules = new Set(['react', '../components/preview/PhotoPageVideo', '../theme', '../lib/preview-temp-file', '../lib/photo-viewer-window']);
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
type PageKind = 'video' | 'streamVideo' | 'image' | 'raw';

function entryFor(i: number, kind: PageKind) {
  const isVideo = kind === 'video' || kind === 'streamVideo';
  const id = kind === 'streamVideo' ? `file-stream-${i}` : `file-${i}`;
  return {
    id,
    name_encrypted: `n${i}`,
    display_name: isVideo ? `clip-${i}.mp4` : kind === 'raw' ? `shot-${i}.dng` : `photo-${i}.jpg`,
    mime_type: isVideo ? 'video/mp4' : kind === 'raw' ? 'image/x-adobe-dng' : 'image/jpeg',
    size_bytes: 1000,
    chunk_count: 1,
    thumbnail_uri: null,
    local_asset_id: null,
  };
}
function Pager({ total, current, kinds }: { total: number; current: number; kinds: PageKind[] }) {
  // Every page stays mounted (worst case for the pager's window). Which pages may load their full
  // resource is decided EXACTLY as PreviewScreen does: activePhotoPageIndices(current, total,
  // PHOTO_PAGE_LOAD_RADIUS) (a source test below pins that call site).
  const loadable = activePhotoPageIndices(current, total, PHOTO_PAGE_LOAD_RADIUS);
  return React.createElement(
    React.Fragment,
    null,
    Array.from({ length: total }, (_, i) =>
      React.createElement(PhotoPage, {
        key: i,
        entry: entryFor(i, kinds[i]),
        shouldLoadFull: loadable.has(i),
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
  ledger.imageLoads.clear(); ledger.rawDecrypts.clear(); ledger.largeRequests.clear(); ledger.videoViews.clear();
  ledger.previewReleases.length = 0;
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

  test('scrolling through 60 video pages never holds more than 1 live AVPlayer (per the task 1669 evidence transcription the 08:41 jetsam run had 14 deallocated)', async () => {
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

  const rawOnDisk = () => [...ledger.rawTempCreated].filter((u) => !ledger.rawTempDeleted.has(u)).length;

  test('scrolling through 60 image pages never holds more than 3 mounted full-resolution images (current +-1)', async () => {
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
      expect(ledger.liveImages.size).toBeLessThanOrEqual(3);
    }
    expect(peak).toBe(3); // the window really fills (a bound met by loading nothing proves nothing)
    expect(ledger.imageMounts).toBeGreaterThanOrEqual(total);
    await act(async () => { r.unmount(); });
  });

  test('scrolling through 60 RAW pages never holds more than 3 decrypted RAW source files on disk (current +-1)', async () => {
    const total = 60;
    const kinds = Array.from({ length: total }, () => 'raw' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    let peak = rawOnDisk();
    for (let cur = 1; cur < total; cur += 1) {
      await act(async () => { r.update(React.createElement(Pager, { total, current: cur, kinds })); });
      await settle();
      peak = Math.max(peak, rawOnDisk());
      expect(rawOnDisk()).toBeLessThanOrEqual(3);
    }
    expect(peak).toBe(3);
    expect(ledger.rawTempCreated.size).toBeGreaterThanOrEqual(total); // every page really decrypted
    await act(async () => { r.unmount(); });
  });

  test('a mixed image / RAW / video walk holds <= 3 image+RAW resources and <= 1 AVPlayer at every step', async () => {
    const total = 45;
    const kinds = Array.from({ length: total }, (_, i) => (['image', 'raw', 'video'] as const)[i % 3]);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    let peakPlayers = 0;
    let peakResources = 0;
    for (let cur = 0; cur < total; cur += 1) {
      if (cur > 0) await act(async () => { r.update(React.createElement(Pager, { total, current: cur, kinds })); });
      await settle();
      const resources = ledger.liveImages.size + rawOnDisk();
      peakPlayers = Math.max(peakPlayers, livePlayers());
      peakResources = Math.max(peakResources, resources);
      expect(livePlayers()).toBeLessThanOrEqual(1);
      expect(resources).toBeLessThanOrEqual(3);
    }
    expect(peakPlayers).toBe(1);
    expect(peakResources).toBeGreaterThanOrEqual(2); // image + RAW neighbours really were held
    await act(async () => { r.unmount(); });
  });

  test('swipe away and back to a neighbour triggers 0 new loads / decrypts (image)', async () => {
    const total = 6;
    const kinds = Array.from({ length: total }, () => 'image' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 1, kinds })); });
    await settle();
    const afterAway = sum(ledger.imageLoads);
    await act(async () => { r.update(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    expect(sum(ledger.imageLoads)).toBe(afterAway); // swiping back loaded nothing
    expect(ledger.imageLoads.get('file-0')).toBe(1);
    expect(ledger.imageLoads.get('file-1')).toBe(1);
    expect(afterAway).toBe(3); // pages 0,1,2 were each loaded exactly once overall
    await act(async () => { r.unmount(); });
  });

  test('swipe away and back to a neighbour triggers 0 new decrypt calls (RAW)', async () => {
    const total = 6;
    const kinds = Array.from({ length: total }, () => 'raw' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 1, kinds })); });
    await settle();
    const afterAway = sum(ledger.rawDecrypts);
    await act(async () => { r.update(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    expect(sum(ledger.rawDecrypts)).toBe(afterAway); // 0 new decrypt calls on the swipe back
    expect(ledger.rawDecrypts.get('file-0')).toBe(1);
    expect(ledger.rawDecrypts.get('file-1')).toBe(1);
    expect(afterAway).toBe(3);
    await act(async () => { r.unmount(); });
  });

  test('a page released beyond the +-1 window DOES reload when revisited (the bound is real, not "never release")', async () => {
    const total = 8;
    const kinds = Array.from({ length: total }, () => 'image' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 5, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    expect(ledger.imageLoads.get('file-0')).toBe(2);
    await act(async () => { r.unmount(); });
  });

  test('a RAW page releases the decryptToTempFile preview lease when it leaves the load window', async () => {
    const total = 6;
    const kinds = Array.from({ length: total }, () => 'raw' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 4, kinds })); });
    await settle();
    expect(ledger.previewReleases).toContainEqual({ id: 'file-0', ext: 'dng' });
    await act(async () => { r.unmount(); });
  });

  test('a loopback video page releases its stream preview lease when it is unloaded', async () => {
    const total = 4;
    const kinds = Array.from({ length: total }, (_, i) => (i === 0 ? 'streamVideo' : 'video') as PageKind);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 1, kinds })); });
    await settle();
    expect(ledger.previewReleases).toContainEqual({ id: 'file-stream-0', ext: 'mp4' });
    await act(async () => { r.unmount(); });
  });

  test('ruling 1: a photo revisited after release requests the LARGE preview again (largePreviewAttemptRef is reset on release)', async () => {
    const total = 8;
    const kinds = Array.from({ length: total }, () => 'image' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    expect(ledger.largeRequests.get('file-0')).toBe(1); // first visit upgrades once
    await act(async () => { r.update(React.createElement(Pager, { total, current: 5, kinds })); }); // file-0 released
    await settle();
    expect(ledger.largeRequests.get('file-0')).toBe(1); // not current: no request
    await act(async () => { r.update(React.createElement(Pager, { total, current: 0, kinds })); }); // revisit
    await settle();
    // Same thumbnail uri comes back; without the ref reset `${id}:${uri}` matches the previous
    // attempt and the upgrade is skipped forever.
    expect(ledger.largeRequests.get('file-0')).toBe(2);
    await act(async () => { r.unmount(); });
  });

  test('ruling 1: an immediate neighbour revisit (still loaded, never released) does NOT re-request the large preview', async () => {
    const total = 6;
    const kinds = Array.from({ length: total }, () => 'image' as const);
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 1, kinds })); });
    await settle();
    await act(async () => { r.update(React.createElement(Pager, { total, current: 0, kinds })); });
    await settle();
    expect(ledger.largeRequests.get('file-0')).toBe(1); // resource kept, attempt kept
    await act(async () => { r.unmount(); });
  });

  describe('Picture in Picture (expo-video 57 VideoView onPictureInPictureStart / onPictureInPictureStop, simulated)', () => {
    const videoUri = (i: number) => `file:///cache/file-${i}.mp4`;
    const total = 8;
    const kinds = Array.from({ length: total }, () => 'video' as const);
    const go = async (r: any, cur: number) => {
      await act(async () => { r.update(React.createElement(Pager, { total, current: cur, kinds })); });
      await settle();
    };
    const fire = async (i: number, ev: 'onPictureInPictureStart' | 'onPictureInPictureStop') => {
      const props = ledger.videoViews.get(videoUri(i));
      expect(typeof props?.[ev]).toBe('function'); // PhotoPageVideo really wires the event
      await act(async () => { props[ev](); });
      await settle();
    };

    test('a player in PiP is NOT released when its page stops being current; it is released when PiP ends', async () => {
      let r: TestRenderer.ReactTestRenderer;
      await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
      await settle();
      expect(livePlayers()).toBe(1);
      await fire(0, 'onPictureInPictureStart');
      await go(r, 1);
      expect(ledger.playersReleased).toBe(0); // page 0's player survived the swipe
      expect(livePlayers()).toBe(2); // the PiP player + the new current page's player
      await go(r, 5); // far away: still held
      expect(livePlayers()).toBe(2);
      await fire(0, 'onPictureInPictureStop');
      expect(livePlayers()).toBe(1); // PiP ended: released; only the current page's player remains
      expect(ledger.playersReleased).toBeGreaterThanOrEqual(1);
      await act(async () => { r.unmount(); });
      expect(livePlayers()).toBe(0);
    });

    test('PiP ending while the page is still current does not release its player', async () => {
      let r: TestRenderer.ReactTestRenderer;
      await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
      await settle();
      await fire(0, 'onPictureInPictureStart');
      await fire(0, 'onPictureInPictureStop');
      expect(livePlayers()).toBe(1);
      await go(r, 1); // and it is released normally once the page leaves
      expect(livePlayers()).toBe(1);
      expect(ledger.playersReleased).toBe(1);
      await act(async () => { r.unmount(); });
    });

    test('without PiP the same swipe releases the previous page player (control)', async () => {
      let r: TestRenderer.ReactTestRenderer;
      await act(async () => { r = TestRenderer.create(React.createElement(Pager, { total, current: 0, kinds })); });
      await settle();
      await go(r, 1);
      expect(ledger.playersReleased).toBe(1);
      expect(livePlayers()).toBe(1);
      await act(async () => { r.unmount(); });
    });
  });

  test('the pager passes the +-1 load radius to PhotoPage (source pin: radius constant is 1 and is what PreviewScreen uses)', () => {
    expect(PHOTO_PAGE_LOAD_RADIUS).toBe(1);
    expect(source).toMatch(/activePhotoPageIndices\(currentPhotoIndex, photoList\.length, PHOTO_PAGE_LOAD_RADIUS\)/);
    expect(source).toMatch(/windowSize=\{3\}/); // the radius matches the pager's render window
  });
});
