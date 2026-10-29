/**
 * upload-classification — what this device already knows about files it
 * uploaded itself (task 1959 round 4, Codex P1 on mobile PR #181).
 *
 * The file-index loader serves the Photos tab from the on-disk index cache
 * inside its revalidation window. A file uploaded after the window opened
 * reaches that cache only through the sync write-through
 * (`sync-client.ts` `syncNodeToFileEntry`), which has no `is_media`: the
 * server's `file_create` op carries no classification, the plaintext MIME is
 * encrypted inside `name_encrypted`, and a fresh upload has no thumbnail yet.
 * `photoCandidatesFromIndex` therefore dropped the new photo until a forced
 * refresh or the window expired.
 *
 * The server's `is_media` is the uploading client's own classification, sent
 * on upload init. When THIS device was the uploader it already knows that
 * value, so it can fill it in without asking the server:
 *   - JS uploads (`uploadEncryptedChunked`, `uploadEncryptedFileNative`):
 *     `finalizeUpload` records the `isMedia` it sent, keyed by the server's
 *     file id, BEFORE the complete call (the `file_create` sync op follows
 *     the complete, so the record is always there first).
 *   - Camera-roll backup (the Swift / Kotlin backup engines, which do their
 *     own init): the shared `backup_assets` table maps `remote_file_id` to
 *     `asset_type`; photo and video assets are uploaded with `is_media: true`
 *     (NativeBackupEngine.swift `mediaFlag`), contacts and calendars with
 *     false.
 * A row neither source knows (another device, the share extension, a file
 * request) stays unclassified, and the loader revalidates for it once
 * (file-index-loader.ts `revalidateUnclassified`).
 *
 * In memory only, per account: dropped on every account-epoch advance, and
 * capped so a long session of uploads cannot grow it without bound (the
 * oldest entries go first; by then a server check has long since carried the
 * real value).
 */

import { onAccountEpochAdvance } from './account-epoch';

/** Upper bound on remembered uploads (oldest evicted first). */
export const UPLOAD_CLASSIFICATION_LIMIT = 10_000;

let uploads = new Map<string, boolean>();

onAccountEpochAdvance(() => {
  uploads = new Map();
});

/** Record the `is_media` this device sent for `fileId` (the server's id). */
export function rememberUploadClassification(fileId: string, isMedia: boolean): void {
  if (!fileId) return;
  uploads.delete(fileId);
  uploads.set(fileId, isMedia);
  while (uploads.size > UPLOAD_CLASSIFICATION_LIMIT) {
    const oldest = uploads.keys().next().value;
    if (oldest === undefined) break;
    uploads.delete(oldest);
  }
}

export type BackupMediaLookup = (fileIds: string[]) => Promise<Map<string, boolean>>;

async function backupEngineLookup(fileIds: string[]): Promise<Map<string, boolean>> {
  // Lazy: BackupDatabase opens SQLite; only a load that actually has
  // unclassified new rows pays for the query.
  const { getBackupMediaFlags } = await import('../services/BackupDatabase');
  return getBackupMediaFlags(fileIds);
}

/**
 * `is_media` for each id this device uploaded, from the JS upload record
 * first and the backup engine's table for the rest. Ids it does not know are
 * absent from the result. Never throws: a failed backup-table read only
 * means fewer ids are known.
 */
export async function classifyOwnUploads(
  fileIds: string[],
  lookupBackup: BackupMediaLookup = backupEngineLookup,
): Promise<Map<string, boolean>> {
  const known = new Map<string, boolean>();
  const rest: string[] = [];
  for (const id of fileIds) {
    const value = uploads.get(id);
    if (value === undefined) rest.push(id);
    else known.set(id, value);
  }
  if (rest.length === 0) return known;
  try {
    const fromBackup = await lookupBackup(rest);
    for (const id of rest) {
      const value = fromBackup.get(id);
      if (value !== undefined) known.set(id, value);
    }
  } catch {
    // Unknown stays unknown: the caller revalidates against the server.
  }
  return known;
}

/** Test hook. */
export function resetUploadClassificationsForTests(): void {
  uploads = new Map();
}
