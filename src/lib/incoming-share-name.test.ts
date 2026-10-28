// @ts-nocheck
// Task 2263 — the mobile Shared tab never decrypted an incoming share's name,
// so every "With me" row read "Encrypted file". Web's shared-with-me list
// (repos/web/src/pages/shared.tsx, "Decrypt filenames for 'With me' tab")
// derives the file key from the sender's X25519 public key and the invite's
// wrapped file key, then reads the name with core's FILE-KEY reader.
//
// These tests feed the REAL wire shapes (60-byte nonce||AES-GCM wrapped file
// key, `{cipher_suite, nonce, ciphertext}` name envelope) and use WebCrypto
// AES-GCM as the stand-in for the native primitives (same 12-byte nonce,
// ciphertext||16-byte tag). `decryptNameWithKey` stands in for core's
// `FileKeyHandle.decryptNameMetadata`.
import { describe, expect, test } from 'bun:test';
import type { ShareInvite } from './api';
import {
  decryptIncomingShareName,
  displayIncomingInviteName,
  NAME_UNAVAILABLE,
  type IncomingShareCrypto,
} from './incoming-share-name';

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

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const FILE_ID = '9d1c0a1e-0000-4000-8000-000000000226';
const SHARE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const FILE_KEY = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const SENDER_PUB = Uint8Array.from({ length: 32 }, (_, i) => 7 + i);

/** Exactly what `encryptFileKeyForRecipient` writes: nonce(12)||ciphertext(48). */
async function wrapFileKey(shareKey: Uint8Array, fileKey: Uint8Array): Promise<string> {
  const { nonce, ct } = await aesGcmEncrypt(shareKey, fileKey);
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, nonce.length);
  return b64(blob);
}

async function nameEnvelope(fileKey: Uint8Array, name: string, mime: string | null = null): Promise<string> {
  const payload = JSON.stringify(mime ? { name, mime_type: mime } : { name });
  const { nonce, ct } = await aesGcmEncrypt(fileKey, new TextEncoder().encode(payload));
  return JSON.stringify({ cipher_suite: 'V1Aes256Gcm', nonce: Array.from(nonce), ciphertext: Array.from(ct) });
}

function makeCrypto(overrides: Partial<IncomingShareCrypto> = {}): IncomingShareCrypto {
  return {
    deriveX25519Private: async () => SENDER_PUB.slice(),
    x25519SharedSecret: async () => Uint8Array.from({ length: 32 }, (_, i) => 3),
    deriveShareKey: async () => SHARE_KEY.slice(),
    decryptChunk: aesGcmDecrypt,
    decryptNameWithKey: async (fileKey, envelope) => {
      const parsed = JSON.parse(envelope);
      const pt = await aesGcmDecrypt(fileKey, Uint8Array.from(parsed.nonce), Uint8Array.from(parsed.ciphertext));
      const meta = JSON.parse(new TextDecoder().decode(pt));
      return { name: typeof meta.name === 'string' ? meta.name : null, mimeType: meta.mime_type ?? null };
    },
    ...overrides,
  };
}

async function invite(overrides: Partial<ShareInvite> = {}): Promise<ShareInvite> {
  return {
    id: 'invite-1',
    file_id: FILE_ID,
    sender_id: 'sender',
    recipient_email: 'me@example.com',
    status: 'approved',
    created_at: '2026-10-28T00:00:00Z',
    file_name_encrypted: await nameEnvelope(FILE_KEY, 'Q3 report.pdf', 'application/pdf'),
    sender_public_key: b64(SENDER_PUB),
    encrypted_file_key: await wrapFileKey(SHARE_KEY, FILE_KEY),
    ...overrides,
  };
}

describe('decryptIncomingShareName (task 2263)', () => {
  test('an incoming share name opens with the ECDH-unwrapped file key', async () => {
    const row = await invite();
    const got = await decryptIncomingShareName(row, makeCrypto());
    expect(got).toEqual({ name: 'Q3 report.pdf', mimeType: 'application/pdf' });
  });

  test('a tampered name envelope returns null, never ciphertext', async () => {
    const otherKey = Uint8Array.from({ length: 32 }, (_, i) => 55 + i);
    const row = await invite({ file_name_encrypted: await nameEnvelope(otherKey, 'Q3 report.pdf') });
    expect(await decryptIncomingShareName(row, makeCrypto())).toBeNull();
  });

  test('a tampered wrapped file key returns null', async () => {
    const row = await invite({ encrypted_file_key: await wrapFileKey(SHARE_KEY, Uint8Array.from({ length: 32 }, (_, i) => 1 + i)) });
    expect(await decryptIncomingShareName(row, makeCrypto())).toBeNull();
  });

  test('no sender public key or wrapped file key returns null', async () => {
    expect(await decryptIncomingShareName(await invite({ sender_public_key: undefined }), makeCrypto())).toBeNull();
    expect(await decryptIncomingShareName(await invite({ encrypted_file_key: undefined }), makeCrypto())).toBeNull();
  });

  test('a legacy plaintext name is shown as-is (no key material needed)', async () => {
    const row = await invite({ file_name_encrypted: 'old report.pdf', sender_public_key: undefined, encrypted_file_key: undefined });
    expect(await decryptIncomingShareName(row, makeCrypto())).toEqual({ name: 'old report.pdf', mimeType: null });
  });

  test('the file id is the ASCII uuid the sender keyed the wrap with', async () => {
    const seen: string[] = [];
    const crypto = makeCrypto({
      deriveShareKey: async (_ss, fileIdBytes) => {
        seen.push(new TextDecoder().decode(fileIdBytes));
        return SHARE_KEY.slice();
      },
    });
    await decryptIncomingShareName(await invite(), crypto);
    expect(seen).toEqual([FILE_ID]);
  });
});

describe('displayIncomingInviteName (task 2263)', () => {
  test('shows the decrypted name', async () => {
    expect(displayIncomingInviteName(await invite(), { name: 'Q3 report.pdf', mimeType: null })).toBe('Q3 report.pdf');
  });

  test('a name that fails to open says so honestly, never "Encrypted file"', async () => {
    expect(displayIncomingInviteName(await invite(), null)).toBe(NAME_UNAVAILABLE);
    expect(NAME_UNAVAILABLE).toBe("Can't show this name");
  });

  test('a plaintext legacy name still shows', async () => {
    expect(displayIncomingInviteName(await invite({ file_name_encrypted: 'old report.pdf' }), null)).toBe('old report.pdf');
  });
});
