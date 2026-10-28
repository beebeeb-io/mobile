/**
 * Incoming-share name decryption for the Shared tab (task 2263).
 *
 * Every row in "With me" read "Encrypted file": the invite's
 * `file_name_encrypted` is the file's metadata envelope, encrypted under the
 * FILE key, and the recipient never derived that key. Web does it in
 * repos/web/src/pages/shared.tsx ("Decrypt filenames for 'With me' tab"):
 *
 *   my X25519 private (from the master key)
 *     + invite.sender_public_key        → shared secret
 *     + file_id bytes                   → share key   (HKDF, core `derive_share_key`)
 *     decrypt invite.encrypted_file_key under the share key → FILE key
 *     read the name with core's file-key reader (`decrypt_name_metadata_with_key`)
 *
 * Same steps here, every crypto operation through a native/core call — this
 * module holds no cryptographic code. Pure and dependency-injected so it is
 * unit-testable without the native module.
 *
 * Failure is honest: a name that does not open returns null and the caller
 * shows "Can't show this name" (never ciphertext, never a mojibake name).
 */
import type { ShareInvite } from './api';

/** Shown when an encrypted name cannot be opened with this device's keys. */
export const NAME_UNAVAILABLE = "Can't show this name";

export interface IncomingShareCrypto {
  /** X25519 secret scalar for this account, derived natively from the master-key handle. */
  deriveX25519Private: () => Promise<Uint8Array>;
  /** core `x25519_shared_secret`. */
  x25519SharedSecret: (myPrivate: Uint8Array, theirPublic: Uint8Array) => Promise<Uint8Array>;
  /** core `derive_share_key` (HKDF-SHA256, info = file id bytes). */
  deriveShareKey: (sharedSecret: Uint8Array, fileId: Uint8Array) => Promise<Uint8Array>;
  /** Generic AES-256-GCM open, for the wrapped file key (core `decrypt_chunk`). */
  decryptChunk: (key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<Uint8Array>;
  /** core `FileKeyHandle::decrypt_name_metadata` — name subkey first, legacy raw key second. */
  decryptNameWithKey: (
    fileKey: Uint8Array,
    nameEncrypted: string,
  ) => Promise<{ name: string | null; mimeType: string | null }>;
}

export interface DecryptedInviteName {
  name: string;
  mimeType: string | null;
}

/** Standard base64 (the server's wire format) → bytes. */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** ASCII bytes of the canonical file-id string (what the sender keyed the wrap with). */
function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i);
  return bytes;
}

/**
 * Decrypt one incoming invite's name. Returns null when there is nothing to
 * decrypt from, the material is incomplete, or the name does not authenticate
 * under the derived file key.
 */
export async function decryptIncomingShareName(
  invite: ShareInvite,
  crypto: IncomingShareCrypto,
): Promise<DecryptedInviteName | null> {
  const raw = invite.file_name_encrypted;
  if (!raw) return null;

  // Legacy plaintext name (stored before names were encrypted): nothing to open.
  if (!raw.startsWith('{')) {
    const name = raw.trim();
    return name ? { name, mimeType: null } : null;
  }

  const senderPublicKey = invite.sender_public_key;
  const wrappedFileKey = invite.encrypted_file_key;
  if (!senderPublicKey || !wrappedFileKey) return null;

  let privateKey: Uint8Array | null = null;
  let sharedSecret: Uint8Array | null = null;
  let shareKey: Uint8Array | null = null;
  let fileKey: Uint8Array | null = null;
  try {
    const wrapped = base64ToBytes(wrappedFileKey);
    // nonce(12) || AES-256-GCM ciphertext(32 + 16 tag) — the sender's wrap layout.
    if (wrapped.length < 13) return null;

    privateKey = await crypto.deriveX25519Private();
    sharedSecret = await crypto.x25519SharedSecret(privateKey, base64ToBytes(senderPublicKey));
    shareKey = await crypto.deriveShareKey(sharedSecret, asciiBytes(invite.file_id));
    fileKey = await crypto.decryptChunk(shareKey, wrapped.slice(0, 12), wrapped.slice(12));
    if (fileKey.length !== 32) return null;

    const meta = await crypto.decryptNameWithKey(fileKey, raw);
    const name = meta.name?.trim();
    if (!name) return null;
    return { name, mimeType: meta.mimeType ?? null };
  } catch {
    return null;
  } finally {
    privateKey?.fill(0);
    sharedSecret?.fill(0);
    shareKey?.fill(0);
    fileKey?.fill(0);
  }
}

/**
 * What an invite row shows. `decrypted` is the result of
 * [`decryptIncomingShareName`] for this invite (undefined while it is still
 * being derived). An encrypted name we cannot open says so honestly.
 */
export function displayIncomingInviteName(
  invite: ShareInvite,
  decrypted: DecryptedInviteName | null | undefined,
): string {
  if (decrypted?.name) return decrypted.name;
  const raw = invite.file_name_encrypted;
  if (!raw) return invite.is_folder || invite.is_folder_share ? 'Shared folder' : 'Shared file';
  if (!raw.startsWith('{')) {
    return raw.length > 28 ? raw.slice(0, 24) + '...' : raw;
  }
  return NAME_UNAVAILABLE;
}
