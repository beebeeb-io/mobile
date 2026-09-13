// @ts-nocheck
/**
 * Pre-mortem 12 / task 0300 — pins the gate that keeps
 * `beebeeb-simulator-master-key.txt` (a RAW master key, plaintext, in
 * `documentDirectory`) off physical devices.
 *
 * `crypto-context.tsx` carries the warning "do NOT add `|| __DEV__` here" on
 * `usesSoftwareVaultFallback()`. This test (together with the real-hardware
 * negative case in `software-vault-gate-device.test.ts`) is that warning,
 * enforced: a debug build on real hardware must still take the Secure
 * Enclave path.
 *
 * Split into TWO files rather than one file with a mutable `expo-device`
 * mock: Bun 1.3.4's `mock.module` snapshots a factory's getters at the first
 * ESM interop access (`import * as Device from 'expo-device'` reads
 * `Device.isDevice` fresh each call in the SOURCE, but the MOCK's returned
 * object gets its getters evaluated once and frozen into static bindings —
 * confirmed directly: a minimal repro mutating the backing state after one
 * dynamic import kept reading the pre-mutation value). `bun run test`
 * already gives every test FILE its own process (mobile/CLAUDE.md "Tests"),
 * so two small fixed-scenario files sidestep the snapshot entirely instead
 * of fighting it.
 *
 * Isolated-runner rule: this file mocks every native module AND every
 * relative dependency `crypto-context.tsx` pulls in, itself — none of them
 * are exercised by the two exports under test here, so each is stubbed to
 * the minimum shape that lets the module load.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('expo-device', () => ({
  isDevice: false,
  modelName: 'iPhone 17 Pro Simulator',
}));
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///tmp/docs/',
  cacheDirectory: 'file:///tmp/cache/',
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  deleteAsync: async () => {},
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));
// crypto-context.tsx does a STATIC `import { ... }` of ~20 named crypto
// primitives from this module. ES module linking requires every named
// binding to actually exist on the target module at link time (unlike CJS
// `require()`, where a missing property is just `undefined`) — an empty `{}`
// mock (the pattern welcome-seed.test.ts / decrypt-to-file.test.ts use for
// files with fewer/no named imports from this module) fails to link here
// with "Export named 'handleEncryptMetadata' not found". None of these are
// invoked by usesSoftwareVaultFallback() or SIMULATOR_MASTER_KEY_FILE — both
// are plain top-level values — so every stub below is a no-op.
mock.module('../../modules/beebeeb-crypto', () => ({
  computeRecoveryCheck: () => undefined,
  createMasterKeyHandle: () => undefined,
  createRequestKeypairWithHandle: () => undefined,
  decryptNames: () => undefined,
  deriveX25519PublicFromPrivate: () => undefined,
  handleComputeRecoveryCheck: () => undefined,
  handleDecryptChunk: () => undefined,
  handleDecryptMetadata: () => undefined,
  handleDeriveFileKey: () => undefined,
  handleDeriveX25519Private: () => undefined,
  handleEncryptChunk: () => undefined,
  handleEncryptMetadata: () => undefined,
  loadKeyFromKeychainAsHandle: () => undefined,
  logDiagnostic: () => undefined,
  recoverFromPhrase: () => undefined,
  releaseHandle: () => undefined,
  replaceKeychainAccessControl: () => undefined,
  replaceKeychainAccessControlFromHandle: () => undefined,
  storeKeyInKeychain: () => undefined,
  unwrapRequestPrivateWithHandle: () => undefined,
}));
// Relative dependencies of crypto-context.tsx — mocked wholesale so their own
// (much larger) transitive dependency trees never need to load.
mock.module('../services/BackupService', () => ({
  setBackupEncryption: () => {},
  getKeepVaultUnlocked: async () => false,
}));
mock.module('./runtime-trace', () => ({
  recordRuntimeTrace: () => null,
}));
mock.module('./file-request-crypto', () => ({
  createRequestKeyResolver: () => ({}),
}));

// Static imports are hoisted above these mock.module calls, so the module
// under test must be loaded dynamically, after the mocks are registered.
const { usesSoftwareVaultFallback, SIMULATOR_MASTER_KEY_FILE } = await import('./crypto-context');

describe('software vault fallback gate — simulator', () => {
  test('true on a simulator — the raw-key file path is reachable there', () => {
    expect(usesSoftwareVaultFallback()).toBe(true);
  });

  test('the key file lives at a path the native registry protects', () => {
    expect(SIMULATOR_MASTER_KEY_FILE.endsWith('beebeeb-simulator-master-key.txt')).toBe(true);
  });
});
