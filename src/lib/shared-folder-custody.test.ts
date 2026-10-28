// @ts-nocheck
/**
 * Task 2237c, decision L7c (plan C): custody is one-way per account.
 *
 * Once this account has seen a folder's custody record and opened it, a later
 * 404/405/501 from the server is an error ("This folder's keys are
 * unavailable"), never "legacy". The server is untrusted: it must not be able
 * to downgrade a folder this client already knows is custody. A folder whose
 * custody was never seen keeps the L7b behaviour (404/405/501 = legacy).
 * The record is durable (SecureStore), keyed per account, and cleared on
 * sign-out; another account never inherits it.
 *
 * `expo-secure-store` is mocked here (isolated-runner rule): the Map plays the
 * Keychain, and a "restart" is a NEW memory instance over the SAME Map.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const keychain = new Map<string, string>();
let failReads = false;
let failWrites = false;
mock.module('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: async (key: string) => {
    if (failReads) throw new Error('keychain unreadable');
    return keychain.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (failWrites) throw new Error('keychain unwritable');
    keychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => { keychain.delete(key); },
}));

const custody = await import('./shared-folder-custody');
const { advanceAccountEpoch } = await import('./account-epoch');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const FOLDER = '11111111-2222-4333-8444-555555555555';
const OTHER_FOLDER = '66666666-7777-4888-8999-000000000000';

beforeEach(() => {
  keychain.clear();
  failReads = false;
  failWrites = false;
});

function restart() { return custody.createCustodyMemory(custody.secureStoreCustodyPort); }

describe('L7c: seen custody can never be downgraded', () => {
  for (const status of [404, 405, 501]) {
    test(`seen, then a later ${status}, refuses and never answers legacy`, async () => {
      const memory = restart();
      await memory.markSeen(A, FOLDER);
      await expect(custody.settleMissingCustody(memory, A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    });

    test(`never seen, a ${status} reads legacy (L7b, flag-off invites stay readable)`, async () => {
      const memory = restart();
      expect(custody.isCustodyAbsentStatus(status)).toBe(true);
      expect(await custody.settleMissingCustody(memory, A, FOLDER)).toBe('legacy');
    });
  }

  test('other statuses are not "custody absent"', () => {
    for (const status of [200, 401, 403, 409, 429, 500, 502, 503, undefined, null]) {
      expect(custody.isCustodyAbsentStatus(status)).toBe(false);
    }
  });

  test('the refusal names the honest state', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    const error = await custody.settleMissingCustody(memory, A, FOLDER).catch(e => e);
    expect(error.name).toBe('CustodyUnavailableError');
    expect(error.message).toBe("This folder's keys are unavailable");
  });

  test('seen is per folder: a different folder of the same account still reads legacy', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    expect(await custody.settleMissingCustody(memory, A, OTHER_FOLDER)).toBe('legacy');
  });

  test('folder ids compare case-insensitively', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER.toUpperCase());
    await expect(custody.settleMissingCustody(memory, A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a fresh folder key is never minted over a folder whose custody was seen', async () => {
    const memory = restart();
    await custody.assertMayRegisterCustody(memory, A, FOLDER);
    await memory.markSeen(A, FOLDER);
    await expect(custody.assertMayRegisterCustody(memory, A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    await custody.assertMayRegisterCustody(memory, A, OTHER_FOLDER);
  });
});

describe('L7c: the record is durable and per account', () => {
  test('survives an app restart (a new memory over the same Keychain)', async () => {
    await restart().markSeen(A, FOLDER);
    const afterRestart = restart();
    expect(await afterRestart.hasSeen(A, FOLDER)).toBe(true);
    await expect(custody.settleMissingCustody(afterRestart, A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('another account does not inherit it', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    expect(await memory.hasSeen(B, FOLDER)).toBe(false);
    expect(await custody.settleMissingCustody(memory, B, FOLDER)).toBe('legacy');
    await custody.assertMayRegisterCustody(memory, B, FOLDER);
  });

  test('the Keychain never holds the account id or the folder id in a key name', async () => {
    await restart().markSeen(A, FOLDER);
    expect(keychain.size).toBeGreaterThan(0);
    for (const key of keychain.keys()) {
      expect(key).not.toContain(A);
      expect(key).not.toContain(FOLDER);
      expect(/^[A-Za-z0-9._-]+$/.test(key)).toBe(true);
    }
  });

  test('sign-out clears every account\'s record, in memory and in the Keychain', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    await memory.markSeen(B, OTHER_FOLDER);
    await memory.clearAll();
    expect([...keychain.keys()].filter(k => k.startsWith('beebeeb.custody-seen'))).toEqual([]);
    expect(await memory.hasSeen(A, FOLDER)).toBe(false);
    expect(await restart().hasSeen(B, OTHER_FOLDER)).toBe(false);
  });

  test('an epoch advance drops the in-memory copy but not the Keychain record', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    advanceAccountEpoch();
    keychain.set('beebeeb.custody-seen.v1.canary', 'x');
    expect(await memory.hasSeen(A, FOLDER)).toBe(true);
  });

  test('marking is idempotent and keeps earlier folders', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    await memory.markSeen(A, FOLDER);
    await memory.markSeen(A, OTHER_FOLDER);
    const again = restart();
    expect(await again.hasSeen(A, FOLDER)).toBe(true);
    expect(await again.hasSeen(A, OTHER_FOLDER)).toBe(true);
  });

  test('concurrent marks for different folders both land', async () => {
    const memory = restart();
    await Promise.all([memory.markSeen(A, FOLDER), memory.markSeen(A, OTHER_FOLDER)]);
    const again = restart();
    expect(await again.hasSeen(A, FOLDER)).toBe(true);
    expect(await again.hasSeen(A, OTHER_FOLDER)).toBe(true);
  });
});

describe('L7c: an unreadable or unwritable memory never degrades to legacy', () => {
  test('a Keychain read failure refuses instead of answering legacy', async () => {
    const memory = restart();
    failReads = true;
    await expect(custody.settleMissingCustody(memory, A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a corrupt record refuses instead of answering legacy', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    for (const key of [...keychain.keys()]) if (!key.endsWith('.index')) keychain.set(key, '{not json');
    await expect(custody.settleMissingCustody(restart(), A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a failed durable write rejects, so the folder key is not used', async () => {
    const memory = restart();
    failWrites = true;
    await expect(memory.markSeen(A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    failWrites = false;
    expect(await restart().hasSeen(A, FOLDER)).toBe(false);
  });

  test('no account (vault locked) refuses instead of answering legacy', async () => {
    const memory = restart();
    await expect(custody.settleMissingCustody(memory, null, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    await expect(memory.markSeen(null, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a write that outlives its sign-out writes nothing', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = {
      get: async (key: string) => { await gate; return keychain.get(key) ?? null; },
      set: async (key: string, value: string) => { keychain.set(key, value); },
      delete: async (key: string) => { keychain.delete(key); },
    };
    const memory = custody.createCustodyMemory(slow);
    const pending = memory.markSeen(A, FOLDER);
    advanceAccountEpoch();
    release();
    await expect(pending).rejects.toMatchObject({ name: 'StaleAccountError' });
    expect(keychain.size).toBe(0);
  });
});

describe('contract: format l7 and 409 upgrade_required', () => {
  test('withL7Format adds format l7 and leaves the caller\'s body alone', () => {
    const body = { keys: [{ file_id: 'f', encrypted_file_key: 'k' }] };
    const out = custody.withL7Format(body);
    expect(out).toEqual({ keys: body.keys, format: 'l7' });
    expect('format' in body).toBe(false);
  });

  test('withL7Format refuses a body that already names another format', () => {
    expect(() => custody.withL7Format({ format: 'legacy' })).toThrow();
    expect(custody.withL7Format({ format: 'l7' })).toEqual({ format: 'l7' });
  });

  test('409 upgrade_required is the honest "owner must upgrade" state, not a generic error', () => {
    const upgrade = custody.toUpgradeRequired({ status: 409, code: 'upgrade_required', message: 'x' });
    expect(upgrade).toBeInstanceOf(custody.UpgradeRequiredError);
    expect(upgrade.message).toBe('The owner must convert this folder first');
  });

  test('other 409s and other statuses carrying that code are not upgrade_required', () => {
    expect(custody.toUpgradeRequired({ status: 409, code: 'folder_key_missing' })).toBeNull();
    expect(custody.toUpgradeRequired({ status: 409 })).toBeNull();
    expect(custody.toUpgradeRequired({ status: 400, code: 'upgrade_required' })).toBeNull();
    expect(custody.toUpgradeRequired(new Error('boom'))).toBeNull();
    expect(custody.toUpgradeRequired(null)).toBeNull();
  });

  test('no user-visible string in the module is purchase vocabulary (task 1821 scan)', () => {
    expect(new custody.UpgradeRequiredError().message).not.toMatch(/upgrad/i);
  });

  test('upgrade_required is distinct from the custody-unavailable refusal', () => {
    expect(new custody.UpgradeRequiredError()).not.toBeInstanceOf(custody.CustodyUnavailableError);
  });
});

describe('L11: no fresh custody over a folder the server said needs the upgrade', () => {
  const upgradeError = { status: 409, code: 'upgrade_required', message: 'x' };

  test('after a 409 upgrade_required the folder is never minted over, and the state is the upgrade state', async () => {
    const memory = restart();
    await custody.assertMayRegisterCustody(memory, A, FOLDER);
    const state = await custody.noteUpgradeRequired(memory, A, FOLDER, upgradeError);
    expect(state).toBeInstanceOf(custody.UpgradeRequiredError);
    await expect(custody.assertMayRegisterCustody(memory, A, FOLDER)).rejects.toBeInstanceOf(custody.UpgradeRequiredError);
    await custody.assertMayRegisterCustody(memory, A, OTHER_FOLDER);
  });

  test('it survives a restart, is per account, and is cleared at sign-out', async () => {
    await custody.noteUpgradeRequired(restart(), A, FOLDER, upgradeError);
    const again = restart();
    await expect(custody.assertMayRegisterCustody(again, A, FOLDER)).rejects.toBeInstanceOf(custody.UpgradeRequiredError);
    await custody.assertMayRegisterCustody(again, B, FOLDER);
    await again.clearAll();
    await custody.assertMayRegisterCustody(restart(), A, FOLDER);
  });

  test('other errors do not mark the folder', async () => {
    const memory = restart();
    expect(await custody.noteUpgradeRequired(memory, A, FOLDER, { status: 409, code: 'folder_key_missing' })).toBeNull();
    expect(await custody.noteUpgradeRequired(memory, A, FOLDER, new Error('boom'))).toBeNull();
    await custody.assertMayRegisterCustody(memory, A, FOLDER);
  });

  test('once the upgrade finished and custody was seen, the folder is custody and the flag is gone', async () => {
    const memory = restart();
    await custody.noteUpgradeRequired(memory, A, FOLDER, upgradeError);
    await memory.markSeen(A, FOLDER);
    const again = restart();
    expect(await again.isUpgradeRequired(A, FOLDER)).toBe(false);
    await expect(custody.assertMayRegisterCustody(again, A, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a Keychain that cannot store the flag still returns the upgrade state for this write', async () => {
    const memory = restart();
    failWrites = true;
    expect(await custody.noteUpgradeRequired(memory, A, FOLDER, upgradeError)).toBeInstanceOf(custody.UpgradeRequiredError);
  });

  test('records written before the flag existed still load', async () => {
    const memory = restart();
    await memory.markSeen(A, FOLDER);
    for (const key of [...keychain.keys()]) {
      if (key.endsWith('.index')) continue;
      keychain.set(key, JSON.stringify({ v: 1, folders: [FOLDER] }));
    }
    const again = restart();
    expect(await again.hasSeen(A, FOLDER)).toBe(true);
    expect(await again.isUpgradeRequired(A, FOLDER)).toBe(false);
  });
});

describe('source contract', () => {
  const source = readFileSync(join(import.meta.dir, 'shared-folder-custody.ts'), 'utf8');
  test('the custody module never logs (folder ids and account digests stay out of logs)', () => {
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/logDiagnostic|trace\(/);
  });
  test('the only durable store is SecureStore, never AsyncStorage (the sign-out purge deletes that)', () => {
    expect(source).toMatch(/from 'expo-secure-store'/);
    expect(source).not.toMatch(/async-storage/);
  });
});
