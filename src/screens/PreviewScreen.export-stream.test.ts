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
      decryptExportCopy: async () => { throw new Error('stream export must not use fallback decrypt'); },
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
      decryptExportCopy: async () => ({ uri: localPath, release: async () => {} }),
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
      decryptExportCopy: async () => ({ uri: localPath, release: async () => {} }),
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
      decryptExportCopy: async () => ({ uri: localPath, release: async () => {} }),
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
      decryptExportCopy: async () => { throw new Error('cached video should be reused'); },
      materializeStreamVideoForExport: async () => { throw new Error('cached video should not materialize'); },
    });

    expect(result).toEqual({ uri: 'file:///cache/preview/local-video.mp4', reusedPreview: true });
  });

  test('task 2335 review: with no reusable preview, the export gets a copy of its own, to move and to release', async () => {
    // An unplayable MKV (videoUri never set), or Save while a stream is still buffering: the
    // export decrypts a copy under its own key and hands it over as export-owned, with the
    // release that deletes it when the share sheet closes.
    const released: string[] = [];
    const exportCopy = 'file:///cache/preview/video.export-0a1b2c3d.mkv';
    const result = await resolvePreviewExportUri({
      isImage: false,
      imageUri: null,
      imagePreviewKind: null,
      isVideo: true,
      videoUri: null,
      videoFileId: 'video',
      videoExtension: 'mkv',
      isPdf: false,
      pdfUri: null,
      decryptExportCopy: async () => ({ uri: exportCopy, release: async () => { released.push(exportCopy); } }),
      materializeStreamVideoForExport: async () => { throw new Error('no stream to materialize'); },
    });
    expect(result.uri).toBe(exportCopy);
    expect(result.exportOwned).toBe(true);
    expect(result.reusedPreview).toBe(false);
    await result.release?.();
    expect(released).toEqual([exportCopy]);
  });

  test('task 2335 review: getExportUri decrypts under an export key, moves an export-owned copy, and releases it', () => {
    const body = source.slice(source.indexOf('const getExportUri = useCallback'), source.indexOf('}, [', source.indexOf('const getExportUri = useCallback')));
    expect(body).toContain('const exportExtension = exportDecryptExtension(previewDecryptExtension(currentMimeType, currentFileName));');
    expect(body).toContain('const uri = await fetchAndDecrypt({ signal, onExportProgress, exportExtension });');
    expect(body).toContain('const release = () => releasePreviewCopy(currentFileId, exportExtension).then(() => {});');
    // Released on any failure too, so a cancel right after the decrypt leaves nothing leased.
    expect(body).toMatch(/\} catch \(error\) \{[\s\S]{0,300}await release\(\)\.catch\(\(\) => \{\}\);\n\s+throw error;/);
    expect(body).toContain('const staged = await stageExportForShare(resolved, { displayName: exportName ?? null, idBasedName });');
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

  test('task 2335 delta review: Cancel on the export banner and leaving the screen abort the export', () => {
    const handleDownloadIndex = source.indexOf('const handleDownload = useCallback');
    const handleDownloadBody = source.slice(handleDownloadIndex, source.indexOf('const handleViewOriginal', handleDownloadIndex));
    // The running export's controller is reachable from outside the handler…
    expect(handleDownloadBody).toContain('exportControllerRef.current = exportController;');
    // …a cancel is not a failure (no "Download failed", no error haptic) and opens no sheet…
    expect(handleDownloadBody).toMatch(/\} catch \(err\) \{\n\s+if \(exportController\.signal\.aborted \|\| isAbortError\(err\)\) \{/);
    expect(handleDownloadBody.indexOf('if (exportController.signal.aborted) return;')).toBeGreaterThan(handleDownloadBody.indexOf('const { uri: shareUri, release } = await getExportUri('));
    expect(handleDownloadBody.indexOf('if (exportController.signal.aborted) return;')).toBeLessThan(handleDownloadBody.indexOf('await Sharing.shareAsync'));
    // …and the controller is cleared only by its own export.
    expect(handleDownloadBody).toContain('if (exportControllerRef.current === exportController) exportControllerRef.current = null;');
    // Unmount aborts it.
    expect(source).toMatch(/useEffect\(\(\) => \(\) => \{\n\s+exportControllerRef\.current\?\.abort\(\);\n\s+\}, \[\]\);/);
    // The banner's Cancel is wired, and the overlay lets the touch through to it.
    const overlay = source.slice(source.indexOf('const exportProgressOverlay = preparingExport'), source.indexOf(') : null;', source.indexOf('const exportProgressOverlay = preparingExport')));
    expect(overlay).toContain('pointerEvents="box-none"');
    expect(overlay).toContain('onCancel={cancelExport}');
    expect(source).toContain('const cancelExport = useCallback(() => exportControllerRef.current?.abort(), []);');
    const banner = readFileSync(join(SRC, 'components', 'ExportProgressBanner.tsx'), 'utf8');
    expect(banner).toContain('testID="export-progress-cancel"');
    expect(banner).toMatch(/onPress=\{onCancel\}[\s\S]{0,300}accessibilityRole="button"[\s\S]{0,300}>\s*Cancel\s*</);
  });

  test('task 2335 delta review: the export leftover sweep runs once after launch and after every unlock', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toContain("import { sweepExportLeftovers } from './lib/native-decrypt';");
    const guard = app.slice(app.indexOf('function BiometricGuard('), app.indexOf('async function handleUnlocked('));
    expect(guard).toMatch(/useEffect\(\(\) => \{\n\s+if \(Platform\.OS !== 'web'\) void sweepExportLeftovers\(\)\.catch\(\(\) => 0\);\n\s+\}, \[\]\);/);
    const unlocked = app.slice(app.indexOf('async function handleUnlocked('), app.indexOf('ok: true,', app.indexOf('async function handleUnlocked(')));
    expect(unlocked.indexOf('void sweepExportLeftovers().catch(() => 0);')).toBeGreaterThan(unlocked.indexOf('onUnlock();'));
  });
});
