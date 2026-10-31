// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// In-memory file system. Keys are absolute file:// URIs.
const CACHE = 'file:///caches/';
const DIR = `${CACHE}beebeeb-previews-v1/`;
let files = new Map<string, { size: number; mtime: number }>();
let dirs = new Set<string>();
let secure = new Map<string, string>();
let downloadImpl: (...a: unknown[]) => Promise<unknown>;
let downloadCalls: unknown[][] = [];
let clock = 1000;

function strip(uri: string) { return uri.endsWith('/') ? uri.slice(0, -1) : uri; }

mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: CACHE,
  makeDirectoryAsync: async (uri: string) => { dirs.add(strip(uri)); },
  readDirectoryAsync: async (uri: string) => {
    const base = strip(uri) + '/';
    const out: string[] = [];
    for (const k of files.keys()) if (k.startsWith(base) && !k.slice(base.length).includes('/')) out.push(k.slice(base.length));
    for (const d of dirs) if (d.startsWith(base) && !d.slice(base.length).includes('/')) out.push(d.slice(base.length));
    return out;
  },
  getInfoAsync: async (uri: string) => {
    if (dirs.has(strip(uri))) return { exists: true, isDirectory: true, uri };
    const f = files.get(uri);
    return f ? { exists: true, isDirectory: false, size: f.size, modificationTime: f.mtime, uri } : { exists: false, isDirectory: false, uri };
  },
  deleteAsync: async (uri: string) => {
    files.delete(uri);
    const base = strip(uri);
    dirs.delete(base);
    for (const k of [...files.keys()]) if (k.startsWith(base + '/')) files.delete(k);
  },
  readAsStringAsync: async (uri: string) => {
    const f = files.get(uri) as any;
    if (!f || f.text === undefined) throw new Error('ENOENT');
    return f.text;
  },
  moveAsync: async ({ from, to }: { from: string; to: string }) => {
    const f = files.get(from);
    if (!f) throw new Error('ENOENT');
    files.delete(from); files.set(to, f);
  },
  writeAsStringAsync: async (uri: string, text: string) => { files.set(uri, { size: text.length, mtime: clock, text } as any); },
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  downloadPhotoPreviewNative: async (...a: unknown[]) => { downloadCalls.push(a); return downloadImpl(...a); },
}));
mock.module('./api', () => ({ getApiUrl: () => 'http://api.test', getToken: async () => 'tok' }));

const c = await import('./photo-preview-cache');

// expo-file-system reports modificationTime in seconds; the LRU index uses ms.
function put(id: string, size: number, mtimeMs = clock) { files.set(`${DIR}${id}.img`, { size, mtime: mtimeMs / 1000 }); }
const GB = 1024 ** 3;

beforeEach(() => {
  files = new Map(); dirs = new Set(); secure = new Map(); downloadCalls = []; clock = 1000;
  downloadImpl = async () => ({ bytes: 10, format: 'heic', px: 2560 });
  c.__resetPreviewCacheForTests({ now: () => ++clock, totalDisk: async () => 100 * GB, handleId: () => 7 });
});

describe('location', () => {
  test('lives under Caches/beebeeb-previews-v1', () => {
    expect(c.previewCacheDir()).toBe(DIR);
  });
});

describe('usage', () => {
  test('sums files and ignores sub-directories and the index', async () => {
    put('a', 100); put('b', 250);
    dirs.add(`${strip(DIR)}/samples`);
    files.set(`${DIR}samples/x.jpg`, { size: 999, mtime: 1 });
    expect(await c.previewCacheUsage()).toEqual({ files: 2, bytes: 350 });
  });
  test('empty or missing dir', async () => {
    expect(await c.previewCacheUsage()).toEqual({ files: 0, bytes: 0 });
  });
});

describe('getCachedPreview', () => {
  test('null when absent, uri when present', async () => {
    expect(await c.getCachedPreview('a')).toBeNull();
    put('a', 5);
    expect(await c.getCachedPreview('a')).toBe(`${DIR}a.img`);
  });
  test('rejects ids that are not plain file ids', async () => {
    expect(await c.getCachedPreview('../x')).toBeNull();
  });
});

describe('trimPreviewCache', () => {
  test('removes least recently used first until under the limit', async () => {
    put('old', 100); put('mid', 100); put('new', 100);
    await c.getCachedPreview('mid');
    await c.getCachedPreview('new');   // order of use: old (never), mid, new
    const r = await c.trimPreviewCache(250);
    expect(r).toEqual({ removed: 1, bytes: 200 });
    expect(files.has(`${DIR}old.img`)).toBe(false);
    expect(files.has(`${DIR}mid.img`)).toBe(true);
  });
  test('a touch moves a file to the back of the queue', async () => {
    put('a', 100); put('b', 100); put('c', 100);
    await c.getCachedPreview('a'); await c.getCachedPreview('b'); await c.getCachedPreview('c');
    await c.getCachedPreview('a');
    await c.trimPreviewCache(200);
    expect(files.has(`${DIR}b.img`)).toBe(false);
    expect(files.has(`${DIR}a.img`)).toBe(true);
  });
  test('never removes ids in keep, even when still over the limit', async () => {
    put('a', 100); put('b', 100);
    await c.getCachedPreview('a'); await c.getCachedPreview('b');
    const r = await c.trimPreviewCache(0, new Set(['a']));
    expect(files.has(`${DIR}a.img`)).toBe(true);
    expect(files.has(`${DIR}b.img`)).toBe(false);
    expect(r).toEqual({ removed: 1, bytes: 100 });
  });
  test('no-op when under the limit', async () => {
    put('a', 100);
    expect(await c.trimPreviewCache(1000)).toEqual({ removed: 0, bytes: 100 });
  });
  test('lowering the stored limit below usage trims on the next trim', async () => {
    put('a', 600); put('b', 600);
    await c.getCachedPreview('a'); await c.getCachedPreview('b');
    await c.setPreviewCacheLimitBytes(700);
    await c.trimPreviewCache(await c.getPreviewCacheLimitBytes(), new Set(['b']));
    expect(files.has(`${DIR}a.img`)).toBe(false);
    expect(files.has(`${DIR}b.img`)).toBe(true);
  });
});

describe('index persistence', () => {
  test('concurrent touches and trims leave a parseable index matching the files on disk', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) put(id, 100);
    await Promise.all([
      c.getCachedPreview('a'), c.getCachedPreview('b'), c.getCachedPreview('c'),
      c.trimPreviewCache(350), c.getCachedPreview('d'), c.getCachedPreview('e'),
      c.trimPreviewCache(250), c.getCachedPreview('a'),
    ]);
    const onDisk = [...files.keys()].filter((k) => k.endsWith('.img')).map((k) => k.slice(DIR.length, -4)).sort();
    const idx = JSON.parse((files.get(`${DIR}.lru-index.json`) as any).text);
    for (const id of Object.keys(idx)) expect(onDisk).toContain(id);
    expect(files.has(`${DIR}.lru-index.tmp`)).toBe(false);
    expect(onDisk.length).toBeLessThan(5);
  });
  test('removals are persisted', async () => {
    put('a', 100); put('b', 100);
    await c.getCachedPreview('a'); await c.getCachedPreview('b');
    await c.trimPreviewCache(100);
    const idx = JSON.parse((files.get(`${DIR}.lru-index.json`) as any).text);
    expect(Object.keys(idx)).toEqual(['b']);
  });
});

describe('clearPreviewCache', () => {
  test('removes cached previews but leaves the cache usable', async () => {
    put('a', 10);
    await c.clearPreviewCache();
    expect(await c.previewCacheUsage()).toEqual({ files: 0, bytes: 0 });
    expect(await c.getCachedPreview('a')).toBeNull();
  });
});

describe('fetchPreviewToCache', () => {
  test('downloads to the cache dir and returns the uri', async () => {
    downloadImpl = async (...a) => { files.set(`${DIR}f1.img`, { size: 42, mtime: clock }); return { bytes: 42, format: 'heic', px: 2560 }; };
    const uri = await c.fetchPreviewToCache('f1');
    expect(uri).toBe(`${DIR}f1.img`);
    expect(downloadCalls[0].slice(0, 4)).toEqual([7, 'http://api.test', 'tok', 'f1']);
    expect(String(downloadCalls[0][4]).startsWith('/caches/beebeeb-previews-v1/')).toBe(true);
  });
  test('missing preview gives null', async () => {
    downloadImpl = async () => { throw Object.assign(new Error('preview_missing'), { code: 'preview_missing' }); };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
  });
  test('corrupt preview gives null and the file is gone', async () => {
    downloadImpl = async () => {
      files.set(`${DIR}f1.img`, { size: 3, mtime: clock });
      throw Object.assign(new Error('preview_corrupt'), { code: 'preview_corrupt' });
    };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });
  test('error carried only in the message is still classified', async () => {
    downloadImpl = async () => { files.set(`${DIR}f1.img`, { size: 3, mtime: clock }); throw new Error('Call to function failed: preview_corrupt'); };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });
  test('transient failure keeps an existing cached file', async () => {
    put('f1', 50);
    downloadImpl = async () => { throw new Error('network down'); };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(true);
  });
  test('locked vault keeps an existing cached file', async () => {
    put('f1', 50);
    c.__resetPreviewCacheForTests({ handleId: () => { throw new Error('Vault is locked'); } });
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(true);
  });
  test('404 removes an existing cached file', async () => {
    put('f1', 50);
    downloadImpl = async () => { throw Object.assign(new Error('x'), { code: 'preview_missing' }); };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });
  test('corrupt removes an existing cached file', async () => {
    put('f1', 50);
    downloadImpl = async () => { throw Object.assign(new Error('x'), { code: 'preview_corrupt' }); };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });
  test('any other failure also gives null and removes a partial file', async () => {
    downloadImpl = async () => { files.set(`${DIR}f1.img`, { size: 1, mtime: clock }); throw new Error('network'); };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });
  test('no token or locked vault gives null without calling native', async () => {
    c.__resetPreviewCacheForTests({ handleId: () => { throw new Error('Vault is locked'); } });
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(downloadCalls.length).toBe(0);
  });
  test('a zero-byte result is treated as missing', async () => {
    downloadImpl = async () => { files.set(`${DIR}f1.img`, { size: 0, mtime: clock }); return { bytes: 0, format: 'heic', px: 2560 }; };
    expect(await c.fetchPreviewToCache('f1')).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });
});

describe('cache limit', () => {
  test('default is min(20 GB, 10% of disk)', async () => {
    expect(await c.getPreviewCacheLimitBytes()).toBe(10 * GB);
    c.__resetPreviewCacheForTests({ totalDisk: async () => 1000 * GB });
    expect(await c.getPreviewCacheLimitBytes()).toBe(20 * GB);
  });
  test('default survives an unknown disk size', async () => {
    c.__resetPreviewCacheForTests({ totalDisk: async () => { throw new Error('x'); } });
    expect(await c.getPreviewCacheLimitBytes()).toBe(20 * GB);
  });
  test('stored per device in SecureStore under the versioned key', async () => {
    await c.setPreviewCacheLimitBytes(5 * GB);
    expect(secure.get('beebeeb.preview-cache-limit.v1')).toBe(String(5 * GB));
    expect(await c.getPreviewCacheLimitBytes()).toBe(5 * GB);
  });
  test('garbage in the store falls back to the default', async () => {
    secure.set('beebeeb.preview-cache-limit.v1', 'nope');
    expect(await c.getPreviewCacheLimitBytes()).toBe(10 * GB);
  });
  test('rejects a negative or non-finite limit', async () => {
    await expect(c.setPreviewCacheLimitBytes(-1)).rejects.toThrow();
    await expect(c.setPreviewCacheLimitBytes(NaN)).rejects.toThrow();
  });
});

describe('format and size of a cached preview', () => {
  test('recorded from the download; a different row setting is a miss and the file is dropped', async () => {
    downloadImpl = async () => { files.set(`${DIR}f1.img`, { size: 5, mtime: 1 }); return { bytes: 5, format: 'heic', px: 1280 }; };
    expect(await c.fetchPreviewToCache('f1')).toBe(`${DIR}f1.img`);
    expect(await c.getCachedPreview('f1', { format: 'heic', px: 1280 })).toBe(`${DIR}f1.img`);
    expect(await c.getCachedPreview('f1', { format: 'heic', px: 3840 })).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });

  test('a cached file without recorded format/size counts as a miss when the row knows them', async () => {
    put('old', 5);
    expect(await c.getCachedPreview('old', { format: 'jpeg', px: 1920 })).toBeNull();
    put('old2', 5);
    expect(await c.getCachedPreview('old2')).toBe(`${DIR}old2.img`);
  });

  test('missing response headers fall back to the row values', async () => {
    downloadImpl = async () => { files.set(`${DIR}f2.img`, { size: 5, mtime: 1 }); return { bytes: 5, format: '', px: 0 }; };
    await c.fetchPreviewToCache('f2', { format: 'jpeg', px: 2560 });
    expect(await c.getCachedPreview('f2', { format: 'jpeg', px: 2560 })).toBe(`${DIR}f2.img`);
  });

  test('dropCachedPreview removes one entry', async () => {
    put('a', 5); put('b', 5);
    await c.dropCachedPreview('a');
    expect(files.has(`${DIR}a.img`)).toBe(false);
    expect(files.has(`${DIR}b.img`)).toBe(true);
  });

  test('the index survives a reload with its metadata', async () => {
    downloadImpl = async () => { files.set(`${DIR}f3.img`, { size: 5, mtime: 1 }); return { bytes: 5, format: 'heic', px: 3840 }; };
    await c.fetchPreviewToCache('f3');
    c.__resetPreviewCacheForTests({ now: () => ++clock, totalDisk: async () => 100 * GB, handleId: () => 7 });
    expect(await c.getCachedPreview('f3', { format: 'heic', px: 3840 })).toBe(`${DIR}f3.img`);
  });
});

describe('trim safety', () => {
  test('a file the index does not know yet is ordered by its modification time, not as oldest', async () => {
    put('a', 100); put('b', 100);
    await c.getCachedPreview('a'); await c.getCachedPreview('b');
    clock += 10;
    put('fresh', 100, clock); // written by a concurrent download, not yet indexed
    await c.trimPreviewCache(250);
    expect(files.has(`${DIR}fresh.img`)).toBe(true);
    expect(files.has(`${DIR}a.img`)).toBe(false);
  });

  test('an id being downloaded is never trimmed', async () => {
    put('old', 100);
    let release: () => void = () => {};
    downloadImpl = async () => {
      files.set(`${DIR}busy.img`, { size: 100, mtime: 0 });
      await new Promise<void>((r) => { release = r; });
      return { bytes: 100, format: 'heic', px: 2560 };
    };
    const pending = c.fetchPreviewToCache('busy');
    await new Promise((r) => setTimeout(r, 0));
    await c.trimPreviewCache(0);
    expect(files.has(`${DIR}busy.img`)).toBe(true);
    expect(files.has(`${DIR}old.img`)).toBe(false);
    release();
    expect(await pending).toBe(`${DIR}busy.img`);
  });

  test('deletePreviewSamples removes only the samples directory', async () => {
    put('a', 5);
    files.set(`${DIR}samples/x.jpg`, { size: 9, mtime: 1 });
    await c.deletePreviewSamples();
    expect(files.has(`${DIR}samples/x.jpg`)).toBe(false);
    expect(files.has(`${DIR}a.img`)).toBe(true);
  });
});

describe('stored preview identity (preview_bytes)', () => {
  test('same format and size but another stored preview (new version) is a miss', async () => {
    downloadImpl = async () => { files.set(`${DIR}f1.img`, { size: 1000, mtime: 1 }); return { bytes: 1000, format: 'heic', px: 2560 }; };
    await c.fetchPreviewToCache('f1');
    // The server's preview_bytes is the plaintext size + 28 (nonce + tag).
    expect(await c.getCachedPreview('f1', { format: 'heic', px: 2560, bytes: 1028 })).toBe(`${DIR}f1.img`);
    expect(await c.getCachedPreview('f1', { format: 'heic', px: 2560, bytes: 2028 })).toBeNull();
    expect(files.has(`${DIR}f1.img`)).toBe(false);
  });

  test('a row without preview_bytes checks format and size only', async () => {
    downloadImpl = async () => { files.set(`${DIR}f2.img`, { size: 10, mtime: 1 }); return { bytes: 10, format: 'jpeg', px: 1280 }; };
    await c.fetchPreviewToCache('f2');
    expect(await c.getCachedPreview('f2', { format: 'jpeg', px: 1280, bytes: null })).toBe(`${DIR}f2.img`);
  });

  test('an entry cached without a byte size is a miss once the row has one', async () => {
    downloadImpl = async () => { files.set(`${DIR}f3.img`, { size: 10, mtime: 1 }); return { bytes: 0, format: 'jpeg', px: 1280 }; };
    put('f3', 10);
    await c.getCachedPreview('f3'); // indexed, no metadata
    expect(await c.getCachedPreview('f3', { format: 'jpeg', px: 1280, bytes: 38 })).toBeNull();
  });
});

describe('commitPreviewCacheLimit', () => {
  test('a lowered limit is stored and trims right away', async () => {
    put('a', 100); put('b', 100); put('c', 100);
    await c.getCachedPreview('a'); await c.getCachedPreview('b'); await c.getCachedPreview('c');
    const r = await c.commitPreviewCacheLimit(150, 100, 1000);
    expect(r).toEqual({ limit: 150, usageBytes: 100 });
    expect(await c.getPreviewCacheLimitBytes()).toBe(150);
    expect(files.has(`${DIR}c.img`)).toBe(true);
  });

  test('clamped to the slider range', async () => {
    expect((await c.commitPreviewCacheLimit(5, 100, 1000)).limit).toBe(100);
    expect((await c.commitPreviewCacheLimit(5000, 100, 1000)).limit).toBe(1000);
    expect(await c.getPreviewCacheLimitBytes()).toBe(1000);
  });
});
