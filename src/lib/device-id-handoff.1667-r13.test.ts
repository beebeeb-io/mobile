// @ts-nocheck
/**
 * Task 1667 round 13 (review of mobile#182 at a19037f9, item 1, P1 duplicate
 * upload): a keychain read that FAILS is not "no device id".
 *
 * At a19037f9 `getDeviceId()` turned a failed SecureStore read (device locked:
 * `bb_sync_device_id` is stored WHEN_UNLOCKED) into null, minted a fresh UUID,
 * and the `BackupProvider` mount handed that UUID to native, which stored it
 * over the real id. Every later /check, /identifiers and /mark then used an id
 * the server had no map for, and after the next sign-in the photos uploaded
 * again.
 *
 * Real modules: `device-identity.ts` and `backup-device-id-handoff.ts`. Only
 * expo-secure-store (an in-memory keychain that can be "locked") and the
 * native `setBackupDeviceId` are stubbed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let locked = false;
/** Keys whose read throws even when unlocked (a keychain error on one item). */
const failingReads = new Set<string>();
let writesFail = 0; // how many next writes throw
const writes: Array<[string, string]> = [];

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    if (locked || failingReads.has(key)) {
      // expo-secure-store throws for every status but errSecItemNotFound.
      throw new Error('KeyChainException: errSecInteractionNotAllowed (-25308)');
    }
    return store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (locked || writesFail > 0) {
      writesFail = Math.max(0, writesFail - 1);
      throw new Error('KeyChainException: errSecInteractionNotAllowed (-25308)');
    }
    writes.push([key, value]);
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));

const handedToNative: Array<{ id: string; persisted: boolean }> = [];
mock.module('../../modules/beebeeb-crypto', () => ({
  setBackupDeviceId: async (id: string, options?: { persisted: boolean }) => {
    handedToNative.push({ id, persisted: options?.persisted ?? false });
    return true;
  },
}));

const SYNC_KEY = 'bb_sync_device_id';
const LEGACY_KEY = 'beebeeb_device_id';
const REAL_ID = 'real-canonical-id-0001';

async function fresh() {
  const bust = Math.random();
  const identity = await import(`./device-identity?r13=${bust}`);
  const handoff = await import(`./backup-device-id-handoff?r13=${bust}`);
  return { identity, handoff };
}

beforeEach(() => {
  store.clear();
  failingReads.clear();
  locked = false;
  writesFail = 0;
  writes.length = 0;
  handedToNative.length = 0;
});

describe('getDeviceId never mints over an id it could not read (round 13 item 1)', () => {
  test('r13-1.1 locked keychain: getDeviceId rejects with DeviceIdUnavailableError and writes nothing', async () => {
    store.set(SYNC_KEY, REAL_ID);
    locked = true;
    const { identity } = await fresh();
    let error: unknown = null;
    try {
      await identity.getDeviceId();
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect((error as Error).name).toBe('DeviceIdUnavailableError');
    expect(writes).toEqual([]);
    locked = false;
    expect(store.get(SYNC_KEY)).toBe(REAL_ID);
  });

  test('r13-1.2 canonical absent, legacy read fails: rejects, nothing minted', async () => {
    failingReads.add(LEGACY_KEY);
    const { identity } = await fresh();
    await expect(identity.getDeviceId()).rejects.toThrow('device id unavailable');
    expect(writes).toEqual([]);
    expect(store.has(SYNC_KEY)).toBe(false);
  });

  test('r13-1.3 first run (both keys read as absent): mints one UUID, persists it, reports it durable', async () => {
    const { identity } = await fresh();
    const r = await identity.resolveDeviceId();
    expect(r.source).toBe('minted');
    expect(r.persisted).toBe(true);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(store.get(SYNC_KEY)).toBe(r.id);
    expect(await identity.getDurableDeviceId()).toBe(r.id);
  });

  test('r13-1.4 a minted id whose write fails is session-only: same id again, not durable, write retried', async () => {
    writesFail = 1;
    const { identity } = await fresh();
    const first = await identity.resolveDeviceId();
    expect(first.persisted).toBe(false);
    expect(store.has(SYNC_KEY)).toBe(false);
    // The next call in this session reuses the id (no second mint) and
    // retries the write, which now succeeds.
    const second = await identity.resolveDeviceId();
    expect(second.id).toBe(first.id);
    expect(second.persisted).toBe(true);
    expect(store.get(SYNC_KEY)).toBe(first.id);
  });

  test('r13-1.5 a stored id resolves as stored and durable', async () => {
    store.set(SYNC_KEY, REAL_ID);
    const { identity } = await fresh();
    expect(await identity.resolveDeviceId()).toEqual({ id: REAL_ID, source: 'stored', persisted: true });
  });
});

describe('the native handoff sends only a durable id (round 13 item 1)', () => {
  test('r13-1.6 locked keychain at mount: nothing is handed over (native keeps the real id)', async () => {
    store.set(SYNC_KEY, REAL_ID);
    locked = true;
    const { handoff } = await fresh();
    expect(await handoff.syncBackupDeviceIdToNative()).toBe(false);
    expect(handedToNative).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('r13-1.7 read error on the legacy key: no handoff', async () => {
    failingReads.add(LEGACY_KEY);
    const { handoff } = await fresh();
    expect(await handoff.syncBackupDeviceIdToNative()).toBe(false);
    expect(handedToNative).toEqual([]);
  });

  test('r13-1.8 first run: mint + persist + handoff, flagged durable', async () => {
    const { handoff } = await fresh();
    expect(await handoff.syncBackupDeviceIdToNative()).toBe(true);
    expect(handedToNative.length).toBe(1);
    expect(handedToNative[0].id).toBe(store.get(SYNC_KEY));
    expect(handedToNative[0].persisted).toBe(true);
  });

  test('r13-1.9 the stored id is handed over, flagged durable', async () => {
    store.set(SYNC_KEY, REAL_ID);
    const { handoff } = await fresh();
    expect(await handoff.syncBackupDeviceIdToNative()).toBe(true);
    expect(handedToNative).toEqual([{ id: REAL_ID, persisted: true }]);
  });

  test('r13-1.10 a minted id whose write failed is never handed over', async () => {
    writesFail = 1;
    const { handoff } = await fresh();
    expect(await handoff.syncBackupDeviceIdToNative()).toBe(false);
    expect(handedToNative).toEqual([]);
  });

  test('r13-1.11 a native refusal or a throwing native call resolves false, never throws', async () => {
    store.set(SYNC_KEY, REAL_ID);
    const { handoff, identity } = await fresh();
    expect(await handoff.syncBackupDeviceIdToNative({
      resolveDeviceId: identity.resolveDeviceId,
      setBackupDeviceId: async () => false,
    })).toBe(false);
    expect(await handoff.syncBackupDeviceIdToNative({
      resolveDeviceId: identity.resolveDeviceId,
      setBackupDeviceId: async () => { throw new Error('old native build'); },
    })).toBe(false);
  });
});
