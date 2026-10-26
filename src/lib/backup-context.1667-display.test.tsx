// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches every other *.test.ts(x) file in this repo).
//
// Task 1667, simulator rung on main 9f997265, step 5b (FAIL, display only):
// after camera backup was turned OFF and back ON, Photos showed
// "23 photos, 2 videos on device · 0 backed up" and Settings "25 of 0 items"
// until a cold relaunch, while the server and the native manifest both had
// all 25 (`.claude/tasks/_qa-evidence/1667/sim-rung/main-9f997265/43-…45-`).
//
// Root cause (main 9f997265): `togglePhotoBackup` (off) reset the DISPLAYED progress to
// EMPTY_PROGRESS, but the task-1686 equality early-return in
// `applyNativeProgress` kept its last-RECEIVED payload. After re-enable,
// native returned the identical 25/25 payload, every poll returned early,
// and the display stayed at 0 until the process restarted.
// Fix: the shown native payload is written only by native reads (so the
// dedupe always compares against what is shown) and cleared when backup is
// turned on; "backup off shows nothing" is derived from the toggle instead of
// written into that state.
//
// These tests render the REAL BackupProvider with react-test-renderer (every
// dependency mocked, same convention as ConfirmActionPrompt.test.tsx) and
// read what a screen would read through `useBackup()`:
//   1. off -> on: the count is 25/25 again after the re-enable's own read
//      (one native read, no 5 s poll tick needed);
//   2. a native read still in flight when backup is turned off cannot paint
//      the count back, and a native disable that throws still clears it;
//   3. account switch and sign-out the way App.tsx does them (the provider
//      remounts under the user-keyed CryptoProvider): nothing carries over;
//   4. launch path (question B of the same rung): with the preference ON, a
//      mount enables the native engine as soon as the vault is unlocked, and
//      the display shows the native count without any user action.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

// Mutable inputs the mocks read at call time.
let currentUser: { user_id: string } | null = { user_id: USER_A };
let unlocked = true;
let nativeProgressFor: () => Record<string, unknown> = () => full25();
let heldTrigger: { promise: Promise<unknown>; resolve: (v: unknown) => void } | null = null;
let holdReads = false;
const heldReads: Array<(v: unknown) => void> = [];
let disableThrows = false;
const calls = { getBackupProgress: 0, enablePhotoBackup: [] as Array<[string, string]>, disablePhotoBackup: 0 };

function full25() {
  // A FRESH object with identical fields on every read, like the native bridge.
  return {
    total: 25,
    completed: 25,
    inProgress: 0,
    pending: 0,
    waitingToEncrypt: 0,
    encryptedPendingUpload: 0,
    uploading: 0,
    failed: 0,
    state: 'complete',
    reason: 'All items backed up',
    lastBackupAt: '2026-10-19T02:41:30.000Z',
    accountMismatchReason: null,
    accountMismatchGeneration: 0,
    ownerUnconfirmedReason: null,
    accountRefusalReason: null,
    manifestUnavailableReason: null,
    serverCheckPausedReason: null,
  };
}

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
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));

mock.module('@react-native-community/netinfo', () => ({
  default: { fetch: async () => ({ type: 'wifi', isConnected: true }) },
}));

mock.module('./crypto-context', () => ({ useCrypto: () => ({ isUnlocked: unlocked }) }));
mock.module('./auth', () => ({ useAuth: () => ({ user: currentUser }) }));
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
mock.module('../../modules/beebeeb-crypto', () => ({
  configureBackupFolder: async () => {},
  disablePhotoBackup: async () => {
    calls.disablePhotoBackup += 1;
    if (disableThrows) throw new Error('native disable failed');
  },
  disableContactsBackup: async () => {},
  disableCalendarBackup: async () => {},
  teardownAllBackup: async () => {},
  enablePhotoBackup: async (token: string, userId: string) => { calls.enablePhotoBackup.push([token, userId]); },
  enableContactsBackup: async () => {},
  enableCalendarBackup: async () => {},
  resumeContactsBackup: async () => {},
  resumeCalendarBackup: async () => {},
  getBackupProgress: async () => {
    calls.getBackupProgress += 1;
    if (holdReads) return new Promise((r) => { heldReads.push(r); });
    return nativeProgressFor();
  },
  triggerImmediateBackup: async () => (heldTrigger ? heldTrigger.promise : nativeProgressFor()),
  mirrorBackupClientSession: async () => true,
  getPhotoBackupIncludeVideos: async () => true,
  setPhotoBackupIncludeVideos: async () => true,
  setBackupDeviceId: async () => true,
}));

const {
  BackupProvider,
  useBackup,
  backupPrefKey,
  nextShownNativeProgress,
} = await import('./backup-context');

let latest: ReturnType<typeof useBackup> | null = null;
let renders = 0;
function Probe() {
  renders += 1;
  latest = useBackup();
  return null;
}

/** Let every queued promise chain (SecureStore reads, enable, refresh) settle. */
async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
async function mount(key = 'root') {
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(BackupProvider, { key }, React.createElement(Probe)),
    );
  });
  await settle();
}
async function rerender(key = 'root') {
  await act(async () => {
    renderer!.update(React.createElement(BackupProvider, { key }, React.createElement(Probe)));
  });
  await settle();
}

const shown = () => ({ completed: latest!.backupProgress.completed, total: latest!.backupProgress.total });

beforeEach(() => {
  store.clear();
  store.set('beebeeb_session_token', 'token-1');
  currentUser = { user_id: USER_A };
  unlocked = true;
  nativeProgressFor = () => full25();
  calls.getBackupProgress = 0;
  calls.enablePhotoBackup = [];
  calls.disablePhotoBackup = 0;
  heldTrigger = null;
  holdReads = false;
  heldReads.length = 0;
  disableThrows = false;
  latest = null;
  renders = 0;
});

afterEach(async () => {
  if (renderer) {
    await act(async () => { renderer!.unmount(); });
    renderer = null;
  }
});

describe('task 1667 5b — backed-up count after camera backup off -> on', () => {
  test('re-enabling shows 25 of 25 again after its own native read (was: 0 backed up, "25 of 0")', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    expect(latest!.isPhotoBackupEnabled).toBe(true);
    expect(shown()).toEqual({ completed: 25, total: 25 });

    await act(async () => { await latest!.togglePhotoBackup(); });
    await settle();
    expect(latest!.isPhotoBackupEnabled).toBe(false);
    expect(calls.disablePhotoBackup).toBe(1);
    expect(shown()).toEqual({ completed: 0, total: 0 });

    const readsBefore = calls.getBackupProgress;
    await act(async () => { await latest!.togglePhotoBackup(); });
    await settle();
    expect(latest!.isPhotoBackupEnabled).toBe(true);
    // Native was read again (no 5 s tick has elapsed: setTimeout(0) only) ...
    expect(calls.getBackupProgress).toBeGreaterThan(readsBefore);
    // ... and that identical 25/25 payload reached the screen.
    expect(shown()).toEqual({ completed: 25, total: 25 });
    expect(latest!.backupProgress.state).toBe('complete');
  });

  test('re-enable never shows the progress kept from before: nothing until native answers, then its answer', async () => {
    nativeProgressFor = () => ({ ...full25(), completed: 22, inProgress: 3, pending: 0, uploading: 3, state: 'uploading' });
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    expect(latest!.backupProgress.state).toBe('uploading');

    await act(async () => { await latest!.togglePhotoBackup(); });
    await settle();
    expect(shown()).toEqual({ completed: 0, total: 0 });

    // Turn it on while every native read is still on its way.
    nativeProgressFor = () => full25();
    holdReads = true;
    let toggling!: Promise<void>;
    await act(async () => { toggling = latest!.togglePhotoBackup(); });
    await settle();
    expect(latest!.isPhotoBackupEnabled).toBe(true);
    expect(heldReads.length).toBeGreaterThan(0);
    expect(shown()).toEqual({ completed: 0, total: 0 });
    expect(latest!.backupProgress.inProgress).toBe(0);
    expect(latest!.backupProgress.state).not.toBe('uploading');

    await act(async () => { for (const r of heldReads.splice(0)) r(full25()); await toggling; });
    await settle();
    expect(shown()).toEqual({ completed: 25, total: 25 });
    expect(latest!.backupProgress.state).toBe('complete');
  });

  test('off -> on twice in a row still lands on 25 of 25 each time', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    for (let round = 0; round < 2; round += 1) {
      await act(async () => { await latest!.togglePhotoBackup(); });
      await settle();
      expect(shown()).toEqual({ completed: 0, total: 0 });
      await act(async () => { await latest!.togglePhotoBackup(); });
      await settle();
      expect(shown()).toEqual({ completed: 25, total: 25 });
    }
  });
});

describe('task 1667 5b — turning backup off always clears the count', () => {
  test('a native read in flight when backup is turned off does not paint the count back', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    expect(shown()).toEqual({ completed: 25, total: 25 });

    // "Back up now" is waiting on native when the user turns backup off.
    let resolve!: (v: unknown) => void;
    heldTrigger = { promise: new Promise((r) => { resolve = r; }), resolve: (v) => resolve(v) };
    let pending!: Promise<void>;
    await act(async () => { pending = latest!.triggerBackupNow(); });
    await settle();

    await act(async () => { await latest!.togglePhotoBackup(); });
    await settle();
    expect(shown()).toEqual({ completed: 0, total: 0 });

    // Native answers after the reset.
    await act(async () => { heldTrigger!.resolve({ ...full25(), completed: 20, inProgress: 5, state: 'uploading' }); await pending; });
    await settle();
    expect(latest!.isPhotoBackupEnabled).toBe(false);
    expect(shown()).toEqual({ completed: 0, total: 0 });

    // ... and turning backup on again shows native's fresh answer, not that late read.
    heldTrigger = null;
    await act(async () => { await latest!.togglePhotoBackup(); });
    await settle();
    expect(shown()).toEqual({ completed: 25, total: 25 });
    expect(latest!.backupProgress.state).toBe('complete');
  });

  test('a native disable that throws still clears the count', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    disableThrows = true;
    await act(async () => { await latest!.togglePhotoBackup(); });
    await settle();
    expect(calls.disablePhotoBackup).toBe(1);
    expect(latest!.isPhotoBackupEnabled).toBe(false);
    expect(shown()).toEqual({ completed: 0, total: 0 });
  });
});

describe('task 1667 5b — account switch and sign-out never show the previous account\'s count', () => {
  test('App.tsx remounts BackupProvider per account: it sits inside the user-keyed CryptoProvider', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const keyed = app.indexOf("<CryptoProvider key={user?.user_id ?? 'signed-out'}");
    const open = app.indexOf('<BackupProvider>');
    const close = app.indexOf('</BackupProvider>');
    const keyedClose = app.indexOf('</CryptoProvider>', close);
    expect(keyed).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(keyed);
    expect(close).toBeGreaterThan(open);
    expect(keyedClose).toBeGreaterThan(close);
  });

  test('A -> B (keyed remount): B, backup off, starts at 0 with no last-backup time', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount(USER_A);
    expect(shown()).toEqual({ completed: 25, total: 25 });
    expect(latest!.lastBackupAt).toBe('2026-10-19T02:41:30.000Z');
    currentUser = { user_id: USER_B };
    await rerender(USER_B);
    expect(latest!.isPhotoBackupEnabled).toBe(false);
    expect(shown()).toEqual({ completed: 0, total: 0 });
    expect(latest!.lastBackupAt).toBeNull();
  });

  test('A -> signed out -> A (keyed remounts, identical native payload): 0 while signed out, 25 of 25 again for A', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount(USER_A);
    currentUser = null;
    await rerender('signed-out');
    expect(shown()).toEqual({ completed: 0, total: 0 });
    expect(latest!.lastBackupAt).toBeNull();
    currentUser = { user_id: USER_A };
    await rerender(USER_A);
    expect(shown()).toEqual({ completed: 25, total: 25 });
  });
});

describe('task 1686 kept — an unchanged native read re-renders nothing', () => {
  test('two "Back up now" reads with the identical payload: 0 provider re-renders', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    expect(shown()).toEqual({ completed: 25, total: 25 });
    const before = renders;
    await act(async () => { await latest!.triggerBackupNow(); });
    await settle();
    await act(async () => { await latest!.triggerBackupNow(); });
    await settle();
    expect(renders - before).toBe(0);
  });

  test('a changed read does re-render (the probe can see renders)', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    const before = renders;
    nativeProgressFor = () => ({ ...full25(), completed: 24, pending: 1, state: 'idle' });
    await act(async () => { await latest!.triggerBackupNow(); });
    await settle();
    expect(renders - before).toBeGreaterThan(0);
    expect(shown()).toEqual({ completed: 24, total: 25 });
  });
});

describe('task 1667 5b + task 1686 — nextShownNativeProgress compares against what is shown', () => {
  test('an equal payload returns the SAME object (React bails out: no idle re-render)', () => {
    const first = full25();
    expect(nextShownNativeProgress(first, full25())).toBe(first);
  });

  test('from nothing shown (null) the payload is always shown', () => {
    const p = full25();
    expect(nextShownNativeProgress(null, p)).toBe(p);
  });

  test('a changed payload replaces the shown one', () => {
    const a = full25();
    const b = { ...full25(), completed: 24, pending: 1, state: 'idle' };
    expect(nextShownNativeProgress(a, b)).toBe(b);
  });
});

describe('task 1667 question B — the launch path restarts camera backup on its own', () => {
  test('preference ON + vault unlocked at mount: native engine enabled and the count shown, no user action', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    await mount();
    expect(calls.enablePhotoBackup).toEqual([['token-1', USER_A]]);
    expect(shown()).toEqual({ completed: 25, total: 25 });
  });

  test('preference ON + vault still locked at mount (the cold-launch order in the sim trace): enabled right after unlock', async () => {
    store.set(backupPrefKey('beebeeb_camera_backup', USER_A), 'true');
    unlocked = false;
    await mount();
    // backup.native.enable.deferred reason=vault_locked
    expect(calls.enablePhotoBackup).toEqual([]);
    unlocked = true;
    await rerender();
    // backup.native.folder_configured runNow=false -> [NativeBackupEngine] Started
    expect(calls.enablePhotoBackup).toEqual([['token-1', USER_A]]);
    expect(shown()).toEqual({ completed: 25, total: 25 });
  });

  test('preference OFF: nothing is enabled at launch', async () => {
    await mount();
    expect(calls.enablePhotoBackup).toEqual([]);
    expect(shown()).toEqual({ completed: 0, total: 0 });
  });
});



describe('PR 203 auxiliary-only refusal recovery', () => {
  for (const category of ['contacts', 'calendar']) {
    test(`${category}-only backup reads native refusals after enabling`, async () => {
      nativeProgressFor = () => ({ ...full25(), accountRefusalReason: 'Free up space' });
      await mount();
      await act(async () => {
        await (category === 'contacts' ? latest!.toggleContactsBackup() : latest!.toggleCalendarBackup());
      });
      await settle();
      expect(latest!.isPhotoBackupEnabled).toBe(false);
      expect(calls.getBackupProgress).toBeGreaterThan(0);
      expect(latest!.accountRefusalReason).toBe('Free up space');
    });
  }
});
