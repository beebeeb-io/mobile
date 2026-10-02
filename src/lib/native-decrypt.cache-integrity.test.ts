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
const nativeCalls: number[] = [];
mock.module('../../modules/beebeeb-crypto', () => ({
  isNativeAvailable: true,
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