/**
 * JS-side mirror of the native `PlaintextStorageProtection` registry
 * (`modules/beebeeb-crypto/ios/PlaintextStorageProtection.swift`).
 *
 * Native code hardens every registered path at launch. The JS caches, however,
 * are created lazily on first write — potentially hours after launch — so each
 * JS writer calls `notePlaintextPathCreated()` after creating its file or
 * directory. That coalesces into ONE native `hardenPlaintextStorage()` call per
 * process, which re-applies exclusion to whatever now exists.
 *
 * `PROTECTED_LEAF_NAMES` and `REVIEWED_NATIVE_SOURCES` are consumed by
 * `plaintext-storage.test.ts`, which fails when a new backed-up write path is
 * added to the source without a registry entry.
 */
import { Platform } from 'react-native';

import { auditPlaintextStorage, hardenPlaintextStorage } from '../../modules/beebeeb-crypto';

/** Leaf names in the native registry, in registry order. */
export const PROTECTED_LEAF_NAMES = [
  'beebeeb-thumbnails-v3',
  'beebeeb-photokit-cache',
  'offline',
  'PendingShareUploads',
  'SQLite',
  'beebeeb-name-cache-v1.json',
  'beebeeb-file-index-cache-v1.json',
  'local-id-map.json',
  'thumbnail_queue.sqlite',
  'beebeeb-simulator-master-key.txt',
  'NativeBackupStaging',
  'Beebeeb',
  'RCTAsyncLocalStorage_V1',
  'IncomingShares',
  'widget-data.json',
  'pinned',
  'temp',
] as const;

/**
 * Swift files already reviewed for backup exposure and reflected in the
 * registry. A NEW Swift file that touches `.documentDirectory` or
 * `.applicationSupportDirectory` must be reviewed and added here (and, if it
 * writes, added to the registry) or the guard test fails. Covers BOTH
 * `modules/beebeeb-crypto/ios/` (the main app / Expo module target) and
 * `targets/file-provider/` (the separately compiled `BeebeebFileProvider`
 * extension target) — see `plaintext-storage.test.ts`, which walks both.
 */
export const REVIEWED_NATIVE_SOURCES = [
  'BeebeebCryptoBridge.swift',
  'BeebeebCryptoModule.swift',
  'NativeBackupEngine.swift',
  'PendingSharesAccess.swift',
  'PhotoBackupManager.swift',
  'PhotoKitResolver.swift',
  'PlaintextStorageProtection.swift',
  'ThumbnailQueueDB.swift',
  'ThumbnailService.swift',
  'Constants.swift',
] as const;

let hardenScheduled = false;

/**
 * Call after creating a file or directory in `documentDirectory`. Debounced to
 * one native round-trip per process; failures are swallowed (a missed harden is
 * repaired on the next cold launch).
 */
export function notePlaintextPathCreated(): void {
  if (Platform.OS !== 'ios') return;
  if (hardenScheduled) return;
  hardenScheduled = true;
  void hardenPlaintextStorage()
    .then(() => {
      if (__DEV__) return auditPlaintextStorage();
      return [];
    })
    .catch(() => {
      hardenScheduled = false;
    });
}

/** Test seam — resets the once-per-process debounce. */
export function resetPlaintextStorageGuardForTests(): void {
  hardenScheduled = false;
}
