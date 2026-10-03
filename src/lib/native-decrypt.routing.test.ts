// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1683j — video routing in `decryptToTempFile`: a video extension on a
 * native build routes to `streamVideoNative` (the streaming engine), a
 * non-video extension keeps `downloadAndDecryptFileNative` (the whole-file
 * path), and a streaming failure falls THROUGH to the whole-file path (the
 * 1683b pipeline stays the safety net).
 *
 * Mocking mirrors native-decrypt.inflight.test.ts (task 1593): the real
 * native-decrypt.ts over an in-memory file system and controllable natives.
 * RED before the routing lands: streamVideoNative is never called.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const files = new Map<string, number>(); // uri -> size
const deletes: string[] = [];
let streamCalls = 0;
let streamFailError: Error | null = null;
let wholeCalls = 0;

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

mock.module('../../modules/beebeeb-crypto', () => ({
  isNativeAvailable: true,
  decryptLocalFileNative: async () => {
    throw new Error('decryptLocalFileNative must not be reached by the routing tests');
  },
  downloadAndDecryptFileNative: (_h, _api, _tok, _id, outputPath) => {
    wholeCalls += 1;
    files.set(outputPath, 5000);
    return { outputUri: outputPath, plaintextSize: 5000, chunksDecrypted: 1 };
  },
  streamVideoNative: (_h, _api, _tok, _id, _outputPath) => {
    streamCalls += 1;
    if (streamFailError) throw streamFailError;
    return {
      streamUri: 'http://127.0.0.1:41234/s/streamid/v.mp4',
      outputUri: _outputPath,
      outputPath: _outputPath,
      plaintextSize: 5000,
      chunkCount: 2,
      streamId: 'streamid',
    };
  },
  getPreviewLoadProgress: () => ({}),
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
  friendlyError: (err: unknown) => err instanceof Error ? err.message : String(err),
  getApiUrl: () => 'https://api.test',
  getDownloadUrl: (id) => `https://api.test/api/v1/files/${id}/download`,
  getToken: async () => 'tok',
}));
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => { throw new Error('no js download here'); } }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => {} }));
mock.module('./offline-manager', () => ({
  offlineManager: { init: async () => {}, isAvailable: () => false, getMeta: () => null },
  offlineFilePath: (id) => `file:///offline/${id}`,
}));
mock.module('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: true }) } }));

const nd = await import('./native-decrypt');

beforeEach(() => {
  files.clear();
  deletes.length = 0;
  streamCalls = 0;
  wholeCalls = 0;
  streamFailError = null;
});

describe('1683j video routing', () => {
  test('an mp4 routes to streamVideoNative and returns the loopback stream uri', async () => {
    const uri = await nd.decryptToTempFile('v1', null, 'mp4', 5000, 2, 7, {});
    expect(streamCalls).toBe(1);
    expect(wholeCalls).toBe(0);
    expect(uri).toBe('http://127.0.0.1:41234/s/streamid/v.mp4');
  });

  test('a pdf keeps the whole-file native path', async () => {
    const uri = await nd.decryptToTempFile('p1', null, 'pdf', 5000, 1, 7, {});
    expect(streamCalls).toBe(0);
    expect(wholeCalls).toBe(1);
    expect(uri).toBe('file:///cache/preview/p1.pdf');
  });

  test('a streaming failure falls through to the whole-file path', async () => {
    streamFailError = new Error('stream setup failed');
    const uri = await nd.decryptToTempFile('v2', null, 'mp4', 5000, 2, 7, {});
    expect(streamCalls).toBe(1);
    expect(wholeCalls).toBe(1);
    expect(uri).toBe('file:///cache/preview/v2.mp4');
  });

  test('a stream uri result is never deleteAsync-ed on success (the player owns it)', async () => {
    await nd.decryptToTempFile('v3', null, 'mov', 5000, 2, 7, {});
    expect(deletes).toEqual([]);
  });
});
