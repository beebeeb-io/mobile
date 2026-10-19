// @ts-nocheck
/**
 * Task 1667 round 9 (Codex P1 "Delete retained marks during permanent account
 * deletion", mobile#182 at dacc089d).
 *
 * The bug: DeleteAccountScreen purged with the ordinary sign-out purge, whose
 * native reset keeps every unmarked camera-roll upload as a pending mark for
 * 30 days, and the signOut() that followed did the same again. The deleted
 * account's user id, PhotoKit identifiers and file ids stayed on the device.
 *
 * Asserted here (the native reset itself is covered on real SQLite by
 * scripts/swift-tests/manifest-account-deletion-test.swift):
 *   (c) wiring guards: DeleteAccountScreen passes mode 'account-deleted' and
 *       the account id; App.tsx makes the account-deleted-elsewhere purge a
 *       deletion, clears it at the next session, and skips the sign-out mark
 *       flush after a deletion; the native module and engine pass the mode
 *       through to the reset;
 *   - the REAL account-cleanup.ts hands the mode to the native purge, keeps it
 *     for the follow-up purges (signOut(), the signed-out surface) until a
 *     new session, never downgrades it, and leaves an ordinary sign-out as it
 *     was (regression);
 *   - after a deletion the backup folder cache must be confirmed gone.
 * Mocks follow account-cleanup.1667-backup-manifest.test.ts (isolated runner).
 */
import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as Record<string, unknown>).__DEV__ = false;
(globalThis as Record<string, unknown>).expo = {
  EventEmitter: class {
    addListener = () => ({ remove: () => {} });
    removeAllListeners = () => {};
  },
  modules: {},
};

mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
  readAsStringAsync: async () => '',
  writeAsStringAsync: async () => {},
  createDownloadResumable: () => ({ downloadAsync: async () => ({ uri: 'file:///offline/x' }) }),
}));

const secure = new Map<string, string>();
let secureDeleteFails = false;
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => {
    if (secureDeleteFails) throw new Error('keychain busy');
    secure.delete(k);
  },
}));

mock.module('react-native', () => {
  const noopEmitter = { addListener: () => ({ remove: () => {} }), emit: () => {}, removeAllListeners: () => {} };
  return {
    Platform: { OS: 'ios', select: (o) => o.ios ?? o.default ?? o.android },
    TurboModuleRegistry: { getEnforcing: () => ({}), get: () => null },
    AppRegistry: { registerRunnable: () => {}, getRunnable: () => null, registerComponent: () => {}, getComponent: () => null },
    NativeModules: {},
    DeviceEventEmitter: noopEmitter,
    NativeEventEmitter: class { addListener = () => ({ remove: () => {} }); removeAllListeners = () => {}; },
    InteractionManager: { runAfterInteractions: (cb) => { cb(); return { cancel: () => {} }; } },
    PixelRatio: { get: () => 2 },
  };
});

mock.module('./api', () => ({
  getDownloadUrl: (fileId: string) => `https://api.test/download/${fileId}`,
  getToken: async () => 'test-token',
  fetchPhotoBackupIdentifierMap: async () => ({}),
  photoBackupClearAssociation: async () => {},
  clearCachedFileIndex: async () => {},
  sweepAllUploadResumeStates: async () => {},
}));
mock.module('./name-cache', () => ({ clearNameCache: async () => {} }));
mock.module('./thumbnail-cache', () => ({ clearThumbnailCache: async () => {} }));
mock.module('./native-decrypt', () => ({ clearPreviewCache: async () => {} }));
mock.module('./photo-cache', () => ({ clearPhotoCache: async () => {} }));
mock.module('./caches-plaintext-registry', () => ({
  purgeCachesPlaintext: async () => ({ removed: [], failed: [] }),
}));
mock.module('./local-identifier-map', () => ({ clearLocalIdentifierMap: async () => {} }));

/** What each native purge was asked to do. */
const nativeCalls: Array<{ mode: string | undefined; deletedAccountIds: string[] | undefined }> = [];
mock.module('../../modules/beebeeb-crypto', () => ({
  purgePlaintextStorage: async (options?: { mode?: string; deletedAccountIds?: string[] }) => {
    nativeCalls.push({ mode: options?.mode, deletedAccountIds: options?.deletedAccountIds });
    return { removed: 0, failed: 0 };
  },
  finishBackupManifestPurge: async () => ({ ok: 1, unlinked: 0 }),
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
  decryptLocalFileNative: async () => { throw new Error('not exercised in this file'); },
  downloadAndDecryptFileNative: async () => { throw new Error('not exercised in this file'); },
  isNativeAvailable: true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => null,
  uploadChunksNative: async () => { throw new Error('not exercised in this file'); },
  logDiagnostic: () => {},
}));

const cleanup = await import('./account-cleanup');
const { BACKUP_FOLDER_CACHE_KEY } = await import('./backup-folder-cache');

const repo = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(repo, rel), 'utf8');

beforeEach(() => {
  nativeCalls.length = 0;
  // Optional call: on the pre-round-9 code (red run) it does not exist, and
  // each test must fail on its own assertion, not in this hook.
  cleanup.clearAccountDeletionPurge?.();
  secureDeleteFails = false;
  secure.clear();
});

describe('(c) wiring guards: every account-deletion purge passes mode account-deleted', () => {
  test('DeleteAccountScreen purges with mode account-deleted and the signed-in account id', () => {
    const src = read('src/screens/DeleteAccountScreen.tsx');
    expect(src).toMatch(/purgeAllPlaintextCaches\(\{\s*mode:\s*'account-deleted',\s*accountId:\s*deletedAccountId\s*\}\)/);
    expect(src).toMatch(/const deletedAccountId = user\?\.user_id \?\? null;/);
    expect(src).toMatch(/const \{ user, signOut \} = useAuth\(\);/);
    // The purge is a lambda now; passing the bare function runs a sign-out purge.
    expect(src).not.toMatch(/purge:\s*purgeAllPlaintextCaches\s*[,}]/);
  });

  test('App.tsx: deleted elsewhere is a deletion, the next session clears it, no mark flush after one', () => {
    const src = read('src/App.tsx');
    const handler = src.slice(src.indexOf('registerAccountDeletedHandler(('), src.indexOf('registerAccountDeletedHandler((') + 1000);
    // Round 14 (item 2): at a cold start the stored key's owner names the account.
    expect(handler).toMatch(/noteAccountDeleted\(accountIdForDeletedElsewhere\(currentUserIdRef\.current, coldStartOwnerRef\.current\)\);\s*\n\s*setUser\(null\)/);
    // Round 15 (item 5): cleared when the user becomes null.
    expect(src).toMatch(/currentUserIdRef\.current = user \? user\.user_id : null;/);
    expect(src).toMatch(/signedOutPurger\.sessionStarted\(\);[^\n]*\n\s*setUser\(me\);\n(?:\s*\/\/[^\n]*\n)*\s*clearAccountDeletionPurge\(\);/);
    expect(src).toMatch(/if \(Platform\.OS === 'ios' && !accountDeletionPurgePending\(\)\) \{\s*\n\s*await flushMarksBeforeSignOut/);
  });

  test('the JS wrapper, the native module and the engine pass the mode through to the reset', () => {
    const wrapper = read('modules/beebeeb-crypto/src/BeebeebCrypto.ts');
    expect(wrapper).toMatch(/BeebeebCryptoModule\.purgePlaintextStorage\(\s*options\.mode \?\? 'sign-out',\s*options\.deletedAccountIds \?\? \[\],\s*\)/);
    const module = read('modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift');
    expect(module).toContain('AsyncFunction("purgePlaintextStorage") { (mode: String?, deletedAccountIds: [String]?) -> [String: Int] in');
    expect(module).toMatch(/let purgeMode = ManifestPurgeMode\.parse\(mode\)\s*\n\s*let manifest = NativeBackupEngine\.shared\.prepareForStoragePurge\(\s*mode: purgeMode, deletedAccountIds: Set\(deletedAccountIds \?\? \[\]\)\s*\)/);
    const engine = read('modules/beebeeb-crypto/ios/NativeBackupEngine.swift');
    // Round 13 (review item 3): with whether the outgoing account is only remembered.
    expect(engine).toMatch(/manifestHandle\.resetForSignOut\(\s*outgoingAccountId: outgoing\.accountId, outgoingInferred: outgoing\.inferred,\s*mode: mode, deletedAccountIds: deletedAccountIds\s*\)/);
    expect(engine).toMatch(/discardPending: \.userDefaults\(NativeBackupEngine\.manifestResetDiscardPendingKey\)/);
  });
});

describe('account-cleanup: the purge mode reaches the native purge', () => {
  test('(b) an ordinary sign-out purge is a sign-out (regression)', async () => {
    await cleanup.purgeAllPlaintextCaches();
    expect(nativeCalls).toEqual([{ mode: 'sign-out', deletedAccountIds: [] }]);
  });

  test('account deletion: mode account-deleted with the account id', async () => {
    await cleanup.purgeAllPlaintextCaches({ mode: 'account-deleted', accountId: 'acct-A' });
    expect(nativeCalls).toEqual([{ mode: 'account-deleted', deletedAccountIds: ['acct-A'] }]);
  });

  test('the follow-up purges (signOut(), the signed-out surface) stay account-deleted until a new session', async () => {
    await cleanup.purgeAllPlaintextCaches({ mode: 'account-deleted', accountId: 'acct-A' });
    await cleanup.purgeAllPlaintextCaches(); // signOut()'s own purge
    await cleanup.purgeAllPlaintextCaches({ mode: 'sign-out' }); // never downgraded
    expect(nativeCalls.map((c) => c.mode)).toEqual(['account-deleted', 'account-deleted', 'account-deleted']);
    expect(nativeCalls.every((c) => c.deletedAccountIds?.includes('acct-A'))).toBe(true);
    expect(cleanup.accountDeletionPurgePending()).toBe(true);
    cleanup.clearAccountDeletionPurge(); // App.tsx refreshAuth: a new session
    await cleanup.purgeAllPlaintextCaches();
    expect(nativeCalls[3]).toEqual({ mode: 'sign-out', deletedAccountIds: [] });
  });

  test('deleted elsewhere: noteAccountDeleted makes the signed-out purge a deletion of that account', async () => {
    cleanup.noteAccountDeleted('acct-B');
    await cleanup.purgeAllPlaintextCaches();
    expect(nativeCalls).toEqual([{ mode: 'account-deleted', deletedAccountIds: ['acct-B'] }]);
  });

  // Task 1667 round 14 (review of mobile#182 at 18312919, item 2): the app
  // cold-starts with A's stored session; refreshAuth reads the stored key's
  // owner (A) before getMe, and getMe answers 403 account_deleted before any
  // user is set. The handler's account is what the purge names; native then
  // discards ONLY A's kept marks (manifest-account-deletion-test e7), so C's
  // kept marks survive. Before, it named nobody and native discarded every
  // kept mark on the device (C's too).
  test('r14-2.1 cold-start deletion: the stored key owner is named, so only that account is discarded', async () => {
    const id = cleanup.accountIdForDeletedElsewhere(null, 'acct-A'); // currentUserIdRef null at cold start
    cleanup.noteAccountDeleted(id);
    await cleanup.purgeAllPlaintextCaches(); // the signed-out surface's purge
    expect(nativeCalls).toEqual([{ mode: 'account-deleted', deletedAccountIds: ['acct-A'] }]);
    expect(nativeCalls[0].deletedAccountIds).not.toContain('acct-C');
  });

  test('r14-2.2 the signed-in user wins over the cold-start owner; neither known: no name (fail closed)', async () => {
    expect(cleanup.accountIdForDeletedElsewhere('acct-B', 'acct-A')).toBe('acct-B');
    expect(cleanup.accountIdForDeletedElsewhere(null, null)).toBe(null);
    expect(cleanup.accountIdForDeletedElsewhere(undefined, '')).toBe(null);
    cleanup.noteAccountDeleted(cleanup.accountIdForDeletedElsewhere(null, null));
    await cleanup.purgeAllPlaintextCaches();
    expect(nativeCalls).toEqual([{ mode: 'account-deleted', deletedAccountIds: [] }]);
  });

  test('a deletion with no known account id is still a deletion (the native side uses its own account)', async () => {
    await cleanup.purgeAllPlaintextCaches({ mode: 'account-deleted', accountId: null });
    expect(nativeCalls).toEqual([{ mode: 'account-deleted', deletedAccountIds: [] }]);
  });

  test('purgeThenSignOut with the DeleteAccountScreen purge: both purges are account-deleted', async () => {
    const order: string[] = [];
    await cleanup.purgeThenSignOut({
      purge: () => cleanup.purgeAllPlaintextCaches({ mode: 'account-deleted', accountId: 'acct-A' }),
      signOut: async () => {
        order.push('signOut');
        await cleanup.purgeAllPlaintextCaches(); // what runSignOut does
      },
    });
    expect(order).toEqual(['signOut']);
    expect(nativeCalls.map((c) => c.mode)).toEqual(['account-deleted', 'account-deleted']);
  });
});

describe('account deletion: the backup folder cache must be confirmed gone', () => {
  test('deleted and read back absent: not a failure', async () => {
    secure.set(BACKUP_FOLDER_CACHE_KEY, '{"root":"f1"}');
    const r = await cleanup.purgeAllPlaintextCaches({ mode: 'account-deleted', accountId: 'acct-A' });
    expect(secure.has(BACKUP_FOLDER_CACHE_KEY)).toBe(false);
    expect(r.failed).toBe(0);
  });

  test('a delete that fails is a counted failure after a deletion, best-effort after a sign-out', async () => {
    secure.set(BACKUP_FOLDER_CACHE_KEY, '{"root":"f1"}');
    secureDeleteFails = true;
    const signOut = await cleanup.purgeAllPlaintextCaches();
    expect(signOut.failed).toBe(0);
    const deletion = await cleanup.purgeAllPlaintextCaches({ mode: 'account-deleted', accountId: 'acct-A' });
    expect(deletion.failed).toBe(1);
  });
});
