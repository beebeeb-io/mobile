import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  configureBackupFolder,
  disablePhotoBackup,
  disableContactsBackup,
  disableCalendarBackup,
  enablePhotoBackup,
  enableContactsBackup,
  enableCalendarBackup,
  resumeContactsBackup,
  resumeCalendarBackup,
  getBackupProgress,
  triggerImmediateBackup,
  mirrorBackupClientSession,
  getPhotoBackupIncludeVideos,
  setPhotoBackupIncludeVideos,
  type NativeBackupProgress,
} from '../../modules/beebeeb-crypto';
import { ensureBackupFolders, reconcileDerivedStateAgainstServer, type BackupCategory } from '../services/BackupService';
import { useCrypto } from './crypto-context';
import { useAuth } from './auth';
import { recordRuntimeTrace } from './runtime-trace';
import { registerDevice } from './device-registration';
import { clearMobileIosBackupClientSession, ensureMobileIosBackupClientSession } from './api';

const BACKUP_PHOTO_KEY = 'beebeeb_camera_backup';
const BACKUP_CONTACTS_KEY = 'beebeeb_contacts_backup';
const BACKUP_CALENDAR_KEY = 'beebeeb_calendar_backup';
const BACKUP_INCLUDE_VIDEOS_KEY = 'beebeeb_camera_include_videos';
const BACKUP_WIFI_ONLY_KEY = 'beebeeb_camera_wifi_only';
const BACKUP_BG_UPLOAD_KEY = 'beebeeb_camera_bg_upload';
const SESSION_TOKEN_KEY = 'beebeeb_session_token';
// Records which user id has already claimed the pre-1443 device-global
// preference values during the one-time migration below. See
// migrateLegacyBackupPrefs.
const BACKUP_PREF_OWNER_KEY = 'beebeeb_backup_pref_owner';

// Task 1443: before this fix, all six preferences above lived at a single
// SecureStore key shared by EVERY account that ever signed in on this
// device — so account B, created right after account A signed out, silently
// inherited A's "back up camera roll: ON" and the native engine uploaded the
// device's photo library into B's vault with no consent step. These six
// base keys are now suffixed per-user (see backupPrefKey) and read only
// after the signed-in user's id is known.
const LEGACY_BACKUP_PREF_KEYS = [
  BACKUP_PHOTO_KEY,
  BACKUP_CONTACTS_KEY,
  BACKUP_CALENDAR_KEY,
  BACKUP_INCLUDE_VIDEOS_KEY,
  BACKUP_WIFI_ONLY_KEY,
  BACKUP_BG_UPLOAD_KEY,
];

/**
 * Per-user scoped SecureStore key for a backup preference.
 *
 * Expo SecureStore keys may only contain letters, digits, `.`, `-` and `_`
 * (`getItemAsync`/`setItemAsync` throw "Invalid key" on device otherwise) —
 * so the separator is `__`, never `:`. User ids are UUIDs (hex + dashes),
 * which are already safe under that charset.
 */
export function backupPrefKey(base: string, userId: string): string {
  return `${base}__${userId}`;
}

// Captured once, at module load — i.e. app cold start — BEFORE any sign-in
// flow in THIS process could have written a session token. Module top-level
// code runs synchronously before React ever renders, so nothing in this
// process can have signed in before this read is dispatched: true means a
// session was ALREADY stored when the app launched (a restored session
// carried through the upgrade); false means whichever account ends up
// signed in got there via an interactive sign-in/sign-up during THIS run.
// See migrateLegacyBackupPrefs — only the former may claim an unowned
// legacy preference.
const sessionPresentAtLaunchPromise: Promise<boolean> = getStoredToken().then((t) => t !== null);

// Guards the bootstrap ("nobody has claimed this device yet") migration path
// to at most once per app launch — see migrateLegacyBackupPrefs.
let legacyMigrationAttemptedThisLaunch = false;

/**
 * One-time migration of the pre-1443 device-global backup preference values
 * into this user's scoped keys.
 *
 * - If this SAME user already claimed the legacy values (BACKUP_PREF_OWNER_KEY
 *   === userId), they are copied into this user's scoped keys again
 *   (idempotent — e.g. a retry/remount without signing out).
 * - Otherwise, an UNOWNED legacy value (BACKUP_PREF_OWNER_KEY absent) may be
 *   claimed ONLY on the very first migration attempt this app launch, and
 *   only when a session already existed when the app launched (i.e. this is
 *   an upgrade of an already-signed-in install, not a fresh interactive
 *   sign-in that happens to run first). Without both conditions, claiming
 *   "whoever asks first" is the same shared-device leak task 1443 exists to
 *   close — just one step later (a new account created THIS run, instead of
 *   at the next launch).
 * - Copying only happens where a scoped value doesn't already exist, so a
 *   preference this user already set explicitly is never clobbered — and
 *   ownership is recorded. This is what keeps an existing single-account
 *   install's backup preference ON across the upgrade to this fix.
 * - Any other case (a DIFFERENT user already claimed the legacy values, or
 *   this is a later interactive sign-in this same launch) ignores them —
 *   never copied into this user's scoped keys.
 *
 * Either way, the legacy keys are deleted so they are consumed exactly once
 * and can never leak into a third account later.
 */
export async function migrateLegacyBackupPrefs(userId: string): Promise<void> {
  try {
    const legacyValues = await Promise.all(
      LEGACY_BACKUP_PREF_KEYS.map((key) => SecureStore.getItemAsync(key)),
    );
    if (legacyValues.every((v) => v === null)) return; // nothing to migrate — fresh install / already migrated

    const owner = await SecureStore.getItemAsync(BACKUP_PREF_OWNER_KEY);
    const isBootstrapAttempt = !legacyMigrationAttemptedThisLaunch;
    legacyMigrationAttemptedThisLaunch = true;

    let claimable = owner === userId;
    if (!claimable && owner === null && isBootstrapAttempt) {
      claimable = await sessionPresentAtLaunchPromise;
    }

    if (claimable) {
      await Promise.all(
        LEGACY_BACKUP_PREF_KEYS.map(async (key, i) => {
          const legacyValue = legacyValues[i];
          if (legacyValue === null) return;
          const scopedKey = backupPrefKey(key, userId);
          const existing = await SecureStore.getItemAsync(scopedKey);
          if (existing === null) {
            await SecureStore.setItemAsync(scopedKey, legacyValue);
          }
        }),
      );
      await SecureStore.setItemAsync(BACKUP_PREF_OWNER_KEY, userId);
    }

    await Promise.all(LEGACY_BACKUP_PREF_KEYS.map((key) => SecureStore.deleteItemAsync(key)));
  } catch {
    // SecureStore unavailable (web / unit tests) — nothing to migrate.
  }
}

/** Persists a scoped preference value and records who currently owns this
 * device's backup preferences, so a future different user's migration check
 * (see migrateLegacyBackupPrefs) correctly ignores stale legacy state. */
async function setScopedBackupPref(base: string, userId: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(backupPrefKey(base, userId), value);
  await SecureStore.setItemAsync(BACKUP_PREF_OWNER_KEY, userId).catch(() => {});
}

/**
 * Task 1531 [P0]: whether `enableNativeBackup`'s camera_roll branch may call
 * the native `enablePhotoBackup(token, userId)` bridge. The native engine
 * tags every newly-staged asset with `userId` and, on `start()`, purges any
 * staged-but-unuploaded asset tagged for a DIFFERENT account left over on
 * this device (`purgeMismatchedStagedAssets` in NativeBackupEngine.swift) —
 * without a known userId there is nothing to tag or compare, so the native
 * call must not happen. Exported standalone (same pattern as
 * backupPrefKey/stopBackupEngines below) so this guard is unit testable
 * without rendering BackupProvider.
 */
export function canEnableNativeCameraBackup(userId: string | undefined | null): userId is string {
  return typeof userId === 'string' && userId.length > 0;
}

/**
 * Stops every native backup engine and clears the mirrored client session.
 * Called when a BackupProvider instance unmounts (sign-out, or sign-in as a
 * different user — see the useEffect cleanup below) so the native engines
 * never keep running against a session token that no longer belongs to the
 * account that enabled them (task 1443). Exported standalone so it is unit
 * testable without rendering the provider.
 */
export async function stopBackupEngines(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Promise.all([
    disablePhotoBackup().catch(() => {}),
    disableContactsBackup().catch(() => {}),
    disableCalendarBackup().catch(() => {}),
    clearMobileIosBackupClientSession().catch(() => {}),
  ]);
}

interface BackupProgress {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  waitingToEncrypt?: number;
  encryptedPendingUpload?: number;
  uploading?: number;
  failed: number;
  state: string;
  reason: string;
}

export interface BackupContextValue {
  isPhotoBackupEnabled: boolean;
  isContactsBackupEnabled: boolean;
  isCalendarBackupEnabled: boolean;
  togglePhotoBackup: () => Promise<void>;
  toggleContactsBackup: () => Promise<void>;
  toggleCalendarBackup: () => Promise<void>;
  // Camera backup options
  includeVideos: boolean;
  wifiOnly: boolean;
  backgroundUpload: boolean;
  setIncludeVideos: (value: boolean) => Promise<void>;
  setWifiOnly: (value: boolean) => Promise<void>;
  setBackgroundUpload: (value: boolean) => Promise<void>;
  backupProgress: BackupProgress;
  lastBackupAt: string | null;
  triggerBackupNow: () => Promise<void>;
  // Legacy alias for components that used the old API
  isBackupEnabled: boolean;
  toggleBackup: () => Promise<void>;
}

const EMPTY_PROGRESS: BackupProgress = {
  total: 0,
  completed: 0,
  inProgress: 0,
  pending: 0,
  failed: 0,
  state: 'complete',
  reason: 'Nothing to back up',
};

export const BackupContext = createContext<BackupContextValue>({
  isPhotoBackupEnabled: false,
  isContactsBackupEnabled: false,
  isCalendarBackupEnabled: false,
  togglePhotoBackup: async () => {},
  toggleContactsBackup: async () => {},
  toggleCalendarBackup: async () => {},
  includeVideos: true,
  wifiOnly: false,
  backgroundUpload: true,
  setIncludeVideos: async () => {},
  setWifiOnly: async () => {},
  setBackgroundUpload: async () => {},
  backupProgress: EMPTY_PROGRESS,
  lastBackupAt: null,
  triggerBackupNow: async () => {},
  isBackupEnabled: false,
  toggleBackup: async () => {},
});

async function getStoredToken(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      return typeof window !== 'undefined' ? window.localStorage.getItem(SESSION_TOKEN_KEY) : null;
    }
    return await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function mirrorBackupSessionForNative(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    const deviceId = await registerDevice();
    if (!deviceId) return;
    const sessionId = await ensureMobileIosBackupClientSession(deviceId);
    if (sessionId) {
      await mirrorBackupClientSession(sessionId).catch(() => false);
    }
  } catch (err) {
    // Backup telemetry is best-effort. Never block or fail backup startup.
    if (__DEV__) console.warn('[backup] client-session setup failed:', err);
  }
}

export function BackupProvider({ children }: { children: React.ReactNode }) {
  const { isUnlocked } = useCrypto();
  const { user } = useAuth();
  const userId = user?.user_id;
  const [isPhotoBackupEnabled, setIsPhotoBackupEnabled] = useState(false);
  const [isContactsBackupEnabled, setIsContactsBackupEnabled] = useState(false);
  const [isCalendarBackupEnabled, setIsCalendarBackupEnabled] = useState(false);
  const [includeVideos, setIncludeVideosState] = useState(true);
  const [wifiOnly, setWifiOnlyState] = useState(false);
  const [backgroundUpload, setBackgroundUploadState] = useState(true);
  const [backupProgress, setBackupProgress] = useState<BackupProgress>(EMPTY_PROGRESS);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const includeVideosRef = useRef(true);

  const applyNativeProgress = useCallback((p: NativeBackupProgress) => {
    const pending = p.pending ?? Math.max(0, p.total - p.completed - p.inProgress);
    const nativeState = p.state ?? (p.inProgress > 0 ? 'uploading' : pending > 0 ? 'idle' : 'complete');
    setBackupProgress({
      total: p.total,
      completed: p.completed,
      inProgress: p.inProgress,
      pending,
      waitingToEncrypt: p.waitingToEncrypt,
      encryptedPendingUpload: p.encryptedPendingUpload,
      uploading: p.uploading,
      failed: p.failed ?? 0,
      state: nativeState,
      reason: p.reason ?? '',
    });
    if (p.lastBackupAt) setLastBackupAt(p.lastBackupAt);
  }, []);

  const refreshNativeProgress = useCallback(async () => {
    if (Platform.OS === 'web') return;
    const p: NativeBackupProgress = await getBackupProgress();
    applyNativeProgress(p);
  }, [applyNativeProgress]);

  const enableNativeBackup = useCallback(async (category: BackupCategory, options: { runNow?: boolean } = {}) => {
    if (Platform.OS === 'web') return;
    const token = await getStoredToken();
    if (!token) return;
    if (!isUnlocked) {
      recordRuntimeTrace('backup.native.enable.deferred', {
        category,
        reason: 'vault_locked',
        runNow: options.runNow !== false,
      });
      return;
    }

    const { categoryFolderId } = await ensureBackupFolders(category);
    await configureBackupFolder(category, categoryFolderId);
    recordRuntimeTrace('backup.native.folder_configured', {
      category,
      hasParentFolder: categoryFolderId.length > 0,
      runNow: options.runNow !== false,
    });

    if (category === 'camera_roll') {
      // Task 1531 [P0]: userId tags newly-staged assets with the account
      // they were encrypted for, and lets the native engine purge any
      // staged-but-unuploaded asset left over from a DIFFERENT account on
      // this device before draining anything under this session. Without a
      // known userId there is nothing to tag/compare against, so skip
      // rather than call the native side with an empty account id.
      if (!canEnableNativeCameraBackup(userId)) {
        recordRuntimeTrace('backup.native.enable.deferred', {
          category,
          reason: 'no_user_id',
          runNow: options.runNow !== false,
        });
        return;
      }
      await setPhotoBackupIncludeVideos(includeVideosRef.current).catch(() => false);
      await mirrorBackupSessionForNative();
      await enablePhotoBackup(token, userId);
    } else if (category === 'contacts') {
      // Task 1531 [P0]: same account-binding rationale as camera_roll above
      // — `canEnableNativeCameraBackup` is just a non-empty-string check
      // despite its name, reused here so Contacts uploads are bound to an
      // account the same way. Without a known userId there is nothing to
      // bind, so skip rather than call the native side with no account id.
      if (!canEnableNativeCameraBackup(userId)) {
        recordRuntimeTrace('backup.native.enable.deferred', {
          category,
          reason: 'no_user_id',
          runNow: options.runNow !== false,
        });
        return;
      }
      if (options.runNow === false) {
        await resumeContactsBackup(token, userId);
      } else {
        await enableContactsBackup(token, userId);
      }
    } else {
      // Task 1531 [P0]: same account-binding rationale as camera_roll above.
      if (!canEnableNativeCameraBackup(userId)) {
        recordRuntimeTrace('backup.native.enable.deferred', {
          category,
          reason: 'no_user_id',
          runNow: options.runNow !== false,
        });
        return;
      }
      if (options.runNow === false) {
        await resumeCalendarBackup(token, userId);
      } else {
        await enableCalendarBackup(token, userId);
      }
    }
  }, [isUnlocked, userId]);

  // Load persisted preferences on mount — scoped to the signed-in user
  // (task 1443). No userId means this instance is the signed-out slot
  // (CryptoProvider key='signed-out'): there is nothing to load and nothing
  // should auto-enable, so the initial `false` defaults stand.
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        await migrateLegacyBackupPrefs(userId);
        const [photo, contacts, calendar, videos, wifi, bgUpload] = await Promise.all([
          SecureStore.getItemAsync(backupPrefKey(BACKUP_PHOTO_KEY, userId)),
          SecureStore.getItemAsync(backupPrefKey(BACKUP_CONTACTS_KEY, userId)),
          SecureStore.getItemAsync(backupPrefKey(BACKUP_CALENDAR_KEY, userId)),
          SecureStore.getItemAsync(backupPrefKey(BACKUP_INCLUDE_VIDEOS_KEY, userId)),
          SecureStore.getItemAsync(backupPrefKey(BACKUP_WIFI_ONLY_KEY, userId)),
          SecureStore.getItemAsync(backupPrefKey(BACKUP_BG_UPLOAD_KEY, userId)),
        ]);
        setIsPhotoBackupEnabled(photo === 'true');
        setIsContactsBackupEnabled(contacts === 'true');
        setIsCalendarBackupEnabled(calendar === 'true');
        // Defaults: videos on, wifi-only off, background on
        let includeVideosValue = videos !== null ? videos === 'true' : true;
        if (Platform.OS === 'ios') {
          try {
            const nativeIncludeVideos = await getPhotoBackupIncludeVideos();
            if (videos === null) {
              includeVideosValue = nativeIncludeVideos;
            } else if (nativeIncludeVideos !== includeVideosValue) {
              await setPhotoBackupIncludeVideos(includeVideosValue);
            }
          } catch {
            // Older native builds do not expose this setting yet.
          }
        }
        includeVideosRef.current = includeVideosValue;
        setIncludeVideosState(includeVideosValue);
        if (wifi !== null) setWifiOnlyState(wifi === 'true');
        if (bgUpload !== null) setBackgroundUploadState(bgUpload === 'true');
        // 0811 — sequence the enables. Firing all three unawaited made each
        // category's ensureBackupFolders race to create its own "Backups" root
        // (duplicate roots). Running them in series means the first warms the
        // folder tree and the rest reuse it; ensureFolder's in-flight coalescing
        // is the belt-and-braces guard for any remaining concurrency (e.g. a
        // background task firing alongside this). Wrapped so the mount effect
        // isn't blocked.
        void (async () => {
          try {
            if (photo === 'true') await enableNativeBackup('camera_roll', { runNow: false });
            if (contacts === 'true') await enableNativeBackup('contacts', { runNow: false });
            if (calendar === 'true') await enableNativeBackup('calendar', { runNow: false });
          } catch {
            // Best-effort warm-up — individual enables log their own failures.
          }
        })();
      } catch {
        // SecureStore unavailable (web / unit tests)
      }
    })();
  }, [enableNativeBackup, userId]);

  // Stop the native backup engines when this instance unmounts. CryptoProvider
  // is keyed by user id (`user?.user_id ?? 'signed-out'` in App.tsx), so BOTH
  // a sign-out AND a sign-in as a different user fully unmount this provider
  // before the next one mounts. Without an explicit stop here, the native
  // engines — which keep running independently of the JS component tree once
  // started — kept running against whatever session token SecureStore
  // happened to hold when the NEXT instance mounted, uploading the device's
  // photo library into a different account's vault with no consent step
  // (task 1443). This mirrors the pattern crypto-context.tsx already uses to
  // release the native master-key handle on the same kind of remount.
  useEffect(() => {
    return () => {
      void stopBackupEngines();
    };
  }, []);

  // Poll native backup progress every 5 s when photo backup is enabled
  useEffect(() => {
    if (!isPhotoBackupEnabled || Platform.OS === 'web') return;

    const poll = async () => {
      try {
        await refreshNativeProgress();
      } catch {
        // Native module not linked yet — ignore
      }
    };

    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isPhotoBackupEnabled, refreshNativeProgress]);

  // Native state can legitimately say "open Beebeeb" after a background handoff.
  // If the user has already foregrounded the app, refresh immediately so Settings
  // reflects the live worker state instead of a stale background state.
  useEffect(() => {
    if (!isPhotoBackupEnabled || Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      // 0817 — on foreground, reconcile derived state vs server truth FIRST
      // (hash-gated, ~free when unchanged), then refresh the native bar so a
      // server-side delete (e.g. from web) self-corrects the count.
      void (async () => {
        try {
          await reconcileDerivedStateAgainstServer();
        } catch {
          // best-effort
        }
        await refreshNativeProgress().catch(() => {});
      })();
    });
    return () => sub.remove();
  }, [isPhotoBackupEnabled, refreshNativeProgress]);

  const togglePhotoBackup = useCallback(async () => {
    if (!userId) return; // signed-out instance — nothing to persist against
    const next = !isPhotoBackupEnabled;
    setIsPhotoBackupEnabled(next);
    try {
      await setScopedBackupPref(BACKUP_PHOTO_KEY, userId, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          await enableNativeBackup('camera_roll');
          await refreshNativeProgress().catch(() => {});
        } else {
          await disablePhotoBackup();
          await clearMobileIosBackupClientSession().catch(() => {});
          await configureBackupFolder('camera_roll', null);
          setBackupProgress(EMPTY_PROGRESS);
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [enableNativeBackup, isPhotoBackupEnabled, refreshNativeProgress, userId]);

  const toggleContactsBackup = useCallback(async () => {
    if (!userId) return;
    const next = !isContactsBackupEnabled;
    setIsContactsBackupEnabled(next);
    try {
      await setScopedBackupPref(BACKUP_CONTACTS_KEY, userId, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          await enableNativeBackup('contacts');
        } else {
          await disableContactsBackup();
          await configureBackupFolder('contacts', null);
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [enableNativeBackup, isContactsBackupEnabled, userId]);

  const toggleCalendarBackup = useCallback(async () => {
    if (!userId) return;
    const next = !isCalendarBackupEnabled;
    setIsCalendarBackupEnabled(next);
    try {
      await setScopedBackupPref(BACKUP_CALENDAR_KEY, userId, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          await enableNativeBackup('calendar');
        } else {
          await disableCalendarBackup();
          await configureBackupFolder('calendar', null);
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [enableNativeBackup, isCalendarBackupEnabled, userId]);

  const setIncludeVideos = useCallback(async (value: boolean) => {
    includeVideosRef.current = value;
    setIncludeVideosState(value);
    try {
      if (userId) await setScopedBackupPref(BACKUP_INCLUDE_VIDEOS_KEY, userId, value ? 'true' : 'false');
    } catch {
      // SecureStore unavailable
    }
    if (Platform.OS === 'ios') {
      await setPhotoBackupIncludeVideos(value).catch(() => false);
    }
  }, [userId]);

  const setWifiOnly = useCallback(async (value: boolean) => {
    setWifiOnlyState(value);
    try {
      if (userId) await setScopedBackupPref(BACKUP_WIFI_ONLY_KEY, userId, value ? 'true' : 'false');
    } catch {
      // SecureStore unavailable
    }
  }, [userId]);

  const setBackgroundUpload = useCallback(async (value: boolean) => {
    setBackgroundUploadState(value);
    try {
      if (userId) await setScopedBackupPref(BACKUP_BG_UPLOAD_KEY, userId, value ? 'true' : 'false');
    } catch {
      // SecureStore unavailable
    }
  }, [userId]);

  const triggerBackupNow = useCallback(async () => {
    try {
      // wifiOnly opt-in: refuse to start a manual backup over cellular or
      // when offline.
      if (wifiOnly) {
        const net = await NetInfo.fetch();
        const onWifi = net.type === 'wifi' && net.isConnected !== false;
        if (!onWifi) {
          console.warn('[backup] triggerBackupNow blocked: wifiOnly=true and not on Wi-Fi');
          return;
        }
      }

      if (Platform.OS === 'web') {
        return;
      }

      const token = await getStoredToken();
      if (!token) return;
      // Task 1531 [P2-4]: `triggerImmediateBackup` binds/checks the engine's
      // account with `userId` the same way `enablePhotoBackup` does — without
      // a known userId there is nothing to bind, so skip rather than call
      // the native side with no account id (mirrors the `canEnableNativeCameraBackup`
      // guard already used for `enablePhotoBackup` below).
      if (!canEnableNativeCameraBackup(userId)) return;
      try {
        const { categoryFolderId } = await ensureBackupFolders('camera_roll');
        await configureBackupFolder('camera_roll', categoryFolderId);
        await setPhotoBackupIncludeVideos(includeVideosRef.current).catch(() => false);
        await mirrorBackupSessionForNative();
        const progress = await triggerImmediateBackup(token, userId);
        applyNativeProgress(progress);
      } catch (err) {
        console.warn('[backup] native photo backup warm-up failed:', err);
        if (canEnableNativeCameraBackup(userId)) {
          await enablePhotoBackup(token, userId);
        }
        await refreshNativeProgress().catch(() => {});
      }
    } catch (err) {
      console.warn('[backup] triggerBackupNow failed:', err);
    }
  }, [applyNativeProgress, refreshNativeProgress, wifiOnly, userId]);

  const value: BackupContextValue = {
    isPhotoBackupEnabled,
    isContactsBackupEnabled,
    isCalendarBackupEnabled,
    togglePhotoBackup,
    toggleContactsBackup,
    toggleCalendarBackup,
    includeVideos,
    wifiOnly,
    backgroundUpload,
    setIncludeVideos,
    setWifiOnly,
    setBackgroundUpload,
    backupProgress,
    lastBackupAt,
    triggerBackupNow,
    // Legacy alias
    isBackupEnabled: isPhotoBackupEnabled,
    toggleBackup: togglePhotoBackup,
  };

  return (
    <BackupContext.Provider value={value}>
      {children}
    </BackupContext.Provider>
  );
}

export function useBackup(): BackupContextValue {
  return useContext(BackupContext);
}
