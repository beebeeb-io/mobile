import * as SecureStore from 'expo-secure-store';

/**
 * Photo-library inclusion preferences (Plex-style "folders in Photos", task 0885).
 *
 * The Photos tab shows every `is_media` file regardless of which folder it lives
 * in, so a desktop-uploaded album cover sitting in `Music/<album>/` wrongly
 * appears next to the camera roll. This module persists a per-device set of
 * EXCLUDED folder UUIDs whose contents (transitively) are hidden from Photos.
 *
 * Why UUIDs, not names: the folder UUID is already plaintext on the wire
 * (`FileEntry.parent_id`), so persisting it leaks nothing the server doesn't
 * already see. Folder *names* stay encrypted and are only decrypted in memory
 * for the settings UI. UUIDs are also rename-stable; a deleted folder's UUID
 * becomes a harmless no-op.
 *
 * Default is EMPTY (everything shows — today's behaviour). The user opts to
 * exclude folders; the camera roll is never hidden by default.
 *
 * Storage mirrors `src/lib/backup-notification-settings.ts` (SecureStore,
 * per-device). Cross-device sync via an encrypted preferences blob is deferred.
 *
 * The pure filter helpers live in `photo-library-filter.ts` (dependency-free so
 * they are unit-testable) and are re-exported here for convenient single-import.
 */

export {
  buildFolderParentMap,
  isAncestorExcluded,
  filterByExcludedFolders,
  filterByExcludedFoldersDirect,
  mediaCountByFolder,
  type FolderIndexEntry,
  type ParentedEntry,
} from './photo-library-filter';

const EXCLUDED_FOLDERS_KEY = 'beebeeb_photos_excluded_folders';

export async function getExcludedPhotoFolderIds(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(EXCLUDED_FOLDERS_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
    }
  } catch {
    // Corrupt value — treat as "nothing excluded" rather than crashing Photos.
  }
  return [];
}

export async function setExcludedPhotoFolderIds(ids: string[]): Promise<string[]> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
  await SecureStore.setItemAsync(EXCLUDED_FOLDERS_KEY, JSON.stringify(unique)).catch(() => {});
  return unique;
}

/**
 * Toggle a single folder's exclusion. `excluded === true` hides the folder (and
 * its descendants) from Photos; `false` shows it again. Returns the new list.
 */
export async function setPhotoFolderExcluded(folderId: string, excluded: boolean): Promise<string[]> {
  const current = new Set(await getExcludedPhotoFolderIds());
  if (excluded) {
    current.add(folderId);
  } else {
    current.delete(folderId);
  }
  return setExcludedPhotoFolderIds(Array.from(current));
}
