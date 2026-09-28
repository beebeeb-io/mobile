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

/**
 * F6/F3 (round 2): mirror the owner record into the SHARED keychain access
 * group (`R8352WDJJR.io.beebeeb.shared`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
 * — the same group + accessibility the master key itself is stored under),
 * via `BeebeebCryptoModule.mirrorKeyOwner`. `SecureStore.setItemAsync` above
 * writes to the APP's own default keychain (app-only group, `whenUnlocked`),
 * which the File Provider and Share Extension processes cannot read — that
 * mismatch (F6) is why those extensions previously used the vault key with
 * NO ownership check at all (F3): there was nowhere for them to read one
 * from. Both writes happen here so every existing call site (App.tsx
 * `signOut`, the unlock() branches below) gets the mirror for free. The
 * native call is best-effort: a failure here must never break the app's own
 * (already-authoritative) SecureStore-based precheck.
 */
async function mirrorKeyOwnerNative(userId: string | null): Promise<void> {
  const BeebeebCrypto = await import('../../modules/beebeeb-crypto');
  // Defensive `typeof` guard (not just try/catch): many existing tests
  // `mock.module('../../modules/beebeeb-crypto', () => ({...}))` a partial
  // object that predates this function, and calling a missing property
  // throws SYNCHRONOUSLY (`TypeError: ... is not a function`) before a
  // `.catch()` on its result could ever attach.
  if (typeof BeebeebCrypto.mirrorKeyOwner !== 'function') return;
  await BeebeebCrypto.mirrorKeyOwner(userId).catch(() => false);
}

/**
 * F3/F6 (round 2): mirror the CURRENTLY SIGNED-IN user's id into the same
 * shared keychain, via `BeebeebCryptoModule.mirrorSessionUserId`. Extensions
 * compare THIS value against the owner record above and refuse the key on
 * any mismatch or either being absent (`CryptoBridge.swift`,
 * `FileProviderExtension.swift`, `ShareViewController.swift`). Called from
 * `CryptoProvider`'s mount effect (crypto-context.tsx) — every sign-in / user
 * change re-mounts that provider. `mirrorSessionToAppGroup` (the session
 * token mirror, `BeebeebCryptoModule.swift`) clears this same shared value
 * the instant the token changes, so there is no window where a NEWLY
 * mirrored (now-authenticated) token pairs with a STALE session-user-id that
 * still matches the PREVIOUS owner record.
 */
export async function mirrorSignedInUserId(userId: string | null): Promise<void> {
  const BeebeebCrypto = await import('../../modules/beebeeb-crypto');
  if (typeof BeebeebCrypto.mirrorSessionUserId !== 'function') return;
  await BeebeebCrypto.mirrorSessionUserId(userId).catch(() => false);
}

export async function writeKeyOwner(userId: string): Promise<void> {
  await SecureStore.setItemAsync(MASTER_KEY_OWNER_LABEL, userId);
  await mirrorKeyOwnerNative(userId);
}

export async function clearKeyOwner(): Promise<void> {
  await SecureStore.deleteItemAsync(MASTER_KEY_OWNER_LABEL).catch(() => {});
  await mirrorKeyOwnerNative(null);
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
  if (owner === userId) {
    // Self-healing migration (round 2): an install that proved ownership
    // under the round-1 fix has the owner recorded in SecureStore (app-only)
    // but never mirrored it to the shared keychain, since that mirror did
    // not exist yet — so the extensions would see no owner record at all and
    // correctly refuse (fail closed). Re-mirror it on every bound precheck
    // (idempotent, best-effort) rather than requiring a fresh proof.
    await mirrorKeyOwnerNative(userId);
    return 'bound';
  }
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
 * Which proof `verifyKeyBelongsToAccount` is allowed to send over the wire.
 *
 *   - `trusted`  the key is either ALREADY bound to this user by an earlier
 *                proven sign-in (`precheckKeyOwner` returned `'bound'`), or
 *                was just derived from a phrase the user typed THIS attempt.
 *                Sending its `recovery_check` is safe: it is either already
 *                known to be this account's, or the user just proved
 *                knowledge of it by typing the phrase.
 *   - `unbound`  no local owner record exists for this key (a pre-1594 build
 *                never wrote one, or this is the very first proof attempt).
 *                It may be a DIFFERENT account's leftover key — see F1 below.
 *                `recovery_check` must never be sent in this mode.
 */
export type OwnershipCheckMode = 'trusted' | 'unbound';

/**
 * Ask the server whether the key whose `recovery_check` is `recoveryCheckB64`
 * belongs to `userId` (the session's account). `derivePublicKey` derives the
 * key's X25519 public key natively (the private scalar is zeroed by the
 * caller) and is called whenever the check itself is not sent — always in
 * `'unbound'` mode, and on the ambiguous 400 path in `'trusted'` mode.
 *
 * F1 (round 2, lead crypto review of #143 @ 8ae2b80, BLOCK): the round-1 fix
 * sent `recovery_check` FIRST regardless of `mode` — including for an
 * UNBOUND key, i.e. possibly a DIFFERENT account's leftover key, under the
 * NEW session. `recovery_check` is not an inert integrity value: server
 * `routes/recovery.rs` `recover_start` (`POST /recover-with-phrase-start`) is
 * UNAUTHENTICATED and accepts `{email, recovery_check}` to issue a
 * password-reset token good enough to re-register OPAQUE for that email —
 * i.e. `recovery_check` is a reset credential, full account takeover if
 * known. This app ships with no certificate pinning, so anyone who can read
 * this device's outgoing traffic (a MITM, or trivially the signed-in user
 * themselves via an on-device debugging proxy) learns account A's
 * `recovery_check` the moment it is sent under B's session — then calls the
 * unauthenticated endpoint directly with A's email. So: for an `'unbound'`
 * key, the check is proven WITHOUT ever sending `recovery_check` — by
 * comparing the key's derived X25519 public key against
 * `GET /auth/public-key/{userId}` (server 1554's `get_public_key`, callable
 * by any authenticated session for any user id — public keys are meant to be
 * looked up, e.g. for sharing, so nothing secret leaves this GET). Only
 * `'trusted'` keys ever POST `recovery_check`.
 */
export async function verifyKeyBelongsToAccount(params: {
  userId: string;
  recoveryCheckB64: string;
  derivePublicKey: () => Promise<Uint8Array>;
  mode: OwnershipCheckMode;
}): Promise<OwnershipVerdict> {
  const api = await import('./api');

  if (params.mode === 'trusted') {
    try {
      await api.verifyRecoveryCheck(params.recoveryCheckB64);
      recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'match', via: 'recovery_check' });
      return 'match';
    } catch (err) {
      if (httpStatus(err) !== 400) {
        recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'unreachable', status: httpStatus(err) });
        return 'unreachable';
      }
      // 400 invalid_recovery_phrase: a different account's key, OR an
      // account with no stored check (the server answers both the same).
      // Settle it below with the account's X25519 public key — same path an
      // `'unbound'` key always takes.
    }
  }

  // Unbound key (mode === 'unbound'), or a trusted key's ambiguous 400.
  // Nothing secret leaves this GET — see the doc comment above.
  let serverPublicKeyB64: string | null;
  try {
    serverPublicKeyB64 = await api.getUserPublicKey(params.userId);
  } catch (err) {
    recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'unreachable', via: 'public_key', status: httpStatus(err) });
    return 'unreachable';
  }
  const serverPublicKey = serverPublicKeyB64 ? base64ToBytes(serverPublicKeyB64) : null;
  if (!serverPublicKey) {
    // No public key on file either (early/legacy account, task 0875, that
    // also predates the 1554 public-key rollout): there is nothing to prove
    // an UNBOUND key against without sending its recovery_check — and that
    // is exactly the leak this mode exists to prevent. Ask for the phrase
    // instead (the caller treats 'unverifiable' + unbound as "not purged,
    // needs phrase" — see crypto-context.tsx).
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
  // F7 (reasoned through, round 2): can a WRONG key ever reach this backfill?
  // No — and this holds regardless of `mode`. X25519 public-key derivation is
  // a deterministic function of the private scalar; two distinct private
  // keys producing the same public point is cryptographically negligible
  // (not a real attack surface, not something a wrong key can be crafted to
  // do). `derivePublicKey` above is always bound to the SPECIFIC handle just
  // loaded/created for THIS candidate key by the caller (crypto-context.tsx
  // never passes a stale or different handle's deriver). So reaching this
  // line already proves the LOCAL key is the one behind `params.userId`'s
  // public key, independent of whether the caller arrived in `'trusted'` or
  // `'unbound'` mode. Backfilling that account's own recovery_check — a
  // set-once-if-absent, server-enforced write (`routes/recovery.rs`
  // `set_recovery_check`, `WHERE recovery_check IS NULL`) — is therefore
  // safe even from an `'unbound'` key: it is THIS cryptographic proof, not
  // the `mode` flag, that authorizes the write, exactly as web does after a
  // proven unlock (recovery-validation.ts backfillRecoveryCheckIfAbsent).
  void api.setRecoveryCheckIfAbsent(params.recoveryCheckB64).catch(() => ({ updated: false }));
  recordRuntimeTrace('vault.key_ownership.verdict', { verdict: 'match', via: 'public_key' });
  return 'match';
}
