// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1687d — a truncated preview cache entry must never render as a
// "halve file". Drive the REAL native-decrypt.ts with an in-memory file
// system and a controllable native download (same harness as
// native-decrypt.inflight.test.ts).
//
// RED-first evidence (mutation protocol) in task 1687 Notes: with the
// size-integrity check reverted (cache hit = "exists && size > 0", the
// pre-fix test), the truncated-cache cases fail; reverted again, green.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const files = new Map<string, number>(); // uri -> size
const deletes: string[] = [];
let nativePlaintextSize = 5000;
let copyHook: null | (() => Promise<void>) = null;
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async (uri) => {
    if (uri.endsWith('/')) return { exists: true };
    return files.has(uri) ? { exists: true, size: files.get(uri), modificationTime: Date.now() / 1000 } : { exists: false };
  },
  makeDirectoryAsync: async () => {},
  copyAsync: async ({from, to}) => { await copyHook?.(); files.set(to, files.get(from)); },
  readDirectoryAsync: async (dir) => [...files.keys()].filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length)),
  deleteAsync: async (uri) => {
    deletes.push(uri);
    for (const k of [...files.keys()]) if (k === uri || (uri.endsWith('/') && k.startsWith(uri))) files.delete(k);
  },
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));
const nativeCalls: number[] = [];
mock.module('../../modules/beebeeb-crypto', () => ({
  isNativeAvailable: true,
  // task 1683d — the offline streaming decrypt (decryptLocalFileNative) lives
  // behind a typeof guard in native-decrypt.ts; this harness drives the
  // DOWNLOAD path, so a stub that throws (rather than silently succeeding) is
  // the honest mock here (same convention as native-decrypt.inflight.test.ts).
  decryptLocalFileNative: async () => {
    throw new Error('decryptLocalFileNative must not be reached by the download-path tests');
  },
  downloadAndDecryptFileNative: (_h, _api, _tok, _id, outputPath, opts) =>
    new Promise((resolve, reject) => {
      files.set(outputPath, nativePlaintextSize);
      nativeCalls.push(1);
      if (opts?.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
      // Resolve on the next microtask so callers can await the promise.
      setTimeout(() => resolve({ outputUri: outputPath, plaintextSize: nativePlaintextSize, chunksDecrypted: 1 }), 0);
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
  // preview-load-error (imported for PARTIAL_DECRYPT_MESSAGE) needs this.
  friendlyError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => { throw new Error('no js download in this test'); } }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => {} }));
mock.module('./offline-manager', () => ({
  offlineManager: { init: async () => {}, isAvailable: () => false, getMeta: () => null },
  offlineFilePath: (id) => `file:///offline/${id}`,
}));
mock.module('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: true }) } }));

const nd = await import('./native-decrypt');
const { PARTIAL_DECRYPT_MESSAGE } = await import('./preview-load-error');
const { plaintextGate } = await import('./plaintext-gate');

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  files.clear();
  deletes.length = 0;
  nativeCalls.length = 0;
  nativePlaintextSize = 5000;
  copyHook = null;
  plaintextGate.open();
});

describe('task 1687d — preview cache integrity', () => {
  test('a TRUNCATED cache entry is rejected: scrubbed, re-decrypted fresh', async () => {
    files.set('file:///cache/preview/t1.pdf', 2000); // truncated (expected 5000)
    const p = nd.decryptToTempFile('t1', null, 'pdf', 5000, 1, 7);
    await p;
    expect(deletes).toContain('file:///cache/preview/t1.pdf');
    expect(nativeCalls.length).toBe(1);
    expect(files.get('file:///cache/preview/t1.pdf')).toBe(5000);
  });

  test('a size-matching cache entry is still served without a re-decrypt', async () => {
    files.set('file:///cache/preview/t2.pdf', 5000);
    const sources: string[] = [];
    const p = nd.decryptToTempFile('t2', null, 'pdf', 5000, 1, 7, { onSource: (s) => sources.push(s) });
    const out = await p;
    expect(out).toBe('file:///cache/preview/t2.pdf');
    expect(sources).toEqual(['cache']);
    expect(nativeCalls.length).toBe(0);
    expect(deletes).toEqual([]);
  });

  test('a fresh native decrypt that comes up SHORT is deleted and rejects with the honest partial message', async () => {
    nativePlaintextSize = 3000; // native writer died at 3000/5000 bytes
    const p = nd.decryptToTempFile('t3', null, 'pdf', 5000, 1, 7);
    await expect(p).rejects.toThrow(PARTIAL_DECRYPT_MESSAGE);
    expect(deletes).toContain('file:///cache/preview/t3.pdf');
    expect(files.has('file:///cache/preview/t3.pdf')).toBe(false);
  });

  test('an UNKNOWN size (null) keeps the old semantics: a non-empty cache is served', async () => {
    files.set('file:///cache/preview/t4.pdf', 123);
    const out = await nd.decryptToTempFile('t4', null, 'pdf', null, 1, 7);
    expect(out).toBe('file:///cache/preview/t4.pdf');
    expect(nativeCalls.length).toBe(0);
  });

  test('a size-matching cache entry for a file whose metadata size is unknown-sized stays untouched', async () => {
    files.set('file:///cache/preview/t5.pdf', 5000);
    const out = await nd.decryptToTempFile('t5', null, 'pdf', undefined, 1, 7);
    expect(out).toBe('file:///cache/preview/t5.pdf');
    expect(deletes).toEqual([]);
  });
});

describe('1721 — freshly uploaded source seeds bounded preview cache', () => {
  test('a 57 MB uploaded DNG opens without a download or key derivation', async () => {
    const size = 57 * 1024 * 1024;
    files.set('file:///upload.dng', size);
    expect(await nd.cacheUploadedPreview('fresh', 'dng', 'file:///upload.dng', size)).toBe(true);
    const out = await nd.decryptToTempFile('fresh', () => { throw new Error('must not derive'); }, 'dng', size, 57, 7);
    expect(out).toBe('file:///cache/preview/fresh.dng');
    expect(nativeCalls.length).toBe(0);
    expect(files.get('file:///upload.dng')).toBe(size);
    await nd.releasePreviewCopy('fresh', 'dng');
  });
  test('a truncated upload source cannot poison the preview cache', async () => {
    files.set('file:///upload.dng', 2000);
    expect(await nd.cacheUploadedPreview('short', 'dng', 'file:///upload.dng', 5000)).toBe(false);
    expect(files.has('file:///cache/preview/short.dng')).toBe(false);
  });
  test('unknown or oversized sources are not retained', async () => {
    files.set('file:///huge.dng', 600 * 1024 * 1024);
    expect(await nd.cacheUploadedPreview('huge', 'dng', 'file:///huge.dng', 600 * 1024 * 1024)).toBe(false);
    expect(await nd.cacheUploadedPreview('unknown', 'dng', 'file:///huge.dng', null)).toBe(false);
  });
  test('purge refuses new upload-cache writes', async () => {
    files.set('file:///upload.dng', 5000);
    await plaintextGate.purge(async () => {});
    await expect(nd.cacheUploadedPreview('signedout', 'dng', 'file:///upload.dng', 5000)).rejects.toThrow();
    expect(files.has('file:///cache/preview/signedout.dng')).toBe(false);
  });
  test('preview cache stays bounded by 24 items', async () => {
    for (let i = 0; i < 30; i++) {
      files.set(`file:///source-${i}`, 5000);
      await nd.cacheUploadedPreview(`batch-${i}`, 'dng', `file:///source-${i}`, 5000);
    }
    expect([...files.keys()].filter(k => k.startsWith('file:///cache/preview/')).length).toBe(24);
  });
  test('an in-use preview is never overwritten by an uploaded version', async () => {
    files.set('file:///cache/preview/leased.dng', 5000);
    await nd.decryptToTempFile('leased', null, 'dng', 5000, 1, 7);
    files.set('file:///new.dng', 6000);
    expect(await nd.cacheUploadedPreview('leased', 'dng', 'file:///new.dng', 6000)).toBe(false);
    expect(files.get('file:///cache/preview/leased.dng')).toBe(5000);
    await nd.releasePreviewCopy('leased', 'dng');
  });
});

test('1721 — preview joins upload-source copy without reading a partial file', async () => {
  let finish!: () => void;
  copyHook = () => new Promise(resolve => { finish = resolve; });
  files.set('file:///source.dng', 5000);
  const seed = nd.cacheUploadedPreview('joining', 'dng', 'file:///source.dng', 5000);
  while (!finish) await tick();
  const preview = nd.decryptToTempFile('joining', null, 'dng', 5000, 1, 7);
  finish();
  expect(await seed).toBe(true);
  expect(await preview).toBe('file:///cache/preview/joining.dng');
  expect(nativeCalls.length).toBe(0);
  await nd.releasePreviewCopy('joining', 'dng');
});
test('1721 — sign-out racing an upload-source copy leaves no plaintext behind', async () => {
  let finish!: () => void;
  copyHook = () => new Promise(resolve => { finish = resolve; });
  files.set('file:///source.dng', 5000);
  const seed = nd.cacheUploadedPreview('purging', 'dng', 'file:///source.dng', 5000);
  while (!finish) await tick();
  const purge = plaintextGate.purge(async () => { files.delete('file:///cache/preview/purging.dng'); });
  finish();
  await expect(seed).rejects.toThrow();
  await purge;
  expect(files.has('file:///cache/preview/purging.dng')).toBe(false);
});
test('1721 — a batch cannot retain more than 512 MB of uploaded sources', async () => {
  const size = 200 * 1024 * 1024;
  for (let i = 0; i < 4; i++) {
    files.set(`file:///large-${i}`, size);
    await nd.cacheUploadedPreview(`large-${i}`, 'dng', `file:///large-${i}`, size);
  }
  const cached = [...files.entries()].filter(([uri]) => uri.startsWith('file:///cache/preview/'));
  expect(cached.length).toBe(2);
  expect(cached.reduce((sum, [, n]) => sum + n, 0)).toBeLessThanOrEqual(512 * 1024 * 1024);
});
