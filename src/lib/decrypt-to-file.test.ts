// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../../modules/beebeeb-crypto', () => ({}));

const {
  DecryptToFileUnavailableError,
  __setDecryptToFileBridgeForTest,
  decryptChunksToFile,
  isDecryptToFileReady,
  sliceEncryptedBody,
} = await import('./decrypt-to-file');

const NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

function makeEncryptedBody(chunkCount: number, sizeBytes: number, chunkSize: number): Uint8Array {
  let total = 0;
  for (let i = 0; i < chunkCount; i++) {
    const isLast = i === chunkCount - 1;
    const plaintext = chunkCount === 1
      ? sizeBytes
      : isLast ? sizeBytes - i * chunkSize : chunkSize;
    total += NONCE_LENGTH + plaintext + GCM_TAG_LENGTH;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunkCount; i++) {
    const isLast = i === chunkCount - 1;
    const plaintext = chunkCount === 1
      ? sizeBytes
      : isLast ? sizeBytes - i * chunkSize : chunkSize;
    for (let n = 0; n < NONCE_LENGTH; n++) out[offset + n] = i;
    offset += NONCE_LENGTH;
    for (let c = 0; c < plaintext + GCM_TAG_LENGTH; c++) {
      out[offset + c] = 0x80 | i;
    }
    offset += plaintext + GCM_TAG_LENGTH;
  }
  return out;
}

describe('sliceEncryptedBody (fallback-path helper)', () => {
  test('produces one chunk for chunkCount=1', () => {
    const body = makeEncryptedBody(1, 1000, 4 * 1024 * 1024);
    const chunks = sliceEncryptedBody(body, 1, 1000, 4 * 1024 * 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].nonce.length).toBe(NONCE_LENGTH);
    expect(chunks[0].ciphertext.length).toBe(1000 + GCM_TAG_LENGTH);
  });

  test('produces N chunks with correct nonce/ciphertext sizes for uniform split', () => {
    const chunkSize = 4 * 1024 * 1024;
    const sizeBytes = chunkSize * 3;
    const body = makeEncryptedBody(3, sizeBytes, chunkSize);
    const chunks = sliceEncryptedBody(body, 3, sizeBytes, chunkSize);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.nonce.length).toBe(NONCE_LENGTH);
      expect(chunk.ciphertext.length).toBe(chunkSize + GCM_TAG_LENGTH);
    }
  });

  test('last chunk holds the remainder when sizeBytes is not a multiple of chunkSize', () => {
    const chunkSize = 1024;
    const sizeBytes = chunkSize * 2 + 250;
    const body = makeEncryptedBody(3, sizeBytes, chunkSize);
    const chunks = sliceEncryptedBody(body, 3, sizeBytes, chunkSize);
    expect(chunks[0].ciphertext.length).toBe(chunkSize + GCM_TAG_LENGTH);
    expect(chunks[1].ciphertext.length).toBe(chunkSize + GCM_TAG_LENGTH);
    expect(chunks[2].ciphertext.length).toBe(250 + GCM_TAG_LENGTH);
  });

  test('nonce bytes are sliced from the correct offsets (chunk index in nonce)', () => {
    const chunkSize = 1024;
    const sizeBytes = chunkSize * 4;
    const body = makeEncryptedBody(4, sizeBytes, chunkSize);
    const chunks = sliceEncryptedBody(body, 4, sizeBytes, chunkSize);
    for (let i = 0; i < 4; i++) {
      for (let n = 0; n < NONCE_LENGTH; n++) {
        expect(chunks[i].nonce[n]).toBe(i);
      }
    }
  });

  test('throws on invalid chunkCount', () => {
    expect(() => sliceEncryptedBody(new Uint8Array(0), 0, 0, 1024)).toThrow(/invalid chunkCount/);
  });

  test('throws on invalid chunkSize', () => {
    expect(() => sliceEncryptedBody(new Uint8Array(0), 1, 0, 0)).toThrow(/invalid chunkSize/);
  });

  test('throws when the body is shorter than the chunk layout expects', () => {
    expect(() =>
      sliceEncryptedBody(new Uint8Array(10), 1, 100, 4 * 1024 * 1024),
    ).toThrow(/wants \d+ bytes/);
  });

  test('throws when the body has trailing bytes beyond the chunk layout', () => {
    const chunkSize = 100;
    const sizeBytes = 100;
    const body = makeEncryptedBody(1, sizeBytes, chunkSize);
    const padded = new Uint8Array(body.length + 5);
    padded.set(body, 0);
    expect(() => sliceEncryptedBody(padded, 1, sizeBytes, chunkSize)).toThrow(/unread/);
  });
});

describe('decryptChunksToFile adapter (contiguous-body native call)', () => {
  beforeEach(() => {
    __setDecryptToFileBridgeForTest(null);
  });

  afterEach(() => {
    __setDecryptToFileBridgeForTest(null);
  });

  test('isDecryptToFileReady is false when the bridge has not shipped', () => {
    expect(isDecryptToFileReady()).toBe(false);
  });

  test('throws DecryptToFileUnavailableError when the bridge is missing', async () => {
    const fileKey = new Uint8Array(32);
    const body = new Uint8Array(NONCE_LENGTH + 10 + GCM_TAG_LENGTH);
    await expect(decryptChunksToFile(fileKey, body, 10, '/tmp/out')).rejects.toBeInstanceOf(
      DecryptToFileUnavailableError,
    );
  });

  test('isDecryptToFileReady flips to true when the bridge is injected', () => {
    __setDecryptToFileBridgeForTest({
      decryptContiguousToFile: async () => 0,
    });
    expect(isDecryptToFileReady()).toBe(true);
  });

  test('calls the native bridge with the agreed argument shape (fileKey, body, chunkSize, path)', async () => {
    const spy = mock(async () => 12_345);
    __setDecryptToFileBridgeForTest({ decryptContiguousToFile: spy });
    const fileKey = new Uint8Array(32).fill(0xaa);
    const body = makeEncryptedBody(2, 200, 100);
    const written = await decryptChunksToFile(fileKey, body, 100, '/tmp/decrypted.bin');
    expect(written).toBe(12_345);
    expect(spy).toHaveBeenCalledTimes(1);
    const call = (spy as any).mock.calls[0];
    expect(call[0]).toBe(fileKey);
    expect(call[1]).toBe(body);
    expect(call[2]).toBe(100);
    expect(call[3]).toBe('/tmp/decrypted.bin');
  });

  test('rejects when fileKey is not exactly 32 bytes', async () => {
    __setDecryptToFileBridgeForTest({ decryptContiguousToFile: async () => 0 });
    const tooShort = new Uint8Array(16);
    const body = new Uint8Array(NONCE_LENGTH + 10 + GCM_TAG_LENGTH);
    await expect(decryptChunksToFile(tooShort, body, 10, '/tmp/out')).rejects.toThrow(/32-byte fileKey/);
  });

  test('rejects when the body is empty', async () => {
    __setDecryptToFileBridgeForTest({ decryptContiguousToFile: async () => 0 });
    const fileKey = new Uint8Array(32);
    await expect(decryptChunksToFile(fileKey, new Uint8Array(0), 10, '/tmp/out')).rejects.toThrow(/body is empty/);
  });

  test('rejects when chunkSize is not a positive integer', async () => {
    __setDecryptToFileBridgeForTest({ decryptContiguousToFile: async () => 0 });
    const fileKey = new Uint8Array(32);
    const body = new Uint8Array(NONCE_LENGTH + 10 + GCM_TAG_LENGTH);
    await expect(decryptChunksToFile(fileKey, body, 0, '/tmp/out')).rejects.toThrow(/chunkSize must be a positive integer/);
    await expect(decryptChunksToFile(fileKey, body, 10.5, '/tmp/out')).rejects.toThrow(/positive integer/);
  });

  test('propagates native errors verbatim', async () => {
    const failing = mock(async () => {
      throw new Error('GCM auth tag mismatch on chunk 17');
    });
    __setDecryptToFileBridgeForTest({ decryptContiguousToFile: failing });
    const fileKey = new Uint8Array(32);
    const body = new Uint8Array(NONCE_LENGTH + 10 + GCM_TAG_LENGTH);
    await expect(decryptChunksToFile(fileKey, body, 10, '/tmp/out')).rejects.toThrow(/auth tag mismatch/);
  });
});
