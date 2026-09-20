// @ts-nocheck
// Task 1443 — the "Back up camera roll" (and contacts/calendar) preference
// used to live at a single device-global SecureStore key shared by every
// account that ever signed in on this device, so signing out of account A
// and creating account B on the same device silently inherited A's choice
// and the native engine uploaded A's photo library into B's vault with no
// consent step. These tests cover the three pieces of the fix in isolation
// (no React render needed — backup-context.tsx exports them standalone):
//   - backupPrefKey: per-user key scoping
//   - migrateLegacyBackupPrefs: the one-time legacy-key migration rule
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

const { backupPrefKey, migrateLegacyBackupPrefs, stopBackupEngines } = await import('./backup-context');

const LEGACY_PHOTO_KEY = 'beebeeb_camera_backup';
const OWNER_KEY = 'beebeeb_backup_pref_owner';

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
  test('suffixes the base key with the user id', () => {
    expect(backupPrefKey(LEGACY_PHOTO_KEY, 'user-a')).toBe('beebeeb_camera_backup:user-a');
  });

  test('two different users never share the same scoped key', () => {
    const a = backupPrefKey(LEGACY_PHOTO_KEY, 'user-a');
    const b = backupPrefKey(LEGACY_PHOTO_KEY, 'user-b');
    expect(a).not.toBe(b);
  });
});

describe('migrateLegacyBackupPrefs', () => {
  test('no legacy values on this device: no-op, nothing written', async () => {
    await migrateLegacyBackupPrefs('user-a');
    expect(store.size).toBe(0);
  });

  test('existing single-account install: legacy value + no prior owner migrates and keeps backup ON', async () => {
    store.set(LEGACY_PHOTO_KEY, 'true');
    await migrateLegacyBackupPrefs('user-a');
    expect(store.get(backupPrefKey(LEGACY_PHOTO_KEY, 'user-a'))).toBe('true');
    expect(store.get(OWNER_KEY)).toBe('user-a');
    // Legacy key is consumed so it can never be read by a later, different user.
    expect(store.has(LEGACY_PHOTO_KEY)).toBe(false);
  });

  test('the reported bug: a brand-new account created after sign-out does NOT inherit the previous account\'s legacy preference', async () => {
    // Account A enabled backup under the pre-1443 device-global key.
    store.set(LEGACY_PHOTO_KEY, 'true');
    // A's own BackupProvider mount runs the migration first and claims it.
    await migrateLegacyBackupPrefs('user-a');
    expect(store.get(backupPrefKey(LEGACY_PHOTO_KEY, 'user-a'))).toBe('true');

    // B signs up fresh on the same device — this is the exact QA repro
    // (task 1443): 9 photos uploaded into a brand-new account within 20s.
    await migrateLegacyBackupPrefs('user-b');
    expect(store.has(backupPrefKey(LEGACY_PHOTO_KEY, 'user-b'))).toBe(false);
  });

  test('legacy value already owned by a DIFFERENT user: ignored, never copied, and still deleted', async () => {
    store.set(LEGACY_PHOTO_KEY, 'true');
    store.set(OWNER_KEY, 'user-a');
    await migrateLegacyBackupPrefs('user-b');
    expect(store.has(backupPrefKey(LEGACY_PHOTO_KEY, 'user-b'))).toBe(false);
    expect(store.has(LEGACY_PHOTO_KEY)).toBe(false);
    // Ownership is untouched by B's ignored read.
    expect(store.get(OWNER_KEY)).toBe('user-a');
  });

  test('re-migration for the same owning user never clobbers a scoped value the user already set explicitly', async () => {
    store.set(LEGACY_PHOTO_KEY, 'true');
    store.set(OWNER_KEY, 'user-a');
    // User A already turned it back off under the new scoped key since the
    // legacy value was written.
    store.set(backupPrefKey(LEGACY_PHOTO_KEY, 'user-a'), 'false');
    await migrateLegacyBackupPrefs('user-a');
    expect(store.get(backupPrefKey(LEGACY_PHOTO_KEY, 'user-a'))).toBe('false');
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
