// @ts-nocheck
/**
 * Task 2237c, decisions L7d (supersedes L7c's "per account"), L10 and L11 (plan C).
 *
 * The custody memory belongs to the DEVICE. Once this device has seen a shared folder's custody
 * record and opened it, a later 404/405/501 for that folder is an error ("This folder's keys are
 * unavailable"), never "legacy": the server is untrusted and nothing it says can shrink the set.
 * It is one device-wide set of folder ids in SecureStore, keyed by no account, never cleared by a
 * sign-out or an account switch (a forced 401 sign-out must not let a server downgrade a folder).
 * A folder never seen keeps the L7b behaviour: 404/405/501 = legacy.
 *
 * `expo-secure-store` is mocked here (isolated-runner rule): the Map plays the Keychain, and a
 * "restart" is a NEW memory over the SAME Map. The marker (Android Keystore loss) is a port.
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
// The default marker is two native calls (no-backup storage: iOS Application Support excluded from backup,
// Android noBackupFilesDir), loaded lazily; mocked here.
let nativeMarker = false;
let nativeMarkerReadFails = false;
let nativeMarkerWriteFails = false;
let nativeMarkerMissing = false;
mock.module('../../modules/beebeeb-crypto', () => ({
  // A build without the native functions makes the JS bridge throw (BeebeebCrypto.ts), so "missing" is a throw here.
  custodyMarkerExists: async () => { if (nativeMarkerMissing) throw new Error('The custody marker is not available in this build'); if (nativeMarkerReadFails) throw new Error('marker unreadable'); return nativeMarker; },
  writeCustodyMarker: async () => { if (nativeMarkerMissing) throw new Error('The custody marker is not available in this build'); if (nativeMarkerWriteFails) throw new Error('marker unwritable'); nativeMarker = true; },
}));

const custody = await import('./shared-folder-custody');

const FOLDER = '11111111-2222-4333-8444-555555555555';
const OTHER_FOLDER = '66666666-7777-4888-8999-000000000000';
const RECORD_KEY = 'beebeeb.custody-seen.v1';

// The Keychain-side port is the production one (SecureStore, mocked above); the marker is a flag.
let markerPresent = false;
let markerReadFails = false;
let markerWriteFails = false;
let markerWrites = 0;
const markerPort = {
  exists: async () => { if (markerReadFails) throw new Error('marker unreadable'); return markerPresent; },
  write: async () => { if (markerWriteFails) throw new Error('marker unwritable'); markerWrites++; markerPresent = true; },
};
beforeEach(() => {
  keychain.clear(); nativeMarker = false; nativeMarkerReadFails = false; nativeMarkerWriteFails = false; nativeMarkerMissing = false;
  failReads = false; failWrites = false; markerPresent = false; markerReadFails = false; markerWriteFails = false; markerWrites = 0;
});

function restart() { return custody.createCustodyMemory(custody.secureStoreCustodyPort, markerPort); }

describe('L7d: seen custody can never be downgraded', () => {
  for (const status of [404, 405, 501]) {
    test(`seen, then a later ${status}, refuses and never answers legacy`, async () => {
      const memory = restart();
      await memory.markSeen(FOLDER);
      await expect(custody.settleMissingCustody(memory, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    });

    test(`never seen, a ${status} reads legacy (L7b, flag-off invites stay readable)`, async () => {
      const memory = restart();
      expect(custody.isCustodyAbsentStatus(status)).toBe(true);
      expect(await custody.settleMissingCustody(memory, FOLDER)).toBe('legacy');
    });
  }

  test('other statuses are not "custody absent"', () => {
    for (const status of [200, 401, 403, 409, 429, 500, 502, 503, undefined, null]) {
      expect(custody.isCustodyAbsentStatus(status)).toBe(false);
    }
  });

  test('the refusal names the honest state', async () => {
    const memory = restart();
    await memory.markSeen(FOLDER);
    const error = await custody.settleMissingCustody(memory, FOLDER).catch(e => e);
    expect(error.name).toBe('CustodyUnavailableError');
    expect(error.message).toBe("This folder's keys are unavailable");
  });

  test('seen is per folder: a different folder still reads legacy', async () => {
    const memory = restart();
    await memory.markSeen(FOLDER);
    expect(await custody.settleMissingCustody(memory, OTHER_FOLDER)).toBe('legacy');
  });

  test('a fresh folder key is never minted over a folder whose custody was seen', async () => {
    const memory = restart();
    await custody.assertMayRegisterCustody(memory, FOLDER);
    await memory.markSeen(FOLDER);
    await expect(custody.assertMayRegisterCustody(memory, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    await custody.assertMayRegisterCustody(memory, OTHER_FOLDER);
  });
});

describe('L7d: folder ids are canonical UUIDs, and only those', () => {
  test('upper case is the same folder', async () => {
    const memory = restart();
    await memory.markSeen(FOLDER.toUpperCase());
    await expect(custody.settleMissingCustody(memory, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('any other form is refused, never remembered and never read as "not seen"', async () => {
    const memory = restart();
    for (const bad of ['folder', '', ' ', `{${FOLDER}}`, FOLDER.replace(/-/g, ''), `${FOLDER} `, `${FOLDER}x`, 'urn:uuid:' + FOLDER, 'a', FOLDER.slice(1), null, undefined, 7]) {
      await expect(memory.markSeen(bad)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
      await expect(memory.hasSeen(bad)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
      await expect(custody.settleMissingCustody(memory, bad)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
      await expect(custody.assertMayRegisterCustody(memory, bad)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    }
    expect(keychain.size).toBe(0);
  });
});

describe('L7d: one durable set for the whole device', () => {
  test('survives an app restart (a new memory over the same Keychain)', async () => {
    await restart().markSeen(FOLDER);
    const afterRestart = restart();
    expect(await afterRestart.hasSeen(FOLDER)).toBe(true);
    await expect(custody.settleMissingCustody(afterRestart, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('the Keychain holds exactly one item, with no account id, digest, or index', async () => {
    await restart().markSeen(FOLDER);
    await restart().markSeen(OTHER_FOLDER);
    expect([...keychain.keys()]).toEqual([RECORD_KEY]);
    expect(Object.keys(JSON.parse(keychain.get(RECORD_KEY))).sort()).toEqual(['folders', 'upgrade', 'v']);
  });

  test('nothing removes an entry: there is no clear, forget or sweep', async () => {
    const memory = restart();
    expect(Object.keys(memory).sort()).toEqual(['hasSeen', 'isUpgradeRequired', 'markSeen', 'markUpgradeRequired']);
    expect(custody.clearCustodyMemory).toBeUndefined();
  });

  test('marking is idempotent and keeps earlier folders', async () => {
    const memory = restart();
    await memory.markSeen(FOLDER);
    await memory.markSeen(FOLDER);
    await memory.markSeen(OTHER_FOLDER);
    const again = restart();
    expect(await again.hasSeen(FOLDER)).toBe(true);
    expect(await again.hasSeen(OTHER_FOLDER)).toBe(true);
  });

  test('concurrent marks for different folders both land', async () => {
    const memory = restart();
    await Promise.all([memory.markSeen(FOLDER), memory.markSeen(OTHER_FOLDER)]);
    const again = restart();
    expect(await again.hasSeen(FOLDER)).toBe(true);
    expect(await again.hasSeen(OTHER_FOLDER)).toBe(true);
  });

  test('a read waits for a write that is still in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = {
      get: async (key: string) => keychain.get(key) ?? null,
      set: async (key: string, value: string) => { await gate; keychain.set(key, value); },
    };
    const memory = custody.createCustodyMemory(slow, markerPort);
    const marking = memory.markSeen(FOLDER);
    let answered: boolean | null = null;
    const reading = memory.hasSeen(FOLDER).then(v => { answered = v; return v; });
    await new Promise(r => setTimeout(r, 20));
    expect(answered).toBeNull(); // still behind the write: never an early "not seen"
    release();
    await marking;
    expect(await reading).toBe(true);
  });
});

describe('L7d: an unreadable or unwritable memory never degrades to legacy', () => {
  test('a Keychain read failure refuses instead of answering legacy', async () => {
    const memory = restart();
    failReads = true;
    await expect(custody.settleMissingCustody(memory, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a corrupt record refuses instead of answering legacy', async () => {
    await restart().markSeen(FOLDER);
    keychain.set(RECORD_KEY, '{not json');
    await expect(custody.settleMissingCustody(restart(), FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    keychain.set(RECORD_KEY, JSON.stringify({ v: 2, folders: [FOLDER] }));
    await expect(custody.settleMissingCustody(restart(), FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a failed durable write rejects, so the folder key is not used', async () => {
    const memory = restart();
    failWrites = true;
    await expect(memory.markSeen(FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    failWrites = false;
    expect(await restart().hasSeen(FOLDER)).toBe(false);
  });
});

describe('P2-2: a lost Android Keystore never reads as "never seen"', () => {
  test('marking arms the marker, outside SecureStore', async () => {
    expect(markerPresent).toBe(false);
    await restart().markSeen(FOLDER);
    expect(markerPresent).toBe(true);
    expect(markerWrites).toBeGreaterThan(0);
  });

  test('marker present but the set reads back null: every question refuses', async () => {
    await restart().markSeen(FOLDER);
    keychain.clear(); // what a lost Keystore key looks like to expo-secure-store: a null read
    const memory = restart();
    await expect(memory.hasSeen(FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    await expect(memory.markSeen(OTHER_FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    await expect(custody.settleMissingCustody(memory, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    await expect(custody.assertMayRegisterCustody(memory, OTHER_FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    expect(keychain.size).toBe(0); // and nothing was written over the lost set
  });

  test('no marker and a null read is a device that never saw custody', async () => {
    expect(await custody.settleMissingCustody(restart(), FOLDER)).toBe('legacy');
  });

  test('a marker that cannot be read refuses when the set is null, and is not needed when the set reads fine', async () => {
    await restart().markSeen(FOLDER);
    markerReadFails = true;
    expect(await restart().hasSeen(FOLDER)).toBe(true); // set readable: no marker question
    keychain.clear();
    await expect(restart().hasSeen(FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a readable set re-arms a marker that went missing', async () => {
    await restart().markSeen(FOLDER);
    markerPresent = false; markerWrites = 0;
    expect(await restart().hasSeen(FOLDER)).toBe(true);
    expect(markerPresent).toBe(true);
  });

  test('the FIRST marker write failing fails markSeen: the folder key is not used', async () => {
    const memory = restart();
    markerWriteFails = true;
    await expect(memory.markSeen(FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    expect(markerPresent).toBe(false);
  });

  test('a markSeen retry arms the marker even though the folder is already in the stored set', async () => {
    const memory = restart();
    markerWriteFails = true;
    await expect(memory.markSeen(FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    markerWriteFails = false;
    await memory.markSeen(FOLDER); // the set already holds it; arming is still owed
    expect(markerPresent).toBe(true);
    expect(await restart().hasSeen(FOLDER)).toBe(true);
  });

  test('once the marker is armed, a later marker write failure does not fail markSeen', async () => {
    const memory = restart();
    await memory.markSeen(FOLDER);
    markerWriteFails = true;
    await memory.markSeen(OTHER_FOLDER);
    expect(await restart().hasSeen(OTHER_FOLDER)).toBe(true);
  });

  test('the default marker is the native no-backup marker, and a build without it refuses', async () => {
    const memory = custody.createCustodyMemory(custody.secureStoreCustodyPort); // default marker
    await memory.markSeen(FOLDER);
    expect(nativeMarker).toBe(true);
    keychain.clear();
    await expect(custody.createCustodyMemory(custody.secureStoreCustodyPort).hasSeen(FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
    nativeMarker = false; nativeMarkerMissing = true; // an older native build: no marker functions
    await expect(custody.createCustodyMemory(custody.secureStoreCustodyPort).markSeen(OTHER_FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
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

  test('409 upgrade_required is the honest "owner must convert" state, not a generic error', () => {
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
    await custody.assertMayRegisterCustody(memory, FOLDER);
    const state = await custody.noteUpgradeRequired(memory, FOLDER, upgradeError);
    expect(state).toBeInstanceOf(custody.UpgradeRequiredError);
    await expect(custody.assertMayRegisterCustody(memory, FOLDER)).rejects.toBeInstanceOf(custody.UpgradeRequiredError);
    await custody.assertMayRegisterCustody(memory, OTHER_FOLDER);
  });

  test('it survives a restart and a sign-out (nothing clears it)', async () => {
    await custody.noteUpgradeRequired(restart(), FOLDER, upgradeError);
    await expect(custody.assertMayRegisterCustody(restart(), FOLDER)).rejects.toBeInstanceOf(custody.UpgradeRequiredError);
  });

  test('other errors do not mark the folder', async () => {
    const memory = restart();
    expect(await custody.noteUpgradeRequired(memory, FOLDER, { status: 409, code: 'folder_key_missing' })).toBeNull();
    expect(await custody.noteUpgradeRequired(memory, FOLDER, new Error('boom'))).toBeNull();
    await custody.assertMayRegisterCustody(memory, FOLDER);
  });

  test('once the upgrade finished and custody was seen, the folder is custody and the flag is gone', async () => {
    const memory = restart();
    await custody.noteUpgradeRequired(memory, FOLDER, upgradeError);
    await memory.markSeen(FOLDER);
    const again = restart();
    expect(await again.isUpgradeRequired(FOLDER)).toBe(false);
    await expect(custody.assertMayRegisterCustody(again, FOLDER)).rejects.toBeInstanceOf(custody.CustodyUnavailableError);
  });

  test('a seen folder is not flagged upgrade-required by a later 409', async () => {
    const memory = restart();
    await memory.markSeen(FOLDER);
    await custody.noteUpgradeRequired(memory, FOLDER, upgradeError);
    expect(await restart().isUpgradeRequired(FOLDER)).toBe(false);
  });

  test('a Keychain that cannot store the flag still returns the upgrade state for this write', async () => {
    const memory = restart();
    failWrites = true;
    expect(await custody.noteUpgradeRequired(memory, FOLDER, upgradeError)).toBeInstanceOf(custody.UpgradeRequiredError);
  });
});

describe('source contract', () => {
  const source = readFileSync(join(import.meta.dir, 'shared-folder-custody.ts'), 'utf8');
  test('the custody module never logs', () => {
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/logDiagnostic|trace\(/);
  });
  test('the only durable store is SecureStore, never AsyncStorage (the sign-out purge deletes that), loaded lazily', () => {
    expect(source).toMatch(/import\('expo-secure-store'\)/);
    expect(source).not.toMatch(/async-storage/);
    expect(source).not.toMatch(/^import .*['"]expo-secure-store['"]/m);
  });
  test('the marker is native no-backup storage, never the cache directory', () => {
    expect(source).not.toMatch(/cacheDirectory|expo-file-system/);
    expect(source).toMatch(/import\('..\/..\/modules\/beebeeb-crypto'\)/);
  });
  test('L7d: the code knows no account and has no way to shrink the set', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments explain the rule in words
    expect(code).not.toMatch(/accountId|account-epoch|accountKey|digest|StaleAccountError/);
    expect(code).not.toMatch(/clearAll|clearCustodyMemory|deleteItemAsync|forget|store\.delete|folders\.delete/);
  });
});
