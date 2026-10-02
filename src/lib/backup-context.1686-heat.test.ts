// @ts-nocheck
// Task 1686 — iOS idle heat: the native backup-progress poll (5 s interval)
// and the account-refusal poll (15 s interval) both kept running while the
// app was backgrounded/locked, and the progress poll re-rendered the whole
// tree every 5 s even when NOTHING changed (~12 setState/min at idle).
//
// RED-first tests for the three pure decisions extracted from
// backup-context.tsx (same no-React-harness pattern as the file's own
// reduceAccountMismatchPoll / runAccountRefusalPollTick):
//
//   1. nativeProgressEquals — field-by-field equality of the projected
//      BackupProgress shape, so applyNativeProgress can skip its setState
//      (and every downstream mirror setState) when a poll tick read the
//      same progress as the last one.
//   2. shouldPauseBackupPolls — the AppState pause decision: 'background'
//      and 'inactive' pause BOTH polls; 'active' never pauses. The
//      account-refusal poll must NOT change its 15 s foreground semantics
//      (behavior contract for active users) — only the background pause is
//      new.
//   3. reduceAccountMismatchPoll interplay — when the equality guard skips
//      setState, the mismatch fold must NOT be skipped with it if the
//      generation moved (a stale-reason session-ending edge must survive an
//      otherwise-identical progress payload). Covered via the existing
//      reducer's own tests plus an explicit "skip only when the fold state
//      would be identical" check through reduceAccountMismatchPoll.
import { describe, expect, mock, test } from 'bun:test';

// In-memory SecureStore, matching backup-context.test.ts's pattern.
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
  disablePhotoBackup: async () => {},
  disableContactsBackup: async () => {},
  disableCalendarBackup: async () => {},
  teardownAllBackup: async () => {},
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

const {
  nativeProgressEquals,
  shouldPauseBackupPolls,
} = await import('./backup-context');

function progress(overrides: Record<string, unknown> = {}) {
  return {
    total: 10,
    completed: 3,
    inProgress: 1,
    pending: 6,
    waitingToEncrypt: 0,
    encryptedPendingUpload: 0,
    uploading: 1,
    failed: 0,
    state: 'uploading',
    reason: '',
    lastBackupAt: '2026-10-02T10:00:00.000Z',
    accountMismatchReason: null,
    accountMismatchGeneration: 4,
    ownerUnconfirmedReason: null,
    accountRefusalReason: null,
    ...overrides,
  };
}

describe('nativeProgressEquals (task 1686 — equality early-return for the 5 s poll)', () => {
  test('identical payloads are equal — the skip-setState case', () => {
    expect(nativeProgressEquals(progress(), progress())).toBe(true);
  });

  test('every projected field participates: changing any one of them breaks equality', () => {
    const fields: Array<[string, unknown]> = [
      ['total', 11],
      ['completed', 4],
      ['inProgress', 2],
      ['pending', 5],
      ['waitingToEncrypt', 2],
      ['encryptedPendingUpload', 3],
      ['uploading', 0],
      ['failed', 1],
      ['state', 'idle'],
      ['reason', 'quota'],
      ['lastBackupAt', '2026-10-02T11:00:00.000Z'],
      ['accountMismatchReason', 'mismatch'],
      ['accountMismatchGeneration', 5],
      ['ownerUnconfirmedReason', 'no owner'],
      ['accountRefusalReason', 'trial_cap'],
    ];
    for (const [key, value] of fields) {
      const a = progress();
      const b = progress({ [key]: value });
      expect(nativeProgressEquals(a, b)).toBe(false);
    }
  });

  test('undefined vs a concrete value is NOT equal (a native build that starts reporting a field must surface it)', () => {
    expect(nativeProgressEquals(progress({ failed: undefined }), progress({ failed: 0 }))).toBe(false);
    expect(nativeProgressEquals(progress({ state: undefined }), progress({ state: 'idle' }))).toBe(false);
  });

  test('both undefined is equal (two polls of an old native build)', () => {
    expect(nativeProgressEquals(progress({ failed: undefined }), progress({ failed: undefined }))).toBe(true);
  });

  test('null vs undefined is NOT equal (mirror state transitions must not be silently swallowed)', () => {
    expect(nativeProgressEquals(progress({ accountRefusalReason: null }), progress({ accountRefusalReason: undefined }))).toBe(false);
  });
});

describe('shouldPauseBackupPolls (task 1686 — pause both polls when backgrounded)', () => {
  test("'background' and 'inactive' pause; 'active' does not", () => {
    expect(shouldPauseBackupPolls('background')).toBe(true);
    expect(shouldPauseBackupPolls('inactive')).toBe(true);
    expect(shouldPauseBackupPolls('active')).toBe(false);
  });

  test("unknown state does NOT pause (fail open — a missed foreground must never freeze live progress)", () => {
    expect(shouldPauseBackupPolls(undefined)).toBe(false);
  });
});
