// @ts-nocheck
/**
 * Task 1399 follow-up (Codex P1 "Purge plaintext caches after deleting the
 * account") — proves `purgeThenSignOut` calls `purge()` BEFORE `signOut()`,
 * not the other way around. Ordering matters here as defense in depth: the
 * account-deletion flow's own cleanup guarantee should not silently depend
 * on `signOut()`'s internal step order never changing (see App.tsx —
 * `signOut()` also purges internally, but the deletion screen calls this
 * explicitly first).
 *
 * `./account-cleanup` imports `./name-cache` and `./thumbnail-cache` (which
 * transitively pull in `expo-file-system`/`react-native` — real
 * `react-native/index.js` uses Flow syntax bun's parser rejects outright)
 * and `../../modules/beebeeb-crypto`. Per the isolated-runner rule
 * (mobile/CLAUDE.md "Tests"), this file mocks all three itself. Static
 * `import` statements are hoisted above `mock.module` calls regardless of
 * source order, so `./account-cleanup` is loaded via a dynamic `await
 * import(...)` below the mocks (same pattern as `plaintext-storage.test.ts`).
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
mock.module('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
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
  purgePlaintextStorage: async () => { purgeCalls.push('native'); return { removed: 0, failed: 0 }; },
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

const { purgeThenSignOut, purgeAllPlaintextCaches, purgeDecryptedCaches } = await import('./account-cleanup');
const { plaintextGate } = await import('./plaintext-gate');
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('purgeAllPlaintextCaches (task 1593 — plaintext survived sign-out)', () => {
  test('clears previews, the photo cache, every registered Library/Caches writer, thumbnails, names and the native registry', async () => {
    purgeCalls.length = 0;
    await purgeAllPlaintextCaches();
    expect(purgeCalls).toContain('previews');
    expect(purgeCalls).toContain('photos');
    expect(purgeCalls.indexOf('previews')).toBeLessThan(purgeCalls.indexOf('native'));
    // The registry sweep runs after the in-flight-aware clears.
    expect(purgeCalls.indexOf('caches-registry')).toBeGreaterThan(purgeCalls.indexOf('previews'));
    expect(purgeCalls.indexOf('caches-registry')).toBeGreaterThan(purgeCalls.indexOf('photos'));
    expect([...purgeCalls].sort()).toEqual(['caches-registry', 'names', 'native', 'photos', 'previews', 'thumbnails']);
  });

  test('a failing preview purge never blocks the rest of sign-out', async () => {
    purgeCalls.length = 0;
    previewClear = async () => { throw new Error('disk'); };
    await expect(purgeAllPlaintextCaches()).resolves.toEqual({ removed: 0, failed: 0 });
    await expect(purgeDecryptedCaches()).resolves.toBeUndefined();
    expect(purgeCalls).toContain('caches-registry');
    previewClear = async () => { purgeCalls.push('previews'); };
  });

  test('purgeDecryptedCaches clears decrypted content but not the native registry', async () => {
    purgeCalls.length = 0;
    await purgeDecryptedCaches();
    expect([...purgeCalls].sort()).toEqual(['caches-registry', 'names', 'photos', 'previews', 'thumbnails']);
  });
});

describe('task 1593 round 3 (#141 Codex P1) — the purge drains every plaintext writer before it sweeps', () => {
  test('a writer holding a lease: NOTHING is swept until it settles, and it cannot write after', async () => {
    plaintextGate.open();
    purgeCalls.length = 0;
    const lease = plaintextGate.acquire('SharedView decrypt');
    let done = false;
    const purge = purgeAllPlaintextCaches().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(purgeCalls).toEqual([]); // still draining — no sweep yet
    expect(done).toBe(false);
    expect(lease.valid).toBe(false); // the writer's late write will be refused
    lease.release();
    await purge;
    expect(purgeCalls).toContain('caches-registry');
    expect(purgeCalls).toContain('native');
    // The gate stays closed after the sweep: no writer can start behind it.
    expect(plaintextGate.isOpen()).toBe(false);
    expect(() => plaintextGate.acquire('late')).toThrow();
    plaintextGate.open();
  });
});

describe('App.tsx purges in ONE place — the signed-out surface (task 1593 round 2, P2-A/P2-B)', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');
  test('the signed-out effect drives the purger from user + the surface state', () => {
    expect(app).toMatch(/signedOutPurger\.noteUser\(user != null\);\s*\}, \[user\]\);/);
    expect(app).toMatch(/const onSignedOutSurface = !checking && !showDiagnostics && !showSecureStorageError && user == null;/);
    expect(app).toMatch(/if \(onSignedOutSurface\) void signedOutPurger\.enterSignedOut\(\);\s*\}, \[onSignedOutSurface\]\);/);
  });
  test('round 3: EVERY signed-out arrival (cold launch too) gets the FULL purge incl. the native registry', () => {
    expect(app).toMatch(/createSignedOutPurger\(\{\s*full: \(\) => purgeAllPlaintextCaches\(\),\s*\}\);/);
    expect(app).not.toMatch(/purgeDecryptedCaches/);
  });
  test('sign-in waits for a purge still running, then reopens the plaintext gate before setUser', () => {
    expect(app).toMatch(/const refreshAuth = useCallback\(async \(\) => \{\s*try \{[\s\S]{0,200}await signedOutPurger\.settled\(\);\s*const me = await getMe\(\);\s*signedOutPurger\.sessionStarted\(\);[^\n]*\n\s*setUser\(me\);/);
  });
  test('no per-call-site preview-only sweep is left', () => {
    expect(app).not.toMatch(/purgePreviewPlaintextWhileSignedOut/);
  });
  test('ordinary sign-out still purges before the UI flips', () => {
    expect(app).toMatch(/await purgeAllPlaintextCaches\(\)/);
  });
});

describe('purgeThenSignOut', () => {
  test('purges plaintext caches before signing out', async () => {
    const calls: string[] = [];
    await purgeThenSignOut({
      purge: async () => {
        calls.push('purge');
        return { removed: 3, failed: 0 };
      },
      signOut: async () => {
        calls.push('signOut');
      },
    });
    expect(calls).toEqual(['purge', 'signOut']);
  });

  test('awaits purge to fully complete before signOut starts', async () => {
    const calls: string[] = [];
    await purgeThenSignOut({
      purge: () =>
        new Promise((resolve) => {
          // Resolve on a later macrotask so a signOut() call that started
          // too early would show up in `calls` BEFORE 'purge-resolved'.
          setTimeout(() => {
            calls.push('purge-resolved');
            resolve({ removed: 1, failed: 0 });
          }, 0);
        }),
      signOut: async () => {
        calls.push('signOut');
      },
    });
    expect(calls).toEqual(['purge-resolved', 'signOut']);
  });
});
