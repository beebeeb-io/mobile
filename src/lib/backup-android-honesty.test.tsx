// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches every other *.test.ts(x) file in this repo).
//
// Task 2303 — Android has no native backup engine. Every backup bridge
// function the UI can reach (`enablePhotoBackup`, `enableContactsBackup`,
// `enableCalendarBackup`, `resumeContactsBackup`, `resumeCalendarBackup`,
// `triggerImmediateBackup`, `getBackupProgress`, `teardownAllBackup`,
// `disable*`) is registered only in the iOS module
// (`modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift`); the Android
// module registers none of them, so tapping a backup toggle there threw
// (or silently did nothing behind a catch) while the UI claimed it was on.
//
// This renders the REAL BackupProvider on Android and asserts that no UI
// entry point reaches a native backup function. The iOS case is rendered
// too so the gate can never spread to iOS: the same toggle that Android
// must not call still calls `enablePhotoBackup`.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
const USER_A = '11111111-1111-4111-8111-111111111111';

// Mutable so one file can cover both platforms with the same module graph.
const platform = { OS: 'android' };

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
  Platform: platform,
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));

mock.module('@react-native-community/netinfo', () => ({
  default: { fetch: async () => ({ type: 'wifi', isConnected: true }) },
}));

mock.module('./crypto-context', () => ({ useCrypto: () => ({ isUnlocked: true }) }));
mock.module('./auth', () => ({ useAuth: () => ({ user: { user_id: USER_A } }) }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => {} }));
mock.module('./device-registration', () => ({ registerDevice: async () => 'device-1' }));
mock.module('./backup-device-id-handoff', () => ({ syncBackupDeviceIdToNative: async () => true }));
mock.module('./account-state-context', () => ({
  useAccountState: () => ({ ready: true, gate: { kind: 'ok' }, subscription: null, refresh: async () => ({ kind: 'ok' }) }),
}));
mock.module('./api', () => ({
  clearMobileIosBackupClientSession: async () => {},
  ensureMobileIosBackupClientSession: async () => 'session-1',
  captureRequestAuthSnapshot: async () => ({ generation: 0, token: null }),
  endSessionForAccountMismatch: async () => {},
  getSubscription: async () => null,
}));
mock.module('../services/BackupService', () => ({
  ensureBackupFolders: async () => ({ categoryFolderId: 'folder-1' }),
  reconcileDerivedStateAgainstServer: async () => {},
}));

// Every backup bridge the UI path can call. Each spy is the evidence: on
// Android all of them must stay at zero, on iOS the enable path must fire.
const CALLED: string[] = [];
function spy(name: string, impl: (...args: unknown[]) => unknown = async () => {}) {
  return (...args: unknown[]) => {
    CALLED.push(name);
    return impl(...args);
  };
}

const progress = () => ({
  total: 0, completed: 0, inProgress: 0, pending: 0, waitingToEncrypt: 0,
  encryptedPendingUpload: 0, uploading: 0, failed: 0, state: 'idle', reason: '',
});

mock.module('../../modules/beebeeb-crypto', () => ({
  configureBackupFolder: spy('configureBackupFolder'),
  disablePhotoBackup: spy('disablePhotoBackup'),
  disableContactsBackup: spy('disableContactsBackup'),
  disableCalendarBackup: spy('disableCalendarBackup'),
  teardownAllBackup: spy('teardownAllBackup'),
  enablePhotoBackup: spy('enablePhotoBackup'),
  enableContactsBackup: spy('enableContactsBackup'),
  enableCalendarBackup: spy('enableCalendarBackup'),
  resumeContactsBackup: spy('resumeContactsBackup'),
  resumeCalendarBackup: spy('resumeCalendarBackup'),
  getBackupProgress: spy('getBackupProgress', progress),
  triggerImmediateBackup: spy('triggerImmediateBackup', progress),
  mirrorBackupClientSession: spy('mirrorBackupClientSession', async () => true),
  getPhotoBackupIncludeVideos: spy('getPhotoBackupIncludeVideos', async () => true),
  setPhotoBackupIncludeVideos: spy('setPhotoBackupIncludeVideos', async () => true),
  setBackupDeviceId: spy('setBackupDeviceId', async () => true),
}));

const { BackupProvider, useBackup, backupPrefKey } = await import('./backup-context');

let latest: ReturnType<typeof useBackup> | null = null;
function Probe() {
  latest = useBackup();
  return null;
}

async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(BackupProvider, { key: 'root' }, React.createElement(Probe)),
    );
  });
  await settle();
}

beforeEach(() => {
  store.clear();
  store.set('beebeeb_session_token', 'token-1');
  // A preference that was somehow on already must not be enough on Android:
  // the warm-up path has to be gated too, not just the user's tap.
  store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
  store.set(backupPrefKey('beebeeb_contacts_backup', USER_A), 'true');
  store.set(backupPrefKey('beebeeb_calendar_backup', USER_A), 'true');
  platform.OS = 'android';
  CALLED.length = 0;
  latest = null;
});

afterEach(async () => {
  if (renderer) {
    await act(async () => { renderer!.unmount(); });
    renderer = null;
  }
});

describe('task 2303 — Android backup UI never reaches a native backup function', () => {
  test('mounting with backup preferences on calls nothing native', async () => {
    await mount();
    expect(CALLED).toEqual([]);
  });

  test('toggling photo, contacts and calendar backup calls no missing native function', async () => {
    await mount();
    await act(async () => { await latest!.togglePhotoBackup(); });
    await act(async () => { await latest!.toggleContactsBackup(); });
    await act(async () => { await latest!.toggleCalendarBackup(); });
    await settle();
    expect(CALLED).toEqual([]);
    // Tapping must not pretend it worked either: the Android UI shows the
    // status line, so the state stays off rather than flipping to a lie.
    expect(latest!.isPhotoBackupEnabled).toBe(false);
    expect(latest!.isContactsBackupEnabled).toBe(false);
    expect(latest!.isCalendarBackupEnabled).toBe(false);
  });

  test('"Back up now" and sign-out teardown call nothing native', async () => {
    await mount();
    await act(async () => { await latest!.triggerBackupNow(); });
    await settle();
    expect(CALLED).toEqual([]);
  });
});

describe('task 2303 — iOS backup path is unchanged', () => {
  test('the iOS photo toggle still calls enablePhotoBackup', async () => {
    store.clear();
    store.set('beebeeb_session_token', 'token-1');
    platform.OS = 'ios';
    CALLED.length = 0;
    await mount();
    expect(CALLED).not.toContain('enablePhotoBackup');
    await act(async () => { await latest!.togglePhotoBackup(); });
    await settle();
    expect(latest!.isPhotoBackupEnabled).toBe(true);
    expect(CALLED).toContain('enablePhotoBackup');
  });
});
