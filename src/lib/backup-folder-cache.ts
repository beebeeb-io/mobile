/**
 * Task 1962 Bug 4 (tracked with 1667) — the camera-roll backup's folder-id
 * cache in SecureStore.
 *
 * `BackupService` caches the account's Backups / device / category folder ids
 * under this key. It is per ACCOUNT, but nothing cleared it at sign-out: the
 * next account to sign in on the device started from the previous account's
 * folder ids (its first reconcile saw "the Backups root is gone" and
 * re-queued its own uploads), and the same account signing back in reused the
 * ids next to a manifest the sign-out had emptied.
 *
 * Kept dependency-light so account-cleanup.ts can clear it without importing
 * BackupService (and with it the api client) into every purge test.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const BACKUP_FOLDER_CACHE_KEY = 'beebeeb_backup_folders';

/** Never throws: sign-out must not be blocked by it. */
export async function clearBackupFolderCacheForSignOut(): Promise<void> {
  await clearBackupFolderCacheChecked();
}

/**
 * Task 1667 round 9: as above, and reports whether the key is really gone
 * (deleted, then read back as absent; one retry). Account deletion counts a
 * false as a failed purge instead of treating "best effort" as done. Never
 * throws.
 */
export async function clearBackupFolderCacheChecked(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (Platform.OS === 'web') {
        if (typeof window === 'undefined') return true;
        window.localStorage.removeItem(BACKUP_FOLDER_CACHE_KEY);
        if (window.localStorage.getItem(BACKUP_FOLDER_CACHE_KEY) == null) return true;
        continue;
      }
      await SecureStore.deleteItemAsync(BACKUP_FOLDER_CACHE_KEY);
      if ((await SecureStore.getItemAsync(BACKUP_FOLDER_CACHE_KEY)) == null) return true;
    } catch {
      // retried once, then reported
    }
  }
  return false;
}
