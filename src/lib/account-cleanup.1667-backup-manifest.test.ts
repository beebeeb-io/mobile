// @ts-nocheck
/**
 * Task 1667 (item 1) + 1962 Bug 4 — what sign-out does to the camera-roll
 * backup manifest's JS handle and to the backup folder cache.
 *
 * Simulator evidence (_qa-evidence/1962/sim-dup/00-summary.txt): the native
 * purge unlinked Documents/SQLite/beebeeb-backup.db while BackupDatabase.ts
 * still held it open; the process kept using the deleted file, and the next
 * cold launch started from an empty manifest and uploaded every photo again.
 *
 * Asserted here, with the REAL account-cleanup.ts and BackupDatabase.ts and a
 * fake expo-sqlite that counts open/close:
 *   - the JS handle is never closed at sign-out: expo-sqlite bundles its own
 *     SQLite, and its close deleted -wal/-shm under the engine's connection
 *     (simulator rung, task 1667); the native side empties the file in place;
 *   - a JS database call made during the purge waits until the purge is done;
 *   - the `beebeeb_backup_folders` cache does not survive sign-out.
 * Mocks follow account-cleanup.test.ts (isolated runner rule).
 */
import { describe, expect, mock, test } from 'bun:test';

// expo's async-require setup reads the RN global `__DEV__` at import time;
// expo-modules-core's EventEmitter binds `globalThis.expo` — stub both before
// anything loads (same stubs offline-manager.persist.test.ts uses).
(globalThis as Record<string, unknown>).__DEV__ = false;
(globalThis as Record<string, unknown>).expo = {
  EventEmitter: class {
    addListener = () => ({ remove: () => {} });
    removeAllListeners = () => {};
  },
  modules: {},
};

// expo-file-system/legacy must be stubbed like the persist test does: the real
// legacy shim extends NativeModule, which is not constructable under bun's
// mock registry (offline-manager.ts imports it; account-cleanup uses deleteAsync).
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

// Same pattern: expo-secure-store's ExpoSecureStore.js requires the native
// module at import time — offline-manager.ts imports it; the stub covers
// getItemAsync/setItemAsync/deleteItemAsync (the only calls account-cleanup's
// graph makes).
const secure = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));

// react-native must be mocked HERE too: `./account-cleanup` transitively pulls
// the real `react-native/index.js` (Flow syntax — bun's parser rejects it) via
// clears that don't import it directly. Without this mock the file dies at
// import ("Unexpected typeof") — seen isolated 2026-10-02 (ac-alone2.log).
mock.module('react-native', () => {
  const noopEmitter = { addListener: () => ({ remove: () => {} }), emit: () => {}, removeAllListeners: () => {} };
  const base: Record<string, unknown> = {
    Platform: { OS: 'ios', select: (o) => o.ios ?? o.default ?? o.android },
    TurboModuleRegistry: { getEnforcing: () => ({}), get: () => null },
    AppRegistry: { registerRunnable: () => {}, getRunnable: () => null, registerComponent: () => {}, getComponent: () => null },
    NativeModules: {},
    DeviceEventEmitter: noopEmitter,
    NativeEventEmitter: class { addListener = () => ({ remove: () => {} }); removeAllListeners = () => {}; },
    InteractionManager: { runAfterInteractions: (cb) => { cb(); return { cancel: () => {} }; } },
    PixelRatio: { get: () => 2 },
  };
  return base;
});

// Mock './api' (like offline-manager.persist.test.ts does): the real api.ts
// drags RN's codegen Text path into the graph (expo-constants/sse chain) and
// bun's named-binding check rejects the real react-native index.js at import.
// account-cleanup only needs the two local-identifier-map fns to exist.
mock.module('./api', () => ({
  getDownloadUrl: (fileId: string) => `https://api.test/download/${fileId}`,
  getToken: async () => 'test-token',
  fetchPhotoBackupIdentifierMap: async () => ({}),
  photoBackupClearAssociation: async () => {},
  clearCachedFileIndex: async () => {},
  // Task 1683f — account-cleanup imports sweepAllUploadResumeStates from './api';
  // a missing name surfaces as "Export named 'X' not found" against the REAL
  // api.ts (bun checks named bindings against the real file even when mocked).
  sweepAllUploadResumeStates: async () => {},
}));

const purgeCalls: string[] = [];
mock.module('./name-cache', () => ({
  clearNameCache: async () => { purgeCalls.push('names'); },
}));
mock.module('./thumbnail-cache', () => ({
  clearThumbnailCache: async () => { purgeCalls.push('thumbnails'); },
}));
// Task 1593 — the decrypted preview cache (Library/Caches/preview/).
let previewClear: () => Promise<void> = async () => { purgeCalls.push('previews'); };
mock.module('./native-decrypt', () => ({
  clearPreviewCache: () => previewClear(),
}));
// Task 1593 round 2 (P1-A) — the decrypted photo cache.
mock.module('./photo-cache', () => ({
  clearPhotoCache: async () => { purgeCalls.push('photos'); },
}));
// Task 1593 round 2 (P2-E) — every other registered Library/Caches writer.
mock.module('./caches-plaintext-registry', () => ({
  // True counts (task 1683d): the real purge returns {removed, failed}; a
  // string[] stub here bled into other files' tests in combined bun runs
  // (mock.module is invocation-global) and undefined'd their result fields.
  purgeCachesPlaintext: async () => { purgeCalls.push('caches-registry'); return { removed: [], failed: [] }; },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  // All named exports any static importer in this file's graph needs:
  // account-cleanup.ts imports purgePlaintextStorage; plaintext-storage.ts
  // imports harden/audit; native-decrypt.ts (pulled transitively) statically
  // names decryptLocalFileNative/downloadAndDecryptFileNative/isNativeAvailable.
  // A missing name surfaces as "Export named 'X' not found" from the REAL
  // index.js — bun checks named bindings against the real file even when a
  // mock is registered (seen: ac-alone4/5.log).
  purgePlaintextStorage: async () => nativePurge(),
  finishBackupManifestPurge: async (allowUnlink: boolean) => nativeFinish(allowUnlink),
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
  decryptLocalFileNative: async () => { throw new Error('not exercised in this file'); },
  downloadAndDecryptFileNative: async () => { throw new Error('not exercised in this file'); },
  isNativeAvailable: true,
  // api.ts statically names these three; ./api is mocked in this file, but bun
  // resolves named bindings against the REAL index.js regardless — provide them.
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => null,
  uploadChunksNative: async () => { throw new Error('not exercised in this file'); },
  // runtime-trace.ts (dynamically imported by plaintext-gate.ts:236) statically
  // names logDiagnostic — a missing name falls back to the REAL index.js check
  // and dies on RN's codegen Text pull (ac-alone7/9.log).
  logDiagnostic: () => {},
}));

// Mock './local-identifier-map' at the leaf account-cleanup uses: the real
// module statically drags ./thumbnail → expo-media-library/legacy → RN's
// codegen Text path, which bun's named-binding check rejects against the real
// react-native/index.js (ac-alone7..11.log whack-a-mole). Mocking the leaf
// keeps that whole chain out of the graph.
mock.module('./local-identifier-map', () => ({
  clearLocalIdentifierMap: async () => {},
}));


// ---- fake expo-sqlite: counts live handles ---------------------------------
let opened = 0;
let closed = 0;
let nextId = 0;
const events: string[] = [];
const usedAfterClose: number[] = [];
let closeFails = false;
let readGate: Promise<void> | null = null;
class FakeDb {
  id = ++nextId;
  isClosed = false;
  private use(): void {
    if (this.isClosed) usedAfterClose.push(this.id);
    if (nativeRunning) callsDuringNative.push(this.id);
  }
  async execAsync(): Promise<void> { this.use(); }
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    this.use();
    if (/PRAGMA\s+user_version/i.test(sql)) return { user_version: 99 } as T;
    if (/COUNT/i.test(sql)) return { n: 0, c: 0, count: 0 } as T;
    return null;
  }
  async getAllAsync(): Promise<unknown[]> {
    this.use();
    if (readGate) {
      events.push(`read-start:${this.id}`);
      await readGate;
      events.push(`read-end:${this.id}`);
    }
    return [];
  }
  async runAsync(): Promise<{ changes: number }> { this.use(); return { changes: 0 }; }
  async closeAsync(): Promise<void> {
    events.push(`close:${this.id}`);
    if (closeFails) throw new Error('close failed');
    this.isClosed = true;
    closed += 1;
  }
}
let openGate: Promise<void> | null = null;
let nativeRunning = false;
const callsDuringNative: number[] = [];
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    if (openGate) await openGate;
    opened += 1;
    return new FakeDb();
  },
}));

const live = () => opened - closed;
let duringPurge: (() => Promise<void>) | null = null;
let liveAtNativePurge = -1;
let liveAtNativePurgeEnd = -1;
let nativeResult: Record<string, number> = { removed: 0, failed: 0 };
async function nativePurge() {
  purgeCalls.push('native');
  events.push('native-purge');
  liveAtNativePurge = live();
  nativeRunning = true;
  if (duringPurge) await duringPurge();
  else await new Promise((r) => setTimeout(r, 10));
  nativeRunning = false;
  liveAtNativePurgeEnd = live();
  return nativeResult;
}
let finishResult = { ok: 1, unlinked: 1 };
const finishCalls: boolean[] = [];
let liveAtFinish = -1;
async function nativeFinish(allowUnlink: boolean) {
  events.push(`native-finish:${allowUnlink}`);
  finishCalls.push(allowUnlink);
  liveAtFinish = live();
  return finishResult;
}

const BackupDatabase = await import('../services/BackupDatabase');
const { purgeAllPlaintextCaches } = await import('./account-cleanup');

describe('sign-out and the backup manifest JS handle (task 1667)', () => {
  test('the JS handle is NOT closed (expo-sqlite\'s own SQLite copy would delete the engine\'s WAL) and is still the one used after', async () => {
    await BackupDatabase.initDatabase();
    const openedBefore = opened;
    await purgeAllPlaintextCaches();
    expect(purgeCalls).toContain('native');
    expect(closed).toBe(0);
    expect(liveAtNativePurge).toBe(1);
    // Same handle afterwards: the native side kept the file and emptied it in place.
    await BackupDatabase.getUploadedCount();
    expect(opened).toBe(openedBefore);
  });

  test('a manifest call issued DURING the purge waits until the native reset is done', async () => {
    await BackupDatabase.initDatabase();
    let readDone = false;
    let readDoneAtNativeEnd: boolean | null = null;
    let read: Promise<unknown> | null = null;
    duringPurge = async () => {
      read = BackupDatabase.getUploadedCount().then(() => { readDone = true; });
      await new Promise((r) => setTimeout(r, 15));
      readDoneAtNativeEnd = readDone;
    };
    await purgeAllPlaintextCaches();
    duringPurge = null;
    // The bug this guards: a JS write landing between the native reset and
    // the registry purge (or in the middle of the reset) on the shared file.
    expect(readDoneAtNativeEnd).toBe(false);
    await read;
    expect(readDone).toBe(true);
    expect(closed).toBe(0);
  });
});

describe('round 2 (Codex P1): an in-flight read is drained before the native reset', () => {
  test('a read already running when sign-out starts finishes BEFORE the native purge begins', async () => {
    await BackupDatabase.initDatabase();
    events.length = 0;
    let openRead!: () => void;
    readGate = new Promise<void>((r) => { openRead = r; });
    const read = BackupDatabase.getDeadLetterItems();
    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.startsWith('read-start'))).toBe(true);
    const purge = purgeAllPlaintextCaches();
    await new Promise((r) => setTimeout(r, 20));
    // The bug: the native checkpoint ran while this read held its snapshot.
    expect(events).not.toContain('native-purge');
    openRead();
    await read;
    await purge;
    readGate = null;
    const readEnd = events.findIndex((e) => e.startsWith('read-end'));
    const native = events.indexOf('native-purge');
    expect(readEnd).toBeGreaterThan(-1);
    expect(native).toBeGreaterThan(readEnd);
  });
});

describe('round 2 (Codex P1): after a failed native reset the JS handle is closed, never left on a deleted inode', () => {
  test('reset failed: close the JS handle FIRST, then finish (allowUnlink), then reopen a fresh handle', async () => {
    await BackupDatabase.initDatabase();
    const openedBefore = opened;
    events.length = 0;
    finishCalls.length = 0;
    usedAfterClose.length = 0;
    nativeResult = { removed: 3, failed: 0, backupManifestResetFailed: 1 };
    finishResult = { ok: 1, unlinked: 1 };
    const result = await purgeAllPlaintextCaches();
    nativeResult = { removed: 0, failed: 0 };
    const close = events.findIndex((e) => e.startsWith('close:'));
    const finish = events.indexOf('native-finish:true');
    expect(close).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(close);
    expect(finishCalls).toEqual([true]);
    expect(liveAtFinish).toBe(0);
    expect(result.failed).toBe(0);
    // The next call gets a NEW handle; nothing touches the closed one.
    await BackupDatabase.getUploadedCount();
    await BackupDatabase.getDeadLetterItems();
    expect(opened).toBe(openedBefore + 1);
    expect(usedAfterClose).toEqual([]);
  });

  test('a JS close that fails forbids the unlink (finish gets allowUnlink=false) and a failed finish is counted', async () => {
    await BackupDatabase.initDatabase();
    events.length = 0;
    finishCalls.length = 0;
    closeFails = true;
    nativeResult = { removed: 0, failed: 0, backupManifestResetFailed: 1 };
    finishResult = { ok: 0, unlinked: 0 };
    const result = await purgeAllPlaintextCaches();
    closeFails = false;
    nativeResult = { removed: 0, failed: 0 };
    finishResult = { ok: 1, unlinked: 1 };
    expect(finishCalls).toEqual([false]);
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  test('a call issued while the (re)opened handle is still opening never runs during the native purge', async () => {
    // Put the module in the "no handle" state: a failed reset closes it.
    nativeResult = { removed: 0, failed: 0, backupManifestResetFailed: 1 };
    finishResult = { ok: 1, unlinked: 1 };
    await purgeAllPlaintextCaches();
    nativeResult = { removed: 0, failed: 0 };
    callsDuringNative.length = 0;
    let releaseOpen!: () => void;
    openGate = new Promise<void>((r) => { releaseOpen = r; });
    const call = BackupDatabase.getUploadedCount();
    await new Promise((r) => setTimeout(r, 5));
    const purge = purgeAllPlaintextCaches();
    await new Promise((r) => setTimeout(r, 5));
    openGate = null;
    releaseOpen();
    await Promise.all([call, purge]);
    expect(callsDuringNative).toEqual([]);
  });

  test('reset succeeded: no close and no finish call', async () => {
    await BackupDatabase.initDatabase();
    events.length = 0;
    finishCalls.length = 0;
    const closedBefore = closed;
    await purgeAllPlaintextCaches();
    expect(finishCalls).toEqual([]);
    expect(closed).toBe(closedBefore);
  });
});

describe('sign-out clears the backup folder cache (1962 Bug 4)', () => {
  test('beebeeb_backup_folders does not survive purgeAllPlaintextCaches', async () => {
    secure.set('beebeeb_backup_folders', JSON.stringify({ rootId: 'root-of-A', deviceId: 'dev-A' }));
    secure.set('unrelated_key', 'kept');
    await purgeAllPlaintextCaches();
    expect(secure.has('beebeeb_backup_folders')).toBe(false);
    expect(secure.get('unrelated_key')).toBe('kept');
  });
});
