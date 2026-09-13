// @ts-nocheck
/**
 * Pre-mortem 12 / task 0300 — the real-hardware negative case for the
 * software-vault-fallback gate (see `software-vault-gate.test.ts` for the
 * simulator positive case and why this is a separate file, not a mutated
 * shared mock: Bun 1.3.4 snapshots `mock.module` getters/values at first
 * ESM interop access rather than treating them as a live binding, so a
 * SINGLE dynamic import of `crypto-context.tsx` cannot see a later mock
 * mutation. Fixing the device under test means fixing the mock).
 *
 * A debug build on real hardware must still take the Secure Enclave path —
 * this is the enforcement of the `crypto-context.tsx` comment "do NOT add
 * `|| __DEV__` here".
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('expo-device', () => ({
  isDevice: true,
  modelName: 'iPhone 17 Pro',
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

const { usesSoftwareVaultFallback } = await import('./crypto-context');

describe('software vault fallback gate — real hardware', () => {
  test('false on real hardware, even in a debug build', () => {
    expect(usesSoftwareVaultFallback()).toBe(false);
  });
});
