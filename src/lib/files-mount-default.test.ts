// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1722 round 4 — Guus, 2026-10-15:
 *   Q1 "Files on by default": a signed-in, unlocked user gets Beebeeb in iOS Files without
 *      touching the switch; the Settings switch still turns it off. Reverses task 0314's opt-in.
 *   Q2 "Always reset on sign-out": every sign-out removes the domain and the Files key; the
 *      next sign-in switches Files on again by default, unless that account turned it off.
 *
 * What "default on" means (src/lib/files-mount-default.ts):
 *   - consent on (the native flags)            -> register the existing domain (no reset)
 *   - consent off, no explicit off recorded    -> mount (fresh sign-in, after a session expiry,
 *                                                 after any sign-out)
 *   - consent off, this account turned it off  -> stay off (the choice outlives sign-out)
 *   - upgrade from a build without the default (TF 236): checked once per device. Consent on
 *     stays on. Consent off on an install that mounted Files before cannot be told apart from an
 *     explicit toggle-off (TF 236 cleared the same flags on every sign-out), so it counts as an
 *     explicit off for the account signed in at that moment. Never mounted = never chosen = on.
 *
 * `./file-provider-mount` imports react-native and the native bridge, so this file mocks it, plus
 * `react-native`, the native module and AsyncStorage (see mobile/CLAUDE.md "Tests").
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
let platformOS = 'ios';
mock.module('react-native', () => ({
  Platform: {
    get OS() {
      return platformOS;
    },
  },
}));

const storage = new Map<string, string>();
let storageFails = false;
/** Reads of keys with this prefix fail (an unreadable off choice). */
let readFailsFor: string | null = null;
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (storageFails || (readFailsFor && key.startsWith(readFailsFor))) throw new Error('storage unavailable');
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem: async (key: string, value: string) => {
      if (storageFails) throw new Error('storage unavailable');
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      if (storageFails) throw new Error('storage unavailable');
      storage.delete(key);
    },
  },
}));

/** Native consent state, as getFileProviderPrivacyState reports it. */
let native = { supported: true, showInFiles: false, everMounted: false };
mock.module('../../modules/beebeeb-crypto', () => ({
  getFileProviderPrivacyState: async () => ({
    supported: native.supported,
    showInFiles: native.showInFiles,
    trustedMountEnabled: native.showInFiles,
    mounted: native.showInFiles,
    everMounted: native.everMounted,
    requireDeviceAuth: true,
    unlockedUntilMs: 0,
    unlockWindowSeconds: 0,
    locked: !native.showInFiles,
  }),
}));

const calls: string[] = [];
let mountFails = false;
let mountGate: Promise<void> | null = null;
/** What the opt-out store held for this account at the moment Files was removed. */
let optOutAtRemoval: Array<boolean> = [];
let currentAccount = '';
const mounted = { supported: true, identifier: 'io.beebeeb.files', displayName: 'Beebeeb', registered: true, added: true,
  removedBeforeAdd: false, domainCount: 1, rootEnumerationSignaled: true, workingSetEnumerationSignaled: true,
  cacheDatabaseReady: true, userVisibleRootError: null };
mock.module('./file-provider-mount', () => ({
  mountTrustedFileProvider: async (options: { vaultUnlocked?: boolean } = {}) => {
    calls.push(`mount vaultUnlocked=${options.vaultUnlocked === true}`);
    if (mountGate) await mountGate;
    if (mountFails) throw new Error('Files integration is unavailable on this device');
    native.showInFiles = true;
    native.everMounted = true;
    return mounted;
  },
  registerTrustedFileProviderDomain: async () => {
    calls.push('register');
    return mounted;
  },
  removeTrustedFileProvider: async () => {
    calls.push('remove');
    const M = await import('./files-mount-default');
    optOutAtRemoval.push(await M.hasFilesOptOut(currentAccount));
    native.showInFiles = false;
    return { ...mounted, registered: false };
  },
}));

const M = await import('./files-mount-default');

/** What every sign-out does to the native state (Q2): consent off; the install has mounted before. */
function signOutResetsConsent() {
  native.showInFiles = false;
}

afterEach(() => {
  storage.clear();
  storageFails = false;
  readFailsFor = null;
  native = { supported: true, showInFiles: false, everMounted: false };
  calls.length = 0;
  mountFails = false;
  mountGate = null;
  optOutAtRemoval = [];
  currentAccount = '';
  platformOS = 'ios';
});

describe('the default-on decision (pure)', () => {
  test('consent on registers; consent off mounts unless this account turned Files off', () => {
    expect(M.filesDefaultAction({ consentOn: true, optedOut: false })).toBe('register');
    expect(M.filesDefaultAction({ consentOn: true, optedOut: true })).toBe('register');
    expect(M.filesDefaultAction({ consentOn: false, optedOut: false })).toBe('mount');
    expect(M.filesDefaultAction({ consentOn: false, optedOut: true })).toBe('stay-off');
  });

  test('upgrade from a build without the default: only "off on an install that mounted before" counts as an explicit off', () => {
    expect(M.legacyFilesChoice({ consentOn: true, everMounted: true })).toBe('none');
    expect(M.legacyFilesChoice({ consentOn: true, everMounted: false })).toBe('none');
    expect(M.legacyFilesChoice({ consentOn: false, everMounted: true })).toBe('opt-out');
    expect(M.legacyFilesChoice({ consentOn: false, everMounted: false })).toBe('none');
  });

  test('the account is stored as a digest: stable, per account, not the id itself', () => {
    const a = M.accountDigest('7f1c2a9e-0000-4000-8000-000000000001');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(M.accountDigest('7f1c2a9e-0000-4000-8000-000000000001')).toBe(a);
    expect(M.accountDigest('7f1c2a9e-0000-4000-8000-000000000002')).not.toBe(a);
    for (const key of storage.keys()) expect(key).not.toContain('7f1c2a9e');
  });
});

describe('Q1: signed in and unlocked, Files is mounted without the switch', () => {
  test('fresh sign-in on a new install: one mount (the vault is unlocked, so no second prompt), nothing recorded as off', async () => {
    const out = await M.ensureFilesMountedByDefault('user-a');
    expect(out.action).toBe('mount');
    expect(calls).toEqual(['mount vaultUnlocked=true']);
    expect(await M.hasFilesOptOut('user-a')).toBe(false);
  });

  test('the next foreground registers the mounted domain again and never re-mounts (a re-mount resets the domain)', async () => {
    await M.ensureFilesMountedByDefault('user-a');
    calls.length = 0;
    const out = await M.ensureFilesMountedByDefault('user-a');
    expect(out.action).toBe('register');
    expect(calls).toEqual(['register']);
  });

  test('Q2: after a sign-out or a session expiry the same account is mounted again on its next sign-in', async () => {
    await M.ensureFilesMountedByDefault('user-a');
    signOutResetsConsent();
    calls.length = 0;
    const out = await M.ensureFilesMountedByDefault('user-a');
    expect(out.action).toBe('mount');
    expect(calls).toEqual(['mount vaultUnlocked=true']);
  });

  test('not iOS, no account, or no File Provider support: nothing happens', async () => {
    platformOS = 'android';
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('unsupported');
    platformOS = 'ios';
    expect((await M.ensureFilesMountedByDefault('')).action).toBe('unsupported');
    native.supported = false;
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('unsupported');
    expect(calls).toEqual([]);
  });
});

describe('the Settings switch still turns Files off, and that choice outlives sign-out', () => {
  test('turning Files off records the choice BEFORE the domain is removed, and the next sign-in leaves Files off', async () => {
    currentAccount = 'user-a';
    await M.ensureFilesMountedByDefault('user-a');
    await M.setFilesMountedByUser({ userId: 'user-a', enabled: false, vaultUnlocked: true });
    expect(optOutAtRemoval).toEqual([true]);
    signOutResetsConsent();
    calls.length = 0;
    const out = await M.ensureFilesMountedByDefault('user-a');
    expect(out.action).toBe('stay-off');
    expect(calls).toEqual([]);
  });

  test('another account on the same phone still gets the default', async () => {
    await M.ensureFilesMountedByDefault('user-a');
    await M.setFilesMountedByUser({ userId: 'user-a', enabled: false, vaultUnlocked: true });
    signOutResetsConsent();
    calls.length = 0;
    expect((await M.ensureFilesMountedByDefault('user-b')).action).toBe('mount');
  });

  test('turning Files on again clears the choice, so the default applies after the next sign-out', async () => {
    await M.setFilesMountedByUser({ userId: 'user-a', enabled: false, vaultUnlocked: true });
    await M.setFilesMountedByUser({ userId: 'user-a', enabled: true, vaultUnlocked: true });
    expect(await M.hasFilesOptOut('user-a')).toBe(false);
    signOutResetsConsent();
    calls.length = 0;
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('mount');
  });

  test('a failed turn-on keeps the earlier off choice', async () => {
    await M.setFilesMountedByUser({ userId: 'user-a', enabled: false, vaultUnlocked: true });
    mountFails = true;
    await expect(M.setFilesMountedByUser({ userId: 'user-a', enabled: true, vaultUnlocked: true })).rejects.toThrow(/unavailable/);
    expect(await M.hasFilesOptOut('user-a')).toBe(true);
  });

  test('if the choice cannot be stored, Files is not removed (no half-applied off that the next sign-in undoes)', async () => {
    await M.ensureFilesMountedByDefault('user-a');
    storageFails = true;
    calls.length = 0;
    await expect(M.setFilesMountedByUser({ userId: 'user-a', enabled: false, vaultUnlocked: true })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('an off choice that cannot be read counts as off: no mount on a guess', async () => {
    await M.ensureFilesMountedByDefault('user-a');
    signOutResetsConsent();
    calls.length = 0;
    readFailsFor = 'beebeeb:files-mount-off:';
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('stay-off');
    expect(calls).toEqual([]);
  });

  test('a toggle-off while a default mount is still running waits for it, and Files ends off', async () => {
    currentAccount = 'user-a';
    let release: () => void = () => {};
    mountGate = new Promise<void>((resolve) => { release = resolve; });
    const auto = M.ensureFilesMountedByDefault('user-a');
    await Promise.resolve();
    const off = M.setFilesMountedByUser({ userId: 'user-a', enabled: false, vaultUnlocked: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(['mount vaultUnlocked=true']);
    release();
    await auto;
    await off;
    expect(calls).toEqual(['mount vaultUnlocked=true', 'remove']);
    expect(native.showInFiles).toBe(false);
    expect(await M.hasFilesOptOut('user-a')).toBe(true);
  });
});

describe('upgrade from TestFlight 236 (opt-in, cleared on every sign-out), checked once per device', () => {
  test('Files was on: stays on through a register, nothing recorded as off', async () => {
    native = { supported: true, showInFiles: true, everMounted: true };
    const out = await M.ensureFilesMountedByDefault('user-a');
    expect(out.action).toBe('register');
    expect(calls).toEqual(['register']);
    expect(await M.hasFilesOptOut('user-a')).toBe(false);
  });

  test('Files was off on an install that mounted it before: counted as an explicit off for this account', async () => {
    native = { supported: true, showInFiles: false, everMounted: true };
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('stay-off');
    expect(await M.hasFilesOptOut('user-a')).toBe(true);
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('stay-off');
    expect(calls).toEqual([]);
  });

  test('the check runs once: a later sign-out of the new build is not mistaken for an explicit off', async () => {
    native = { supported: true, showInFiles: false, everMounted: false };
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('mount');
    signOutResetsConsent();
    expect(native.everMounted).toBe(true);
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('mount');
    expect(await M.hasFilesOptOut('user-a')).toBe(false);
  });

  test('turning Files ON before the first default pass settles the check: a later sign-out is not re-read as an off', async () => {
    native = { supported: true, showInFiles: false, everMounted: true };
    await M.setFilesMountedByUser({ userId: 'user-a', enabled: true, vaultUnlocked: true });
    signOutResetsConsent();
    calls.length = 0;
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('mount');
    expect(await M.hasFilesOptOut('user-a')).toBe(false);
  });

  test('turning Files OFF before the first default pass settles the check: the next account is not given that off', async () => {
    native = { supported: true, showInFiles: true, everMounted: true };
    await M.setFilesMountedByUser({ userId: 'user-a', enabled: false, vaultUnlocked: true });
    calls.length = 0;
    expect((await M.ensureFilesMountedByDefault('user-b')).action).toBe('mount');
    expect(await M.hasFilesOptOut('user-b')).toBe(false);
  });

  test('Files never mounted on this install: never chosen, so on', async () => {
    native = { supported: true, showInFiles: false, everMounted: false };
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('mount');
  });

  test('the upgrade check is not consumed when the off choice cannot be stored (no mount on a guess)', async () => {
    native = { supported: true, showInFiles: false, everMounted: true };
    storageFails = true;
    await expect(M.ensureFilesMountedByDefault('user-a')).rejects.toThrow();
    expect(calls).toEqual([]);
    storageFails = false;
    expect((await M.ensureFilesMountedByDefault('user-a')).action).toBe('stay-off');
  });
});
