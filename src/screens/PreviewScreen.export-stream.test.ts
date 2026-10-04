// @ts-nocheck — bun runs this; PreviewScreen imports are generated into stubs below.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');
const SCREEN = join(SRC, 'screens/PreviewScreen.tsx');

const localPath = 'file:///cache/preview/video.mp4';
const loopbackCapability = 'http://127.0.0.1:49152/s/secret-capability/video.mp4';
const releaseCalls: Array<{ id: string; ext: string }> = [];

const overrides = new Map<string, Record<string, unknown>>();
const defineMock = (spec: string, factory: () => Record<string, unknown>) => { overrides.set(spec, factory()); };
const noop = (..._args: any[]) => null;
const host = (name: string) => (props: any) => ({ type: name, props });

defineMock('react-native', () => ({
  View: host('View'),
  Text: host('Text'),
  Pressable: host('Pressable'),
  TouchableOpacity: host('TouchableOpacity'),
  ScrollView: host('ScrollView'),
  FlatList: host('FlatList'),
  ActivityIndicator: host('ActivityIndicator'),
  Image: host('Image'),
  Animated: {
    Value: class {
      constructor(public value: number) {}
      setValue(value: number) { this.value = value; }
      interpolate() { return this; }
    },
    View: host('AnimatedView'),
    Image: host('AnimatedImage'),
    Text: host('AnimatedText'),
    timing: () => ({ start() {}, stop() {} }),
    loop: () => ({ start() {}, stop() {} }),
    sequence: () => ({ start() {}, stop() {} }),
    parallel: () => ({ start() {}, stop() {} }),
    spring: () => ({ start() {}, stop() {} }),
    delay: () => ({ start() {}, stop() {} }),
  },
  Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
  Easing: new Proxy({}, { get: () => () => () => 0 }),
  Platform: { OS: 'ios', select: (value: any) => value.ios ?? value.default },
  StyleSheet: { create: (styles: any) => styles, absoluteFill: {}, absoluteFillObject: {}, hairlineWidth: 1, flatten: (style: any) => style },
  Alert: { alert() {} },
  AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }), announceForAccessibility() {} },
}));
defineMock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async () => ({ exists: false }),
  deleteAsync: async () => {},
  readAsStringAsync: async () => '',
  writeAsStringAsync: async () => {},
  makeDirectoryAsync: async () => {},
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));
defineMock('../lib/native-decrypt', () => ({
  decryptToTempFile: noop,
  invalidatePreviewCache: noop,
  releasePreviewCopy: async (id: string, ext: string) => { releaseCalls.push({ id, ext }); },
}));
defineMock('../lib/video-stream', () => ({
  isLoopbackStreamUri: (uri: string | null | undefined) => typeof uri === 'string' && uri.startsWith('http://127.0.0.1:'),
  streamBufferPctFromEvent: () => undefined,
}));
defineMock('../theme', () => ({
  colors: new Proxy({}, { get: () => '#000' }),
  fonts: {},
  radii: {},
  shadows: {},
}));
defineMock('../lib/theme-context', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#000' }) }) }));
defineMock('../lib/api', () => ({
  friendlyError: (err: unknown) => err instanceof Error ? err.message : String(err),
  getToken: async () => 'tok',
}));
defineMock('../lib/preview-cache-key', () => ({
  extensionForMime: () => 'mp4',
  previewCacheName: (name: string) => name,
  previewDecryptExtension: () => 'mp4',
  previewDisplayName: (name: string) => name,
}));

const source = readFileSync(SCREEN, 'utf8');
const importRe = /^import\s+(?!type\b)([\s\S]*?)\s+from\s+'([^']+)';?$/gm;
const wanted = new Map<string, { named: Set<string>; hasDefault: boolean; hasNamespace: boolean }>();
const realModules = new Set(['react']);
for (let m = importRe.exec(source); m; m = importRe.exec(source)) {
  const [, clause, spec] = m;
  if (realModules.has(spec)) continue;
  const entry = wanted.get(spec) ?? { named: new Set(), hasDefault: false, hasNamespace: false };
  const trimmed = clause.trim();
  if (trimmed.startsWith('* as ')) entry.hasNamespace = true;
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ')) continue;
      entry.named.add(t.split(/\s+as\s+/)[0].trim());
    }
  }
  if (/^[A-Za-z_$][\w$]*\s*(,|$)/.test(trimmed)) entry.hasDefault = true;
  wanted.set(spec, entry);
}
for (const spec of overrides.keys()) {
  if (!wanted.has(spec)) wanted.set(spec, { named: new Set(), hasDefault: false, hasNamespace: false });
}
for (const [spec, shape] of wanted) {
  const mod: Record<string, unknown> = {};
  for (const name of shape.named) mod[name] = noop;
  if (shape.hasDefault) mod.default = noop;
  Object.assign(mod, overrides.get(spec) ?? {});
  const resolved = spec.startsWith('.') ? join(SRC, 'screens', spec) : spec;
  mock.module(resolved, () => mod);
}

const { resolvePreviewExportUri } = await import('./PreviewScreen');

beforeEach(() => {
  releaseCalls.length = 0;
});

describe('PreviewScreen stream export resolver', () => {
  test('delegates loopback video export to the stream materializer and never returns the capability URL', async () => {
    const calls: unknown[] = [];
    const result = await resolvePreviewExportUri({
      isImage: false,
      imageUri: null,
      imagePreviewKind: null,
      isVideo: true,
      videoUri: loopbackCapability,
      videoFileId: 'video',
      videoExtension: 'mp4',
      isPdf: false,
      pdfUri: null,
      fetchAndDecrypt: async () => { throw new Error('stream export must not use fallback decrypt'); },
      materializeStreamVideoForExport: async (fileId: string, extension: string) => {
        calls.push([fileId, extension]);
        return localPath;
      },
    });

    await Promise.resolve(result.release?.());

    expect(result.uri).toBe(localPath);
    expect(result.uri).not.toContain('127.0.0.1');
    expect(result.uri).not.toContain('secret-capability');
    expect(calls).toEqual([['video', 'mp4']]);
    expect(releaseCalls).toEqual([{ id: 'video', ext: 'mp4' }]);
  });

  test('surfaces materializer terminal errors immediately without caller release', async () => {
    const terminalError = new Error('Native stream failed');
    await expect(resolvePreviewExportUri({
      isImage: false,
      imageUri: null,
      imagePreviewKind: null,
      isVideo: true,
      videoUri: loopbackCapability,
      videoFileId: 'video',
      videoExtension: 'mp4',
      isPdf: false,
      pdfUri: null,
      fetchAndDecrypt: async () => localPath,
      materializeStreamVideoForExport: async () => { throw terminalError; },
    })).rejects.toThrow('Native stream failed');

    expect(releaseCalls).toEqual([]);
  });

  test('releases the helper lease if a defensive loopback validation rejects after materialization', async () => {
    await expect(resolvePreviewExportUri({
      isImage: false,
      imageUri: null,
      imagePreviewKind: null,
      isVideo: true,
      videoUri: loopbackCapability,
      videoFileId: 'video',
      videoExtension: 'mp4',
      isPdf: false,
      pdfUri: null,
      fetchAndDecrypt: async () => localPath,
      materializeStreamVideoForExport: async () => loopbackCapability,
    })).rejects.toThrow('Cannot export this video yet');

    expect(releaseCalls).toEqual([{ id: 'video', ext: 'mp4' }]);
  });

  test('releases the helper lease if cancellation arrives after materialization', async () => {
    const controller = new AbortController();
    await expect(resolvePreviewExportUri({
      isImage: false,
      imageUri: null,
      imagePreviewKind: null,
      isVideo: true,
      videoUri: loopbackCapability,
      videoFileId: 'video',
      videoExtension: 'mp4',
      isPdf: false,
      pdfUri: null,
      fetchAndDecrypt: async () => localPath,
      signal: controller.signal,
      materializeStreamVideoForExport: async () => {
        controller.abort();
        return localPath;
      },
    })).rejects.toThrow('Export cancelled.');

    expect(releaseCalls).toEqual([{ id: 'video', ext: 'mp4' }]);
  });

  test('keeps non-stream cached video export behavior unchanged', async () => {
    const result = await resolvePreviewExportUri({
      isImage: false,
      imageUri: null,
      imagePreviewKind: null,
      isVideo: true,
      videoUri: 'file:///cache/preview/local-video.mp4',
      videoFileId: 'video',
      videoExtension: 'mp4',
      isPdf: false,
      pdfUri: null,
      fetchAndDecrypt: async () => { throw new Error('cached video should be reused'); },
      materializeStreamVideoForExport: async () => { throw new Error('cached video should not materialize'); },
    });

    expect(result).toEqual({ uri: 'file:///cache/preview/local-video.mp4', reusedPreview: true });
  });

  test('real download handler releases an export lease from finally after share returns', () => {
    const handleDownloadIndex = source.indexOf('const handleDownload = useCallback');
    const handleDownloadBody = source.slice(handleDownloadIndex, source.indexOf('const handleViewOriginal', handleDownloadIndex));
    expect(handleDownloadBody.indexOf('await Sharing.shareAsync')).toBeGreaterThan(0);
    expect(handleDownloadBody.indexOf('await Promise.resolve(releaseExportCopy())')).toBeGreaterThan(
      handleDownloadBody.indexOf('await Sharing.shareAsync'),
    );
    expect(handleDownloadBody).toContain('} finally {');
  });
});
