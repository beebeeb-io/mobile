// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * MB-0005 [P1] — opening Preview for a file of your OWN on iOS must not export
 * its raw file key into JS. Before, both Preview thumbnail tails
 * (`loadNormalPreviewThumbnail`, `loadLargePreviewThumbnail`) called
 * `getFileKeyBytes` for the current and the neighbouring pages: 32 raw key
 * bytes into the JS heap, plus a `setFileKey` bridge call back into native. On
 * iOS the key stays native: the normal rung reads the native ThumbnailService,
 * and a JS-decrypted variant (the large preview upgrade) decrypts through the
 * native master-key handle (`handleDecryptChunk`). Android keeps the raw key its
 * JS thumbnail path uses by design.
 *
 * Renders the REAL `PhotoPage` from PreviewScreen.tsx (react-test-renderer).
 * Every module PreviewScreen.tsx imports is replaced by a stub GENERATED from
 * its own import list (the `PreviewScreen.photo-page-resources.test.tsx`
 * pattern), with hand-written collaborators for the ones this path calls. The
 * guard under test (`previewThumbnailKey` and both tails) is real.
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
const MASTER_HANDLE = 42;
const SHARED_HANDLE = 7;

const state = {
  platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  sharedLoaded: new Set<string>(),
  nativeThumbnailHit: true,
  // What the crypto context's real getFileKeyBytes does: export the raw key
  // into JS, then push it back to native with ThumbnailService.setFileKey.
  rawKeyExports: [] as string[],
  setFileKeyCalls: 0,
  nativeThumbnailCalls: [] as string[],
  handleDecrypts: [] as Array<{ handle: number; fileId: string }>,
  normalTailKeys: [] as string[], // 'bytes' | 'native-handle' passed to fetchThumbnailUriOnce
  largeTailKeys: [] as string[], // ... to fetchDecryptedLargeThumbnailUri
  keyProviderCalls: 0, // decryptToTempFile calling its lazy key provider
};

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
defineMock('react-native', () => ({
  View: host('View'), Text: host('Text'), Pressable: host('Pressable'), TouchableOpacity: host('TouchableOpacity'),
  ScrollView: host('ScrollView'), FlatList: host('FlatList'), ActivityIndicator: host('ActivityIndicator'),
  Image: host('Image'),
  Animated: {
    Value: AnimatedValue, View: host('AnimatedView'), Image: host('AnimatedImage'), Text: host('AnimatedText'),
    timing: anim, loop: anim, sequence: anim, parallel: anim, spring: anim, delay: anim,
  },
  Easing: new Proxy({}, { get: () => () => () => 0 }),
  Alert: { alert() {} },
  Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
  Platform: state.platform,
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove() {} }),
    announceForAccessibility() {},
  },
  StyleSheet: { create: (s: any) => s, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1, flatten: (s: any) => s },
  PixelRatio: { get: () => 3 },
}));
defineMock('expo-video', () => ({
  useVideoPlayer: () => React.useMemo(() => ({}), []),
  VideoView: host('VideoView'),
}));
const colors = new Proxy({}, { get: () => '#000' });
const themeValue = { colors };
defineMock('../lib/theme-context', () => ({ useTheme: () => themeValue }));
// Stable identities (PhotoPage lists these in effect deps).
const cryptoValue = {
  isUnlocked: true,
  getFileKeyBytes: async (fileId: string) => {
    state.rawKeyExports.push(fileId);
    state.setFileKeyCalls += 1;
    return new Uint8Array(32);
  },
  getMasterKeyHandleId: () => MASTER_HANDLE,
};
defineMock('../lib/crypto-context', () => ({ useCrypto: () => cryptoValue }));
defineMock('../lib/shared-folder-keys', () => ({
  sharedFileKeyIsLoaded: (id: string) => state.sharedLoaded.has(id),
  sharedMasterHandleId: () => SHARED_HANDLE,
}));
defineMock('../../modules/beebeeb-crypto', () => ({
  BeebeebThumbnails: {
    getThumbnail: async (fileId: string) => {
      state.nativeThumbnailCalls.push(fileId);
      if (!state.nativeThumbnailHit) throw new Error('native miss');
      return { uri: `file:///native/${fileId}.webp`, source: 'remote' };
    },
  },
  handleDecryptChunk: async (handle: number, fileId: string) => {
    state.handleDecrypts.push({ handle, fileId });
    return new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  },
}));
const keyKind = (k: unknown) => (typeof k === 'function' ? 'native-handle' : k instanceof Uint8Array ? 'bytes' : String(k));
defineMock('../lib/use-thumbnail', () => ({
  fetchThumbnailUriOnce: async (fileId: string, fileKey: unknown) => {
    state.normalTailKeys.push(keyKind(fileKey));
    if (typeof fileKey === 'function') await fileKey(new Uint8Array(12), new Uint8Array(8));
    return `file:///remote/${fileId}.medium.webp`;
  },
}));
defineMock('../lib/thumbnail', () => ({
  cacheLocalThumbnail: async () => null,
  fetchDecryptedLargeThumbnailUri: async (fileId: string, fileKey: unknown) => {
    state.largeTailKeys.push(keyKind(fileKey));
    if (typeof fileKey === 'function') await fileKey(new Uint8Array(12), new Uint8Array(8));
    return `file:///remote/${fileId}.large.webp`;
  },
}));
defineMock('../lib/thumbnail-cache', () => ({ getCachedThumbnail: async () => null }));
defineMock('../lib/photo-cache', () => ({
  getCachedPhotoWithExtension: async () => null,
  getCachedPhoto: async () => null,
  cachePhoto: async (_id: string, uri: string) => uri,
  cachePhotoWithExtension: async (_id: string, uri: string) => uri,
  mediaCacheExtension: () => 'jpg',
}));
defineMock('../lib/native-decrypt', () => ({
  // With a master-key handle the real decrypt runs natively and never calls the
  // provider; a call here would be the original-load path exporting the key.
  decryptToTempFile: async (id: string, keyProvider: unknown, ext: string, _s: unknown, _c: unknown, handle: unknown) => {
    if (handle == null && typeof keyProvider === 'function') {
      state.keyProviderCalls += 1;
      await keyProvider();
    }
    return `file:///tmp/${id}.${ext}`;
  },
  releasePreviewCopy: async () => true,
  invalidatePreviewCache: async () => {},
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
defineMock('../lib/preview-cache-key', () => ({ extensionForMime: () => 'jpg', previewCacheName: (id: string) => id, previewDecryptExtension: () => 'jpg', previewDisplayName: (n: string) => n }));
defineMock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', deleteAsync: async () => {} }));
defineMock('../lib/video-stream', () => ({ isLoopbackStreamUri: () => false, streamBufferPctFromEvent: () => undefined }));
defineMock('../lib/file-category', () => ({ fileCategory: () => 'image' }));
defineMock('../components/glass', () => ({ glassMaterial: () => new Proxy({}, { get: () => '#000' }) }));
defineMock('../components/preview/ZoomableImage', () => ({ ZoomableImage: (p: any) => React.createElement('Zoomable', null, p.children) }));

// ── generated stubs for EVERY import in PreviewScreen.tsx, then overrides ───
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
function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name_encrypted: `${id}.jpg`,
    display_name: `${id}.jpg`,
    mime_type: 'image/jpeg',
    size_bytes: 1000,
    chunk_count: 1,
    created_at: '2026-10-30T00:00:00Z',
    thumbnail_uri: null,
    local_asset_id: null,
    has_thumbnail: true,
    has_preview: false,
    ...extra,
  };
}
/** Opens Preview on `current`, with its neighbours mounted as the pager does. */
async function openPreview(entries: any[], current = 0) {
  let r: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(
        React.Fragment,
        null,
        entries.map((e, i) =>
          React.createElement(PhotoPage, {
            key: e.id,
            entry: e,
            shouldLoadFull: Math.abs(i - current) <= 1,
            isCurrent: i === current,
            width: 390,
            previewProfile: 'smooth',
            originalRequestNonce: 0,
            locked: false,
            unlocking: false,
            onRequestUnlock: noopFn,
          }),
        ),
      ),
    );
  });
  await act(async () => { for (let k = 0; k < 12; k += 1) await new Promise((res) => setTimeout(res, 0)); });
  await act(async () => { r.unmount(); });
}

beforeEach(() => {
  state.platform.OS = 'ios';
  state.sharedLoaded.clear();
  state.nativeThumbnailHit = true;
  state.rawKeyExports = [];
  state.setFileKeyCalls = 0;
  state.nativeThumbnailCalls = [];
  state.handleDecrypts = [];
  state.normalTailKeys = [];
  state.largeTailKeys = [];
  state.keyProviderCalls = 0;
});
afterEach(() => { mock.restore?.(); });

describe('MB-0005: Preview never exports an own file key into JS on iOS', () => {
  test('iOS, own files: 0 getFileKeyBytes, 0 setFileKey; the thumbnail resolves through the native ThumbnailService', async () => {
    await openPreview([entry('own-1'), entry('own-2'), entry('own-3')], 1);
    expect(state.nativeThumbnailCalls).toContain('own-2');
    expect(state.rawKeyExports).toEqual([]);
    expect(state.setFileKeyCalls).toBe(0);
    // The large upgrade really ran, and decrypted through the native handle.
    expect(state.largeTailKeys).toContain('native-handle');
    expect(state.largeTailKeys).not.toContain('bytes');
    expect(state.handleDecrypts).toContainEqual({ handle: MASTER_HANDLE, fileId: 'own-2' });
    expect(state.keyProviderCalls).toBe(0);
  });

  test('iOS, own file, native rung misses: the remote tail still exports no key', async () => {
    state.nativeThumbnailHit = false;
    await openPreview([entry('own-miss')]);
    expect(state.normalTailKeys).toEqual(['native-handle']);
    expect(state.rawKeyExports).toEqual([]);
    expect(state.setFileKeyCalls).toBe(0);
  });

  test('iOS, foreign shared file: still the native shared-key handle callback, no raw key', async () => {
    state.sharedLoaded.add('shared-1');
    state.nativeThumbnailHit = false;
    await openPreview([entry('shared-1')]);
    expect(state.normalTailKeys).toEqual(['native-handle']);
    expect(state.largeTailKeys).toEqual(['native-handle']);
    expect(state.handleDecrypts.every((d) => d.handle === SHARED_HANDLE && d.fileId === 'shared-1')).toBe(true);
    expect(state.handleDecrypts.length).toBeGreaterThan(0);
    expect(state.rawKeyExports).toEqual([]);
  });

  test('iOS, request upload: keeps its provided key (it is not derived from the master key)', async () => {
    state.nativeThumbnailHit = false;
    await openPreview([entry('request-1', { is_request_upload: true })]);
    expect(state.normalTailKeys).toEqual(['bytes']);
    expect(state.rawKeyExports).toContain('request-1');
    expect(state.handleDecrypts).toEqual([]);
  });

  test('Android is unchanged: its JS thumbnail path uses the raw file key', async () => {
    state.platform.OS = 'android';
    state.nativeThumbnailHit = false;
    await openPreview([entry('own-android')]);
    expect(state.normalTailKeys).toEqual(['bytes']);
    expect(state.largeTailKeys).toEqual(['bytes']);
    expect(state.rawKeyExports.length).toBeGreaterThan(0);
    expect(state.handleDecrypts).toEqual([]);
  });
});

// ── source guard ────────────────────────────────────────────────────────────
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`signature not found: ${signature}`);
  const open = src.indexOf('{', at + signature.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i).replace(/\/\/[^\n]*/g, '');
    }
  }
  throw new Error(`unbalanced: ${signature}`);
}
/** Both Preview thumbnail tails get their key only from `previewThumbnailKey`, which returns before any raw-key export on iOS. */
function previewKeyRuleHolds(src: string): boolean {
  const key = body(src, 'async function previewThumbnailKey(');
  const iosRule = key.indexOf("if (Platform.OS === 'ios' && !entry.is_request_upload) {");
  const iosReturn = key.indexOf('return (nonce: Uint8Array, ciphertext: Uint8Array) => handleDecryptChunk(handleId, entry.id, nonce, ciphertext);', iosRule);
  const rawExport = key.indexOf('getFileKeyBytes(');
  const tails = ['async function loadNormalPreviewThumbnail(', 'async function loadLargePreviewThumbnail('].map((sig) => body(src, sig));
  return (
    iosRule >= 0 &&
    iosReturn > iosRule &&
    rawExport > iosReturn &&
    (key.match(/getFileKeyBytes\(/g) ?? []).length === 1 &&
    tails.every((t) => !t.includes('getFileKeyBytes(') && t.includes('await previewThumbnailKey(entry, getFileKeyBytes, getMasterKeyHandleId)'))
  );
}

describe('MB-0005 source guard', () => {
  test('no getFileKeyBytes( in an iOS-reachable Preview thumbnail path except behind the platform rule', () => {
    expect(previewKeyRuleHolds(source)).toBe(true);
  });
  test('MUTATION: the pre-fix tail (raw key unless shared) is RED', () => {
    const mutated = source.replace(
      '    const fileKey = await previewThumbnailKey(entry, getFileKeyBytes, getMasterKeyHandleId);\n    const remote = await fetchDecryptedLargeThumbnailUri(',
      '    const fileKey = sharedFileKeyIsLoaded(entry.id)\n      ? (nonce: Uint8Array, ciphertext: Uint8Array) => handleDecryptChunk(sharedMasterHandleId(), entry.id, nonce, ciphertext)\n      : await getFileKeyBytes(entry.id);\n    const remote = await fetchDecryptedLargeThumbnailUri(',
    );
    expect(mutated).not.toBe(source);
    expect(previewKeyRuleHolds(mutated)).toBe(false);
  });
  test('MUTATION: dropping the iOS rule from previewThumbnailKey is RED', () => {
    const mutated = source.replace("if (Platform.OS === 'ios' && !entry.is_request_upload) {", 'if (false) {');
    expect(mutated).not.toBe(source);
    expect(previewKeyRuleHolds(mutated)).toBe(false);
  });
});
