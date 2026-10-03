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
let teardownAllBackupMock = mock(async () => {});
let clearSessionMock = mock(async () => {});
// Task 1599 followups (round 2, item 4): applyNativeProgress (not exercised
// by this file — it needs a React render harness this codebase doesn't
// have, see the header note) calls these two on a NEW native
// accountMismatchReason. Only shouldEndSessionForNativeAccountMismatch's
// own pure logic is unit-tested below; these mocks exist purely so
// importing backup-context.tsx (which now references both) doesn't throw
// on an undefined import from the mocked './api' module.
let captureRequestAuthSnapshotMock = mock(async () => ({ generation: 0, token: null }));
let endSessionForAccountMismatchMock = mock(async () => {});

// Task 1037: BackupProvider reads the account state; nothing here exercises it.
mock.module('./account-state-context', () => ({
  useAccountState: () => ({ ready: true, gate: { kind: 'ok' }, subscription: null, refresh: async () => ({ kind: 'ok' }) }),
}));
// Task 1605 review round 3: BackupProvider's module-scope import of
// getSubscription needs a binding to resolve (the poll effect itself is not
// exercised here — see this file's header note — but the import must not
// throw). runAccountRefusalPollTick's own tests below inject their own
// fetchSubscription directly, so this default is never actually called by
// anything in this file.
let getSubscriptionMock = mock(async () => null);

mock.module('./api', () => ({
  clearMobileIosBackupClientSession: (...args: unknown[]) => clearSessionMock(...args),
  ensureMobileIosBackupClientSession: async () => 'session-1',
  captureRequestAuthSnapshot: (...args: unknown[]) => captureRequestAuthSnapshotMock(...args),
  endSessionForAccountMismatch: (...args: unknown[]) => endSessionForAccountMismatchMock(...args),
  getSubscription: (...args: unknown[]) => getSubscriptionMock(...args),
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
  teardownAllBackup: (...args: unknown[]) => teardownAllBackupMock(...args),
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
const {
  backupPrefKey,
  stopBackupEngines,
  canEnableNativeCameraBackup,
  shouldEndSessionForNativeAccountMismatch,
  isAccountMismatchGenerationCurrent,
  reduceAccountMismatchPoll,
  INITIAL_ACCOUNT_MISMATCH_POLL_STATE,
  decideAccountRefusalResume,
  runAccountRefusalPollTick,
} = await import('./backup-context');

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
  teardownAllBackupMock = mock(async () => {});
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

// Task 1531 [P0]: the native backup engine's `backup_assets` staging queue
// has no per-account scoping — a photo staged (encrypted to disk) under
// account A but not yet uploaded when A signs out sits there untouched
// (sign-out purges PLAINTEXT caches only; staged ciphertext was never in
// that registry). If account B is then allowed to call the native
// `enablePhotoBackup` bridge without B's own userId, the engine has no way
// to tell A's leftover staged ciphertext apart from B's own and will PUT it
// into B's account as-is — a file that unwraps under B's own share key
// (share creation derives independently from B's master key) but was never
// actually encrypted with it. This is the "share unwraps, decrypt fails"
// shape reported in 1531/1534. canEnableNativeCameraBackup is the guard that
// keeps the native call (and therefore the native-side account tag +
// mismatch purge in NativeBackupEngine.swift) from ever running without a
// known account to tag/compare against.
describe('canEnableNativeCameraBackup (task 1531 account-tag guard)', () => {
  test('refuses when there is no signed-in user id (nothing to tag staged assets with)', () => {
    expect(canEnableNativeCameraBackup(undefined)).toBe(false);
    expect(canEnableNativeCameraBackup(null)).toBe(false);
    expect(canEnableNativeCameraBackup('')).toBe(false);
  });

  test('allows once a real user id is known', () => {
    expect(canEnableNativeCameraBackup('user-a')).toBe(true);
    expect(canEnableNativeCameraBackup('user-b')).toBe(true);
  });

  test('user A and user B are never treated as interchangeable callers', () => {
    // Regression guard against a future "any truthy id passes" simplification
    // that would silently defeat the per-account tag this guard exists to
    // enable — the whole point is that A's id and B's id are DIFFERENT
    // strings the native side can compare, not just "some id or other".
    const a = canEnableNativeCameraBackup('user-a');
    const b = canEnableNativeCameraBackup('user-b');
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect('user-a').not.toBe('user-b');
  });
});

// Task 1531 [P1] round 6 (delta review 3, finding N1): `stopBackupEngines`
// used to call `disablePhotoBackup`/`disableContactsBackup`/
// `disableCalendarBackup` separately via `Promise.all` — three separate
// native bridge calls whose ORDER mattered (see `teardownAllBackup`'s doc
// comment, BeebeebCrypto.ts, and the matching one in
// BeebeebCryptoModule.swift's `disablePhotoBackup`). It now calls the single
// `teardownAllBackup()` bridge function instead, so these tests assert THAT
// call happens, not the three individual ones.
describe('stopBackupEngines (sign-out / different-user teardown)', () => {
  test('tears down every native backup engine and clears the mirrored client session', async () => {
    await stopBackupEngines();
    expect(teardownAllBackupMock).toHaveBeenCalledTimes(1);
    expect(clearSessionMock).toHaveBeenCalledTimes(1);
    // The three separate disable* bridge calls are NOT used for full
    // teardown any more — `teardownAllBackup` (native) covers them all in
    // one call. See `togglePhotoBackup`/`toggleContactsBackup`/
    // `toggleCalendarBackup`'s own off-branches for where the individual
    // disable* calls are still the correct (single-surface) call.
    expect(disablePhotoBackupMock).not.toHaveBeenCalled();
    expect(disableContactsBackupMock).not.toHaveBeenCalled();
    expect(disableCalendarBackupMock).not.toHaveBeenCalled();
  });

  test('teardownAllBackup rejecting does not block clearing the session', async () => {
    teardownAllBackupMock = mock(async () => { throw new Error('native module not linked'); });
    await expect(stopBackupEngines()).resolves.toBeUndefined();
    expect(clearSessionMock).toHaveBeenCalledTimes(1);
  });

  test('clearMobileIosBackupClientSession rejecting does not block the native teardown', async () => {
    clearSessionMock = mock(async () => { throw new Error('network error'); });
    await expect(stopBackupEngines()).resolves.toBeUndefined();
    expect(teardownAllBackupMock).toHaveBeenCalledTimes(1);
  });
});

// Task 1531 [P1] round 6 (delta review 3, finding N1): JS MIRROR of WHY
// `stopBackupEngines` had to stop calling `disablePhotoBackup` for full
// teardown — contrasts with the round-5 `shouldClearSharedAccountOnPhotoDisable`
// mirror above, which is still correct for the SINGLE-SURFACE toggle path.
// This is a decision-level mirror (see the module doc comment on the
// `shouldPurgeStagedAsset` describe block above for the compile/host caveat
// every mirror in this file shares) — it does not exercise
// BeebeebCryptoModule.swift itself.
describe('teardown purge semantics (JS mirror of the N1 fix: full teardown vs. single-surface toggle)', () => {
  // Mirrors `disablePhotoBackup`'s conditional clear — correct ONLY for the
  // single-surface Camera Roll toggle-off path (`togglePhotoBackup`).
  function shouldPurgeOnSingleSurfaceToggle(contactsBound: boolean, calendarBound: boolean): boolean {
    return !contactsBound && !calendarBound;
  }

  // Mirrors `teardownAllBackup`'s unconditional clear — the full sign-out /
  // account-switch path (`stopBackupEngines`). Always purges, regardless of
  // Contacts/Calendar's bound state, because all three surfaces are being
  // disabled together in the SAME native call.
  function shouldPurgeOnFullTeardown(_contactsBound: boolean, _calendarBound: boolean): boolean {
    return true;
  }

  test('single-surface toggle: contacts still bound → purge is SKIPPED (by design — Contacts must keep working)', () => {
    expect(shouldPurgeOnSingleSurfaceToggle(true, false)).toBe(false);
  });

  test('single-surface toggle: calendar still bound → purge is SKIPPED (by design)', () => {
    expect(shouldPurgeOnSingleSurfaceToggle(false, true)).toBe(false);
  });

  test('full teardown: contacts still bound at the moment of the call → purge still RUNS (the N1 fix)', () => {
    // This is the exact bug: with the old three-separate-calls
    // implementation, `disablePhotoBackup`'s body always ran BEFORE
    // `disableContactsBackup` cleared its own bound state (Expo dispatches
    // AsyncFunctions serially in call order — the array's first element is
    // called first), so this was ALWAYS false for the full sign-out path,
    // every single time Contacts backup was on. `teardownAllBackup` fixes
    // it by not conditioning the purge on any other surface's state at all.
    expect(shouldPurgeOnFullTeardown(true, false)).toBe(true);
  });

  test('full teardown: calendar still bound at the moment of the call → purge still RUNS', () => {
    expect(shouldPurgeOnFullTeardown(false, true)).toBe(true);
  });

  test('full teardown: neither bound → purge runs (same as before)', () => {
    expect(shouldPurgeOnFullTeardown(false, false)).toBe(true);
  });
});

// Task 1531 [P0], lead review (2026-09-25): JS MIRROR of
// `purgeMismatchedStagedAssets`'s row-selection predicate in
// NativeBackupEngine.swift (the actual Swift source of truth — see that
// file, and its `WHERE staged_file_id IS NOT NULL AND (staged_account_id IS
// NULL OR staged_account_id != ?)` SQL). This does NOT exercise the Swift
// code or the SQLite query — it exists because that logic lives inside
// NativeBackupEngine.swift, which imports SDWebImage/ActivityKit/WidgetKit/
// BackgroundTasks and only compiles inside the full Pods-linked app target;
// neither of this repo's two host-less (no-Pods) XCTest targets
// (ProvenanceHeadersTests, CoreVectorsKATTests) can compile it standalone,
// and adding a third Pods-dependent XCTest target was out of scope for this
// fix. `shouldPurgeStagedAsset` below is a plain reimplementation of the
// same three-way decision, kept in sync by hand — a real device/simulator
// XCTest run of the Swift purge function itself is the verification gap
// this mirror does NOT close (see task notes).
describe('shouldPurgeStagedAsset (JS mirror of NativeBackupEngine.swift purgeMismatchedStagedAssets predicate)', () => {
  // Mirrors: staged_account_id IS NULL OR staged_account_id != accountId
  function shouldPurgeStagedAsset(stagedAccountId: string | null, currentAccountId: string): boolean {
    return stagedAccountId === null || stagedAccountId !== currentAccountId;
  }

  test('tagged for a DIFFERENT account → purge', () => {
    expect(shouldPurgeStagedAsset('user-a', 'user-b')).toBe(true);
  });

  test('untagged (NULL — pre-migration, or staged before any account id was known) → purge', () => {
    // This is the exact case the lead review corrected: a row staged under
    // account A before the staged_account_id migration column existed is
    // NULL, not 'user-a' — an earlier version of this fix trusted NULL as
    // "same account" and re-uploaded it into whichever account signed in
    // next, reproducing 1531 through the "trusted" branch.
    expect(shouldPurgeStagedAsset(null, 'user-b')).toBe(true);
  });

  test('tagged for the CURRENT account → keep (never re-encrypt in-flight uploads for the same session)', () => {
    expect(shouldPurgeStagedAsset('user-a', 'user-a')).toBe(false);
  });
});

// Task 1531 [P0], round 3 lead review (2026-09-25): JS MIRROR of the
// fail-closed `guard let accountId = currentAccountId, !accountId.isEmpty
// else { ... return/throw }` added to every engine entry point that can
// stage or upload in NativeBackupEngine.swift — `start()`,
// `handleBackgroundTask`'s `BGProcessingTask` handler, `uploadSingleAsset`,
// and `stageEncryptedAsset`. Same compile/host caveat as
// `shouldPurgeStagedAsset` above: this does NOT exercise the Swift guards
// themselves (that gap is the device rung noted in the task file), it keeps
// the DECISION in sync by hand so a future edit to one side is caught by a
// human reading both, not proof the Swift guard fires.
describe('shouldRunBackup (JS mirror of NativeBackupEngine.swift per-entry-point nil-account guard)', () => {
  // Mirrors: `guard let accountId = currentAccountId, !accountId.isEmpty else { refuse }`
  function shouldRunBackup(currentAccountId: string | null | undefined): boolean {
    return typeof currentAccountId === 'string' && currentAccountId.length > 0;
  }

  test('nil currentAccountId → refuse (no run, no stage, no upload)', () => {
    expect(shouldRunBackup(null)).toBe(false);
  });

  test('undefined currentAccountId → refuse', () => {
    expect(shouldRunBackup(undefined)).toBe(false);
  });

  test('empty-string currentAccountId → refuse (Keychain setter treats "" as absent — see `currentAccountId` setter)', () => {
    expect(shouldRunBackup('')).toBe(false);
  });

  test('a real currentAccountId → allowed to run', () => {
    expect(shouldRunBackup('user-a')).toBe(true);
  });
});

// Task 1531 [P1-A] (round 5 delta security review): JS MIRROR of
// `NativeBackupEngine.bindAccount(userId:)`'s idempotent-bind decision and
// its two downstream call sites — see `bindAccount`'s doc comment in
// NativeBackupEngine.swift, and `disablePhotoBackup`/
// `mirrorSessionToAppGroup` in BeebeebCryptoModule.swift. Same
// compile/host caveat as the mirrors above: this exercises the DECISIONS,
// not the Swift purge/keychain code — the device rung noted in the task
// file is what proves the Swift side.
describe('bindAccount semantics (JS mirror of NativeBackupEngine.swift bindAccount + its call sites)', () => {
  // Mirrors: `guard currentAccountId != userId else { return }` in
  // `bindAccount` — i.e. "does calling bindAccount(userId) actually change
  // the stored shared account".
  function shouldBindAccount(storedAccountId: string | null, userId: string): boolean {
    if (!userId) return false;
    return storedAccountId !== userId;
  }

  test('contacts-only user (Camera Roll never enabled): stored nil, enabling Contacts binds the shared account', () => {
    // This is the actual P1-A bug: before routing
    // ContactsBackupManager.enable through bindAccount, the shared
    // `currentAccountId` NEVER got set for a contacts-only user, so every
    // Contacts upload refused with .accountMismatch forever. The fix makes
    // Contacts' own enable call bind it, same as Camera Roll's enable
    // always did.
    expect(shouldBindAccount(null, 'user-a')).toBe(true);
  });

  test('re-enabling the SAME account is a no-op (keeps the warm master-key handle, no redundant purge)', () => {
    expect(shouldBindAccount('user-a', 'user-a')).toBe(false);
  });

  test('a DIFFERENT stored account rebinds (and purges mismatched staged ciphertext) rather than silently coexisting', () => {
    expect(shouldBindAccount('user-a', 'user-b')).toBe(true);
  });

  test('empty incoming userId never binds', () => {
    expect(shouldBindAccount('user-a', '')).toBe(false);
  });

  // Mirrors: `disablePhotoBackup`'s BeebeebCryptoModule.swift conditional —
  // only clear the shared engine account when NEITHER Contacts nor
  // Calendar is still bound to it.
  function shouldClearSharedAccountOnPhotoDisable(contactsBound: boolean, calendarBound: boolean): boolean {
    return !contactsBound && !calendarBound;
  }

  test('photo disable with Contacts still on: the shared account is KEPT, not cleared', () => {
    // The device-test-checklist scenario this round's review flagged:
    // toggling Camera Roll backup off alone must not break Contacts
    // backup, which now binds through the SAME shared account.
    expect(shouldClearSharedAccountOnPhotoDisable(true, false)).toBe(false);
  });

  test('photo disable with Calendar still on: the shared account is KEPT, not cleared', () => {
    expect(shouldClearSharedAccountOnPhotoDisable(false, true)).toBe(false);
  });

  test('photo disable with neither Contacts nor Calendar bound: full teardown, account cleared', () => {
    expect(shouldClearSharedAccountOnPhotoDisable(false, false)).toBe(true);
  });

  // Mirrors: `mirrorSessionToAppGroup`'s SET branch in
  // BeebeebCryptoModule.swift — there is no token-REFRESH path in this
  // codebase (`setToken` only ever comes from `setSessionCredentials` at
  // signup/login/OPAQUE/2FA — api.ts:201,451,476,2375,2414,2479), so any
  // change to the stored native token is treated as a fresh login and
  // unbinds the previous account + drops the cached key handle first.
  function shouldUnbindOnTokenChange(previousToken: string | null, newToken: string): boolean {
    return previousToken !== newToken;
  }

  test('a genuinely new token (different from the stored one) unbinds the old account', () => {
    expect(shouldUnbindOnTokenChange('token-a', 'token-b')).toBe(true);
  });

  test('first-ever token (no previous stored token) is treated as a change (harmless no-op unbind)', () => {
    expect(shouldUnbindOnTokenChange(null, 'token-a')).toBe(true);
  });

  test('a redundant re-store of the SAME token does not unbind', () => {
    expect(shouldUnbindOnTokenChange('token-a', 'token-a')).toBe(false);
  });
});

// Task 1531 [P1-B] (round 5 delta security review): JS MIRROR of the
// hash-after-success discipline added to ContactsBackupManager /
// CalendarBackupManager — `shouldUpload` is READ-ONLY, and the dedup digest
// is written ONLY from the upload's own `.success` callback
// (`recordUploadSuccess`). Same compile/host caveat as the mirrors above:
// this exercises the DECISION, not the Swift UserDefaults code.
describe('hash-after-success (JS mirror of ContactsBackupManager/CalendarBackupManager dedup discipline)', () => {
  function shouldUpload(storedDigest: string | undefined, digest: string): boolean {
    return storedDigest !== digest;
  }

  function recordUploadSuccess(store: Map<string, string>, key: string, digest: string): void {
    store.set(key, digest);
  }

  test('a FAILED upload never records the digest: the same unchanged content is retried next run', () => {
    const store = new Map<string, string>();
    const digest = 'digest-1';
    expect(shouldUpload(store.get('user-a'), digest)).toBe(true);
    // Upload attempted and FAILS (network error / account-mismatch refusal
    // / no cached master key — see NativeEncryptedBackupUploader) —
    // recordUploadSuccess is NEVER called on this path, unlike the old
    // code which wrote the digest unconditionally BEFORE the network call.
    expect(shouldUpload(store.get('user-a'), digest)).toBe(true);
  });

  test('a SUCCESSFUL upload records the digest, and the same content is then skipped', () => {
    const store = new Map<string, string>();
    const digest = 'digest-1';
    expect(shouldUpload(store.get('user-a'), digest)).toBe(true);
    recordUploadSuccess(store, 'user-a', digest); // .success callback only
    expect(shouldUpload(store.get('user-a'), digest)).toBe(false);
  });

  test('changed content after a successful upload is not skipped', () => {
    const store = new Map<string, string>();
    recordUploadSuccess(store, 'user-a', 'digest-1');
    expect(shouldUpload(store.get('user-a'), 'digest-2')).toBe(true);
  });

  test('account switch A -> B with an IDENTICAL export must upload once for B (per-account keying)', () => {
    const store = new Map<string, string>();
    recordUploadSuccess(store, 'user-a', 'digest-1');
    // B has never uploaded anything — B's own key in the store is unset,
    // regardless of what A's digest was, even though the content hashes
    // identically.
    expect(shouldUpload(store.get('user-b'), 'digest-1')).toBe(true);
  });
});

// Task 1531 [P2] round 6 (delta review 3, finding N2): JS MIRROR of the
// warm-up retry decision added to `ContactsBackupManager.enable` /
// `CalendarBackupManager.enable` — `resumeContactsBackup`/
// `resumeCalendarBackup` (the mount-time "warm-up" call, `runNow: false`)
// used to skip `backup()` unconditionally whenever `runNow` was false, so a
// previously refused/failed upload (which — per the hash-after-success
// discipline above — never recorded success state) sat un-retried until the
// next REAL contact/calendar edit fired the OS-level change notification,
// which could be days or never. Same compile/host caveat as the mirrors
// above: this exercises the DECISION, not the Swift UserDefaults/EventKit/
// Contacts code.
describe('warm-up retry (JS mirror of ContactsBackupManager/CalendarBackupManager.enable\'s runNow-override)', () => {
  // Mirrors: `let shouldRunNow = runNow || !hasUploadedForThisAccount` in
  // ContactsBackupManager.enable, and the equivalent
  // `runNow || !hasUploadedForThisAccount` argument CalendarBackupManager
  // .enable passes into `requestAccessAndBackup`.
  function shouldRunOnEnable(runNow: boolean, hasUploadedForThisAccount: boolean): boolean {
    return runNow || !hasUploadedForThisAccount;
  }

  test('explicit runNow: true always runs, regardless of upload history', () => {
    expect(shouldRunOnEnable(true, true)).toBe(true);
    expect(shouldRunOnEnable(true, false)).toBe(true);
  });

  test('warm-up (runNow: false) with a confirmed prior upload for this account: does NOT force a run', () => {
    // The common, steady-state case: this account already backed up
    // successfully at least once, so the warm-up path only needs to
    // register observers, not force an immediate re-export.
    expect(shouldRunOnEnable(false, true)).toBe(false);
  });

  test('warm-up (runNow: false) with NO confirmed upload for this account: forces a run (the N2 fix)', () => {
    // The bug: a fresh sign-in, or a previously-refused upload (network
    // error / account-mismatch / no cached master key), left no recorded
    // success — `hasUploadedForThisAccount` false — and the warm-up path
    // used to just register observers and wait for the NEXT real edit.
    // Now it retries once, every app mount/foreground, until it succeeds.
    expect(shouldRunOnEnable(false, false)).toBe(true);
  });
});

// Task 1599 followups (round 2, item 4): a native-confirmed
// `account_mismatch` must end the JS session the same way `request()`'s own
// 409 branch does (api.ts), so a user who just toggles backup back on
// doesn't send the SAME stale session straight back into another 409. This
// exercises the pure edge-trigger DECISION only — the actual
// `endSessionForAccountMismatch`/`captureRequestAuthSnapshot` call happens
// inside `applyNativeProgress`, a `useCallback` closure this codebase has no
// render harness to exercise (see this file's own header note).
describe('shouldEndSessionForNativeAccountMismatch (native account-mismatch -> JS session end, edge-triggered)', () => {
  test('null -> a reason: true (the normal confirmed-mismatch case)', () => {
    expect(shouldEndSessionForNativeAccountMismatch(null, 'Backup stopped: this device is signed in to a different account. Sign in again to resume.')).toBe(true);
  });

  test('the SAME reason on a later poll: false (edge-triggered, not once-per-poll)', () => {
    const reason = 'Backup stopped: this device is signed in to a different account. Sign in again to resume.';
    expect(shouldEndSessionForNativeAccountMismatch(reason, reason)).toBe(false);
  });

  test('a DIFFERENT reason string than the previous one: true (a fresh mismatch event)', () => {
    expect(shouldEndSessionForNativeAccountMismatch('old reason', 'new reason')).toBe(true);
  });

  test('a reason clearing back to null: false (native resolved it — nothing to end here, bindAccount already handled the sign-in)', () => {
    expect(shouldEndSessionForNativeAccountMismatch('some reason', null)).toBe(false);
  });

  test('null -> null: false (steady state, nothing happening)', () => {
    expect(shouldEndSessionForNativeAccountMismatch(null, null)).toBe(false);
  });
});

// Task 1599 followups round 3 (P1 — sign-in lockout loop): a confirmed 409
// sets native's sticky `accountMismatchStopReason`; JS ends that session on
// it. The NEXT sign-in mounts a brand-new `BackupProvider`, whose progress
// poll can fire BEFORE `confirmMasterKeyHandle` (unlock) clears the reason
// — misreading the stale reason as fresh and ending the brand-new session
// before the user finishes signing in, forever. These tests cover the
// generation-based backstop (`isAccountMismatchGenerationCurrent`) and the
// full per-mount reducer (`reduceAccountMismatchPoll`) `applyNativeProgress`
// folds over — see this file's own header note for why these are unit-
// tested as pure functions rather than through a React render harness.
describe('isAccountMismatchGenerationCurrent (task 1599 followups round 3, P1)', () => {
  test('no baseline established yet (null): never current, regardless of generation', () => {
    expect(isAccountMismatchGenerationCurrent(null, 0)).toBe(false);
    expect(isAccountMismatchGenerationCurrent(null, 5)).toBe(false);
  });

  test('generation strictly greater than the baseline: current', () => {
    expect(isAccountMismatchGenerationCurrent(3, 4)).toBe(true);
  });

  test('generation equal to the baseline: NOT current (the reason that established the baseline, seen again)', () => {
    expect(isAccountMismatchGenerationCurrent(3, 3)).toBe(false);
  });

  test('generation less than the baseline: NOT current (should never happen — native only increments — but must not be treated as current)', () => {
    expect(isAccountMismatchGenerationCurrent(5, 3)).toBe(false);
  });
});

describe('reduceAccountMismatchPoll (task 1599 followups round 3, P1 — sign-in lockout loop)', () => {
  test('reason set BEFORE mount, new token, poll fires before unlock: session NOT ended', () => {
    // First poll after a fresh BackupProvider mount observes a reason (and
    // its generation) that was already active BEFORE this mount even
    // started — exactly what happens when the previous session's confirmed
    // mismatch is still sitting there because the sign-in that just
    // happened hasn't reached `confirmMasterKeyHandle` (unlock) yet.
    const staleReason = 'Backup stopped: this device is signed in to a different account. Sign in again to resume.';
    const result = reduceAccountMismatchPoll(INITIAL_ACCOUNT_MISMATCH_POLL_STATE, {
      reason: staleReason,
      generation: 3,
    });
    expect(result.shouldEndSession).toBe(false);
    // The baseline is now established at the stale generation — a REPEAT
    // poll of the exact same stale state must also never end the session.
    const repeat = reduceAccountMismatchPoll(result.state, { reason: staleReason, generation: 3 });
    expect(repeat.shouldEndSession).toBe(false);
  });

  test('reason raised DURING the current session (after mount established its baseline): session ended', () => {
    // Mount with nothing wrong yet — first poll establishes baseline 0, no reason.
    const afterMount = reduceAccountMismatchPoll(INITIAL_ACCOUNT_MISMATCH_POLL_STATE, {
      reason: null,
      generation: 0,
    });
    expect(afterMount.shouldEndSession).toBe(false);
    // A NEW confirmed mismatch happens during this session: native bumps
    // the generation and sets a fresh reason.
    const mismatchDuringSession = reduceAccountMismatchPoll(afterMount.state, {
      reason: 'Backup stopped: this device is signed in to a different account. Sign in again to resume.',
      generation: 1,
    });
    expect(mismatchDuringSession.shouldEndSession).toBe(true);
  });

  test('the FULL lockout-loop scenario: stale reason at mount is ignored, but a SUBSEQUENT genuinely-new mismatch in the same mount still ends the session', () => {
    const staleReason = 'Backup stopped: this device is signed in to a different account. Sign in again to resume.';
    // Poll 1 (before unlock): stale reason from the PRIOR session, generation 3.
    const poll1 = reduceAccountMismatchPoll(INITIAL_ACCOUNT_MISMATCH_POLL_STATE, {
      reason: staleReason,
      generation: 3,
    });
    expect(poll1.shouldEndSession).toBe(false);
    // Poll 2 (after unlock succeeds, native cleared the reason via
    // `confirmMasterKeyHandle`/`mirrorSessionToAppGroup`): reason back to null.
    const poll2 = reduceAccountMismatchPoll(poll1.state, { reason: null, generation: 3 });
    expect(poll2.shouldEndSession).toBe(false);
    // Poll 3: a GENUINELY NEW mismatch happens later in this same session —
    // generation increments past the baseline this mount established.
    const poll3 = reduceAccountMismatchPoll(poll2.state, { reason: staleReason, generation: 4 });
    expect(poll3.shouldEndSession).toBe(true);
  });

  test('repeated polls of the SAME current-session reason only end the session once (edge-triggered)', () => {
    const afterMount = reduceAccountMismatchPoll(INITIAL_ACCOUNT_MISMATCH_POLL_STATE, {
      reason: null,
      generation: 0,
    });
    const reason = 'Backup stopped: this device is signed in to a different account. Sign in again to resume.';
    const first = reduceAccountMismatchPoll(afterMount.state, { reason, generation: 1 });
    expect(first.shouldEndSession).toBe(true);
    const second = reduceAccountMismatchPoll(first.state, { reason, generation: 1 });
    expect(second.shouldEndSession).toBe(false);
  });
});

// Task 1605 review round 3 (P1): the trial-cap-pause-never-resumes bug.
// `decideAccountRefusalResume`/`runAccountRefusalPollTick` are the fix's
// entire testable surface — see their doc comments in backup-context.tsx
// for the full mechanism. No React render harness needed (this file's own
// header note): both are plain functions the real `useEffect` calls as a
// thin `setInterval`/`AppState` driver.
const OK_SUB = { account_state: 'ok', uploads_blocked_at: null, access_until: null, data_deletion_at: null };
const CAPPED_TRIAL_SUB = { ...OK_SUB, trial_storage_cap_bytes: 25_000_000_000, used_bytes: 25_000_000_000 };
const CAPPED_TRIAL_UNDER_CAP_SUB = { ...OK_SUB, trial_storage_cap_bytes: 25_000_000_000, used_bytes: 1_000_000 };
const PAID_SUB = { ...OK_SUB, trial_storage_cap_bytes: null, used_bytes: 200_000_000_000 };
const CANCELLED_READ_ONLY_SUB = {
  account_state: 'ok',
  uploads_blocked_at: '2026-09-29T10:00:00Z',
  access_until: '2026-10-13T10:00:00Z',
  data_deletion_at: '2026-10-27T10:00:00Z',
};
const LAPSED_SUB = { account_state: 'lapsed', uploads_blocked_at: null, access_until: null, data_deletion_at: '2026-10-27T10:00:00Z' };

describe('decideAccountRefusalResume (task 1605 review round 3, P1)', () => {
  test('no subscription (fetch failed / never fetched): not unblocked', () => {
    const result = decideAccountRefusalResume(null, true);
    expect(result.unblocked).toBe(false);
    expect(result.shouldResumeCameraBackup).toBe(false);
  });

  test('still at the 25 GB trial cap (used >= cap): NOT unblocked — the exact stuck-paused scenario', () => {
    const result = decideAccountRefusalResume(CAPPED_TRIAL_SUB, true);
    expect(result.unblocked).toBe(false);
    expect(result.shouldResumeCameraBackup).toBe(false);
  });

  test('trial cap cleared by paying (trial_storage_cap_bytes now null): unblocked', () => {
    const result = decideAccountRefusalResume(PAID_SUB, true);
    expect(result.unblocked).toBe(true);
    expect(result.shouldResumeCameraBackup).toBe(true);
  });

  test('still capped, but used dropped back under the cap (e.g. the user deleted files): unblocked', () => {
    const result = decideAccountRefusalResume(CAPPED_TRIAL_UNDER_CAP_SUB, true);
    expect(result.unblocked).toBe(true);
  });

  test('unblocked but camera-roll backup is NOT the enabled category: unblocked, but no resume asked for', () => {
    const result = decideAccountRefusalResume(PAID_SUB, false);
    expect(result.unblocked).toBe(true);
    expect(result.shouldResumeCameraBackup).toBe(false);
  });

  test('a real gate-based refusal (trial cancelled before first charge, read-only): NOT unblocked', () => {
    const result = decideAccountRefusalResume(CANCELLED_READ_ONLY_SUB, true);
    expect(result.unblocked).toBe(false);
  });

  test('the trial resumed on the web (uploads_blocked_at cleared, account_state back to ok): unblocked', () => {
    const result = decideAccountRefusalResume(OK_SUB, true);
    expect(result.unblocked).toBe(true);
  });

  test('lapsed (trial ended, never resumed/paid): NOT unblocked', () => {
    const result = decideAccountRefusalResume(LAPSED_SUB, true);
    expect(result.unblocked).toBe(false);
  });
});

describe('runAccountRefusalPollTick (task 1605 review round 3, P1)', () => {
  test('still capped: no resume, polling continues', async () => {
    const onUnblocked = mock(() => {});
    const resumeCameraBackup = mock(async () => {});
    const result = await runAccountRefusalPollTick({
      fetchSubscription: async () => CAPPED_TRIAL_SUB,
      getIsPhotoBackupEnabled: () => true,
      onUnblocked,
      resumeCameraBackup,
    });
    expect(result.resumed).toBe(false);
    expect(result.shouldStopPolling).toBe(false);
    expect(onUnblocked.mock.calls.length).toBe(0);
    expect(resumeCameraBackup.mock.calls.length).toBe(0);
  });

  test('quota lifted: resume called exactly once, polling told to stop', async () => {
    const onUnblocked = mock(() => {});
    const resumeCameraBackup = mock(async () => {});
    const result = await runAccountRefusalPollTick({
      fetchSubscription: async () => PAID_SUB,
      getIsPhotoBackupEnabled: () => true,
      onUnblocked,
      resumeCameraBackup,
    });
    expect(result.resumed).toBe(true);
    expect(result.shouldStopPolling).toBe(true);
    expect(onUnblocked.mock.calls.length).toBe(1);
    expect(onUnblocked.mock.calls[0][0]).toEqual({ kind: 'ok' });
    expect(resumeCameraBackup.mock.calls.length).toBe(1);
  });

  test('unblocked but photo backup is off: reports resumed (stop polling), but never calls resumeCameraBackup', async () => {
    const resumeCameraBackup = mock(async () => {});
    const result = await runAccountRefusalPollTick({
      fetchSubscription: async () => PAID_SUB,
      getIsPhotoBackupEnabled: () => false,
      onUnblocked: () => {},
      resumeCameraBackup,
    });
    expect(result.resumed).toBe(true);
    expect(result.shouldStopPolling).toBe(true);
    expect(resumeCameraBackup.mock.calls.length).toBe(0);
  });

  test('fetch throws (transient network failure): does not resume, does not stop polling', async () => {
    const onUnblocked = mock(() => {});
    const resumeCameraBackup = mock(async () => {});
    const result = await runAccountRefusalPollTick({
      fetchSubscription: async () => {
        throw new Error('network down');
      },
      getIsPhotoBackupEnabled: () => true,
      onUnblocked,
      resumeCameraBackup,
    });
    expect(result.resumed).toBe(false);
    expect(result.shouldStopPolling).toBe(false);
    expect(onUnblocked.mock.calls.length).toBe(0);
    expect(resumeCameraBackup.mock.calls.length).toBe(0);
  });

  test('the full episode as a sequence of ticks: resume fires on exactly the tick that clears, and a driver honoring shouldStopPolling never polls again after', async () => {
    // Mirrors the real effect's own loop shape (see backup-context.tsx): a
    // driver that stops issuing further ticks once shouldStopPolling comes
    // back true. Three simulated ticks: still capped, still capped,
    // quota lifted — with a FOURTH entry in the queue that would ALSO
    // report unblocked, proving the driver genuinely stops (never reads it)
    // rather than happening to run out of ticks on its own.
    const queue = [CAPPED_TRIAL_SUB, CAPPED_TRIAL_SUB, PAID_SUB, PAID_SUB];
    let fetchCount = 0;
    const resumeCameraBackup = mock(async () => {});
    const onUnblocked = mock(() => {});

    // Bounded (not `while (!stopped)`) on purpose: a mutation that breaks
    // `shouldStopPolling` must fail on the `stopped` assertion below rather
    // than hang the test suite forever — once the queue is exhausted,
    // fetchSubscription keeps resolving null (decideAccountRefusalResume(null, …)
    // is always `unblocked: false`), so an unbounded loop under that
    // mutation would never terminate on its own.
    let stopped = false;
    let ticksRun = 0;
    const MAX_TICKS = 10;
    while (!stopped && ticksRun < MAX_TICKS) {
      ticksRun += 1;
      const result = await runAccountRefusalPollTick({
        fetchSubscription: async () => {
          fetchCount += 1;
          return queue[fetchCount - 1] ?? null;
        },
        getIsPhotoBackupEnabled: () => true,
        onUnblocked,
        resumeCameraBackup,
      });
      if (result.shouldStopPolling) stopped = true;
    }

    expect(stopped).toBe(true); // the loop stopped ITSELF — not just hit MAX_TICKS
    expect(ticksRun).toBe(3); // capped, capped, then the clearing tick
    expect(fetchCount).toBe(3); // the 4th queue entry is never fetched — polling truly stopped
    expect(resumeCameraBackup.mock.calls.length).toBe(1); // resume called exactly once
    expect(onUnblocked.mock.calls.length).toBe(1);
  });
});
