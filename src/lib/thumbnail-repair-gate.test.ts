// @ts-nocheck
// Task 1683i — the no-whole-file contract for thumbnail repair.
// `ensureThumbnailForImage` used to download the ENTIRE encrypted media file,
// decrypt it in memory and base64-write it, six at a time from the repair
// worker — the Java-heap filler behind the Photos-tab OOM (task 1683i crash:
// expo.modules.fetch readByteArray / okio Buffer, 384 MB largeHeap full).
// These tests pin the contract: oversized sources and videos are refused
// BEFORE any network body is consumed.
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const calls = { downloadFile: 0, arrayBuffer: 0, bodyCancel: 0 };

function makeResponse(headers, body) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k) => {
        const v = headers[k] ?? headers[k.toLowerCase()] ?? headers[String(k).toLowerCase()];
        return v == null ? null : String(v);
      },
    },
    body: {
      cancel: async () => {
        calls.bodyCancel += 1;
      },
    },
    arrayBuffer: async () => {
      calls.arrayBuffer += 1;
      return body ?? new ArrayBuffer(16);
    },
  };
}

mock.module('react-native', () => ({
  Platform: { OS: 'android', select: (o) => o.android ?? o.default },
  NativeModules: {},
}));

mock.module('./api', () => ({
  downloadFile: async () => {
    calls.downloadFile += 1;
    return currentResponse;
  },
  uploadThumbnail: async () => true,
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'tok',
  thumbnailUrl: (id) => `https://api.test/thumb/${id}`,
}));

mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async () => currentResponse,
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  encryptChunk: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(4) }),
  decryptChunk: async () => new Uint8Array(8),
  generateVideoThumbnail: async () => null,
  generateDngThumbnail: async () => null,
  generateAndUploadPhotoLibraryThumbnailNative: async () => false,
}));

mock.module('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  documentDirectory: '/doc/',
  cacheDirectory: '/cache/',
  writeAsStringAsync: async () => undefined,
  deleteAsync: async () => undefined,
  getInfoAsync: async () => ({ exists: false }),
  readDirectoryAsync: async () => [],
  makeDirectoryAsync: async () => undefined,
}));

mock.module('./plaintext-gate', () => ({
  gatedPlaintextWrite: async (_label, _uri, _fs, write) => write(),
}));

mock.module('expo-media-library/legacy', () => ({
  getAssetsAsync: async () => ({ assets: [] }),
}));

mock.module('./encrypted-download', () => ({
  decryptEncryptedBytes: async () => new Uint8Array(8),
  inferChunkCountFromEncryptedSize: () => 1,
}));

mock.module('./thumbnail-cache', () => ({
  cacheThumbnail: async () => '/doc/thumb',
  cacheThumbnailBase64: async () => '/doc/thumb',
  enqueueThumbnailLoad: async (_id, fn) => fn(),
  getCachedThumbnail: async () => null,
}));

mock.module('./local-identifier-map', () => ({
  getLocalIdentifier: () => null,
}));

mock.module('expo-image-manipulator', () => ({}));

let currentResponse;

const MAX = 10 * 1024 * 1024;
const overSize = MAX + 1;

describe('thumbnail repair gate (task 1683i — never download a whole media file for a thumbnail)', () => {
  beforeEach(() => {
    calls.downloadFile = 0;
    calls.arrayBuffer = 0;
    calls.bodyCancel = 0;
    currentResponse = makeResponse({}, new ArrayBuffer(16));
  });

  it('returns false WITHOUT downloading when the file is larger than the ceiling (metadata size)', async () => {
    const { ensureThumbnailForImage } = await import('./thumbnail');
    const ok = await ensureThumbnailForImage(
      'file-big',
      'big.mov',
      overSize,          // sizeBytes over the ceiling
      200,               // chunkCount
      'image/jpeg',
      async () => new Uint8Array(32),
    );
    expect(ok).toBe(false);
    expect(calls.downloadFile).toBe(0);   // RED pre-fix: it downloaded the whole file
    expect(calls.arrayBuffer).toBe(0);
  });

  it('returns false WITHOUT downloading for video mimes', async () => {
    const { ensureThumbnailForImage } = await import('./thumbnail');
    const ok = await ensureThumbnailForImage(
      'file-video',
      'clip.mp4',
      1024,              // tiny — still refused: videos never whole-download for a thumbnail
      1,
      'video/mp4',
      async () => new Uint8Array(32),
    );
    expect(ok).toBe(false);
    expect(calls.downloadFile).toBe(0);   // RED pre-fix
    expect(calls.arrayBuffer).toBe(0);
  });

  it('drops the response UNREAD when only the wire headers reveal the oversized body', async () => {
    currentResponse = makeResponse({ 'Content-Length': String(overSize) }, new ArrayBuffer(16));
    const { ensureThumbnailForImage } = await import('./thumbnail');
    const ok = await ensureThumbnailForImage(
      'file-unknown-size',
      'big.jpg',
      null,              // metadata size unknown — the wire gate must catch it
      null,
      'image/jpeg',
      async () => new Uint8Array(32),
    );
    expect(ok).toBe(false);
    expect(calls.downloadFile).toBe(1);   // fetch happens (headers needed)
    expect(calls.arrayBuffer).toBe(0);    // RED pre-fix: the whole body was buffered
    expect(calls.bodyCancel).toBe(1);     // the body is cancelled, not consumed
  });

  it('still attempts the bounded flow for small images with unknown size', async () => {
    currentResponse = makeResponse({ 'Content-Length': String(64 * 1024) }, new ArrayBuffer(64));
    const { ensureThumbnailForImage } = await import('./thumbnail');
    // The downstream pipeline is mocked thin (arrayBuffer throws through the
    // fake decrypt path) — what this pins is that the GATE passes the small
    // source through to the flow instead of refusing it.
    const ok = await ensureThumbnailForImage(
      'file-small',
      'small.jpg',
      null,
      null,
      'image/jpeg',
      async () => new Uint8Array(32),
    ).catch(() => false);
    expect(calls.downloadFile).toBe(1);
    expect(calls.arrayBuffer).toBe(1);    // small body IS consumed
    expect(typeof ok).toBe('boolean');
  });
});
