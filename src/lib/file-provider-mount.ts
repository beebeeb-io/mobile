import { sharedFileKeyIsLoaded } from './shared-folder-keys';
import { Platform } from 'react-native';
// Namespace import on purpose: a test that mocks `react-native` with `Platform` alone must still load this file.
import * as ReactNative from 'react-native';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import type { FileProviderDomainRegistrationResult } from '../../modules/beebeeb-crypto/src/BeebeebCrypto.types';
import type { BatchNameItem, BatchNameResult, FileProviderCacheEntry } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';
import { getApiUrl, getToken, listAllFiles } from './api';
import type { FileEntry } from './api';
import { encryptedMetadataPayloadToBytes } from './encrypted-metadata';
import { requestDeviceOwnerAuth } from './device-owner-auth';
import { wasRecentlyUnlocked } from './lock-state';
import { mapInBatches } from './async-batch';
import { decryptNamesInBackground } from './background-name-decrypt';
import { isPlaintextGateClosed, plaintextGate, withPlaintextLease } from './plaintext-gate';
import { createDeferredCacheWrites, type CacheWrite } from './file-provider-cache-write';
import { accountEpoch, isCurrentAccountEpoch, onAccountEpochAdvance } from './account-epoch';

/**
 * One write to the File Provider cache, as data. Resolves the rows written, or
 * `'not_now'` when the native side refused (no background time left, LD-0002
 * round 2). Reads the write's fields when it calls native, so a `supersede` that
 * trimmed a queued write before this call is honoured.
 */
async function performCacheWrite(write: CacheWrite): Promise<number | 'not_now'> {
  if (write.kind === 'sync') {
    if (write.entries.length === 0 && !(write.prune && (write.pruneParents?.length ?? 0) > 0)) return 0;
    // A fresh lease per attempt: an attempt that runs after a sign-out finds the plaintext gate closed.
    return withPlaintextLease('file provider cache push', async (lease) => {
      lease.assertValid();
      const result = await BeebeebCrypto.syncFileProviderCache(write.entries, write.prune, write.pruneParents);
      return result.status === 'not_now' ? 'not_now' : result.count;
    });
  }
  if (write.kind === 'remove') {
    if (write.ids.length === 0) return 0;
    const result = await BeebeebCrypto.removeFileProviderEntries(write.ids);
    return result.status === 'not_now' ? 'not_now' : result.count;
  }
  const result = await BeebeebCrypto.setFileProviderProtectedFolder(write.id);
  return result.status === 'not_now' ? 'not_now' : result.count;
}

/**
 * Writes the native side refused because the app's background time had ended
 * (LD-0002 round 2, `file-provider-cache-write.ts`): run again, in order, the
 * next time the app is foreground, or by backoff while it already is. `AppState` is
 * read lazily and defensively so a test that mocks `react-native` with `Platform`
 * only still loads this file.
 */
export const deferredFileProviderCacheWrites = createDeferredCacheWrites({
  run: async (write) => {
    // The account it was made for must still be the signed-in one; otherwise it is obsolete.
    if (!isCurrentAccountEpoch(write.epoch)) return true;
    const written = await performCacheWrite(write);
    if (written === 'not_now') return false;
    if (write.kind === 'sync' && write.trashChanged) await signalFileProviderTrashChanged();
    return true;
  },
  subscribeToForeground: (onForeground) => {
    ReactNative.AppState?.addEventListener?.('change', (state: string) => {
      if (state === 'active') onForeground();
    });
  },
  onOverflow: () => {
    console.warn('[file-provider] deferred cache writes over the cap: the oldest was dropped; the next full listing reconciles');
  },
  isForeground: () => ReactNative.AppState?.currentState === 'active',
  onReplayError: (error) => {
    // A sign-out closed the plaintext gate (the purge emptied the cache; the queued names must not come back), or the native call failed outright.
    if (!isPlaintextGateClosed(error)) console.warn('[file-provider] a deferred cache write failed and was dropped');
  },
});
// A sign-in or sign-out is an account boundary: names queued under the old account must never reach the new account's cache.
onAccountEpochAdvance(() => deferredFileProviderCacheWrites.clear());

type MountTrustedFileProviderOptions = {
  vaultUnlocked?: boolean;
};

export async function signalFileProviderTrashChanged(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    await BeebeebCrypto.signalFileProviderTrashEnumerator();
  } catch {
    // best-effort — the extension's rate-limited refresh also reconciles Trash
  }
}

async function mirrorSessionForFileProvider(): Promise<void> {
  const token = await getToken();
  if (!token) {
    throw new Error('Sign in before mounting Beebeeb in Files.');
  }
  let mirrored = false;
  try {
    mirrored = await BeebeebCrypto.mirrorSessionToAppGroup(token, getApiUrl());
  } catch {
    mirrored = false;
  }
  if (!mirrored) {
    throw new Error('Could not save Beebeeb credentials for Files. Try signing in again, then mount Beebeeb in Files.');
  }
}

export async function registerTrustedFileProviderDomain(): Promise<FileProviderDomainRegistrationResult> {
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
  await mirrorSessionForFileProvider();
  return BeebeebCrypto.registerFileProviderDomain();
}

export async function resetTrustedFileProviderDomain(): Promise<FileProviderDomainRegistrationResult> {
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
  await mirrorSessionForFileProvider();
  return BeebeebCrypto.resetFileProviderDomain();
}

export async function mountTrustedFileProvider(
  options: MountTrustedFileProviderOptions = {},
): Promise<FileProviderDomainRegistrationResult> {
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
  if (!options.vaultUnlocked && !wasRecentlyUnlocked()) {
    const auth = await requestDeviceOwnerAuth('Mount Beebeeb in Files', {
      unavailable: 'Set up Face ID or an iPhone passcode before mounting Beebeeb in Files.',
      cancelled: 'Authentication cancelled. Beebeeb was not mounted in Files.',
      failed: 'Authentication failed. Beebeeb was not mounted in Files.',
    });
    if (!auth.ok) {
      throw new Error(auth.message);
    }
  }

  await mirrorSessionForFileProvider();
  const result = await BeebeebCrypto.mountFileProviderAccess();
  if (result.registered && result.cacheDatabaseReady === false) {
    throw new Error('Beebeeb mounted in iOS, but Files storage is not ready yet. Try again in a moment.');
  }
  return result;
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
 *
 * Task 1593 round 4 — this is the ONE JS call site of the native write
 * (`BeebeebCrypto.syncFileProviderCache`, enforced by
 * `caches-plaintext-registry.test.ts`), so gating it HERE covers every caller
 * (the BFS walk below, FilesScreen's per-folder push, the sync write-through)
 * without each one having to remember to. A purge closing the gate mid-call
 * refuses the write before it reaches native; the resolution is 0 pushed
 * rather than a rejection, since every caller already treats "nothing to
 * sync" as a normal, retryable outcome (the next enumeration reconciles).
 */
export async function syncDecryptedEntriesToFileProvider(
  files: FileEntry[],
  decryptedNames: Record<string, string>,
  parentId?: string | null,
  options: { prune?: boolean; pruneParents?: (string | null)[]; trashChanged?: boolean } = {},
): Promise<number> {
  if (Platform.OS !== 'ios') return 0;

  const entries: FileProviderCacheEntry[] = files.filter(f => !sharedFileKeyIsLoaded(f.id)).map((f) => ({
    id: f.id,
    parent_id: f.parent_id ?? parentId ?? null,
    name_encrypted: f.name_encrypted ?? null,
    name_decrypted: decryptedNames[f.id] ?? null,
    mime_type: f.mime_type ?? null,
    size_bytes: f.size_bytes ?? 0,
    is_folder: f.is_folder ?? false,
    created_at: f.created_at ?? null,
    updated_at: f.updated_at ?? null,
  }));

  // `prune` is only safe when `files` is the COMPLETE listing for `parentId`
  // (every child present). A partial push (e.g. FilesScreen's per-folder
  // decrypted-name refresh) must leave prune off so siblings aren't deleted.
  //
  // `pruneParents` lets the caller name parents that became EMPTY — their
  // complete child set is "no rows", so they contribute nothing to `entries`
  // and would never be pruned/signaled from the per-entry derivation alone.
  // Default to the single `parentId` (when pruning) so an emptied folder still
  // gets its surviving rows deleted; callers that push multiple parents in one
  // batch (e.g. the sync write-through) pass the explicit set.
  const prune = options.prune ?? false;
  const pruneParents = prune
    ? options.pruneParents ?? [parentId ?? null]
    : null;

  // The write as DATA (just its arguments and the account it is for; not `files`, not
  // `decryptedNames`): if it has to wait, this is all that is kept. A newer write
  // supersedes queued older ones that overlap it, at the moment it is ISSUED.
  const write: CacheWrite = {
    kind: 'sync',
    entries,
    prune,
    pruneParents,
    trashChanged: options.trashChanged ?? false,
    epoch: accountEpoch(),
    seq: 0,
  };
  // Stamps the write and trims queued older ones it overlaps; the undo puts them back if this write FAILS.
  const undo = deferredFileProviderCacheWrites.issue(write);

  try {
    const synced = await performCacheWrite(write);
    if (synced === 'not_now') {
      // LD-0002 round 2: no background time left, nothing was written. Queue the
      // same write for the next foreground (or a backoff retry while foreground),
      // minus anything a NEWER write has landed for in the meantime.
      deferredFileProviderCacheWrites.defer(write);
      if (options.trashChanged) {
        await signalFileProviderTrashChanged();
      }
      return 0;
    }
    deferredFileProviderCacheWrites.landed(write);
    if (options.trashChanged) {
      await signalFileProviderTrashChanged();
    }
    return synced;
  } catch (err) {
    undo();
    if (isPlaintextGateClosed(err)) return 0;
    throw err;
  }
}

/**
 * Delete entries from the File Provider cache after a local trash/delete so the
 * iOS Files app drops them immediately. No-op off iOS. Failures are swallowed —
 * the cache self-heals on the next full enumeration.
 */
export async function removeFromFileProviderCache(ids: string[]): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (ids.length === 0) return;
  // Issued now: queued older writes of these ids (a pending upsert of a file that was just trashed) are superseded.
  const write: CacheWrite = { kind: 'remove', ids: [...ids], epoch: accountEpoch(), seq: 0 };
  const undo = deferredFileProviderCacheWrites.issue(write);
  try {
    if ((await performCacheWrite(write)) === 'not_now') {
      // LD-0002 round 2: no background time left, nothing was removed. Run it
      // again later rather than leaving the row in Files; a restore of the same
      // ids in the meantime trims it (issue), so it never removes restored rows.
      deferredFileProviderCacheWrites.defer(write);
    } else {
      deferredFileProviderCacheWrites.landed(write);
    }
  } catch {
    // best-effort — next folder enumeration will reconcile. The queued data trimmed for this write was not superseded.
    undo();
  }
  await signalFileProviderTrashChanged();
}

/**
 * Tell the Files app extension which folder is the protected root "Backups" (null clears it).
 * Best-effort and no-op off iOS: the app still protects the folder itself.
 */
export async function setFileProviderProtectedBackupsRoot(id: string | null): Promise<void> {
  if (Platform.OS !== 'ios') return;
  // Only the latest id matters: issuing this supersedes any queued older one.
  const write: CacheWrite = { kind: 'protected-root', id, epoch: accountEpoch(), seq: 0 };
  const undo = deferredFileProviderCacheWrites.issue(write);
  try {
    if ((await performCacheWrite(write)) === 'not_now') {
      // LD-0002 round 2: no background time left, nothing was published.
      deferredFileProviderCacheWrites.defer(write);
    } else {
      deferredFileProviderCacheWrites.landed(write);
    }
  } catch {
    // best-effort — the next backup folder resolve publishes it again
    undo();
  }
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
 *
 * Task 1593 round 4 — this can be a long BFS across the whole vault, so it
 * holds ONE lease from the plaintext gate for its entire span (rather than
 * one per push): a sign-out purge invalidates it immediately and `drain()`
 * waits (bounded) for the walk to notice, instead of the sweep racing a walk
 * that keeps recreating rows underneath it. `lease.valid` is checked before
 * every folder's push to native — and again right after the decrypt span,
 * which is async — so the walk stops queueing/pushing MORE folders the
 * moment a purge starts, rather than only refusing the final push.
 */
export async function populateFileProviderCache(
  decryptMetadata: (fileId: string, nonce: Uint8Array, ct: Uint8Array) => Promise<string>,
  options: {
    recursive?: boolean;
    decryptNames?: (items: BatchNameItem[]) => Promise<BatchNameResult[]>;
  } = {},
): Promise<number> {
  if (Platform.OS !== 'ios') return 0;
  let lease;
  try {
    lease = plaintextGate.acquire('file provider cache walk');
  } catch {
    // Gate already closed (signed out) — nothing to populate.
    return 0;
  }
  try {
    let totalSynced = 0;

    // BFS through all folders. Sync each directory as soon as it is decrypted so
    // Files.app can render root and recently opened folders without waiting for
    // a full-vault traversal.
    const queue: (string | undefined)[] = [undefined]; // start with root
    while (queue.length > 0) {
      if (!lease.valid) break;
      const parentId = queue.shift();
      try {
        // Full cursor walk — the Files.app BFS must see EVERY child of each
        // folder, not the first 200 (task 0755).
        const files = await listAllFiles(parentId);
        const names: Record<string, string> = {};

        const encrypted = files.filter((file) => (file.name_encrypted ?? '').startsWith('{'));
        if (options.decryptNames) {
          await decryptNamesInBackground(
            encrypted.map((file) => ({ fileId: file.id, nameEncrypted: file.name_encrypted ?? '' })),
            options.decryptNames,
            (item, result) => { if (result.name) names[item.fileId] = result.name; },
            () => !lease.valid,
          );
        }
        await mapInBatches(files, 12, async (file) => {
          if (!lease.valid) return;
          try {
            const raw = file.name_encrypted ?? '';
            if (!raw.startsWith('{')) {
              if (raw && raw.length < 200) names[file.id] = raw;
            } else if (!options.decryptNames) {
              const payload = encryptedMetadataPayloadToBytes(raw);
              if (payload) {
                const plaintext = await decryptMetadata(file.id, payload.nonce, payload.ciphertext);
                const name = parseDecryptedName(plaintext);
                if (name) names[file.id] = name;
              }
            }
          } catch {
            // skip individual decrypt failures
          }
        });

        // Re-check: the decrypt span above is async, and a purge may have
        // closed the gate while it ran.
        if (!lease.valid) break;

        // `listAllFiles` returns the COMPLETE child set for this folder (full
        // cursor walk), so prune is safe here — rows for children that no
        // longer exist remotely (e.g. trashed on the web) are deleted.
        totalSynced += await syncDecryptedEntriesToFileProvider(files, names, parentId ?? null, {
          prune: true,
        });

        for (const file of files) {
          if (options.recursive !== false && file.is_folder) queue.push(file.id);
        }
      } catch {
        // skip folders that fail to list
      }
    }

    return totalSynced;
  } catch {
    return 0;
  } finally {
    lease.release();
  }
}
