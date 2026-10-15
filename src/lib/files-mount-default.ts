import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import type { FileProviderDomainRegistrationResult } from '../../modules/beebeeb-crypto/src/BeebeebCrypto.types';
import { mountTrustedFileProvider, registerTrustedFileProviderDomain, removeTrustedFileProvider } from './file-provider-mount';

/**
 * Task 1722 round 4 — Beebeeb in iOS Files is ON by default.
 *
 * Guus, 2026-10-15: Q1 "Files on by default" (reverses task 0314's opt-in) and Q2 "Always reset
 * on sign-out". Every sign-out removes the domain and the Files key (native purge, unchanged);
 * the next sign-in mounts Files again unless that account turned it off in Settings.
 *
 * The decision, once the vault is unlocked (App.tsx `FileProviderDomainRegistrar`, on every
 * unlock and foreground):
 *   - the native consent is on            -> register the existing domain (never a re-mount: a
 *                                            mount resets the domain, and on iOS removing a domain
 *                                            deletes Files items that have not uploaded yet)
 *   - consent off, no recorded off        -> mount (fresh sign-in, session expiry, any sign-out)
 *   - consent off, this account said off  -> stay off
 *
 * The explicit off is kept per account, across sign-outs, because it is a privacy choice: a
 * session expiry must not undo it. It is stored on this device only (AsyncStorage: removed with
 * the app, not in backups of the keychain), keyed by a 64-bit digest of the account id rather
 * than the id itself, and holds nothing else.
 *
 * Upgrade from a build without the default (TestFlight 236 and earlier: opt-in, and every
 * sign-out cleared the consent the same way an explicit toggle-off did): checked once per
 * device, before the first decision. Consent on stays on. Consent off on an install that has
 * mounted Files before (`everMounted`, the domain schema stamp only a successful mount writes)
 * cannot be told apart from an explicit off, so it is recorded as one for the account signed in
 * at that moment; the user turns Files on once in Settings. Never mounted = never chosen = on.
 */

export type FilesDefaultAction = 'register' | 'mount' | 'stay-off';

export interface FilesDefaultOutcome {
  action: FilesDefaultAction | 'unsupported';
  result: FileProviderDomainRegistrationResult | null;
}

export function filesDefaultAction(input: { consentOn: boolean; optedOut: boolean }): FilesDefaultAction {
  if (input.consentOn) return 'register';
  return input.optedOut ? 'stay-off' : 'mount';
}

export function legacyFilesChoice(input: { consentOn: boolean; everMounted: boolean }): 'opt-out' | 'none' {
  return !input.consentOn && input.everMounted ? 'opt-out' : 'none';
}

const OPT_OUT_KEY_PREFIX = 'beebeeb:files-mount-off:v1:';
const LEGACY_CHECKED_KEY = 'beebeeb:files-mount-default:legacy-checked:v1';

function fnv1a32(bytes: Uint8Array, offsetBasis: number): string {
  let hash = offsetBasis >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 16 hex digits from two FNV-1a passes over the account id: enough to recognise the account on
 * this device, without storing the id itself. Not a secret and not meant to be one.
 */
export function accountDigest(userId: string): string {
  const bytes = new TextEncoder().encode(`beebeeb-files-mount:${userId}`);
  return fnv1a32(bytes, 0x811c9dc5) + fnv1a32(bytes, 0x050c5d1f);
}

function optOutKey(userId: string): string {
  return `${OPT_OUT_KEY_PREFIX}${accountDigest(userId)}`;
}

/**
 * Whether this account turned Files off. A storage read that fails counts as off: the default
 * must never override a choice it could not read.
 */
export async function hasFilesOptOut(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(optOutKey(userId))) === '1';
  } catch {
    return true;
  }
}

/** Throws when the choice cannot be stored; callers then do not remove Files. */
export async function recordFilesOptOut(userId: string): Promise<void> {
  await AsyncStorage.setItem(optOutKey(userId), '1');
}

export async function clearFilesOptOut(userId: string): Promise<void> {
  await AsyncStorage.removeItem(optOutKey(userId));
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs Files mount changes one at a time (the default at unlock and the Settings switch), so a
 * toggle-off that arrives during a default mount runs after it, and Files ends off.
 */
export function withFilesMountLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Once per device: the upgrade check described above. Throws (and stays unmarked) when storage
 * fails, so the caller mounts nothing on a guess and the check runs again next time.
 */
async function settleUpgradeChoiceOnce(userId: string, consentOn: boolean, everMounted: boolean): Promise<void> {
  if ((await AsyncStorage.getItem(LEGACY_CHECKED_KEY)) === '1') return;
  if (legacyFilesChoice({ consentOn, everMounted }) === 'opt-out') {
    await recordFilesOptOut(userId);
  }
  await AsyncStorage.setItem(LEGACY_CHECKED_KEY, '1');
}

/**
 * Applies the default for the signed-in, unlocked account. The caller (the registrar) only runs
 * this while the vault is unlocked, so the mount does not ask for device-owner auth again.
 */
export async function ensureFilesMountedByDefault(userId: string | null | undefined): Promise<FilesDefaultOutcome> {
  if (Platform.OS !== 'ios' || !userId) return { action: 'unsupported', result: null };
  return withFilesMountLock(async () => {
    const state = await BeebeebCrypto.getFileProviderPrivacyState();
    if (!state.supported) return { action: 'unsupported', result: null };
    const consentOn = state.showInFiles;
    if (consentOn) {
      // On stays on whatever storage does: the registration also re-provisions the Files key and
      // lifts Files' authentication throttle on every unlock (resumeFileProviderAuthenticationIfReady).
      await settleUpgradeChoiceOnce(userId, true, state.everMounted === true).catch(() => undefined);
    } else {
      await settleUpgradeChoiceOnce(userId, false, state.everMounted === true);
    }
    const action = filesDefaultAction({ consentOn, optedOut: consentOn ? false : await hasFilesOptOut(userId) });
    if (action === 'register') return { action, result: await registerTrustedFileProviderDomain() };
    if (action === 'mount') return { action, result: await mountTrustedFileProvider({ vaultUnlocked: true }) };
    return { action, result: null };
  });
}

/** An explicit choice on this device settles the upgrade check: there is nothing left to infer. */
async function markUpgradeChecked(): Promise<void> {
  await AsyncStorage.setItem(LEGACY_CHECKED_KEY, '1').catch(() => undefined);
}

/**
 * The Settings switch. Off: the choice is stored BEFORE Files is removed (if it cannot be stored,
 * nothing is removed and the caller shows the error, so the next unlock cannot undo a half-made
 * off). On: mounted, and the stored off is cleared only once Files is really mounted. Either way
 * the one-time upgrade check is settled, so it can never re-read a later sign-out as an off.
 */
export async function setFilesMountedByUser(options: {
  userId: string | null | undefined;
  enabled: boolean;
  vaultUnlocked: boolean;
}): Promise<FileProviderDomainRegistrationResult> {
  return withFilesMountLock(async () => {
    if (!options.enabled) {
      if (options.userId) await recordFilesOptOut(options.userId);
      await markUpgradeChecked();
      return removeTrustedFileProvider();
    }
    const result = await mountTrustedFileProvider({ vaultUnlocked: options.vaultUnlocked });
    if (options.userId && result.registered && result.cacheDatabaseReady !== false && !result.userVisibleRootError) {
      await clearFilesOptOut(options.userId);
      await markUpgradeChecked();
    }
    return result;
  });
}
