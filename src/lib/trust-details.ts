/**
 * Copy for the "Encryption details" sheet (TrustDetailsSheet) — task 1591,
 * bug 5. Pure so the wording is pinned by tests.
 *
 * Key source — what repos/core actually does (beebeeb-core/src/kdf.rs,
 * `derive_file_key`): every file gets its own 32-byte AES-256-GCM key,
 * derived with HKDF-SHA256 from your master key and the file's ID
 * (info = "beebeeb-file-key-v1" || file_id). The old label, "Derived from
 * file ID", read as if the file ID alone were the key material — it is only
 * the per-file domain separator; the secret input is the master key.
 * File-request uploads (0643) are the exception: the sender's browser picks a
 * random content key and seals it to the request's X25519 key
 * (src/lib/file-request-crypto.ts), so they say that instead.
 *
 * Encrypted on — the server keeps no record of WHICH client encrypted a file,
 * so the sheet used to print THIS device's name ("bb-shots") for every file,
 * including files another client uploaded. It now states what is true of
 * every file: it was encrypted on the uploading device before upload.
 */

import type { FileEntry } from './api';
import { isRequestUpload } from './file-request-crypto';

type TrustFile = Pick<FileEntry, 'file_request_id' | 'sender_ephemeral_pubkey' | 'wrapped_content_key'>;

export function trustKeySourceLabel(file: TrustFile): string {
  if (isRequestUpload(file)) {
    return 'Random per-file key, sealed to your file request key';
  }
  return 'Per-file key, derived from your master key (HKDF-SHA256)';
}

export const TRUST_ENCRYPTED_ON_LABEL = 'Encrypted on';

export function trustEncryptedOnValue(file: TrustFile): string {
  if (isRequestUpload(file)) return "The sender's device, before upload";
  return 'Your device, before upload';
}
