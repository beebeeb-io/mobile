// @ts-nocheck
/**
 * Task 1594 round 2 (F3/F6) — the owner record + the signed-in user id must
 * reach the SHARED keychain (via `BeebeebCryptoModule.mirrorKeyOwner` /
 * `mirrorSessionUserId`), not just the app-local `expo-secure-store` copy —
 * otherwise the File Provider / Share Extension have nowhere to read an
 * ownership verdict from at all (the round-1 gap, F3).
 *
 * Unlike `crypto-context.key-ownership.test.ts`, this file does NOT mock
 * `../../modules/beebeeb-crypto` away entirely — it spies on the two new
 * mirror functions specifically, so a regression that stops calling them (or
 * calls them with the wrong value) fails here even though the React-effect
 * harness in the other file never runs effects at all.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const secure = new Map<string, string>();
const files = new Map<string, string>();
const nativeCalls: { mirrorKeyOwner: Array<string | null>; mirrorSessionUserId: Array<string | null>; deleteKeychain: number } = {
  mirrorKeyOwner: [],
  mirrorSessionUserId: [],
  deleteKeychain: 0,
};

mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///tmp/docs/',
  deleteAsync: async (p: string) => { files.delete(p); },
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => null }));
mock.module('../../modules/beebeeb-crypto', () => ({
  deleteKeyFromKeychain: async () => { nativeCalls.deleteKeychain += 1; return true; },
  mirrorSimulatorFileProviderMasterKey: async () => true,
  mirrorKeyOwner: async (userId: string | null) => { nativeCalls.mirrorKeyOwner.push(userId); return true; },
  mirrorSessionUserId: async (userId: string | null) => { nativeCalls.mirrorSessionUserId.push(userId); return true; },
}));

const {
  clearKeyOwner,
  mirrorSignedInUserId,
  precheckKeyOwner,
  purgeStoredVaultKey,
  writeKeyOwner,
} = await import('./key-ownership');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  secure.clear();
  files.clear();
  nativeCalls.mirrorKeyOwner.length = 0;
  nativeCalls.mirrorSessionUserId.length = 0;
  nativeCalls.deleteKeychain = 0;
});

describe('1594 round 2 (F6) — the owner record is mirrored to the shared keychain', () => {
  test('writeKeyOwner mirrors natively with the same user id it stores locally', async () => {
    await writeKeyOwner(USER_A);
    expect(secure.get('io.beebeeb.master-key-owner')).toBe(USER_A);
    expect(nativeCalls.mirrorKeyOwner).toEqual([USER_A]);
  });

  test('clearKeyOwner mirrors a native clear (null)', async () => {
    await writeKeyOwner(USER_A);
    await clearKeyOwner();
    expect(secure.has('io.beebeeb.master-key-owner')).toBe(false);
    expect(nativeCalls.mirrorKeyOwner).toEqual([USER_A, null]);
  });

  test('purgeStoredVaultKey (owner_mismatch path) also mirrors the native clear', async () => {
    await writeKeyOwner(USER_A);
    nativeCalls.mirrorKeyOwner.length = 0; // isolate this call
    await purgeStoredVaultKey('owner_mismatch');
    expect(nativeCalls.mirrorKeyOwner).toEqual([null]);
    expect(nativeCalls.deleteKeychain).toBe(1);
  });

  test('a mismatched precheck purges AND mirrors the native clear before returning', async () => {
    secure.set('io.beebeeb.master-key-owner', USER_A); // as if written by round-1 code
    const result = await precheckKeyOwner(USER_B);
    expect(result).toBe('purged');
    expect(nativeCalls.mirrorKeyOwner).toEqual([null]);
  });

  test('self-healing migration: a bound precheck (round-1 SecureStore-only owner) re-mirrors it natively', async () => {
    // Simulates an install that proved ownership under the round-1 fix,
    // before the native mirror existed: the SecureStore owner is already
    // correct, but no shared-keychain mirror has ever been written.
    secure.set('io.beebeeb.master-key-owner', USER_A);
    const result = await precheckKeyOwner(USER_A);
    expect(result).toBe('bound');
    expect(nativeCalls.mirrorKeyOwner).toEqual([USER_A]);
  });

  test('an unbound precheck (no owner recorded at all) does not touch the native mirror', async () => {
    const result = await precheckKeyOwner(USER_A);
    expect(result).toBe('unbound');
    expect(nativeCalls.mirrorKeyOwner).toEqual([]);
  });
});

describe('1594 round 2 (F3) — the signed-in user id is mirrored separately', () => {
  test('mirrorSignedInUserId forwards the exact id given', async () => {
    await mirrorSignedInUserId(USER_A);
    expect(nativeCalls.mirrorSessionUserId).toEqual([USER_A]);
  });

  test('mirrorSignedInUserId(null) clears it (sign-out / no signed-in user)', async () => {
    await mirrorSignedInUserId(USER_A);
    await mirrorSignedInUserId(null);
    expect(nativeCalls.mirrorSessionUserId).toEqual([USER_A, null]);
  });
});

describe('1594 round 2 — the native mirror is best-effort and never breaks the JS-side precheck', () => {
  test('a native mirrorKeyOwner rejection does not stop writeKeyOwner from storing locally', async () => {
    mock.module('../../modules/beebeeb-crypto', () => ({
      deleteKeyFromKeychain: async () => true,
      mirrorSimulatorFileProviderMasterKey: async () => true,
      mirrorKeyOwner: async () => { throw new Error('bridge unavailable'); },
      mirrorSessionUserId: async () => { throw new Error('bridge unavailable'); },
    }));
    // Re-import so the new mock module takes effect (bun caches by module id;
    // key-ownership.ts imports './api'-style lazily but this native module is
    // dynamically imported per-call, so the mock above is picked up live).
    await expect(writeKeyOwner(USER_A)).resolves.toBeUndefined();
    expect(secure.get('io.beebeeb.master-key-owner')).toBe(USER_A);
  });
});
