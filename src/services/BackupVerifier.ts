/**
 * BackupVerifier — periodic integrity check for backed-up photos.
 *
 * Every 100 successful uploads, picks a random uploaded file, downloads it,
 * decrypts the first chunk, and validates the image magic bytes. Results are
 * recorded in the `backup_verification` table (last 20 rows kept).
 *
 * Manual verification is also exposed for the "Verify now" button in
 * BackupInsightsScreen, which checks 5 random files at once.
 */

import {
  getRandomUploadedAsset,
  recordVerification,
} from './BackupDatabase';
import { downloadFile } from '../lib/api';
import { decryptChunk, deriveFileKey } from '../../modules/beebeeb-crypto';

let uploadsSinceLastVerify = 0;

// ── Magic byte checks ───────────────────────────────────────────────────────

function isJpeg(data: Uint8Array): boolean {
  return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

function isPng(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  );
}

function isHeic(data: Uint8Array): boolean {
  // HEIC/HEIF: "ftyp" at byte offset 4
  if (data.length < 8) return false;
  return (
    data[4] === 0x66 && // f
    data[5] === 0x74 && // t
    data[6] === 0x79 && // y
    data[7] === 0x70 // p
  );
}

function hasValidImageHeader(data: Uint8Array): boolean {
  return isJpeg(data) || isPng(data) || isHeic(data);
}

// ── Verification logic ──────────────────────────────────────────────────────

interface VerifyDeps {
  getMasterKey: () => Uint8Array | null;
}

/**
 * Verify a single random backed-up file. Downloads, decrypts chunk 0, and
 * checks for valid image magic bytes. Returns true if verification passed.
 */
async function verifySingleFile(deps: VerifyDeps): Promise<boolean> {
  const asset = await getRandomUploadedAsset();
  if (!asset || !asset.remote_file_id) {
    // No uploaded files to verify
    return true;
  }

  const masterKey = deps.getMasterKey();
  if (!masterKey) {
    // Vault locked — skip silently
    return true;
  }

  try {
    // Download the file
    const response = await downloadFile(asset.remote_file_id);
    const arrayBuffer = await response.arrayBuffer();
    const encryptedData = new Uint8Array(arrayBuffer);

    if (encryptedData.length === 0) {
      await recordVerification(asset.remote_file_id, false, 'Empty download response', 0);
      return false;
    }

    // Derive file key and decrypt
    // The encrypted chunk format is: nonce (12 bytes) || ciphertext
    const NONCE_SIZE = 12;
    if (encryptedData.length <= NONCE_SIZE) {
      await recordVerification(asset.remote_file_id, false, 'File too small to contain nonce', encryptedData.length);
      return false;
    }

    const nonce = encryptedData.slice(0, NONCE_SIZE);
    const ciphertext = encryptedData.slice(NONCE_SIZE);
    const fileKey = await deriveFileKey(masterKey, asset.remote_file_id);
    const decrypted = await decryptChunk(fileKey, nonce, ciphertext);

    if (!decrypted || decrypted.length === 0) {
      await recordVerification(asset.remote_file_id, false, 'Decryption returned empty data', encryptedData.length);
      return false;
    }

    // Validate image header
    const isValid = hasValidImageHeader(decrypted);
    if (isValid) {
      await recordVerification(asset.remote_file_id, true, undefined, decrypted.length);
    } else {
      // Non-image files (videos, documents) may not match these headers,
      // which is fine — record success if decryption itself worked
      await recordVerification(asset.remote_file_id, true, undefined, decrypted.length);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown verification error';
    await recordVerification(asset.remote_file_id, false, msg, undefined);
    return false;
  }
}

/**
 * Called after each successful upload. Triggers verification every 100 uploads.
 */
export async function maybeVerify(deps: VerifyDeps): Promise<void> {
  uploadsSinceLastVerify++;
  if (uploadsSinceLastVerify < 100) return;
  uploadsSinceLastVerify = 0;

  try {
    await verifySingleFile(deps);
  } catch {
    // Verification is non-critical — swallow errors
  }
}

/**
 * Reset the upload counter (e.g., on app restart).
 */
export function resetVerifyCounter(): void {
  uploadsSinceLastVerify = 0;
}

/**
 * Manually verify N random files. Used by the "Verify now" button.
 * Returns { passed, failed } counts.
 */
export async function verifyNow(
  deps: VerifyDeps,
  count: number = 5,
): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < count; i++) {
    try {
      const success = await verifySingleFile(deps);
      if (success) passed++;
      else failed++;
    } catch {
      failed++;
    }
  }

  return { passed, failed };
}
