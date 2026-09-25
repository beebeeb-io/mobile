/**
 * Shared-file name + file-key resolution for the in-app share view
 * (SharedViewScreen). Pure and dependency-injected so it is unit-testable
 * without the native crypto module.
 *
 * The server's public share responses (GET /api/v1/shares/:token and
 * POST /api/v1/shares/:token/verify, repos/server/beebeeb-api/src/routes/
 * shares.rs) carry the file's encrypted metadata as `name_encrypted` — the
 * same `{cipher_suite, nonce, ciphertext}` envelope stored in
 * files.name_encrypted, encrypted under the FILE key. The screen used to read
 * `file_name_encrypted` (a field the server never sends) and never decrypted
 * it, so every share rendered "Shared file" and "Decrypt & save" wrote an
 * extension-less `shared_<token>_shared_<token>`. Mirrors the web client's
 * share-view name decryption (repos/web/src/pages/share-view.tsx).
 */
import type { ShareInfo } from './api';
import { encryptedMetadataPayloadToBytes } from './encrypted-metadata';
import { guessMimeType } from './media';

export interface ShareNameCrypto {
  decryptChunk: (key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<Uint8Array>;
  decryptMetadata: (key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<string>;
}

export interface DecryptedShareName {
  name: string;
  mimeType: string | null;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode a key from the URL #key= fragment. The web client emits base64url
 * (URL-safe, unpadded) for double-encrypted shares but standard base64 for
 * legacy links — accept both by normalizing to base64.
 */
export function fragmentKeyToBytes(key: string): Uint8Array {
  let normalized = key.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  if (pad === 2) normalized += '==';
  else if (pad === 3) normalized += '=';
  return base64ToUint8Array(normalized);
}

/**
 * Resolve the per-file AES-256-GCM key from the #key= fragment. For a
 * double-encrypted share the fragment holds K_c, which unwraps
 * `wrapped_file_key` = base64(nonce(12) || ciphertext(file_key + tag)); for a
 * standard share the fragment IS the file key.
 */
export async function resolveShareFileKey(
  info: ShareInfo,
  shareKey: string,
  decryptChunk: ShareNameCrypto['decryptChunk'],
): Promise<Uint8Array> {
  const kcBytes = fragmentKeyToBytes(shareKey);
  if (!info.double_encrypted) return kcBytes;
  if (!info.wrapped_file_key) {
    throw new Error('Double-encrypted share is missing its wrapped key.');
  }
  const wrapped = base64ToUint8Array(info.wrapped_file_key);
  if (wrapped.length < 13) {
    throw new Error('Wrapped key blob is too small to decrypt.');
  }
  return decryptChunk(kcBytes, wrapped.slice(0, 12), wrapped.slice(12));
}

/** The encrypted name as the server sends it; `file_name_encrypted` kept as a fallback. */
export function shareNameEncrypted(info: ShareInfo): string | null {
  return info.name_encrypted ?? info.file_name_encrypted ?? null;
}

function parseMetadataPlaintext(plaintext: string): DecryptedShareName | null {
  let name = plaintext;
  let mimeType: string | null = null;
  try {
    const meta = JSON.parse(plaintext) as { name?: unknown; mime_type?: unknown };
    if (meta && typeof meta === 'object' && typeof meta.name === 'string') {
      name = meta.name;
      if (typeof meta.mime_type === 'string' && meta.mime_type) mimeType = meta.mime_type;
    }
  } catch {
    // Legacy metadata: the plaintext is the bare filename.
  }
  name = name.trim();
  if (!name) return null;
  return { name, mimeType: mimeType ?? guessMimeType(name) };
}

/**
 * Decrypt the shared file's name with the resolved file key. Returns null
 * when there is no name, the key does not match, or the envelope is
 * malformed — the caller then shows an honest placeholder.
 */
export async function decryptShareFileName(
  info: ShareInfo,
  shareKey: string,
  crypto: ShareNameCrypto,
): Promise<DecryptedShareName | null> {
  const raw = shareNameEncrypted(info);
  if (!raw) return null;
  if (!raw.startsWith('{')) {
    // Legacy plaintext name stored before names were encrypted.
    return parseMetadataPlaintext(raw);
  }
  const payload = encryptedMetadataPayloadToBytes(raw);
  if (!payload) return null;
  try {
    const fileKey = await resolveShareFileKey(info, shareKey, crypto.decryptChunk);
    const plaintext = await crypto.decryptMetadata(fileKey, payload.nonce, payload.ciphertext);
    return parseMetadataPlaintext(plaintext);
  } catch {
    return null;
  }
}

export function displayFileName(info: ShareInfo, decrypted: DecryptedShareName | null): string {
  if (decrypted) return decrypted.name;
  const raw = shareNameEncrypted(info);
  if (!raw) return info.is_folder ? 'Shared folder' : 'Shared file';
  if (raw.startsWith('{')) return info.is_folder ? 'Encrypted folder' : 'Encrypted file';
  if (raw.length > 48) return raw.slice(0, 40) + '...';
  return raw;
}

/** Sanitise a basename so it survives the fs cache path; keeps the extension. */
function safeBasename(name: string): string {
  const cleaned = name.trim().replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  if (cleaned.length <= 64) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 64 - ext.length) + ext;
}

/**
 * Cache filename for the decrypted plaintext: `shared_<token>_<name.ext>`, or
 * just `shared_<token>` when the name could not be decrypted (never the old
 * doubled `shared_<token>_shared_<token>`). The token prefix keeps two shares
 * of equally-named files apart.
 */
export function sharedCacheFileName(
  _info: ShareInfo,
  decrypted: DecryptedShareName | null,
  token: string,
): string {
  const base = decrypted ? safeBasename(decrypted.name) : '';
  return base ? `shared_${token}_${base}` : `shared_${token}`;
}
