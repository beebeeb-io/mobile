// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1669 round 3 (round-2 adversarial review, finding 1) — the Info sheet's RAW EXIF rows when
 * you swipe onto a RAW page that was already loaded as a neighbour, proven against the REAL
 * `PreviewScreen` (default export) rendering the REAL `PhotoPage` pager.
 *
 * The regression: with +-1 preloading, swiping onto a RAW page that had finished extracting as a
 * neighbour made `PhotoPage` re-publish its cached EXIF in a child passive effect; the parent's
 * single-file RAW effect ran LATER in the same commit (deps [isRaw, fetchAndDecrypt] — the latter
 * changes with `currentFileId`) and called `setRawExifInfo(null)`. The Camera / Lens / ISO / ...
 * rows of the Info sheet were empty although the data was in hand. A test of `PhotoPage` alone
 * cannot see this: the bug is the ORDER of a child effect and a parent effect, so the parent has
 * to be rendered.
 *
 * Harness: every module PreviewScreen.tsx imports is replaced by a stub generated from its own
 * import list (same technique as PreviewScreen.photo-page-resources.test.tsx), with hand-written
 * behaviour only where the pager / Info sheet path needs it:
 *   - `FlatList` renders its items (so the real PhotoPages mount) and exposes the pager props so a
 *     test can "swipe" by calling the real `onMomentumScrollEnd` with a content offset;
 *   - `RawRenderer` mimics the real one's contract: on mount (deps [uri, cacheKey]) it reports an
 *     EXIF summary for ITS file through the `onExifInfo` it was handed at that moment;
 *   - `InfoSheet` records the `extraRows` the real screen computed, which is what the user reads.
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
const SCREEN_WIDTH = 390;

// ── ledger ──────────────────────────────────────────────────────────────────
const ledger = {
  rawDecrypts: new Map<string, number>(), // decryptToTempFile calls per file id (a real decrypt of the RAW source)
  rawTempCreated: new Set<string>(),
  rawTempDeleted: new Set<string>(),
  extractions: [] as string[], // RawRenderer extractions (file id per call), in order
  pager: null as any, // latest FlatList props
  infoRows: [] as Array<{ label: string; value: string }>, // latest InfoSheet `extraRows`
  infoFileId: '' as string,
};
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const exifFor = (id: string) => ({ cameraModel: `Camera ${id}`, lensModel: `Lens ${id}`, iso: `ISO-${id}` });

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
const Image = (props: any) => React.createElement('Image', props);
// A FlatList that renders every item (so each real PhotoPage mounts) and publishes its props.
const FlatList = React.forwardRef((props: any, ref: any) => {
  ledger.pager = props;
  React.useImperativeHandle(ref, () => ({ scrollToIndex() {}, scrollToOffset() {} }));
  return React.createElement(
    'FlatList',
    null,
    props.data.map((item: any, index: number) => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item, index }))),
  );
});
defineMock('react-native', () => ({
  View: host('View'), Text: host('Text'), Pressable: host('Pressable'), TouchableOpacity: host('TouchableOpacity'),
  ScrollView: host('ScrollView'), FlatList, ActivityIndicator: host('ActivityIndicator'),
  Image,
  Animated: {
    Value: AnimatedValue, View: host('AnimatedView'), Image, Text: host('AnimatedText'),
    timing: anim, loop: anim, sequence: anim, parallel: anim, spring: anim, delay: anim,
    event: () => () => {},
  },
  Easing: new Proxy({}, { get: () => () => () => 0 }),
  Alert: { alert() {} },
  Dimensions: { get: () => ({ width: SCREEN_WIDTH, height: 844, scale: 3, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
  Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove() {} }),
    announceForAccessibility() {},
  },
  StyleSheet: { create: (s: any) => s, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1, flatten: (s: any) => s },
  PixelRatio: { get: () => 3 },
}));

// ── navigation / context: stable identities (effects list these in their deps) ──
let routeParams: any = {};
const navigation = { goBack() {}, navigate() {}, canGoBack: () => true, setOptions() {}, addListener: () => () => {}, dispatch() {} };
defineMock('@react-navigation/native', () => ({
  useNavigation: () => navigation,
  useRoute: () => ({ params: routeParams }),
}));
const insets = { top: 47, bottom: 34, left: 0, right: 0 };
defineMock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => insets }));
const colors = new Proxy({}, { get: () => '#000' });
const themeValue = { colors, resolved: 'dark' };
defineMock('../lib/theme-context', () => ({ useTheme: () => themeValue }));
const toastValue = { showToast() {} };
defineMock('../lib/toast-context', () => ({ useToast: () => toastValue }));
const cryptoValue = { isUnlocked: true, getFileKeyBytes: async () => new Uint8Array(32), getMasterKeyHandleId: () => 1 };
defineMock('../lib/crypto-context', () => ({ useCrypto: () => cryptoValue }));
defineMock('../lib/api', () => ({
  getToken: async () => 'token',
  friendlyError: (e: any) => String(e?.message ?? e),
  trustLocation: () => ({ region: 'the EU', city: 'Falkenstein' }),
}));
defineMock('../lib/preview-load-error', () => ({ STILL_UPLOADING_MESSAGE: 'still uploading', previewLoadErrorMessage: (e: any) => String(e?.message ?? e) }));
defineMock('../lib/preview-lock-gate', () => ({ checkLockedFileIds: async () => new Set(), isPagerPageGated: () => false }));
defineMock('../lib/status-bar-style', () => ({ previewSurfaceIsDark: () => true, statusBarStyleFor: () => 'light' }));
defineMock('../lib/text-edit-gate', () => ({ evaluateTextEditGate: () => ({ editable: false }) }));
defineMock('../lib/thumbnail-self-repair', () => ({ maybeSelfRepairThumbnailFromLocalFile: async () => {} }));
defineMock('../lib/performance-storage-settings', () => ({ getPerformanceStorageSettings: async () => ({ profile: 'smooth' }) }));
defineMock('../components/glass', () => ({
  glassMaterial: () => new Proxy({}, { get: () => '#000' }),
  GLASS_CIRCLE_SIZES: { regular: 44, small: 36, large: 52 },
  PREVIEW_CHROME_MATERIAL: new Proxy({}, { get: () => '#000' }),
  SCROLL_EDGE: new Proxy({}, { get: () => 0 }),
}));
defineMock('../components/glass/gradient', () => ({ bandColors: () => [] }));

// ── pager collaborators (same shapes as PreviewScreen.photo-page-resources.test.tsx) ──
defineMock('../lib/photo-cache', () => ({
  getCachedPhotoWithExtension: async (id: string) => `file:///cache/${id}.mp4`,
  getCachedPhoto: async (id: string) => `file:///cache/${id}.jpg`,
  cachePhoto: async (_id: string, uri: string) => uri,
  cachePhotoWithExtension: async (_id: string, uri: string) => uri,
  mediaCacheExtension: () => 'jpg',
}));
defineMock('../lib/thumbnail-cache', () => ({ getCachedThumbnail: async () => null }));
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
defineMock('../lib/preview-cache-key', () => ({
  extensionForMime: () => 'jpg', previewCacheName: (id: string) => id, previewDecryptExtension: () => 'dng', previewDisplayName: (n: string) => n,
}));
defineMock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: async (uri: string) => { ledger.rawTempDeleted.add(uri); },
}));
defineMock('../lib/native-decrypt', () => ({
  decryptToTempFile: async (id: string) => {
    bump(ledger.rawDecrypts, id);
    const u = `file:///tmp/${id}-${ledger.rawTempCreated.size}.dng`;
    ledger.rawTempCreated.add(u);
    return u;
  },
  releasePreviewCopy: async () => true,
  invalidatePreviewCache: async () => {},
}));
defineMock('../lib/file-category', () => ({ fileCategory: (_m: unknown, name?: string) => (name?.endsWith('.dng') ? 'raw' : 'image') }));
defineMock('../lib/raw-format', () => ({ extensionForRaw: () => 'dng', rawFormatLabel: () => 'DNG' }));
defineMock('../components/preview/ZoomableImage', () => ({ ZoomableImage: (p: any) => React.createElement('Zoomable', null, p.children) }));

// RawRenderer: the real contract — once per [uri, cacheKey] it reports the parsed EXIF for ITS file
// through the `onExifInfo` it had when that effect ran (the real effect captures it once).
defineMock('../components/preview/RawRenderer', () => ({
  RawRenderer: ({ uri, cacheKey, onExifInfo }: any) => {
    React.useEffect(() => {
      ledger.extractions.push(cacheKey);
      onExifInfo?.(exifFor(cacheKey));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uri, cacheKey]);
    return React.createElement('RawRenderer', { uri, cacheKey });
  },
}));
// InfoSheet: record exactly what the real screen hands the sheet.
defineMock('../components/preview/InfoSheet', () => ({
  InfoSheet: (props: any) => {
    ledger.infoRows = props.extraRows ?? [];
    ledger.infoFileId = props.fileId;
    return null;
  },
}));

// ── generated stubs for EVERY import in PreviewScreen.tsx, then overrides ───
const realModules = new Set([
  'react', '../components/preview/PhotoPageVideo', '../theme', '../lib/preview-temp-file', '../lib/photo-viewer-window',
  '../lib/preview-info', '../lib/preview-chrome', '../lib/format', '../lib/audio-format', '../lib/code-text-preview', '../lib/saved-file-meta', '../lib/preview-content-inset', '../lib/lock-copy', '../lib/move-picker-folders',
]);
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
const noop = (..._a: any[]) => null;
for (const [spec, { named, hasDefault }] of wanted) {
  const mod: Record<string, unknown> = {};
  for (const n of named) mod[n] = noop;
  if (hasDefault) mod.default = noop;
  Object.assign(mod, overrides.get(spec) ?? {});
  const resolved = spec.startsWith('.') ? join(SRC, 'screens', spec) : spec;
  mock.module(resolved, () => mod);
}

const { default: PreviewScreen } = await import('./PreviewScreen');

// ── harness ─────────────────────────────────────────────────────────────────
const rawEntry = (i: number) => ({
  id: `raw-${i}`,
  name_encrypted: `n${i}`,
  display_name: `shot-${i}.dng`,
  mime_type: 'image/x-adobe-dng',
  size_bytes: 1000,
  chunk_count: 1,
  thumbnail_uri: null,
  local_asset_id: null,
});
const photoEntry = (i: number) => ({ ...rawEntry(i), id: `img-${i}`, display_name: `photo-${i}.jpg`, mime_type: 'image/jpeg' });

function mountScreen(list: any[], initialIndex = 0) {
  routeParams = {
    fileId: list[initialIndex].id,
    fileName: list[initialIndex].display_name,
    mimeType: list[initialIndex].mime_type,
    sizeBytes: 1000,
    photoListJson: JSON.stringify(list),
    initialPhotoIndex: initialIndex,
  };
  return act(async () => TestRenderer.create(React.createElement(PreviewScreen)));
}
async function settle() {
  await act(async () => { for (let k = 0; k < 10; k += 1) await new Promise((r) => setTimeout(r, 0)); });
}
/** The real pager callback, as the native ScrollView fires it when a swipe lands on `index`. */
async function swipeTo(index: number) {
  await act(async () => { ledger.pager.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: index * SCREEN_WIDTH } } }); });
  await settle();
}
const infoRow = (label: string) => ledger.infoRows.find((r) => r.label === label)?.value;

beforeEach(() => {
  ledger.rawDecrypts.clear(); ledger.rawTempCreated.clear(); ledger.rawTempDeleted.clear();
  ledger.extractions.length = 0; ledger.pager = null; ledger.infoRows = []; ledger.infoFileId = '';
});
afterEach(() => { mock.restore?.(); });

describe('PreviewScreen pager — Info sheet EXIF for RAW pages (real PreviewScreen + real PhotoPage)', () => {
  test('harness sanity: the initial RAW page shows its own EXIF rows and the Info sheet is on the current file', async () => {
    const r = await mountScreen([rawEntry(0), rawEntry(1), rawEntry(2)], 0);
    await settle();
    expect(ledger.pager).not.toBeNull(); // the pager really rendered
    expect(ledger.infoFileId).toBe('raw-0');
    expect(infoRow('Camera')).toBe('Camera raw-0');
    expect(infoRow('Lens')).toBe('Lens raw-0');
    expect(infoRow('ISO')).toBe('ISO-raw-0');
    await act(async () => { r.unmount(); });
  });

  test('swiping onto a RAW page that was preloaded as a neighbour shows THAT page\'s Camera / Lens / ISO rows', async () => {
    const r = await mountScreen([rawEntry(0), rawEntry(1), rawEntry(2)], 0);
    await settle();
    // raw-1 was loaded as page 0's neighbour and already extracted (exactly 1 extraction each for 0 and 1):
    expect(ledger.extractions.filter((id) => id === 'raw-1')).toHaveLength(1);
    await swipeTo(1);
    expect(ledger.infoFileId).toBe('raw-1');
    expect(infoRow('Camera')).toBe('Camera raw-1');
    expect(infoRow('Lens')).toBe('Lens raw-1');
    expect(infoRow('ISO')).toBe('ISO-raw-1');
    expect(ledger.extractions.filter((id) => id === 'raw-1')).toHaveLength(1); // served from the preload, not re-extracted
    await act(async () => { r.unmount(); });
  });

  test('swiping back and forth keeps each page\'s own EXIF (never the previous page\'s)', async () => {
    const r = await mountScreen([rawEntry(0), rawEntry(1), rawEntry(2)], 0);
    await settle();
    for (const i of [1, 2, 1, 0, 1]) {
      await swipeTo(i);
      expect(ledger.infoFileId).toBe(`raw-${i}`);
      expect(infoRow('Camera')).toBe(`Camera raw-${i}`);
    }
    await act(async () => { r.unmount(); });
  });

  test('RAW -> image -> RAW: the image shows no EXIF rows and the next RAW shows its own', async () => {
    const r = await mountScreen([rawEntry(0), photoEntry(1), rawEntry(2)], 0);
    await settle();
    await swipeTo(1);
    expect(infoRow('Camera')).toBeUndefined();
    await swipeTo(2);
    expect(infoRow('Camera')).toBe('Camera raw-2');
    await act(async () => { r.unmount(); });
  });

  test('the parent does not decrypt the current RAW file a second time in pager mode (only the page\'s own decrypt)', async () => {
    const r = await mountScreen([rawEntry(0), rawEntry(1), rawEntry(2)], 0);
    await settle();
    expect(ledger.rawDecrypts.get('raw-0')).toBe(1);
    await swipeTo(1);
    expect(ledger.rawDecrypts.get('raw-1')).toBe(1); // preloaded once, swipe did not decrypt again
    await act(async () => { r.unmount(); });
  });
});
