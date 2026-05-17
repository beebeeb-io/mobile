import { Platform } from 'react-native';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import type { FileProviderDomainRegistrationResult } from '../../modules/beebeeb-crypto/src/BeebeebCrypto.types';
import type { FileProviderCacheEntry } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';
import { getApiUrl, getToken, listFiles } from './api';
import type { FileEntry } from './api';
import { encryptedMetadataPayloadToBytes } from './encrypted-metadata';
import { requestDeviceOwnerAuth } from './device-owner-auth';
import { wasRecentlyUnlocked } from './lock-state';

export async function mountTrustedFileProvider(): Promise<FileProviderDomainRegistrationResult> {
  if (Platform.OS !== 'ios') {
    return {
      supported: false,
      identifier: 'io.beebeeb.files',
      displayName: 'Beebeeb',
      registered: false,
      added: false,
      removedBeforeAdd: false,
      domainCount: 0,
      rootEnumerationSignaled: false,
      workingSetEnumerationSignaled: false,
    };
  }

  // Skip the device-owner auth prompt if the user just authenticated via
  // BiometricLockScreen. Without this guard, returning from background could
  // trigger a second Face ID prompt when the File Provider mount runs.
  if (!wasRecentlyUnlocked()) {
    const auth = await requestDeviceOwnerAuth('Mount Beebeeb in Files', {
      unavailable: 'Set up Face ID or an iPhone passcode before mounting Beebeeb in Files.',
      cancelled: 'Authentication cancelled. Beebeeb was not mounted in Files.',
      failed: 'Authentication failed. Beebeeb was not mounted in Files.',
    });
    if (!auth.ok) {
      throw new Error(auth.message);
    }
  }

  const token = await getToken();
  if (!token) {
    throw new Error('Sign in before mounting Beebeeb in Files.');
  }

  await BeebeebCrypto.mirrorSessionToAppGroup(token, getApiUrl());
  return BeebeebCrypto.mountFileProviderAccess();
}

export async function removeTrustedFileProvider(): Promise<FileProviderDomainRegistrationResult> {
  return BeebeebCrypto.removeFileProviderAccess();
}

/**
 * Push pre-decrypted file entries into the File Provider's shared SQLite cache
 * so the iOS Files app can display real filenames instead of "Encrypted file".
 *
 * Call this after the main app has fetched + decrypted a directory listing.
 * The native side upserts rows and signals the File Provider to re-enumerate.
 */
export async function syncDecryptedEntriesToFileProvider(
  files: FileEntry[],
  decryptedNames: Record<string, string>,
): Promise<number> {
  if (Platform.OS !== 'ios') return 0;

  const entries: FileProviderCacheEntry[] = files.map((f) => ({
    id: f.id,
    parent_id: f.parent_id ?? null,
    name_encrypted: f.name_encrypted ?? null,
    name_decrypted: decryptedNames[f.id] ?? null,
    mime_type: f.mime_type ?? null,
    size_bytes: f.size_bytes ?? 0,
    is_folder: f.is_folder ?? false,
    created_at: f.created_at ?? null,
    updated_at: f.updated_at ?? null,
  }));

  return BeebeebCrypto.syncFileProviderCache(entries);
}

/**
 * Parse decrypted metadata plaintext. The server stores filename as either a
 * bare string (legacy) or as `{"name":"...", "mime_type":"..."}` (current).
 */
function parseDecryptedName(plaintext: string): string {
  try {
    const metadata = JSON.parse(plaintext) as { name?: unknown };
    if (metadata && typeof metadata === 'object' && typeof metadata.name === 'string') {
      const name = metadata.name.trim();
      if (name) return name;
    }
  } catch {
    // Legacy format: plaintext is the bare filename.
  }
  return plaintext || '';
}

/**
 * Fetch a directory listing, decrypt all names, and push the result into the
 * File Provider cache. Used during mount and as a periodic refresh.
 */
export async function populateFileProviderCache(
  decryptMetadata: (fileId: string, nonce: Uint8Array, ct: Uint8Array) => Promise<string>,
): Promise<number> {
  if (Platform.OS !== 'ios') return 0;
  try {
    const rootFiles = await listFiles();
    const decryptedNames: Record<string, string> = {};

    await Promise.all(
      rootFiles.map(async (file) => {
        try {
          const raw = file.name_encrypted ?? '';
          if (!raw.startsWith('{')) {
            if (raw && raw.length < 200) decryptedNames[file.id] = raw;
            return;
          }
          const payload = encryptedMetadataPayloadToBytes(raw);
          if (!payload) return;
          const plaintext = await decryptMetadata(file.id, payload.nonce, payload.ciphertext);
          const name = parseDecryptedName(plaintext);
          if (name) decryptedNames[file.id] = name;
        } catch {
          // Decryption failure for this entry — skip
        }
      }),
    );

    return syncDecryptedEntriesToFileProvider(rootFiles, decryptedNames);
  } catch {
    // Network or API failure — non-fatal, the cache still has old data
    return 0;
  }
}
