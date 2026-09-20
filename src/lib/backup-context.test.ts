// @ts-nocheck
// Task 1443 — the "Back up camera roll" (and contacts/calendar) preference
// used to live at a single device-global SecureStore key shared by every
// account that ever signed in on this device, so signing out of account A
// and creating account B on the same device silently inherited A's choice
// and the native engine uploaded A's photo library into B's vault with no
// consent step. These tests cover the three pieces of the fix in isolation
// (no React render needed — backup-context.tsx exports them standalone):
//   - backupPrefKey: per-user key scoping (SecureStore-safe charset)
//   - migrateLegacyBackupPrefs: the one-time legacy-key migration rule,
//     including the launch-timing guard from the 2026-09-20 Codex P1 fix
//   - stopBackupEngines: the sign-out / different-user teardown
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// In-memory SecureStore, matching the pattern already used by
// device-identity.test.ts and api-client-session.test.ts.
const store = new Map<string, string>();

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

mock.module('@react-native-community/netinfo', () => ({
  default: { fetch: async () => ({ type: 'wifi', isConnected: true }) },
}));

mock.module('./crypto-context', () => ({
  useCrypto: () => ({ isUnlocked: true }),
}));

mock.module('./auth', () => ({
  useAuth: () => ({ user: null }),
}));

mock.module('./runtime-trace', () => ({
  recordRuntimeTrace: () => {},
}));

mock.module('./device-registration', () => ({
  registerDevice: async () => 'device-1',
}));

// Reassignable per test (same indirection pattern as
// backup-legacy-migration.test.ts's makeBridgeReady/makeBridgeUnavailable) so
// each test can control call counts and failure behavior without depending
// on a specific mock-object API surface.
let disablePhotoBackupMock = mock(async () => {});
let disableContactsBackupMock = mock(async () => {});
let disableCalendarBackupMock = mock(async () => {});
let clearSessionMock = mock(async () => {});

mock.module('./api', () => ({
  clearMobileIosBackupClientSession: (...args: unknown[]) => clearSessionMock(...args),
  ensureMobileIosBackupClientSession: async () => 'session-1',
}));

mock.module('../services/BackupService', () => ({
  ensureBackupFolders: async () => ({ categoryFolderId: 'folder-1' }),
  reconcileDerivedStateAgainstServer: async () => {},
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  configureBackupFolder: async () => {},
  disablePhotoBackup: (...args: unknown[]) => disablePhotoBackupMock(...args),
  disableContactsBackup: (...args: unknown[]) => disableContactsBackupMock(...args),
  disableCalendarBackup: (...args: unknown[]) => disableCalendarBackupMock(...args),
  enablePhotoBackup: async () => {},
  enableContactsBackup: async () => {},
  enableCalendarBackup: async () => {},
  resumeContactsBackup: async () => {},
  resumeCalendarBackup: async () => {},
  getBackupProgress: async () => ({ total: 0, completed: 0, inProgress: 0, failed: 0 }),
  triggerImmediateBackup: async () => ({ total: 0, completed: 0, inProgress: 0, failed: 0 }),
  mirrorBackupClientSession: async () => true,
  getPhotoBackupIncludeVideos: async () => true,
  setPhotoBackupIncludeVideos: async () => true,
}));

// backupPrefKey and stopBackupEngines don't depend on the module's
// launch-time capture (see below), so a single static import is fine for
// them. migrateLegacyBackupPrefs tests need a FRESH module instance per
// scenario (see loadFresh) because sessionPresentAtLaunchPromise is captured
// once, synchronously, the moment the module is first evaluated — exactly
// mirroring how it behaves once per real app process.
const { backupPrefKey, stopBackupEngines } = await import('./backup-context');

const LEGACY_PHOTO_KEY = 'beebeeb_camera_backup';
const OWNER_KEY = 'beebeeb_backup_pref_owner';
const SESSION_TOKEN_KEY = 'beebeeb_session_token';

// Fresh module instance per test, same pattern as device-identity.test.ts —
// needed so each test gets its own sessionPresentAtLaunchPromise (captured
// from the CURRENT store contents at import time) and its own
// legacyMigrationAttemptedThisLaunch flag, instead of leaking module-level
// state between tests.
async function loadFresh() {
  return import(`./backup-context?bust=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  disablePhotoBackupMock = mock(async () => {});
  disableContactsBackupMock = mock(async () => {});
  disableCalendarBackupMock = mock(async () => {});
  clearSessionMock = mock(async () => {});
});

afterEach(() => {
  store.clear();
});

describe('backupPrefKey', () => {
  test('suffixes the base key with the user id using a SecureStore-safe separator', () => {
    expect(backupPrefKey(LEGACY_PHOTO_KEY, 'user-a')).toBe('beebeeb_camera_backup__user-a');
  });

  test('two different users never share the same scoped key', () => {
    const a = backupPrefKey(LEGACY_PHOTO_KEY, 'user-a');
    const b = backupPrefKey(LEGACY_PHOTO_KEY, 'user-b');
    expect(a).not.toBe(b);
  });

  // Codex P1 (2026-09-20): a `:` separator makes Expo SecureStore's
  // getItemAsync/setItemAsync throw "Invalid key" on device — SecureStore
  // keys may only contain letters, digits, `.`, `-` and `_`. Every generated
  // key (base key + a real UUID user id) must stay inside that charset.
  test('generated key matches the SecureStore-safe charset (no colon)', () => {
    const key = backupPrefKey(LEGACY_PHOTO_KEY, 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6');
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('migrateLegacyBackupPrefs', () => {
  test('no legacy values on this device: no-op, nothing written', async () => {
    const { migrateLegacyBackupPrefs } = await loadFresh();
    await migrateLegacyBackupPrefs('user-a');
    expect(store.size).toBe(0);
  });

  // Scenario (a): a session already existed when the app launched — this
  // user was signed in THROUGH the upgrade, not signed in during this run.
  test('signed-in-through-upgrade install: legacy value migrates and keeps backup ON', async () => {
    store.set(SESSION_TOKEN_KEY, 'token-a'); // session present BEFORE this "launch" (module load)
    store.set(LEGACY_PHOTO_KEY, 'true');
    const { migrateLegacyBackupPrefs, backupPrefKey: keyFn } = await loadFresh();
    await migrateLegacyBackupPrefs('user-a');
    expect(store.get(keyFn(LEGACY_PHOTO_KEY, 'user-a'))).toBe('true');
    expect(store.get(OWNER_KEY)).toBe('user-a');
    // Legacy key is consumed so it can never be read by a later, different user.
    expect(store.has(LEGACY_PHOTO_KEY)).toBe(false);
  });

  // Scenario (b): the Codex P1 fix. No stored session at launch (app opened
  // signed out) — a user who THEN signs in interactively during this run
  // must never inherit an unowned legacy value, even though nobody has
  // claimed it yet. This is the same shared-device leak task 1443 exists to
  // close, one step later (a brand-new sign-in this run, not a fresh app
  // launch).
  test('app opened signed out, then A signs in interactively: A does NOT inherit the legacy value', async () => {
    // No SESSION_TOKEN_KEY set — nothing was stored when this "launch" began.
    store.set(LEGACY_PHOTO_KEY, 'true');
    const { migrateLegacyBackupPrefs, backupPrefKey: keyFn } = await loadFresh();
    await migrateLegacyBackupPrefs('user-a');
    expect(store.has(keyFn(LEGACY_PHOTO_KEY, 'user-a'))).toBe(false);
    expect(store.has(OWNER_KEY)).toBe(false);
    // Still consumed — an ignored legacy value can never resurface for a
    // later user either.
    expect(store.has(LEGACY_PHOTO_KEY)).toBe(false);
  });

  // Scenario (c): the owner-match branch is unconditional — it must keep
  // working even with NO session at launch, proving it is driven by the
  // recorded owner, not by the launch-timing bootstrap path.
  test('owner === userId still migrates, regardless of session-at-launch', async () => {
    // No SESSION_TOKEN_KEY — if this claimed via the bootstrap path instead
    // of the owner-match path, this assertion would still pass for the
    // wrong reason, so this test specifically isolates the owner branch by
    // making the bootstrap branch impossible.
    store.set(LEGACY_PHOTO_KEY, 'true');
    store.set(OWNER_KEY, 'user-a');
    const { migrateLegacyBackupPrefs, backupPrefKey: keyFn } = await loadFresh();
    await migrateLegacyBackupPrefs('user-a');
    expect(store.get(keyFn(LEGACY_PHOTO_KEY, 'user-a'))).toBe('true');
  });

  test('the reported bug, end to end: A claims through the upgrade, B (signing up right after, same launch) inherits nothing', async () => {
    store.set(SESSION_TOKEN_KEY, 'token-a'); // A was already signed in when this "launch" began
    store.set(LEGACY_PHOTO_KEY, 'true');
    const { migrateLegacyBackupPrefs, backupPrefKey: keyFn } = await loadFresh();

    // A's own BackupProvider mount runs the migration first and claims it.
    await migrateLegacyBackupPrefs('user-a');
    expect(store.get(keyFn(LEGACY_PHOTO_KEY, 'user-a'))).toBe('true');

    // B signs up fresh on the same device, same running app process — this
    // is the exact QA repro (task 1443): 9 photos uploaded into a brand-new
    // account within 20s of finishing signup.
    await migrateLegacyBackupPrefs('user-b');
    expect(store.has(keyFn(LEGACY_PHOTO_KEY, 'user-b'))).toBe(false);
  });

  test('legacy value already owned by a DIFFERENT user: ignored, never copied, and still deleted', async () => {
    store.set(LEGACY_PHOTO_KEY, 'true');
    store.set(OWNER_KEY, 'user-a');
    const { migrateLegacyBackupPrefs, backupPrefKey: keyFn } = await loadFresh();
    await migrateLegacyBackupPrefs('user-b');
    expect(store.has(keyFn(LEGACY_PHOTO_KEY, 'user-b'))).toBe(false);
    expect(store.has(LEGACY_PHOTO_KEY)).toBe(false);
    // Ownership is untouched by B's ignored read.
    expect(store.get(OWNER_KEY)).toBe('user-a');
  });

  test('re-migration for the same owning user never clobbers a scoped value the user already set explicitly', async () => {
    store.set(LEGACY_PHOTO_KEY, 'true');
    store.set(OWNER_KEY, 'user-a');
    const { migrateLegacyBackupPrefs, backupPrefKey: keyFn } = await loadFresh();
    // User A already turned it back off under the new scoped key since the
    // legacy value was written.
    store.set(keyFn(LEGACY_PHOTO_KEY, 'user-a'), 'false');
    await migrateLegacyBackupPrefs('user-a');
    expect(store.get(keyFn(LEGACY_PHOTO_KEY, 'user-a'))).toBe('false');
  });
});

describe('stopBackupEngines (sign-out / different-user teardown)', () => {
  test('stops every native backup engine and clears the mirrored client session', async () => {
    await stopBackupEngines();
    expect(disablePhotoBackupMock).toHaveBeenCalledTimes(1);
    expect(disableContactsBackupMock).toHaveBeenCalledTimes(1);
    expect(disableCalendarBackupMock).toHaveBeenCalledTimes(1);
    expect(clearSessionMock).toHaveBeenCalledTimes(1);
  });

  test('one native call rejecting does not block the others from running', async () => {
    disablePhotoBackupMock = mock(async () => { throw new Error('native module not linked'); });
    await expect(stopBackupEngines()).resolves.toBeUndefined();
    expect(disableContactsBackupMock).toHaveBeenCalledTimes(1);
    expect(disableCalendarBackupMock).toHaveBeenCalledTimes(1);
    expect(clearSessionMock).toHaveBeenCalledTimes(1);
  });
});
