// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1683d — the offline manifest's SecureStore persist failures must be
 * OBSERVABLE (runtime trace), not swallowed. The pin flow itself must still
 * succeed (persist must not throw), so the trace is the failure surface.
 *
 * Red-first: before the fix, persistFiles swallowed setItemAsync errors with
 * `.catch(() => {})` — no trace, no throw — so `records` stayed empty and
 * this test failed. (Seen red: 1683d-persist-red.log.)
 */
import { describe, expect, mock, test } from 'bun:test';

// expo-modules-core's logger setup reads the RN global `__DEV__` and its
// EventEmitter module binds `globalThis.expo` at import time; stub both
// before anything loads (the same globals the RN runtime provides).
(globalThis as Record<string, unknown>).__DEV__ = false;
(globalThis as Record<string, unknown>).expo = {
  EventEmitter: class {
    addListener = () => ({ remove: () => {} });
    removeAllListeners = () => {};
  },
  modules: {},
};

const secureStoreCalls: Array<{ key: string; value: string }> = [];
let failSetItem: string | null = null;
const records: Array<{ name: string; fields: Record<string, unknown> }> = [];

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStoreCalls.find((c) => c.key === key)?.value ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (failSetItem === key) throw new Error(' SecureStore: secure item too large');
    secureStoreCalls.push({ key, value });
  },
  deleteItemAsync: async (key: string) => {
    const idx = secureStoreCalls.findIndex((c) => c.key === key);
    if (idx >= 0) secureStoreCalls.splice(idx, 1);
  },
}));

mock.module('react-native', () => {
  const noopEmitter = { addListener: () => ({ remove: () => {} }), emit: () => {}, removeAllListeners: () => {} };
  return {
    Platform: { OS: 'android', select: (o) => o.android ?? o.default ?? o.ios },
    TurboModuleRegistry: { getEnforcing: () => ({}), get: () => null },
    AppRegistry: { registerRunnable: () => {}, getRunnable: () => null, registerComponent: () => {}, getComponent: () => null },
    NativeModules: {},
    DeviceEventEmitter: noopEmitter,
    NativeEventEmitter: class { addListener = () => ({ remove: () => {} }); removeAllListeners = () => {}; },
    InteractionManager: { runAfterInteractions: (cb) => { cb(); return { cancel: () => {} }; } },
  };
});

// Fully stub `expo-file-system/legacy` — the real legacy shim extends the
// NativeModule class, which is not constructable under bun's mock registry;
// offline-manager only touches directory/file basics here.
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

mock.module('./api', () => ({
  getDownloadUrl: (fileId: string) => `https://api.test/download/${fileId}`,
  getToken: async () => 'test-token',
}));

mock.module('./runtime-trace', () => ({
  recordRuntimeTrace: (name: string, fields: Record<string, unknown>) => {
    records.push({ name, fields });
  },
}));

mock.module('./plaintext-storage', () => ({
  notePlaintextPathCreated: () => {},
}));

const { offlineManager } = await import('./offline-manager');

describe('offline manifest persist failures are observable (task 1683d)', () => {
  test('a failing SecureStore.setItemAsync leaves a trace and never throws', async () => {
    // Seed one manifest entry via the public pin API (download is mocked away
    // by driving persistFiles through a failed set — pin's own download
    // would fail offline, so drive the private seam directly).
    failSetItem = 'beebeeb_offline_files';
    records.length = 0;
    // Directly exercise the private persist path through pin's finally-state:
    // instead of stubbing the whole download flow, call the private method
    // through a cast — the seam is the contract under test.
    const anyManager = offlineManager as unknown as { persistFiles(): Promise<void> };
    await anyManager.persistFiles(); // must not throw
    const traced = records.find((r) => r.name === 'offline.manifest.persist_failed');
    expect(traced).toBeDefined();
    expect((traced!.fields.error as string).length).toBeGreaterThan(0);
    failSetItem = null;
  });

  test('a successful persist leaves no failure trace', async () => {
    records.length = 0;
    const anyManager = offlineManager as unknown as { persistFiles(): Promise<void> };
    await anyManager.persistFiles();
    expect(records.find((r) => r.name === 'offline.manifest.persist_failed')).toBeUndefined();
  });
});
