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
 *
 * ── Android rule-equivalent (ora-2 ruling, 2026-10-02 — task 1683d) ──────────
 *
 * The iOS registry/harden layer has NO Kotlin analogue, by ruling: the Android
 * rule is STRUCTURAL, and the sign-out purge is real + observable at the JS
 * layer instead. Every protection iOS's registry buys is already an Android
 * default here:
 *
 * 1. INTERNAL-ONLY STORAGE — every Kotlin writer stays inside
 *    `context.filesDir` / `context.cacheDir` / MODE_PRIVATE SharedPreferences
 *    (enforced by the f4780bf guard: `plaintext-storage.test.ts` walks the
 *    Kotlin sources for external-storage / world-readable escapes). expo's
 *    `documentDirectory` IS `context.filesDir` (AppDirectoriesService.kt), so
 *    every registered leaf's writer is TS.
 * 2. `allowBackup="false"` + pinned backup-rule attributes
 *    (`android/dataExtractionRules`/`fullBackupContent` — pinned by the
 *    manifest guard test) keep the whole filesDir subtree out of device
 *    backups and D2D transfers; FBE at-rest encryption is device-wide.
 * 3. PURGE = JS — `account-cleanup.ts`'s sweep deletes every registered
 *    caches-registry leaf, the offline dir, the offline SecureStore manifest,
 *    the identifier map, and calls `purgePlaintextStorage()` (which is
 *    iOS-only work; on Android it reports {removed:0} BY DESIGN — the JS
 *    sweep is the Android purge surface). No second process or content
 *    provider exists on Android that could write plaintext outside this.
 * 4. No `notePlaintextPathCreated()` on Android (iOS-gated below): there is
 *    no native harden step to notify.
 *
 * REVISIT TRIGGERS (the four events that void this ruling — re-add a Kotlin
 * registry analogue when any becomes true):
 *   (a) a Kotlin writer outside the reviewed roots (the f4780bf guard goes red);
 *   (b) a second process or content provider ships (share intent handling
 *       moves to an :outofprocess target, a FileProvider, widget process…);
 *   (c) expo moves `persistentFilesDirectory` off `context.filesDir`;
 *   (d) backup/D2D transfer is re-enabled for this app (allowBackup flips).
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
  // Task 1593 round 11 — the File Provider cache DB's own dedicated
  // directory (see PlaintextStorageProtection.swift's registry() doc
  // comment: protecting this directory is what actually protects its
  // SQLite sidecars, via iOS's protection-class + backup-exclusion
  // inheritance for files created inside it).
  'file-provider-db',
  'file-provider-cache.sqlite',
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
