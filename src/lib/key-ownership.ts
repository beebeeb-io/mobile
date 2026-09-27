/**
 * Task 1594 [P0] — bind the master key to the account that owns it.
 *
 * THE BUG. The keychain master key carried no owner. `loadVerifiedMasterKeyHandle`
 * (crypto-context.tsx) checked it only against `io.beebeeb.master-key-check`, a
 * value computed FROM THE SAME KEY at store time — that proves the key is
 * intact, not whose it is. Keychain items survive a session that ends without
 * the sign-out button (401, revoked session, account deleted, rejected startup
 * token) AND an app reinstall, so the next account to sign in on the device got
 * the previous account's vault key silently, and everything it created (the
 * backup folder tree on the dev DB, 2026-09-26) was sealed under a key that
 * other account holds.
 *
 * THE FIX, in this module:
 *   1. An owner record (`io.beebeeb.master-key-owner`, the account's user id)
 *      is stored next to the key. A stored owner that is not the signed-in user
 *      → the key, check, fallback, simulator file and owner are PURGED before
 *      the key is ever loaded, and the recovery phrase is required.
 *   2. Once per sign-in (a CryptoProvider mount), the key is proven against the
 *      server: `POST /api/v1/auth/verify-recovery-check` with the stored check
 *      value (the same HMAC signup sent and web sends — never the key or the
 *      phrase). A 400 is ambiguous (mismatch OR a legacy account with no stored
 *      check, task 0875), so it is settled by the account's X25519 public key
 *      (set once at signup from the real key; server 1554).
 *
 * Kept free of React so the decision is testable and so App.tsx only needs the
 * purge helper. `./api` is imported lazily: crypto-context loads this module
 * and several existing tests load crypto-context without mocking `./api`.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import { recordRuntimeTrace } from './runtime-trace';

// The keychain / SecureStore labels of the vault key. These strings are
// persisted on users' devices — never rename them.
export const MASTER_KEY_LABEL = 'io.beebeeb.master-key';
export const MASTER_KEY_CHECK_LABEL = 'io.beebeeb.master-key-check';
export const MASTER_KEY_FALLBACK_LABEL = 'io.beebeeb.master-key.fallback';
/** NEW (1594): the user id of the account the stored key belongs to. */
export const MASTER_KEY_OWNER_LABEL = 'io.beebeeb.master-key-owner';
export const SIMULATOR_MASTER_KEY_FILE = `${FileSystem.documentDirectory ?? ''}beebeeb-simulator-master-key.txt`;

/**
 * The message the vault throws when it needs the recovery phrase. It MUST keep
 * matching `/no master key in keychain/i` — BiometricGuard (App.tsx) lets only
 * that failure through the lock screen to the recovery gate.
 */
export const VAULT_NEEDS_PHRASE_MESSAGE = 'No master key in keychain — provide a recovery phrase to restore';
export const PHRASE_WRONG_ACCOUNT_MESSAGE =
  'This recovery phrase belongs to a different account. Enter the phrase for the account you signed in with.';
export const OWNERSHIP_UNREACHABLE_MESSAGE =
  "Couldn't confirm this vault key belongs to your account — check your connection and try again.";

export async function readKeyOwner(): Promise<string | null> {
  const v = await SecureStore.getItemAsync(MASTER_KEY_OWNER_LABEL).catch(() => null);
  return v && v.length > 0 ? v : null;
}

export async function writeKeyOwner(userId: string): Promise<void> {
  await SecureStore.setItemAsync(MASTER_KEY_OWNER_LABEL, userId);
}

export async function clearKeyOwner(): Promise<void> {
  await SecureStore.deleteItemAsync(MASTER_KEY_OWNER_LABEL).catch(() => {});
}

/**
 * Remove every persisted copy of the vault key from this device: the Secure
 * Enclave-wrapped key + the in-process native cache (`deleteKeyFromKeychain`,
 * which also clears `BeebeebCryptoBridge`'s cached handle the native backup
 * engine could adopt), the check value, the SecureStore fallback, the
 * simulator file + the simulator File Provider mirror, and the owner record.
 * Never throws — every step is independent and best-effort, like signOut().
 */
export async function purgeStoredVaultKey(reason: string): Promise<void> {
  recordRuntimeTrace('vault.key_ownership.purge', { reason });
  await BeebeebCrypto.deleteKeyFromKeychain().catch(() => false);
  await BeebeebCrypto.mirrorSimulatorFileProviderMasterKey(null).catch(() => false);
  await SecureStore.deleteItemAsync(MASTER_KEY_CHECK_LABEL).catch(() => {});
  await SecureStore.deleteItemAsync(MASTER_KEY_FALLBACK_LABEL).catch(() => {});
  await FileSystem.deleteAsync(SIMULATOR_MASTER_KEY_FILE, { idempotent: true }).catch(() => {});
  await clearKeyOwner();
}

/**
 * The owner pre-check, run BEFORE the key is loaded (no Face ID prompt, no
 * native handle, nothing the backup engine could adopt).
 *   - `bound`     the stored key belongs to `userId`
 *   - `unbound`   no owner recorded (a pre-1594 build, or a signup stored it
 *                 before the session existed) — must be verified before use
 *   - `purged`    it belonged to someone else and has been removed
 */
export type OwnerPrecheck = 'bound' | 'unbound' | 'purged';

export async function precheckKeyOwner(userId: string): Promise<OwnerPrecheck> {
  const owner = await readKeyOwner();
  if (owner == null) return 'unbound';
  if (owner === userId) return 'bound';
  recordRuntimeTrace('vault.key_ownership.owner_mismatch', {});
  await purgeStoredVaultKey('owner_mismatch');
  return 'purged';
}

/**
 * Server verdict on whether a key belongs to the signed-in account.
 *   - `match`         proven (recovery_check, or the X25519 public key)
 *   - `mismatch`      proven NOT to be this account's key
 *   - `unverifiable`  the account has neither a recovery_check nor a public
 *                     key on the server — nothing to prove it against
 *   - `unreachable`   network / server failure — no verdict (never "valid")
 */
export type OwnershipVerdict = 'match' | 'mismatch' | 'unverifiable' | 'unreachable';

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function httpStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * Ask the server whether the key whose `recovery_check` is `recoveryCheckB64`
 * belongs to `userId` (the session's account). `derivePublicKey` is only
 * called on the ambiguous 400 path; it must derive the key's X25519 public key
 * natively (the private scalar is zeroed by the caller).
 */
export async function verifyKeyBelongsToAccount(params: {
  userId: string;
  recoveryCheckB64: string;
  derivePublicKey: () => Promise<Uint8Array>;
}): Promise<OwnershipVerdict> {
  const api = await import('./api');
  try {
    await api.verifyRecoveryCheck(params.recoveryCheckB64);
    recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'match', via: 'recovery_check' });
    return 'match';
  } catch (err) {
    if (httpStatus(err) !== 400) {
      recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'unreachable', status: httpStatus(err) });
      return 'unreachable';
    }
  }

  // 400 invalid_recovery_phrase: a different account's key, OR an account with
  // no stored check (the server answers both the same). Settle it with the
  // account's X25519 public key.
  let serverPublicKeyB64: string | null;
  try {
    serverPublicKeyB64 = await api.getUserPublicKey(params.userId);
  } catch (err) {
    recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'unreachable', via: 'public_key', status: httpStatus(err) });
    return 'unreachable';
  }
  const serverPublicKey = serverPublicKeyB64 ? base64ToBytes(serverPublicKeyB64) : null;
  if (!serverPublicKey) {
    recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'unverifiable' });
    return 'unverifiable';
  }
  let localPublicKey: Uint8Array;
  try {
    localPublicKey = await params.derivePublicKey();
  } catch {
    // A native derivation failure is not a verdict either way.
    recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'unreachable', via: 'derive_public_key' });
    return 'unreachable';
  }
  if (!constantTimeEqual(localPublicKey, serverPublicKey)) {
    recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'mismatch' });
    return 'mismatch';
  }
  // Proven by the public key → the account simply has no stored check yet.
  // Backfill it (set-once-if-absent server-side), exactly as web does after a
  // proven unlock (recovery-validation.ts backfillRecoveryCheckIfAbsent).
  void api.setRecoveryCheckIfAbsent(params.recoveryCheckB64).catch(() => ({ updated: false }));
  recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'match', via: 'public_key' });
  return 'match';
}
