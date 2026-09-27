// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 — decryptToTempFile's in-flight de-dupe, abort plumbing, cache
 * source reporting, and clearPreviewCache (the sign-out purge of
 * Library/Caches/preview/). Drives the REAL native-decrypt.ts with an
 * in-memory file system and a controllable native download.
 * Mutation evidence: task 1593 Notes.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const files = new Map<string, number>(); // uri -> size
const deletes: string[] = [];
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async (uri) => {
    if (uri.endsWith('/')) return { exists: true };
    return files.has(uri) ? { exists: true, size: files.get(uri), modificationTime: Date.now() / 1000 } : { exists: false };
  },
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async (dir) => [...files.keys()].filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length)),
  deleteAsync: async (uri) => {
    deletes.push(uri);
    for (const k of [...files.keys()]) if (k === uri || (uri.endsWith('/') && k.startsWith(uri))) files.delete(k);
  },
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

type Pending = { outputPath: string; signal?: AbortSignal; finish: () => void; fail: (e) => void };
const nativeCalls: Pending[] = [];
mock.module('../../modules/beebeeb-crypto', () => ({
  isNativeAvailable: true,
  downloadAndDecryptFileNative: (_h, _api, _tok, _id, outputPath, opts) =>
    new Promise((resolve, reject) => {
      // Native writes progressively: a partial, non-empty file exists at once.
      files.set(outputPath, 100);
      const entry = {
        outputPath,
        signal: opts?.signal,
        finish: () => { files.set(outputPath, 5000); resolve({ outputUri: outputPath, plaintextSize: 5000, chunksDecrypted: 1 }); },
        fail: reject,
      };
      opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
      nativeCalls.push(entry);
    }),
}));
mock.module('./encrypted-download', () => ({
  CHUNK_SIZE: 1024,
  decryptEncryptedBytes: async () => new Uint8Array(),
  inferChunkCountFromEncryptedSize: () => 1,
}));
mock.module('./decrypt-to-file', () => ({
  decryptChunksToFile: async () => 0,
  DecryptToFileUnavailableError: class extends Error {},
  isDecryptToFileReady: () => false,
}));
mock.module('./api', () => ({
  ApiError: class extends Error {},
  getApiUrl: () => 'https://api.test',
  getDownloadUrl: (id) => `https://api.test/api/v1/files/${id}/download`,
  getToken: async () => 'tok',
}));
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => { throw new Error('no js download in this test'); } }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => {} }));
mock.module('./offline-manager', () => ({
  offlineManager: { init: async () => {}, isAvailable: () => false, getMeta: () => null },
  offlineFilePath: (id) => `file:///offline/${id}`,
}));
mock.module('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: true }) } }));

const nd = await import('./native-decrypt');

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean) {
  for (let i = 0; i < 50 && !pred(); i++) await tick();
}

beforeEach(() => {
  files.clear();
  deletes.length = 0;
  nativeCalls.length = 0;
});

describe('decryptToTempFile — one in-flight decrypt per cache path', () => {
  test('a second caller joins the first: ONE native download, never the half-written file', async () => {
    const sources: string[] = [];
    const a = nd.decryptToTempFile('f1', null, 'pdf', 5000, 1, 7, { onSource: (s) => sources.push(`a:${s}`) });
    await until(() => nativeCalls.length === 1);
    // The partial file is on disk now — the old code returned it as a cache hit.
    const b = nd.decryptToTempFile('f1', null, 'pdf', 5000, 1, 7, { onSource: (s) => sources.push(`b:${s}`) });
    await tick();
    expect(nativeCalls.length).toBe(1);
    let bSettled = false;
    b.then(() => { bSettled = true; });
    await tick();
    expect(bSettled).toBe(false); // b waits for the full file
    nativeCalls[0].finish();
    expect(await a).toBe('file:///cache/preview/f1.pdf');
    expect(await b).toBe('file:///cache/preview/f1.pdf');
    expect(sources.sort()).toEqual(['a:decrypted', 'b:joined']);
  });

  test('a finished copy is reported as a cache hit', async () => {
    files.set('file:///cache/preview/f2.txt', 42);
    const sources: string[] = [];
    await nd.decryptToTempFile('f2', null, '.txt', 42, 1, 7, { onSource: (s) => sources.push(s) });
    expect(sources).toEqual(['cache']);
    expect(nativeCalls.length).toBe(0);
  });

  test('aborting the only caller aborts the native download and removes the partial file', async () => {
    const c = new AbortController();
    const p = nd.decryptToTempFile('f3', null, 'jpg', 5000, 1, 7, { signal: c.signal });
    await until(() => nativeCalls.length === 1);
    expect(nativeCalls[0].signal.aborted).toBe(false);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeCalls[0].signal.aborted).toBe(true);
    expect(files.has('file:///cache/preview/f3.jpg')).toBe(false);
  });

  test('aborting one of two callers leaves the shared download running', async () => {
    const c = new AbortController();
    const a = nd.decryptToTempFile('f4', null, 'jpg', 5000, 1, 7, { signal: c.signal });
    await until(() => nativeCalls.length === 1);
    const b = nd.decryptToTempFile('f4', null, 'jpg', 5000, 1, 7);
    await tick();
    c.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeCalls[0].signal.aborted).toBe(false);
    nativeCalls[0].finish();
    expect(await b).toBe('file:///cache/preview/f4.jpg');
  });
});

describe('clearPreviewCache — the sign-out purge of decrypted previews', () => {
  test('deletes the preview directory and every plaintext in it', async () => {
    files.set('file:///cache/preview/a.jpg', 10);
    files.set('file:///cache/preview/b.txt', 10);
    files.set('file:///cache/other.bin', 10);
    await nd.clearPreviewCache();
    expect(deletes).toContain('file:///cache/preview/');
    expect([...files.keys()]).toEqual(['file:///cache/other.bin']);
  });

  test('aborts an in-flight decrypt so it cannot write plaintext after the purge', async () => {
    const p = nd.decryptToTempFile('f5', null, 'pdf', 5000, 1, 7).catch((e) => e);
    await until(() => nativeCalls.length === 1);
    await nd.clearPreviewCache();
    expect(nativeCalls[0].signal.aborted).toBe(true);
    expect((await p).name).toBe('AbortError');
    expect(files.has('file:///cache/preview/f5.pdf')).toBe(false);
  });
});
