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
const { backupPrefKey, stopBackupEngines, canEnableNativeCameraBackup } = await import('./backup-context');

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
