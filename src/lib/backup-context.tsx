import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  configureBackupFolder,
  disablePhotoBackup,
  disableContactsBackup,
  disableCalendarBackup,
  teardownAllBackup,
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
import { isVaultKeyMismatchError } from '../services/vault-key-mismatch';
import { useCrypto } from './crypto-context';
import { useAuth } from './auth';
import { useAccountState } from './account-state-context';
import { readOnlyUploadMessage } from './account-state';
import { recordRuntimeTrace } from './runtime-trace';
import { registerDevice } from './device-registration';
import {
  clearMobileIosBackupClientSession,
  ensureMobileIosBackupClientSession,
  captureRequestAuthSnapshot,
  endSessionForAccountMismatch,
} from './api';

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
 *
 * Task 1531 [P1] round 6 (delta review 3, finding N1): this used to call
 * `disablePhotoBackup`/`disableContactsBackup`/`disableCalendarBackup`
 * separately via `Promise.all`. `disablePhotoBackup`'s native body only
 * purges staged ciphertext + clears the shared account when NEITHER
 * Contacts nor Calendar is still bound — and Expo dispatches these native
 * calls serially IN THE ORDER THEY WERE CALLED, so `disablePhotoBackup`
 * (called first in that array) ALWAYS ran before
 * `disableContactsBackup`/`disableCalendarBackup` had cleared their own
 * bound state. The purge was therefore skipped on every sign-out with
 * Contacts or Calendar backup enabled — not occasionally, every time.
 * `teardownAllBackup()` disables all three surfaces and purges
 * unconditionally in one native call, so there is no cross-call order left
 * to get wrong.
 */
export async function stopBackupEngines(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Promise.all([
    teardownAllBackup().catch(() => {}),
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
  /**
   * Task 1594: set when the backup refused to run because this device's vault
   * key cannot read the account's folder names (a wrong key — never build a
   * new tree then). The honest message to show; null when not blocked.
   */
  backupBlockedReason: string | null;
  /**
   * Task 1599 followup 2: set when the NATIVE engine stopped itself because
   * the server confirmed a 409 `account_mismatch` on an authenticated upload
   * mutation (this device's session no longer matches the account the
   * loaded master key is bound to). Sourced from native's poll
   * (`accountMismatchReason` on `NativeBackupProgress`), so — unlike
   * `backupBlockedReason` above, which JS sets synchronously from its own
   * `enableNativeBackup` flow — this can appear between polls, any time the
   * engine is running. The honest message to show; null when not blocked.
   */
  accountMismatchReason: string | null;
  /**
   * Task 1599 followups round 3 (P2): set when the native engine's OWN local
   * ownership check refused to even attempt starting backup (a cached
   * master-key handle with no confirmed/matching owner, or a keychain-
   * sourced handle the shared "proven vault key owner" mirror doesn't
   * confirm) — distinct from `accountMismatchReason` above, which requires a
   * server-confirmed 409. The honest message to show; null when nothing is
   * refusing to start for this reason.
   */
  ownerUnconfirmedReason: string | null;
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
  backupBlockedReason: null,
  accountMismatchReason: null,
  ownerUnconfirmedReason: null,
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

/**
 * Task 1599 followups (round 2, item 4): whether a newly-observed native
 * `accountMismatchReason` should end the current JS session, the same way
 * `request()`'s own 409 `account_mismatch` branch does (`api.ts`). Pure and
 * exported standalone so it is unit-testable without a React render harness
 * (this codebase has none for `BackupProvider` — see `backup-context.test.ts`'s
 * own header note) — mirrors the `CachedKeyOwnership.mayAdopt` /
 * `AccountMismatchDetection` precedent of pulling a decision out as a plain
 * function.
 *
 * Edge-triggered: true only on a transition INTO a reason (null → set, or
 * one reason string → a different one) — never on every repeated poll of
 * the SAME still-set reason. Without this, `applyNativeProgress` (which runs
 * on every poll tick while native reports a non-null reason) would call
 * `endSessionForAccountMismatch` — and therefore `onSessionExpired?.()` —
 * once per poll, not once per actual mismatch event.
 */
export function shouldEndSessionForNativeAccountMismatch(
  previousReason: string | null,
  nextReason: string | null,
): boolean {
  return nextReason !== null && nextReason !== previousReason;
}

/**
 * Task 1599 followups round 3 (P1 — sign-in lockout loop): whether a
 * native-reported `accountMismatchGeneration` was raised AFTER this
 * `BackupProvider` mount established its baseline — i.e. DURING the current
 * session — as opposed to a reason left over from a PRIOR session that
 * native had not yet had a chance to clear.
 *
 * The bug this guards: a confirmed 409 sets native's sticky reason, JS ends
 * that session (`shouldEndSessionForNativeAccountMismatch` above fires).
 * The NEXT sign-in mounts a brand-new `BackupProvider`, whose progress poll
 * can fire before `confirmMasterKeyHandle` (the unlock choke point that
 * clears the reason) completes — reading the STALE reason as if it were
 * fresh and ending the brand-new session before the user finishes signing
 * in, forever. (`mirrorSessionToAppGroup`, BeebeebCryptoModule.swift, now
 * also clears the reason itself on a token change and on sign-out, closing
 * the common case; this generation check is the JS-side backstop for
 * whatever race remains — e.g. an app relaunch with the SAME still-valid
 * token, where no token-changed clear ever fires.)
 *
 * `baselineGeneration === null` means no baseline has been established yet
 * for this mount (the very first poll) — that poll's generation becomes the
 * baseline and is never itself "current".
 */
export function isAccountMismatchGenerationCurrent(
  baselineGeneration: number | null,
  nextGeneration: number,
): boolean {
  return baselineGeneration !== null && nextGeneration > baselineGeneration;
}

/** Per-mount running state `reduceAccountMismatchPoll` folds over. */
export interface AccountMismatchPollState {
  reason: string | null;
  generationBaseline: number | null;
}

export const INITIAL_ACCOUNT_MISMATCH_POLL_STATE: AccountMismatchPollState = {
  reason: null,
  generationBaseline: null,
};

/**
 * Task 1599 followups round 3 (P1): the single decision `applyNativeProgress`
 * makes on every poll tick, extracted as a pure reducer so it is unit-
 * testable as a SEQUENCE of ticks without a React render harness (this
 * codebase has none for `BackupProvider` — see this file's own header
 * note). Composes the two pure checks above: only a reason that is BOTH a
 * fresh edge (`shouldEndSessionForNativeAccountMismatch`) AND raised at a
 * generation newer than this mount's baseline
 * (`isAccountMismatchGenerationCurrent`) ends the session.
 */
export function reduceAccountMismatchPoll(
  state: AccountMismatchPollState,
  next: { reason: string | null; generation: number },
): { state: AccountMismatchPollState; shouldEndSession: boolean } {
  const shouldEndSession =
    isAccountMismatchGenerationCurrent(state.generationBaseline, next.generation) &&
    shouldEndSessionForNativeAccountMismatch(state.reason, next.reason);
  const generationBaseline = state.generationBaseline === null ? next.generation : state.generationBaseline;
  return {
    state: { reason: next.reason, generationBaseline },
    shouldEndSession,
  };
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
  const [backupBlockedReason, setBackupBlockedReason] = useState<string | null>(null);
  // Task 1599 followup 2: mirrors native's `accountMismatchReason` every
  // poll — a single producer (the native poll itself), so unlike
  // `backupBlockedReason` above there is no risk of two writers racing each
  // other; native already clears it on the same sign-in that would supersede
  // this state, so mirroring it verbatim (including back to null) is correct.
  const [accountMismatchReason, setAccountMismatchReason] = useState<string | null>(null);
  // Task 1599 followups round 3 (P2): a LOCAL-only refusal reason (no
  // server round-trip involved — see `ownerUnconfirmedReason`'s doc comment
  // on `NativeBackupProgress`). Mirrored the same way `accountMismatchReason`
  // is: a single producer (the native poll), so no writer race.
  const [ownerUnconfirmedReason, setOwnerUnconfirmedReason] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const includeVideosRef = useRef(true);
  // Task 1599 followups round 3 (P1): the running fold `reduceAccountMismatchPoll`
  // carries across poll ticks for THIS mount — reset to
  // `INITIAL_ACCOUNT_MISMATCH_POLL_STATE` (no baseline established yet) on
  // every fresh `BackupProvider` instance, which is exactly the per-mount
  // scoping the sign-in lockout fix needs (see that function's doc comment).
  const accountMismatchPollStateRef = useRef<AccountMismatchPollState>(INITIAL_ACCOUNT_MISMATCH_POLL_STATE);
  // Task 1037: a needs_plan / lapsed account is refused every upload (409
  // plan_required / account_lapsed). Keep the native engines OFF while that
  // holds: they run on their own (including BGTask runs), and would otherwise
  // retry each asset against the server until it is dead-lettered. The user's
  // backup choices stay saved, and the engines start again once the account
  // can take uploads. Nothing starts before the first account read settles.
  const { ready: accountReady, gate: accountGate } = useAccountState();
  const accountBlockedMessage = readOnlyUploadMessage(accountGate);
  const accountReadyRef = useRef(accountReady);
  const accountBlockedRef = useRef<string | null>(accountBlockedMessage);
  accountReadyRef.current = accountReady;
  accountBlockedRef.current = accountBlockedMessage;

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
    const nextAccountMismatchReason = p.accountMismatchReason ?? null;
    const nextAccountMismatchGeneration = p.accountMismatchGeneration ?? 0;
    // Task 1599 followups (round 2, item 4) / round 3 (P1): the native
    // engine already confirmed a 409 `account_mismatch` and stopped itself
    // (`handleConfirmedAccountMismatch` in NativeBackupEngine.swift) — end
    // the JS session the SAME way `request()`'s own 409 branch does
    // (`api.ts`), so a user who just toggles backup back on
    // (`enablePhotoBackup` rebinds `currentAccountId` immediately, with the
    // SAME stale token) doesn't send it straight back into another 409.
    // Guarded by the current-session snapshot
    // (`captureRequestAuthSnapshot`/`endSessionForAccountMismatch`) so a
    // session that has ALREADY moved on since native set this reason (e.g.
    // the user signed in again in the meantime) is not torn down out from
    // under them. `reduceAccountMismatchPoll` additionally gates on the
    // reason having been raised at a generation newer than THIS mount's
    // baseline — see that function's doc comment for the sign-in lockout
    // loop this closes (a stale reason from a session that already ended
    // must never end the NEXT one before the user finishes signing in).
    const { state: nextPollState, shouldEndSession } = reduceAccountMismatchPoll(
      accountMismatchPollStateRef.current,
      { reason: nextAccountMismatchReason, generation: nextAccountMismatchGeneration },
    );
    accountMismatchPollStateRef.current = nextPollState;
    if (shouldEndSession) {
      void (async () => {
        const snapshot = await captureRequestAuthSnapshot();
        await endSessionForAccountMismatch(snapshot);
      })();
    }
    setAccountMismatchReason(nextAccountMismatchReason);
    setOwnerUnconfirmedReason(p.ownerUnconfirmedReason ?? null);
  }, []);

  const refreshNativeProgress = useCallback(async () => {
    if (Platform.OS === 'web') return;
    const p: NativeBackupProgress = await getBackupProgress();
    applyNativeProgress(p);
  }, [applyNativeProgress]);

  const enableNativeBackup = useCallback(async (category: BackupCategory, options: { runNow?: boolean } = {}) => {
    if (Platform.OS === 'web') return;
    if (accountBlockedRef.current) {
      setBackupBlockedReason(accountBlockedRef.current);
      recordRuntimeTrace('backup.native.enable.blocked', { category, reason: 'account_read_only' });
      return;
    }
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

    let categoryFolderId: string;
    try {
      ({ categoryFolderId } = await ensureBackupFolders(category));
    } catch (err) {
      // Task 1594: a vault key that cannot read the folder names must stop the
      // backup — surface why instead of the silent catch the callers have.
      if (isVaultKeyMismatchError(err)) {
        setBackupBlockedReason(err.message);
        recordRuntimeTrace('backup.native.enable.blocked', { category, reason: 'vault_key_mismatch' });
        return;
      }
      throw err;
    }
    setBackupBlockedReason(null);
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
          // Task 1037: wait for the account read, and never start the
          // engines for a read-only account (see accountBlockedRef above).
          if (!accountReadyRef.current || accountBlockedRef.current) return;
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
    // accountReady / accountBlockedMessage: re-run the warm-up once the first
    // account read lands, and again when a read-only account can upload again.
  }, [enableNativeBackup, userId, accountReady, accountBlockedMessage]);

  // Task 1037: stop the engines when the account becomes read-only, and show
  // why in place of a progress line (Settings reads backupBlockedReason).
  const accountReasonShownRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    if (accountBlockedMessage) {
      accountReasonShownRef.current = accountBlockedMessage;
      setBackupBlockedReason(accountBlockedMessage);
      recordRuntimeTrace('backup.native.stopped', { reason: 'account_read_only', state: accountGate.kind });
      void stopBackupEngines();
      return;
    }
    const shown = accountReasonShownRef.current;
    if (shown) {
      accountReasonShownRef.current = null;
      setBackupBlockedReason((prev) => (prev === shown ? null : prev));
    }
  }, [userId, accountBlockedMessage, accountGate.kind]);

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
    if (accountBlockedRef.current) {
      setBackupBlockedReason(accountBlockedRef.current);
      return;
    }
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
        if (isVaultKeyMismatchError(err)) {
          // Task 1594: never fall back to starting the engine over a tree this
          // key cannot read.
          setBackupBlockedReason(err.message);
          recordRuntimeTrace('backup.native.trigger.blocked', { reason: 'vault_key_mismatch' });
          return;
        }
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
    backupBlockedReason,
    accountMismatchReason,
    ownerUnconfirmedReason,
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
