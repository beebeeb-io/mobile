// @ts-nocheck
// Flow "iOS core journeys" issue: the in-app shared view never showed the
// filename, and "Decrypt & save" wrote an extension-less
// `shared_<token>_shared_<token>` file. Cause: SharedViewScreen read
// `info.file_name_encrypted`, but the server's GET /shares/:token and
// POST /shares/:token/verify responses carry `name_encrypted`
// (repos/server/beebeeb-api/src/routes/shares.rs, both json! bodies), and the
// name was never decrypted with the file key the way web share-view does.
//
// These tests feed the REAL server shape (a `name_encrypted` JSON envelope
// produced with AES-256-GCM under a known key) and use WebCrypto AES-GCM as
// the stand-in for the native decryptChunk/decryptMetadata (the same
// primitive beebeeb-core uses: 12-byte nonce, ciphertext || 16-byte tag).
import { describe, expect, test } from 'bun:test';
import type { ShareInfo } from './api';
import {
  decryptShareFileName,
  displayFileName,
  sharedCacheFileName,
  type ShareNameCrypto,
} from './share-file-name';

const subtle = globalThis.crypto.subtle;

async function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<{ nonce: Uint8Array; ct: Uint8Array }> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, plaintext));
  return { nonce, ct };
}

async function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
}

const webCrypto: ShareNameCrypto = {
  decryptChunk: aesGcmDecrypt,
  decryptMetadata: async (key, nonce, ct) => new TextDecoder().decode(await aesGcmDecrypt(key, nonce, ct)),
};

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The envelope the mobile/web upload paths write into files.name_encrypted. */
async function nameEnvelope(fileKey: Uint8Array, plaintext: string, arrays = true): Promise<string> {
  const { nonce, ct } = await aesGcmEncrypt(fileKey, new TextEncoder().encode(plaintext));
  return JSON.stringify({
    cipher_suite: 'V1Aes256Gcm',
    nonce: arrays ? Array.from(nonce) : b64(nonce),
    ciphertext: arrays ? Array.from(ct) : b64(ct),
  });
}

const TOKEN = '9lQsAbCdEfGh';
const META = JSON.stringify({ name: 'flow5-photo-a.jpeg', mime_type: 'image/jpeg' });

describe('shared-file name from the real server shape', () => {
  test('standard share: name_encrypted + #key= file key -> flow5-photo-a.jpeg', async () => {
    const fileKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    // Exact key set of POST /api/v1/shares/:token/verify (shares.rs).
    const info = {
      id: 'share-id',
      share_type: 'file',
      name_encrypted: await nameEnvelope(fileKey, META),
      size_bytes: 22_000,
      expires_at: null,
      max_opens: null,
      open_count: 1,
      created_at: '2026-09-25T00:00:00Z',
      double_encrypted: false,
      wrapped_file_key: null,
    } as unknown as ShareInfo;

    const decrypted = await decryptShareFileName(info, b64(fileKey), webCrypto);
    expect(displayFileName(info, decrypted)).toBe('flow5-photo-a.jpeg');
    expect(decrypted?.mimeType).toBe('image/jpeg');
    expect(sharedCacheFileName(info, decrypted, TOKEN)).toBe(`shared_${TOKEN}_flow5-photo-a.jpeg`);
  });

  test('double-encrypted share: unwraps wrapped_file_key with K_c from a base64url fragment', async () => {
    const fileKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const kc = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await aesGcmEncrypt(kc, fileKey);
    const blob = new Uint8Array(12 + wrapped.ct.length);
    blob.set(wrapped.nonce, 0);
    blob.set(wrapped.ct, 12);
    const info = {
      share_type: 'file',
      name_encrypted: await nameEnvelope(fileKey, META, false),
      double_encrypted: true,
      wrapped_file_key: b64(blob),
    } as unknown as ShareInfo;

    const decrypted = await decryptShareFileName(info, b64url(kc), webCrypto);
    expect(displayFileName(info, decrypted)).toBe('flow5-photo-a.jpeg');
  });

  test('legacy metadata (bare filename plaintext, no mime) derives the mime from the extension', async () => {
    const fileKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const info = {
      name_encrypted: await nameEnvelope(fileKey, 'flow5-doc.pdf'),
      double_encrypted: false,
    } as unknown as ShareInfo;

    const decrypted = await decryptShareFileName(info, b64(fileKey), webCrypto);
    expect(decrypted).toEqual({ name: 'flow5-doc.pdf', mimeType: 'application/pdf' });
  });

  test('the old `file_name_encrypted` field is still honoured as a fallback', async () => {
    const fileKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const info = {
      file_name_encrypted: await nameEnvelope(fileKey, META),
    } as unknown as ShareInfo;

    const decrypted = await decryptShareFileName(info, b64(fileKey), webCrypto);
    expect(displayFileName(info, decrypted)).toBe('flow5-photo-a.jpeg');
  });

  test('wrong key: no crash, honest placeholder, and the cache name never doubles the token', async () => {
    const fileKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const other = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const info = { name_encrypted: await nameEnvelope(fileKey, META) } as unknown as ShareInfo;

    const decrypted = await decryptShareFileName(info, b64(other), webCrypto);
    expect(decrypted).toBeNull();
    expect(displayFileName(info, decrypted)).toBe('Encrypted file');
    expect(sharedCacheFileName(info, decrypted, TOKEN)).toBe(`shared_${TOKEN}`);
  });
});
