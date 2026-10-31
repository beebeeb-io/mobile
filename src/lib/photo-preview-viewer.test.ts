// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let cached: string | null = null;
let fetched: string | null = null;
let fetchCalls: string[] = [];
let trims: any[][] = [];
let uploads: any[][] = [];
let supported = true;
let setting = { enabled: true, format: 'heic', px: 2560 };
let settingThrows = false;
let cacheThrows = false;
let uploadImpl: () => Promise<unknown>;
let cacheExpected: any[] = [];
let dropped: string[] = [];
let fetchExpected: any[] = [];

mock.module('./photo-preview-cache', () => ({
  getCachedPreview: async (_id: string, expected: any) => { cacheExpected.push(expected); if (cacheThrows) throw new Error('boom'); return cached; },
  fetchPreviewToCache: async (id: string, expected: any) => { fetchCalls.push(id); fetchExpected.push(expected); return fetched; },
  trimPreviewCache: async (...a: any[]) => { trims.push(a); return { removed: 0, bytes: 0 }; },
  getPreviewCacheLimitBytes: async () => 1000,
  dropCachedPreview: async (id: string) => { dropped.push(id); },
}));
mock.module('./api', () => ({
  getApiUrl: () => 'http://api.test',
  getToken: async () => 'tok',
  serverSupportsPhotoPreviews: async () => supported,
}));
mock.module('./photo-preview-sync', () => ({
  getSessionPhotoPreviewSetting: async () => { if (settingThrows) throw new Error('x'); return setting; },
}));
mock.module('./expected-user', () => ({ getExpectedUserId: () => 'acct-1' }));
mock.module('./shared-folder-keys', () => ({ sharedMasterHandleId: () => 7 }));
mock.module('../../modules/beebeeb-crypto', () => ({
  uploadPhotoPreviewNative: async (...a: any[]) => { uploads.push(a); return uploadImpl(); },
}));

const {
  chooseImageSource, loadViewerImage, shouldGenerateFromOpenedOriginal,
  prepareGenerateFromOpenedOriginal, __resetPhotoPreviewViewerForTests, loadStoredPreview, zoomExceedsPreview,
} = await import('./photo-preview-viewer');

const file = (over = {}) => ({ id: 'f1', mime_type: 'image/jpeg', has_preview: true, ...over });

beforeEach(() => {
  cached = null; fetched = null; fetchCalls = []; trims = []; uploads = []; cacheExpected = []; fetchExpected = []; dropped = [];
  supported = true; setting = { enabled: true, format: 'heic', px: 2560 }; settingThrows = false; cacheThrows = false;
  uploadImpl = async () => ({ bytes: 1 });
  __resetPhotoPreviewViewerForTests();
});

describe('chooseImageSource', () => {
  test('cache, download, existing', () => {
    expect(chooseImageSource(file(), 'file:///c.img', true)).toBe('cache');
    expect(chooseImageSource(file(), null, true)).toBe('download-preview');
    expect(chooseImageSource(file({ has_preview: false }), null, true)).toBe('existing');
    expect(chooseImageSource(file({ has_preview: undefined }), null, true)).toBe('existing');
  });
  test('unsupported server always uses the existing path', () => {
    expect(chooseImageSource(file(), 'file:///c.img', false)).toBe('existing');
    expect(chooseImageSource(file(), null, false)).toBe('existing');
  });
  test('an offline-pinned file never downloads a preview, but uses a cached one', () => {
    expect(chooseImageSource(file(), null, true, true)).toBe('existing');
    expect(chooseImageSource(file(), 'file:///c.img', true, true)).toBe('cache');
  });
  test('a stale cache file is ignored when the server has no preview', () => {
    expect(chooseImageSource(file({ has_preview: false }), 'file:///c.img', true)).toBe('existing');
  });
});

describe('loadViewerImage', () => {
  const existing = async () => ({ uri: 'file:///thumb.jpg' });
  test('cache hit does not download', async () => {
    cached = 'file:///c.img';
    const r = await loadViewerImage(file(), existing);
    expect(r).toEqual({ uri: 'file:///c.img', kind: 'preview', source: 'cache' });
    expect(fetchCalls).toEqual([]);
  });
  test('download stores, trims keeping the shown file', async () => {
    fetched = 'file:///d.img';
    const r = await loadViewerImage(file(), existing);
    expect(r).toEqual({ uri: 'file:///d.img', kind: 'preview', source: 'download-preview' });
    expect(trims).toHaveLength(1);
    expect(trims[0][0]).toBe(1000);
    expect([...trims[0][1]]).toEqual(['f1']);
  });
  test('missing or corrupt preview (null) falls back to existing', async () => {
    const r = await loadViewerImage(file(), existing);
    expect(r).toEqual({ uri: 'file:///thumb.jpg', kind: 'original', source: 'existing' });
  });
  test('offline-pinned: no download is attempted', async () => {
    fetched = 'file:///d.img';
    const r = await loadViewerImage(file(), existing, { offlinePinned: true });
    expect(r.source).toBe('existing');
    expect(fetchCalls).toEqual([]);
  });
  test('old server never touches the cache and does not throw', async () => {
    supported = false; cached = 'file:///c.img';
    const r = await loadViewerImage(file(), existing);
    expect(r.source).toBe('existing');
    expect(fetchCalls).toEqual([]);
  });
  test('a throwing cache layer falls back instead of crashing', async () => {
    cacheThrows = true;
    const r = await loadViewerImage(file(), existing);
    expect(r.source).toBe('existing');
  });
  test('without a fallback and without a preview it rejects', async () => {
    await expect(loadViewerImage(file({ has_preview: false }))).rejects.toThrow();
  });
});

describe('generate from opened original', () => {
  const on = { enabled: true, format: 'heic', px: 2560 };
  test('only images, only when enabled, only without a preview', () => {
    expect(shouldGenerateFromOpenedOriginal(file({ has_preview: false }), on, true)).toBe(true);
    expect(shouldGenerateFromOpenedOriginal(file({ has_preview: false, mime_type: 'video/mp4' }), on, true)).toBe(false);
    expect(shouldGenerateFromOpenedOriginal(file({ has_preview: false, mime_type: 'application/pdf' }), on, true)).toBe(false);
    expect(shouldGenerateFromOpenedOriginal(file({ has_preview: false }), { ...on, enabled: false }, true)).toBe(false);
    expect(shouldGenerateFromOpenedOriginal(file({ has_preview: true }), on, true)).toBe(false);
    expect(shouldGenerateFromOpenedOriginal(file({ has_preview: undefined }), on, true)).toBe(false);
    expect(shouldGenerateFromOpenedOriginal(file({ has_preview: false }), on, false)).toBe(false);
  });
  const prep = (over = {}) => prepareGenerateFromOpenedOriginal(file({ has_preview: false, ...over }));
  test('uploads from the decrypted path once per file', async () => {
    const run = await prep();
    await run('file:///a%20b.jpg');
    expect(await prep()).toBeNull();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toEqual([7, 'http://api.test', 'tok', 'f1', null, '/a b.jpg', 'heic', 2560, 'acct-1']);
  });
  test('the file is released only after the native upload settles', async () => {
    const events: string[] = [];
    let finish: (v: unknown) => void = () => {};
    uploadImpl = () => new Promise((r) => { events.push('upload-start'); finish = r; });
    const run = await prep();
    const done = run('file:///a.jpg', () => { events.push('release'); });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['upload-start']);
    finish({ bytes: 1 });
    await done;
    expect(events).toEqual(['upload-start', 'release']);
  });
  test('a failed upload releases the file and allows a retry', async () => {
    let released = 0;
    uploadImpl = async () => { throw new Error('nope'); };
    const run = await prep();
    await run('file:///a.jpg', () => { released += 1; });
    expect(released).toBe(1);
    uploadImpl = async () => ({ bytes: 1 });
    const again = await prep();
    expect(again).not.toBeNull();
    await again('file:///a.jpg');
    expect(uploads).toHaveLength(2);
  });
  test('support, setting and token are resolved before the runner exists', async () => {
    setting = { enabled: false, format: 'heic', px: 2560 };
    expect(await prep({ id: 'a' })).toBeNull();
    setting = on; supported = false;
    expect(await prep({ id: 'b' })).toBeNull();
    supported = true; settingThrows = true;
    expect(await prep({ id: 'c' })).toBeNull();
    expect(uploads).toHaveLength(0);
  });
  test('non-images never upload', async () => {
    expect(await prep({ mime_type: 'video/mp4' })).toBeNull();
  });
});

describe('stored preview format and size', () => {
  test("the row's preview_format/preview_px reach the cache lookup and the download", async () => {
    fetched = 'file:///p.img';
    await loadStoredPreview(file({ preview_format: 'heic', preview_px: 3840 }));
    expect(cacheExpected[0]).toEqual({ format: 'heic', px: 3840, bytes: null });
    expect(fetchExpected[0]).toEqual({ format: 'heic', px: 3840, bytes: null });
  });

  test("the row's preview_bytes is part of the lookup", async () => {
    cached = 'file:///p.img';
    await loadStoredPreview(file({ preview_format: 'heic', preview_px: 2560, preview_bytes: 4242 }));
    expect(cacheExpected[0]).toEqual({ format: 'heic', px: 2560, bytes: 4242 });
  });

  test('a row without a stored preview drops the cached copy', async () => {
    expect(await loadStoredPreview(file({ has_preview: false }))).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(dropped).toEqual(['f1']);
  });

  test('an opened-original upload drops the older cached copy', async () => {
    const run = await prepareGenerateFromOpenedOriginal(file({ has_preview: false }));
    dropped = [];
    await run!('file:///a.jpg');
    expect(dropped).toEqual(['f1']);
  });

  test('a failed opened-original upload keeps the cached copy', async () => {
    uploadImpl = async () => { throw new Error('x'); };
    const run = await prepareGenerateFromOpenedOriginal(file({ has_preview: false }));
    dropped = [];
    await run!('file:///a.jpg');
    expect(dropped).toEqual([]);
  });
});

describe('zoomExceedsPreview', () => {
  const view = { width: 402, height: 874 };
  test('with the preview pixels: exact for landscape and portrait', () => {
    const landscape = { width: 2560, height: 1707 }; // fit 402/2560 -> 1:1 at ~2.12x on a 3x screen
    expect(zoomExceedsPreview(2.0, view, 3, landscape)).toBe(false);
    expect(zoomExceedsPreview(2.2, view, 3, landscape)).toBe(true);
    const portrait = { width: 1920, height: 2560 }; // fit 402/1920 -> 1:1 at ~1.59x
    expect(zoomExceedsPreview(1.5, view, 3, portrait)).toBe(false);
    expect(zoomExceedsPreview(1.65, view, 3, portrait)).toBe(true);
    const tall = { width: 1000, height: 3840 }; // height-limited: fit 874/3840 -> ~1.46x
    expect(zoomExceedsPreview(1.4, view, 3, tall)).toBe(false);
    expect(zoomExceedsPreview(1.5, view, 3, tall)).toBe(true);
  });
  test('never at 1x', () => {
    expect(zoomExceedsPreview(1, view, 3, { width: 100, height: 100 })).toBe(false);
  });
  test('without pixels: page width against the long edge; no size known: never', () => {
    expect(zoomExceedsPreview(1.1, view, 3, null, 1280)).toBe(true);
    expect(zoomExceedsPreview(1.05, view, 3, null, 1280)).toBe(false);
    expect(zoomExceedsPreview(10, view, 3, null, null)).toBe(false);
  });
});
