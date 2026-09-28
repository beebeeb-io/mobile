import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import * as Device from 'expo-device'
import * as FileSystem from 'expo-file-system/legacy'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  computeRecoveryCheck,
  confirmMasterKeyHandle,
  createMasterKeyHandle,
  createRequestKeypairWithHandle,
  decryptNames,
  deriveX25519PublicFromPrivate,
  handleComputeRecoveryCheck,
  handleDecryptChunk,
  handleDecryptMetadata,
  handleDeriveFileKey,
  handleDeriveX25519Private,
  handleEncryptChunk,
  handleEncryptMetadata,
  loadKeyFromKeychainAsHandle,
  logDiagnostic,
  recoverFromPhrase,
  releaseHandle,
  replaceKeychainAccessControl,
  replaceKeychainAccessControlFromHandle,
  storeKeyInKeychain,
  unwrapRequestPrivateWithHandle,
} from '../../modules/beebeeb-crypto'
import type { BatchNameItem, BatchNameResult, EncryptedData, RequestKeypairResult } from '../../modules/beebeeb-crypto'
import { setBackupEncryption, getKeepVaultUnlocked } from '../services/BackupService'
import { recordRuntimeTrace } from './runtime-trace'
import {
  createRequestKeyResolver,
  type RequestFileFields,
  type RequestKeyResolver,
} from './file-request-crypto'
import { verifyRecoveryPhraseAgainstStoredCheck } from './recovery-phrase-verify'
import {
  MASTER_KEY_CHECK_LABEL,
  MASTER_KEY_FALLBACK_LABEL,
  MASTER_KEY_LABEL,
  OWNERSHIP_UNREACHABLE_MESSAGE,
  PHRASE_WRONG_ACCOUNT_MESSAGE,
  SIMULATOR_MASTER_KEY_FILE,
  VAULT_NEEDS_PHRASE_MESSAGE,
  clearKeyOwner,
  mirrorSignedInUserId,
  precheckKeyOwner,
  purgeStoredVaultKey,
  verifyKeyBelongsToAccount,
  writeKeyOwner,
  type OwnershipVerdict,
} from './key-ownership'
import { getExpectedUserId, setExpectedUserId } from './expected-user'

// Task 1594: the labels moved to key-ownership.ts (the purge needs them too);
// re-exported so existing importers (App.tsx, tests) keep working.
export { SIMULATOR_MASTER_KEY_FILE }

// ─── Master key cache lifecycle (task 0556) ────────────────────────────────
//
// SOURCE OF TRUTH: `masterKeyHandleId.current` inside `CryptoProvider`.
// It is an opaque numeric ID pointing at a `MasterKeyHandle` in native
// (Rust/Swift) memory. Raw key bytes NEVER enter the JS heap.
//
// Lifecycle:
//   - CREATED on the first successful `unlock()` of the JS process —
//     either from a recovery phrase (creates a fresh handle from
//     bytes that exist only transiently in native memory) or from a
//     Keychain auto-unlock (`loadKeyFromKeychainAsHandle` reads the
//     SE-wrapped blob, may prompt Face ID once, then zeros bytes).
//   - HELD for the entire life of the JS process. Locking the screen
//     with biometric does NOT release it; the lock screen only gates
//     UI input, the crypto context stays warm so we can decrypt
//     thumbnails the moment the user is back in.
//   - RELEASED only on explicit `lock()` (intended for signout and
//     manual lock paths) or on JS process termination. The handle
//     intentionally outlives the biometric lock screen.
//
// Downstream invariant: every crypto operation in this file goes
// through `requireHandleId()`. NO code path may read the master key
// from the OS Keychain after `unlock()` has succeeded — that would
// re-prompt Face ID. The native backup engine, file provider, and
// PHKit callbacks live in separate processes / native contexts and
// keep their own keychain reads (extension SE key, `.devicePasscode`,
// never Face ID); those are outside this contract.
//
// Diagnostic logging must never receive raw bytes. The handle ID is
// opaque and fine to log.

// MASTER_KEY_LABEL / MASTER_KEY_CHECK_LABEL / MASTER_KEY_FALLBACK_LABEL (the
// SecureStore fallback used when the Secure Enclave is unavailable: simulator,
// older devices) / SIMULATOR_MASTER_KEY_FILE live in key-ownership.ts (1594).

/**
 * True when the master key is NOT stored behind a biometric-gated Secure
 * Enclave key on this runtime (simulator or non-SE device).
 * In that case `unlock()`/`loadVerifiedMasterKeyHandle()` read the key from
 * SecureStore (or the simulator file) WITHOUT raising a Face ID prompt, so the
 * biometric lock screen must perform its own explicit `authenticateAsync()` to
 * enforce a biometric. On a real device (release OR debug build) this is
 * `false`, and the SE decrypt inside `unlock()` IS the biometric gate (a
 * single Face ID prompt).
 * Exported so the lock-screen flow can decide whether `unlock()` will prompt
 * and therefore avoid a redundant second prompt (task 0792).
 *
 * SECURITY NOTE: do NOT add `|| __DEV__` here. A debug build on a real physical
 * device must use the Secure Enclave path — the software-vault fallback writes
 * the master key to a plain file in documentDirectory (unencrypted, accessible
 * to any process on a jailbroken device). `Device.isDevice` (false on
 * simulator/emulator, true on real hardware) is the correct discriminator.
 */
export function usesSoftwareVaultFallback(): boolean {
  return !Device.isDevice || Device.modelName?.toLowerCase().includes('simulator') === true
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Task 1594 round 4 (Codex P1, crypto-context.tsx:763): a module-level "vault
 * generation" counter. Bumped every time a CryptoProvider instance is
 * disposed (the unmount cleanup effect below) — App.tsx keys the provider by
 * user id, so disposal means a different account is signing in, a sign-out
 * is happening, or this same account's provider is being torn down and
 * rebuilt. `storeMasterKey` captures the generation its caller observed at
 * the START of that unlock() attempt and refuses to complete — undoing
 * anything it already wrote — the moment the generation has moved on.
 *
 * This closes a window the existing `disposedRef` checks cannot: `disposedRef`
 * is scoped to ONE React instance and is checked at resume points BEFORE
 * `storeMasterKey` is called, but `storeMasterKey` itself is a bare module
 * function with several of its own sequential `await`s (clearKeyOwner,
 * native keychain store, SecureStore writes) during which the SAME instance
 * can still be disposed — e.g. the user taps "Use another account" while a
 * phrase unlock is inside `storeMasterKey`. Without this, the abandoned call
 * keeps writing and can recreate the old account's key after sign-out, or
 * (if it finishes after a new instance already wrote a fresh key) overwrite
 * that new instance's key with the stale one.
 */
let vaultGeneration = 0

function bumpVaultGeneration(): number {
  vaultGeneration += 1
  return vaultGeneration
}

function currentVaultGeneration(): number {
  return vaultGeneration
}

/**
 * Task 1594 round 6 (reviewer follow-up on `purgeStoredVaultKey` at
 * `storeMasterKeyExclusive`'s stale-generation checks): the generation of the
 * MOST RECENT call — `storeMasterKeyExclusive`, or the keychain-unlock
 * branch's own `writeKeyOwner` — that finished establishing persisted vault
 * state without itself being stale. Round 4 only handled the CROSS-account
 * shape (A's abandoned write must not clobber B's fresh one): it purges
 * unconditionally once `stillCurrent()` is false, on the assumption that
 * "stale" always means "some other write for a different account is now the
 * only thing that matters." That assumption breaks for the SAME-account
 * remount race: a provider can unmount and remount for the SAME user (e.g. a
 * brief session churn), and the fresh instance's KEYCHAIN unlock (a read+
 * `writeKeyOwner` path that does not go through `storeMasterKeyQueue`) can
 * complete — legitimately re-proving and re-recording the very key this
 * generation-stale `storeMasterKeyExclusive` call is mid-writing — before
 * that stale call reaches its own `mid_write`/`after_write` check. Purging at
 * that point would delete the fresh instance's just-established, CORRECT
 * state, even though nothing about it was wrong (same account, same key). A
 * plain owner/check VALUE comparison cannot tell these two cases apart (both
 * write the identical value for the same account) — only generation ORDER
 * can: if a strictly newer generation has already persisted successfully,
 * this stale call's own write is superseded and must be abandoned WITHOUT
 * touching storage, not purged.
 */
let lastPersistedGeneration: number | null = null

function markGenerationPersisted(generation: number): void {
  if (lastPersistedGeneration == null || generation > lastPersistedGeneration) {
    lastPersistedGeneration = generation
  }
}

/** True when a generation strictly newer than `generation` already persisted. */
function newerGenerationAlreadyPersisted(generation: number): boolean {
  return lastPersistedGeneration != null && lastPersistedGeneration > generation
}

const STALE_GENERATION_MESSAGE = 'Vault provider unmounted before unlock completed'

/**
 * Round 4 serialization: only one `storeMasterKey` write sequence may be in
 * flight at a time. Without this, a stale (about to abort-and-purge) call and
 * a fresh, already-successful one could interleave — the stale call's own
 * "roll back what I wrote" purge would then delete the FRESH call's key
 * (they share the same keychain/SecureStore labels), turning a rare race into
 * real data loss instead of a no-op. Serializing means whichever call is
 * still stale by the time it reaches the front of the queue purges into an
 * otherwise-idle keychain — nothing else can be mid-write concurrently — and
 * the next queued call always starts from a clean, consistent state.
 */
let storeMasterKeyQueue: Promise<void> = Promise.resolve()

/**
 * Persist the master key. `ownerUserId` is the account it was PROVEN to belong
 * to (task 1594), or null when no session exists yet (signup stores the key
 * before refreshAuth) — an unbound key is verified against the server on the
 * next unlock before it is used. The old owner record is cleared FIRST so a
 * crash mid-store can only ever leave an unbound key (verified next time),
 * never a new key labelled with a previous account's id.
 *
 * `generation` is the vault generation the CALLER observed when it started
 * unlocking (round 4, Codex P1). Checked before any write (abort cheaply, an
 * unmount raced us before we even began) and again after every write below
 * it (an unmount raced one of OUR OWN awaits) — the final check, after the
 * generation-defining `writeKeyOwner` call, additionally rolls back
 * everything this call wrote via `purgeStoredVaultKey` so a stale write never
 * survives as apparent state, and never masquerades as "adopted" to the
 * caller (which would otherwise keep the native handle alive too). Queued
 * behind `storeMasterKeyQueue` (see above) so that rollback can never race a
 * different, still-current call's writes.
 */
async function storeMasterKey(masterKey: Uint8Array, ownerUserId: string | null, generation: number): Promise<void> {
  const ourTurn = storeMasterKeyQueue.catch(() => {})
  let releaseTurn: () => void = () => {}
  storeMasterKeyQueue = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  await ourTurn
  try {
    await storeMasterKeyExclusive(masterKey, ownerUserId, generation)
  } finally {
    releaseTurn()
  }
}

async function storeMasterKeyExclusive(masterKey: Uint8Array, ownerUserId: string | null, generation: number): Promise<void> {
  const stillCurrent = () => currentVaultGeneration() === generation
  if (!stillCurrent()) {
    recordRuntimeTrace('vault.key_ownership.stale_generation', { stage: 'before_write' })
    throw new Error(STALE_GENERATION_MESSAGE)
  }
  await clearKeyOwner()
  const encoded = uint8ToBase64(masterKey)
  const softwareFallbackRuntime = usesSoftwareVaultFallback()
  let nativeKeychainStored = false
  recordRuntimeTrace('keychain.store.request', {
    label: MASTER_KEY_LABEL,
    softwareFallbackRuntime,
  })
  try {
    await storeKeyInKeychain(masterKey, MASTER_KEY_LABEL)
    nativeKeychainStored = true
    recordRuntimeTrace('keychain.store.native_success', { label: MASTER_KEY_LABEL })
  } catch {
    // Secure Enclave unavailable — fall through to software fallback.
    recordRuntimeTrace('keychain.store.native_failed', { label: MASTER_KEY_LABEL })
  }
  const useSoftwareFallback = !nativeKeychainStored || softwareFallbackRuntime
  if (useSoftwareFallback) {
    await SecureStore.setItemAsync(MASTER_KEY_FALLBACK_LABEL, encoded)
    recordRuntimeTrace('keychain.store.software_fallback_written', {
      label: MASTER_KEY_FALLBACK_LABEL,
    })
  }
  if (softwareFallbackRuntime && FileSystem.documentDirectory) {
    await FileSystem.writeAsStringAsync(SIMULATOR_MASTER_KEY_FILE, encoded)
  }
  if (!stillCurrent()) {
    // Round 6: a same-account remount race can have ALREADY re-established
    // (via the keychain-unlock branch's own `writeKeyOwner`, outside this
    // queue) valid persisted state for a strictly newer generation while this
    // call's own awaits above were in flight. Purging now would destroy that
    // already-correct state for no reason — abandon quietly instead.
    if (newerGenerationAlreadyPersisted(generation)) {
      recordRuntimeTrace('vault.key_ownership.stale_write_superseded', { stage: 'mid_write' })
      throw new Error(STALE_GENERATION_MESSAGE)
    }
    recordRuntimeTrace('vault.key_ownership.stale_generation', { stage: 'mid_write' })
    await purgeStoredVaultKey('stale_generation')
    throw new Error(STALE_GENERATION_MESSAGE)
  }
  const check = await computeRecoveryCheck(masterKey)
  await SecureStore.setItemAsync(MASTER_KEY_CHECK_LABEL, uint8ToBase64(check))
  if (ownerUserId) await writeKeyOwner(ownerUserId)
  if (!stillCurrent()) {
    if (newerGenerationAlreadyPersisted(generation)) {
      recordRuntimeTrace('vault.key_ownership.stale_write_superseded', { stage: 'after_write' })
      throw new Error(STALE_GENERATION_MESSAGE)
    }
    recordRuntimeTrace('vault.key_ownership.stale_generation', { stage: 'after_write' })
    await purgeStoredVaultKey('stale_generation')
    throw new Error(STALE_GENERATION_MESSAGE)
  }
  // This call's write was never superseded and completed while still current
  // — record it so a LATER call that turns out to be stale (any of the three
  // checks above) knows not to destroy it.
  markGenerationPersisted(generation)
}

/** X25519 public key of the key behind `handleId`; the private scalar is zeroed. */
async function publicKeyFromHandle(handleId: number): Promise<Uint8Array> {
  const priv = await handleDeriveX25519Private(handleId)
  try {
    return await deriveX25519PublicFromPrivate(priv)
  } finally {
    priv.fill(0)
  }
}

/**
 * Discriminated outcome of a keychain auto-unlock attempt.
 *
 * The two failure shapes are NOT interchangeable and must never collapse
 * into a single `null` (the old contract):
 *   - `no_key`    — the master-key check label is absent: no key was ever
 *                   provisioned on this install (fresh Debug-sim, or a
 *                   device restore that dropped the SE blob). The vault
 *                   genuinely needs a recovery phrase. This is terminal.
 *   - `transient` — a key WAS provisioned here (check label present) but the
 *                   Secure-Enclave / Keychain read threw or returned null,
 *                   typically because the SE isn't warm yet this early in
 *                   process start (`native_handle_failed`). A relaunch — or a
 *                   single short retry once the SE warms — reads it fine. This
 *                   must NOT trigger the recovery-phrase prompt.
 */
type VaultLoadResult =
  | { handleId: number }
  | { reason: 'no_key' }
  | { reason: 'transient' }
  // Surfaced (fail-closed) biometric outcomes from the native primary load
  // (task 0882). These are NOT retried — the lock screen stays locked and the
  // user gets a real tap-to-retry (0428). `transient` is the ONLY retry path.
  | { reason: 'auth_canceled' }
  | { reason: 'auth_failed' }
  | { reason: 'biometry_lockout' }

/**
 * Map a native vault-auth error `code` (thrown by `loadKeyFromKeychainAsHandle`
 * as an Expo Exception, task 0882) to a surfaced VaultLoadResult reason.
 * Returns `null` for retryable / unknown codes so the caller falls through to
 * the normal `transient` path (silent cold-start warm-up retry).
 */
function surfacedReasonForAuthCode(code: unknown): 'auth_canceled' | 'auth_failed' | 'biometry_lockout' | null {
  switch (code) {
    case 'ERR_VAULT_AUTH_CANCELED':
      return 'auth_canceled'
    case 'ERR_VAULT_AUTH_FAILED':
      return 'auth_failed'
    case 'ERR_VAULT_BIOMETRY_LOCKOUT':
      return 'biometry_lockout'
    // ERR_VAULT_SE_NOT_WARM / ERR_VAULT_AUTH_NOT_AVAILABLE (and anything else)
    // are retryable → fall through to transient.
    default:
      return null
  }
}

/**
 * Load the master key from persistent storage and return an opaque native
 * handle ID. The real key bytes never enter the JS heap. For fallback paths
 * (simulator, older devices) the raw bytes are loaded transiently, stored
 * into the SE-backed keychain to create a handle, then zeroed.
 *
 * Returns a discriminated `VaultLoadResult`:
 *   - `{ handleId }`         on success
 *   - `{ reason: 'no_key' }` ONLY when no key was ever provisioned (check
 *                            label absent) — the genuine recovery path
 *   - `{ reason: 'transient' }` when a key exists here but the read failed
 *                            (SE not warm, fallback miss despite a present
 *                            check label) — safe to retry, never recovery
 */
async function loadVerifiedMasterKeyHandle(): Promise<VaultLoadResult> {
  const checkB64 = await SecureStore.getItemAsync(MASTER_KEY_CHECK_LABEL).catch(() => null)
  if (!checkB64) {
    recordRuntimeTrace('keychain.load.no_recovery_check', { label: MASTER_KEY_CHECK_LABEL })
    return { reason: 'no_key' }
  }

  const expected = base64ToUint8(checkB64)

  // Helper: verify a handle's recovery check against the stored expected value.
  const verifyHandle = async (handleId: number): Promise<boolean> => {
    const actual = await handleComputeRecoveryCheck(handleId)
    return constantTimeEqual(actual, expected)
  }

  // Helper: verify raw bytes, create a handle if valid, zero the raw bytes.
  const verifyAndCreateHandle = async (candidate: Uint8Array | null): Promise<number | null> => {
    if (!candidate) return null
    try {
      const actual = await computeRecoveryCheck(candidate)
      if (!constantTimeEqual(actual, expected)) return null
      try {
        await storeKeyInKeychain(candidate, MASTER_KEY_LABEL)
      } catch {
        // SE may be unavailable — the native handle can still be created
        // directly from this verified fallback key.
      }
      return await createMasterKeyHandle(candidate)
    } finally {
      candidate.fill(0)
    }
  }

  // The check label is present below this point: a key WAS provisioned on this
  // install. Therefore EVERY failure from here on is `transient`, never
  // `no_key` — relaunching (or retrying once the SE warms) reads it fine. The
  // only `no_key` exit is the absent-check-label guard above.

  // Primary: Secure Enclave-wrapped key (real devices)
  if (!usesSoftwareVaultFallback()) {
    try {
      recordRuntimeTrace('keychain.load.native_handle_request', {
        label: MASTER_KEY_LABEL,
        promptMayAppear: true,
        source: 'loadVerifiedMasterKeyHandle',
      })
      // Native primary load (task 0882): KeychainManager.load performs ONE
      // explicit, user-initiated biometric/passcode evaluation and reuses it for
      // the SE decrypt via kSecUseAuthenticationContext — a single prompt
      // (0792), replacing the old too-early IMPLICIT SE evaluation that raced
      // the cold-start warm-up. Auth outcomes arrive as a thrown Expo Exception
      // whose `code` we classify below: cancel/fail/lockout are SURFACED
      // (fail-closed, 0428); warm-up/unavailable fall through to `transient`.
      const handleId = await loadKeyFromKeychainAsHandle(MASTER_KEY_LABEL)
      if (handleId != null) {
        if (await verifyHandle(handleId)) {
          recordRuntimeTrace('keychain.load.native_handle_success', {
            label: MASTER_KEY_LABEL,
            handleId,
          })
          return { handleId }
        }
        // Verification failed — release the handle
        await releaseHandle(handleId).catch(() => {})
        recordRuntimeTrace('keychain.load.native_handle_verify_failed', {
          label: MASTER_KEY_LABEL,
          handleId,
        })
      }
      // handleId == null: the SE/Keychain read returned no key even though a
      // key was provisioned here (check label present) — SE not warm yet.
      // Transient: a relaunch / retry reads it. Do NOT prompt for recovery.
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      const surfaced = surfacedReasonForAuthCode(code)
      if (surfaced != null) {
        // A real user cancel / auth failure / biometric lockout. Surface it —
        // do NOT retry and do NOT fall through to the SecureStore fallback (a
        // provisioned real-device install has none anyway). The lock screen
        // stays locked with a genuine tap-to-retry (0428 fail-closed).
        recordRuntimeTrace('keychain.load.native_handle_auth_surfaced', {
          label: MASTER_KEY_LABEL,
          code: typeof code === 'string' ? code : 'unknown',
          reason: surfaced,
        })
        return { reason: surfaced }
      }
      // SE read threw a retryable/unknown code (warm-up) — same transient story.
      // Fall through to the SecureStore fallback, then report transient.
      recordRuntimeTrace('keychain.load.native_handle_failed', {
        label: MASTER_KEY_LABEL,
        code: typeof code === 'string' ? code : 'unknown',
      })
    }
  }

  // Fallback: SecureStore (simulator, or SE failure on older/unavailable devices)
  const raw = await SecureStore.getItemAsync(MASTER_KEY_FALLBACK_LABEL).catch(() => null)
  const fallbackHandle = await verifyAndCreateHandle(raw ? base64ToUint8(raw) : null)
  if (fallbackHandle != null) {
    recordRuntimeTrace('keychain.load.software_fallback_success', {
      label: MASTER_KEY_FALLBACK_LABEL,
      handleId: fallbackHandle,
    })
    return { handleId: fallbackHandle }
  }

  if (usesSoftwareVaultFallback() && FileSystem.documentDirectory) {
    const fileRaw = await FileSystem.readAsStringAsync(SIMULATOR_MASTER_KEY_FILE).catch(() => null)
    const fileHandle = await verifyAndCreateHandle(fileRaw ? base64ToUint8(fileRaw) : null)
    recordRuntimeTrace('keychain.load.simulator_file_result', {
      found: fileHandle != null,
      handleId: fileHandle,
    })
    if (fileHandle != null) {
      return { handleId: fileHandle }
    }
  }

  // Check label present but no readable key from any source: transient. The
  // genuine missing-key case already returned `no_key` at the top.
  recordRuntimeTrace('keychain.load.transient_miss', { label: MASTER_KEY_CHECK_LABEL })
  return { reason: 'transient' }
}

export type VaultUnlockSource =
  | 'unspecified'
  | 'recovery_phrase'
  | 'keychain'
  | 'backup_background'
  | 'already_unlocked'
  | string

export interface VaultUnlockDiagnostics {
  isUnlocked: boolean
  unlockAttempted: boolean
  unlockInFlight: boolean
  lastUnlockSource: VaultUnlockSource | null
  lastUnlockOutcome: string | null
  lastUnlockAt: string | null
  lastUnlockError: string | null
  lastPromptExpected: boolean | null
  lastAlreadyUnlocked: boolean | null
  lastInFlightAtRequest: boolean | null
}

let latestVaultUnlockDiagnostics: VaultUnlockDiagnostics = {
  isUnlocked: false,
  unlockAttempted: false,
  unlockInFlight: false,
  lastUnlockSource: null,
  lastUnlockOutcome: null,
  lastUnlockAt: null,
  lastUnlockError: null,
  lastPromptExpected: null,
  lastAlreadyUnlocked: null,
  lastInFlightAtRequest: null,
}

export function getLastVaultUnlockDiagnostics(): VaultUnlockDiagnostics {
  return { ...latestVaultUnlockDiagnostics }
}

function updateVaultUnlockDiagnostics(patch: Partial<VaultUnlockDiagnostics>): VaultUnlockDiagnostics {
  latestVaultUnlockDiagnostics = {
    ...latestVaultUnlockDiagnostics,
    ...patch,
  }
  return latestVaultUnlockDiagnostics
}

function logVaultUnlockDiagnostic(event: string, fields: Record<string, unknown>): void {
  recordRuntimeTrace('vault.unlock', {
    event,
    ...fields,
  })
  logDiagnostic('vault.unlock', {
    event,
    ...fields,
  })
  console.info('[BeebeebDiagnostics] vault.unlock', {
    event,
    ...fields,
  })
}

interface CryptoContextValue {
  isUnlocked: boolean
  /**
   * True once the first unlock() call has completed — success OR failure.
   * Screens can use this to distinguish "vault still initialising" from
   * "vault is open" / "vault is locked with no key available".
   */
  unlockAttempted: boolean
  /**
   * True ONLY when a keychain auto-unlock failed because no master key was
   * ever provisioned on this install (the genuine recovery-phrase case:
   * fresh Debug-sim, device restore that dropped the SE blob). It is NOT set
   * by a transient Secure-Enclave fast-fail on cold launch — those get one
   * silent retry and never reach this state. The VaultRecoveryGate keys off
   * THIS signal (not the outcome-agnostic `unlockAttempted`) before routing
   * to RecoveryUnlock.
   */
  needsRecoveryPhrase: boolean
  /**
   * Unlock the vault.
   * - With phrase: derives the master key from a recovery phrase and stores it
   *   in the secure enclave for future unlocks.
   * - Without phrase: loads the master key from the secure enclave directly.
   */
  unlock: (phrase?: string, source?: VaultUnlockSource) => Promise<void>
  /** Latest vault unlock diagnostics for debug/export surfaces. */
  getUnlockDiagnostics: () => VaultUnlockDiagnostics
  /** Zero out the in-memory master key and mark vault as locked. */
  lock: () => void
  encryptChunk: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>
  decryptChunk: (fileId: string, nonce: Uint8Array, ct: Uint8Array) => Promise<Uint8Array>
  encryptMetadata: (fileId: string, metadata: string) => Promise<EncryptedData>
  decryptMetadata: (fileId: string, nonce: Uint8Array, ct: Uint8Array) => Promise<string>
  /**
   * Batch-decrypt many file names in ONE native call (task 0807). The master
   * key stays in the secure-enclave handle (0556). Order + length of the result
   * match `items`; a failed item yields `error` for that item only.
   */
  decryptNames: (items: BatchNameItem[]) => Promise<BatchNameResult[]>
  /**
   * Derive and return the raw 32-byte file key for a given fileId.
   * Used for ZK share creation where we need to wrap the key client-side.
   * Throws if vault is locked.
   */
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>
  /**
   * Return the opaque native handle ID for the master key.
   * The handle resolves to the real key in native memory; raw bytes
   * never enter the JS heap.
   * Throws if vault is locked.
   */
  getMasterKeyHandleId: () => number
  /**
   * Derive the X25519 secret scalar from the master key handle.
   * Returns raw bytes needed for the X25519 shared secret computation
   * during share creation. Throws if vault is locked.
   */
  deriveX25519PrivateFromHandle: () => Promise<Uint8Array>
  /**
   * Derive the search-index encryption key from the master key, using the
   * same HKDF info string the web client uses (`beebeeb-search-index`) so
   * the same key derivation produces the same key on both platforms.
   */
  getIndexKey: () => Promise<Uint8Array>
  /**
   * Persist whether the Secure Enclave wrapping key should require biometrics
   * instead of the device passcode. Requires the vault to already be unlocked.
   */
  setBiometricRequirement: (require: boolean) => Promise<void>
  /**
   * Attempt to unlock the vault from the Keychain without user interaction.
   * Used by the backup bridge when the vault is locked but the user has opted
   * in to "keep vault unlocked for backup". Returns true if the vault was
   * successfully unlocked, false otherwise (setting disabled, no key in
   * Keychain, verification failed).
   *
   * Safe to call when already unlocked — returns true immediately.
   */
  tryBackgroundUnlock: () => Promise<boolean>
  // ── File requests (0643) ──
  /**
   * Generate a per-request X25519 keypair and wrap R_priv under the master key.
   * Returns the public key (for the link fragment) + the wrapped private key
   * (to POST to the server). R_priv is generated natively and never enters JS.
   * Throws if the vault is locked.
   */
  createRequestKeypair: () => Promise<RequestKeypairResult>
  /**
   * Rebuild a request's X25519 public key from its stored wrapped private key,
   * so the share link can be reconstructed. Throws if the vault is locked.
   */
  rebuildRequestPublicKey: (wrapped: Uint8Array, nonce: Uint8Array) => Promise<Uint8Array>
  /**
   * Resolve the content key C for a file that arrived through a file request.
   * Use the returned key wherever a normal per-file key is expected (chunk +
   * metadata decryption). Throws if the vault is locked or the file is not a
   * request upload.
   */
  getRequestContentKey: (file: RequestFileFields) => Promise<Uint8Array>
  /**
   * Task 1445 (ruling 2): verify a typed recovery phrase against the master
   * key ALREADY persisted for this account, without ever writing to the
   * keychain. Returns true only if the phrase derives the same key. Unlike
   * `unlock(phrase)`, a wrong phrase here is inert — it can never overwrite
   * the real stored key (see `recovery-phrase-verify.ts` for the safety
   * contract). Never throws.
   */
  verifyRecoveryPhrase: (phrase: string) => Promise<boolean>
}

const CryptoContext = createContext<CryptoContextValue | null>(null)

export function CryptoProvider({ children, userId }: { children: React.ReactNode; userId?: string | null }) {
  const [isUnlocked, setIsUnlocked] = useState(false)
  // True once the first unlock() attempt has settled (success or failure).
  // Used by FilesScreen to distinguish "still loading key" from "locked".
  const [unlockAttempted, setUnlockAttempted] = useState(false)
  // True ONLY when an auto-unlock proved the vault genuinely has no key
  // provisioned (loadVerifiedMasterKeyHandle → { reason: 'no_key' }). This
  // is the recovery-phrase signal the VaultRecoveryGate gates on. A transient
  // Secure-Enclave fast-fail never sets this; it is handled by a silent retry.
  const [needsRecoveryPhrase, setNeedsRecoveryPhrase] = useState(false)
  // masterKeyHandleId holds an opaque numeric ID referencing the real
  // MasterKeyHandle in native memory. Raw key bytes never enter the JS
  // heap. Never store in React state to avoid accidental serialisation.
  const masterKeyHandleId = useRef<number | null>(null)
  const unlockInFlightRef = useRef(false)
  const unlockPromiseRef = useRef<Promise<void> | null>(null)
  // File-request owner-decrypt resolver (0643). Lazily created; caches unwrapped
  // R_priv per request. Cleared + zeroized on lock() alongside the master key.
  const requestResolverRef = useRef<RequestKeyResolver | null>(null)
  // Task 1594: the signed-in account this provider instance serves. App.tsx
  // keys CryptoProvider by user id, so a mount == one sign-in (or one cold
  // launch restoring a session); `ownershipVerifiedRef` therefore means "the
  // key was proven against the server once during this sign-in".
  const ownerUserId = userId ?? null
  const ownershipVerifiedRef = useRef(false)
  // Task 1594 round 3 (Codex T1): flips true when THIS provider instance is
  // torn down. App.tsx keys CryptoProvider by user id, so a sign-in as a
  // different account (or a session ending and a new one starting) unmounts
  // this instance and mounts a fresh one. An unlock() started here can still
  // be awaiting the server's ownership verdict when that happens — once
  // disposed, it must never publish anything to React state or to the
  // module-level globals (`expected-user.ts`, the keychain owner record):
  // a NEW provider for a possibly different account may already be relying
  // on them, and an abandoned verdict about THIS instance's account must not
  // overwrite what the new one just established.
  const disposedRef = useRef(false)

  // F3 (round 2): mirror who is CURRENTLY signed in into the shared keychain
  // the File Provider / Share Extension read (key-ownership.ts). Every
  // sign-in / user change remounts this provider (App.tsx keys it by user
  // id), so a mount-time effect is exactly "the signed-in user changed".
  // `mirrorSessionToAppGroup` (BeebeebCryptoModule.swift) clears this same
  // shared value the instant the session token changes, so an extension can
  // never read a STALE session-user-id that still happens to match the
  // outgoing owner record while this effect's write is still in flight.
  useEffect(() => {
    void mirrorSignedInUserId(ownerUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerUserId])

  useEffect(() => {
    updateVaultUnlockDiagnostics({
      isUnlocked,
      unlockAttempted,
      unlockInFlight: unlockInFlightRef.current,
    })
  }, [isUnlocked, unlockAttempted])

  // Release native key material on unmount (bug R3). Signout flips this
  // provider's `key` prop (user_id → 'signed-out') which REMOUNTS the provider:
  // that resets the JS refs of the *new* instance but never runs `lock()`, so
  // the OLD instance's native MasterKeyHandle is never released (Rust never
  // zeroizes the master key) and the cached request-key (R_priv) buffers in the
  // resolver are never zeroed. Mirror lock()'s teardown here — minus setState,
  // since the component is unmounting. The biometric lock screen does NOT change
  // `key`, so the warm-vault-on-lock design (the handle intentionally outlives
  // the lock screen) is preserved.
  useEffect(() => {
    return () => {
      // Task 1594 round 3 (T1): set FIRST, before anything else below — an
      // in-flight unlock() checks this ref at its own resume points and must
      // see it flipped the instant this cleanup starts running.
      disposedRef.current = true
      // Task 1594 round 4 (Codex P1): bump the module-level vault generation
      // in the SAME cleanup, so any storeMasterKey() write still in flight
      // for THIS instance (which cannot see disposedRef — it is a bare
      // module function) sees it has gone stale the next time it checks.
      bumpVaultGeneration()
      if (masterKeyHandleId.current != null) {
        void releaseHandle(masterKeyHandleId.current).catch(() => {})
        masterKeyHandleId.current = null
      }
      requestResolverRef.current?.clear()
      requestResolverRef.current = null
      if (ownerUserId != null && getExpectedUserId() === ownerUserId) setExpectedUserId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unlock = useCallback(async (phrase?: string, source: VaultUnlockSource = phrase != null ? 'recovery_phrase' : 'keychain') => {
    const hasRecoveryPhrase = phrase != null
    // Task 1594 round 4 (Codex P1): the vault generation observed at the
    // START of this attempt. Passed to storeMasterKey so it can detect (and
    // undo) writing on behalf of an instance that gets disposed mid-write.
    const myGeneration = currentVaultGeneration()
    const alreadyUnlocked = masterKeyHandleId.current != null
    const promptExpected = !hasRecoveryPhrase && !alreadyUnlocked
    const inFlightAtRequest = unlockPromiseRef.current != null || unlockInFlightRef.current
    updateVaultUnlockDiagnostics({
      isUnlocked: alreadyUnlocked,
      unlockAttempted,
      unlockInFlight: inFlightAtRequest,
      lastUnlockSource: source,
      lastUnlockOutcome: 'requested',
      lastUnlockAt: new Date().toISOString(),
      lastUnlockError: null,
      lastPromptExpected: promptExpected,
      lastAlreadyUnlocked: alreadyUnlocked,
      lastInFlightAtRequest: inFlightAtRequest,
    })
    logVaultUnlockDiagnostic('request', {
      source,
      alreadyUnlocked,
      promptExpected,
      inFlightAtRequest,
    })

    // If the vault is already open and no recovery phrase was given, skip the
    // redundant keychain load. On devices with biometric-protected Secure
    // Enclave keys, loadKeyFromKeychainAsHandle triggers a Face ID prompt —
    // calling unlock() again after BiometricLockScreen already authenticated
    // would surface a second, unnecessary Face ID dialog.
    if (!hasRecoveryPhrase && masterKeyHandleId.current != null) {
      setIsUnlocked(true)
      setUnlockAttempted(true)
      updateVaultUnlockDiagnostics({
        isUnlocked: true,
        unlockAttempted: true,
        unlockInFlight: false,
        lastUnlockSource: source,
        lastUnlockOutcome: 'already_unlocked',
        lastUnlockAt: new Date().toISOString(),
        lastUnlockError: null,
      })
      logVaultUnlockDiagnostic('already_unlocked', { source })
      return
    }

    if (!hasRecoveryPhrase && unlockPromiseRef.current != null) {
      updateVaultUnlockDiagnostics({
        isUnlocked: false,
        unlockAttempted,
        unlockInFlight: true,
        lastUnlockSource: source,
        lastUnlockOutcome: 'awaiting_in_flight',
        lastUnlockAt: new Date().toISOString(),
        lastUnlockError: null,
        lastPromptExpected: false,
        lastAlreadyUnlocked: false,
        lastInFlightAtRequest: true,
      })
      logVaultUnlockDiagnostic('awaiting_in_flight', {
        source,
        alreadyUnlocked: false,
        promptExpected: false,
        inFlightAtRequest: true,
      })
      await unlockPromiseRef.current
      return
    }

    let unlockOperation: Promise<void> | null = null
    unlockOperation = (async () => {
      unlockInFlightRef.current = true
      updateVaultUnlockDiagnostics({
        unlockInFlight: true,
        lastUnlockSource: source,
        lastUnlockOutcome: 'started',
        lastUnlockAt: new Date().toISOString(),
        lastPromptExpected: promptExpected,
        lastAlreadyUnlocked: alreadyUnlocked,
        lastInFlightAtRequest: inFlightAtRequest,
      })
      logVaultUnlockDiagnostic('start', {
        source,
        alreadyUnlocked,
        promptExpected,
        inFlightAtRequest,
      })
      try {
        if (hasRecoveryPhrase) {
          // Derive the master key from the recovery phrase. The raw bytes
          // are needed transiently to persist to keychain, but we immediately
          // load a handle and zero the raw bytes.
          const result = await recoverFromPhrase(phrase)
          const masterKey = result.masterKey
          let handleId: number | null = null
          let adopted = false
          try {
            handleId = await createMasterKeyHandle(masterKey)
            const phraseHandleId = handleId
            // Task 1594: a checksum-valid phrase derives SOME key — prove it is
            // the signed-in account's before it is stored or used (the same
            // gate web runs, recovery-validation.ts). Without a session yet
            // (signup, before refreshAuth) there is nothing to prove against:
            // the key is stored UNBOUND and verified on the next unlock.
            if (ownerUserId != null) {
              const verdict = await verifyKeyBelongsToAccount({
                userId: ownerUserId,
                recoveryCheckB64: uint8ToBase64(await computeRecoveryCheck(masterKey)),
                derivePublicKey: () => publicKeyFromHandle(phraseHandleId),
                // F1 case (b): a phrase the user just typed THIS attempt —
                // sending its recovery_check leaks nothing the user didn't
                // already type themselves.
                mode: 'trusted',
              })
              if (verdict === 'mismatch' || verdict === 'unreachable') {
                throw new Error(verdict === 'mismatch' ? PHRASE_WRONG_ACCOUNT_MESSAGE : OWNERSHIP_UNREACHABLE_MESSAGE)
              }
              // T1 (round 3): the provider may have unmounted (a different
              // account signed in) while the await above was in flight. The
              // verdict just returned is about THIS instance's ownerUserId —
              // never act on it once disposed. `adopted` is still false here,
              // so the outer `finally` below releases `handleId` for us.
              if (disposedRef.current) {
                throw new Error('Vault provider unmounted before unlock completed')
              }
              // 'match', or 'unverifiable' (the account has nothing on the
              // server to prove against — the typed phrase is the only proof
              // there is, as before 1594).
              ownershipVerifiedRef.current = true
            }
            // Persist before reporting phrase unlock as complete. The iOS
            // simulator falls back to SecureStore because Secure Enclave is not
            // available; if this races with a dev reload the next launch asks for
            // the recovery phrase again.
            await storeMasterKey(masterKey, ownerUserId, myGeneration)
            adopted = true
          } finally {
            // Zero the raw bytes — they're now persisted for future unlocks and
            // represented by an opaque native handle for this session.
            masterKey.fill(0)
            // A refused (or failed) phrase never keeps a native handle.
            if (!adopted && handleId != null) await releaseHandle(handleId).catch(() => {})
          }
          masterKeyHandleId.current = handleId
          // A successful phrase unlock provisions a key — clear any prior
          // needs-recovery state.
          setNeedsRecoveryPhrase(false)
        } else {
          // Task 1594: a stored key is only ever used for the account it
          // belongs to. No signed-in account → nothing to bind to: do not load
          // it at all (the signed-out provider's cold-launch silent unlock).
          if (ownerUserId == null) {
            recordRuntimeTrace('vault.key_ownership.no_signed_in_user', { source })
            throw new Error('Sign in to unlock the vault')
          }
          // Owner recorded and it is someone else → purge BEFORE the key is
          // loaded (no Face ID prompt, no native handle for the backup engine
          // to adopt) and ask for this account's recovery phrase.
          const precheck = await precheckKeyOwner(ownerUserId)
          if (precheck === 'purged') {
            setNeedsRecoveryPhrase(true)
            throw new Error(VAULT_NEEDS_PHRASE_MESSAGE)
          }
          let result = await loadVerifiedMasterKeyHandle()

          // Backoff ONLY for `transient` — the Secure-Enclave / auth subsystem
          // not being warm yet this early in a cold restart (SE returned no key,
          // or auth was not yet available; NO prompt was completed and NO user
          // failure occurred). The SE warm-up is device-dependent and can take
          // noticeably longer than one frame on real hardware, so retry with
          // backoff until the read settles.
          //
          // With the task 0882 native fix, the single explicit prompt fires
          // inside the FIRST warm evaluation and its satisfied LAContext is
          // reused by the SE decrypt (kSecUseAuthenticationContext) — so these
          // retries add NO extra Face ID prompts. Crucially, a real user cancel /
          // auth failure / biometric lockout does NOT come back as `transient`:
          // it is a distinct surfaced reason (auth_canceled / auth_failed /
          // biometry_lockout) and is handled below WITHOUT retry (fail-closed,
          // 0428). `no_key` is never retried (genuinely missing → recovery).
          const transientBackoffMs = [300, 500, 800, 1200, 1800]
          for (let attempt = 0; attempt < transientBackoffMs.length; attempt += 1) {
            if (!('reason' in result) || result.reason !== 'transient') break
            recordRuntimeTrace('vault.unlock.transient_retry', {
              source,
              attempt: attempt + 1,
              delayMs: transientBackoffMs[attempt],
            })
            await new Promise((resolve) => setTimeout(resolve, transientBackoffMs[attempt]))
            result = await loadVerifiedMasterKeyHandle()
          }

          if ('handleId' in result) {
            const handleId = result.handleId
            // Task 1594: prove the key against the server once per sign-in.
            // The stored check value is the key's own recovery_check (just
            // re-proven equal to the key by loadVerifiedMasterKeyHandle), so
            // only that HMAC is sent — never the key.
            if (!ownershipVerifiedRef.current) {
              const checkB64 = await SecureStore.getItemAsync(MASTER_KEY_CHECK_LABEL).catch(() => null)
              const verdict: OwnershipVerdict = checkB64
                ? await verifyKeyBelongsToAccount({
                  userId: ownerUserId,
                  recoveryCheckB64: checkB64,
                  derivePublicKey: () => publicKeyFromHandle(handleId),
                  // F1: only a key `precheckKeyOwner` already found BOUND to
                  // this user may have its recovery_check sent. An 'unbound'
                  // key (no local owner record — a pre-round-2 build, or the
                  // very first proof) may be a DIFFERENT account's leftover
                  // key: prove it via the public key first instead (see
                  // key-ownership.ts doc comment).
                  mode: precheck === 'bound' ? 'trusted' : 'unbound',
                })
                : 'unreachable'
              recordRuntimeTrace('vault.key_ownership.keychain_verdict', { source, verdict, precheck })
              // T1 (round 3): the provider may have unmounted (the account
              // changed) while the awaits above were resolving. Whatever the
              // server just said about THIS instance's ownerUserId, never
              // act on it once disposed — release the handle we loaded to
              // check it and abandon this attempt. A fresh provider for the
              // new account already runs its own precheck/unlock.
              if (disposedRef.current) {
                await releaseHandle(handleId).catch(() => {})
                throw new Error('Vault provider unmounted before unlock completed')
              }
              if (verdict === 'match') {
                if (precheck !== 'bound') {
                  try {
                    await writeKeyOwner(ownerUserId)
                  } catch (writeErr) {
                    // T3 (round 3): a transient SecureStore/native-mirror
                    // failure after a successful verify must not leak the
                    // handle we just loaded — release it exactly like every
                    // other failure-before-adoption branch in this function
                    // already does, then propagate the original error.
                    await releaseHandle(handleId).catch(() => {})
                    throw writeErr
                  }
                  // T1: the unmount could also have happened DURING the
                  // (now-successful) write above — the owner record it just
                  // wrote is harmless (it names the account the key actually
                  // belongs to), but this instance must still not adopt the
                  // handle or publish anything further.
                  if (disposedRef.current) {
                    await releaseHandle(handleId).catch(() => {})
                    throw new Error('Vault provider unmounted before unlock completed')
                  }
                  // Round 6 (reviewer follow-up): this `writeKeyOwner` call
                  // does not go through `storeMasterKeyQueue` — record its
                  // success against the SAME generation ledger `storeMasterKey`
                  // uses, so a concurrent, now-stale `storeMasterKeyExclusive`
                  // call for this SAME account (a remount race, not an account
                  // switch) sees a strictly newer generation already persisted
                  // and abandons its own stale write WITHOUT purging what this
                  // call just correctly established.
                  markGenerationPersisted(myGeneration)
                }
                ownershipVerifiedRef.current = true
              } else if (verdict === 'mismatch') {
                // Another account's key: lock, purge, ask for the phrase.
                await releaseHandle(handleId).catch(() => {})
                await purgeStoredVaultKey('server_mismatch')
                setNeedsRecoveryPhrase(true)
                throw new Error(VAULT_NEEDS_PHRASE_MESSAGE)
              } else if (precheck === 'bound') {
                // Bound to this account by an earlier proven unlock; the
                // server has nothing new to say ('unverifiable') or cannot be
                // reached right now ('unreachable') — the binding stands.
                if (verdict === 'unverifiable') {
                  ownershipVerifiedRef.current = true
                  markGenerationPersisted(myGeneration)
                }
              } else if (verdict === 'unverifiable') {
                // An unbound key and an account the server cannot prove any
                // key against: do not use a key of unknown ownership. Ask for
                // the phrase (not purged — the phrase unlock replaces it).
                await releaseHandle(handleId).catch(() => {})
                setNeedsRecoveryPhrase(true)
                throw new Error(VAULT_NEEDS_PHRASE_MESSAGE)
              } else {
                // Unbound + unreachable: no verdict. Never read as valid, and
                // never a reason to destroy the key — retry later.
                await releaseHandle(handleId).catch(() => {})
                throw new Error(OWNERSHIP_UNREACHABLE_MESSAGE)
              }
            }
            masterKeyHandleId.current = handleId
            setNeedsRecoveryPhrase(false)
          } else if (result.reason === 'no_key') {
            // Genuine: no key was ever provisioned here (Debug-sim / device
            // restore). This is the ONLY path that arms the recovery prompt.
            setNeedsRecoveryPhrase(true)
            throw new Error(VAULT_NEEDS_PHRASE_MESSAGE)
          } else if (
            result.reason === 'auth_canceled' ||
            result.reason === 'auth_failed' ||
            result.reason === 'biometry_lockout'
          ) {
            // Real biometric outcome (task 0882): the user canceled, the
            // biometric failed to match, or biometrics are locked out. Fail
            // CLOSED — do NOT arm recovery and do NOT silently retry. Surface a
            // non-recovery error so the BiometricLockScreen stays locked with a
            // genuine tap-to-retry (and the password fallback for lockout). The
            // vault never opens without a successful evaluation (0428).
            recordRuntimeTrace('vault.unlock.auth_surfaced', { source, reason: result.reason })
            const authMessage =
              result.reason === 'biometry_lockout'
                ? 'Biometrics are locked — use your Beebeeb password to unlock'
                : result.reason === 'auth_canceled'
                  ? 'Biometric unlock was canceled'
                  : 'Biometric unlock failed — try again'
            throw new Error(authMessage)
          } else {
            // Still transient after the retry: a key exists on this install but
            // the SE/Keychain read keeps failing this early in process start. Do
            // NOT arm the recovery prompt — a relaunch with a warm keychain
            // reads it. Surface as a (non-recovery) error so unlockAttempted
            // settles and callers can fall back, without navigating to recovery.
            recordRuntimeTrace('vault.unlock.transient_persisted', { source })
            throw new Error('Vault key temporarily unavailable — relaunch the app to retry')
          }
        }

        // T1 (round 3), final defensive gate: covers any other await in the
        // branches above (e.g. `storeMasterKey` in the phrase path) that
        // could still span an unmount not already caught by the checks
        // closer to their own server round-trips. Nothing below this point
        // may run once this instance is disposed.
        if (disposedRef.current) {
          if (masterKeyHandleId.current != null) {
            await releaseHandle(masterKeyHandleId.current).catch(() => {})
            masterKeyHandleId.current = null
          }
          throw new Error('Vault provider unmounted before unlock completed')
        }
        // Task 1594 round 4 (F4): the ONE choke point every adoption path
        // (phrase unlock at signup with no session yet, phrase unlock with a
        // server verdict, keychain unlock's `match`, and the `bound`-precheck
        // `unverifiable`/`unreachable` branches that keep an existing binding)
        // funnels through — every check above (the ownership verdict, EVERY
        // `disposedRef` check including the final gate just above) has
        // already passed by this point. Only NOW does the native, app-wide
        // cache (`BeebeebCryptoBridge`, read directly by `NativeBackupEngine`,
        // `NativeEncryptedBackupUploader`, and `ThumbnailServiceModule`) learn
        // about this handle — never earlier, so those readers can never see a
        // key this verdict was still in the middle of rejecting or an
        // abandoned instance was still in the middle of loading.
        if (masterKeyHandleId.current != null) {
          // Round 6 (reviewer follow-up): a failure here was previously
          // swallowed entirely — the native cache this call populates is the
          // ONLY thing `NativeBackupEngine`/`NativeEncryptedBackupUploader`/
          // `ThumbnailServiceModule` read, so a silent failure here means
          // backup/thumbnails silently stop working with zero diagnostic
          // trail. The handle id is an opaque native reference (never key
          // material) — safe to log per this file's own contract (see the
          // "Master key cache lifecycle" comment above).
          const confirmHandleId = masterKeyHandleId.current
          // Task 1599 followup 3: `ownerUserId` is THIS instance's own
          // already-verified owner (the ownership verdict above already
          // passed for it) — native records it alongside the cached handle
          // so `NativeBackupEngine`'s background-task adoption can refuse a
          // cached handle whose recorded owner doesn't match its live
          // `currentAccountId`.
          await confirmMasterKeyHandle(confirmHandleId, ownerUserId).catch(() => {
            recordRuntimeTrace('vault.key_ownership.confirm_handle_failed', { handleId: confirmHandleId })
          })
        }
        // Task 1594 round 4 (R4): re-mirror the signed-in user id here too,
        // not only from this provider's mount effect (above). A fresh sign-in
        // fires TWO independent, unordered async writes to the same shared
        // value: this provider's mount effect (`mirrorSignedInUserId`) and
        // api.ts's token write, which reaches `mirrorSessionToAppGroup`'s
        // token-changed branch (BeebeebCryptoModule.swift) and DELETES that
        // exact shared value the instant the token changes — clearing it
        // fail-closed until JS re-establishes it, per that function's own
        // comment. If the token write's delete lands AFTER the mount effect's
        // write (there is no ordering guarantee between them), the shared
        // value is left deleted even though sign-in fully succeeded, and
        // every File Provider / Share Extension ownership check refuses
        // (missing signed-in-user mirror) until something re-writes it. Doing
        // it again here, once the key is confirmed adopted (necessarily after
        // both the login token and the ownership verdict have settled),
        // guarantees the mirror reflects reality by the time this function
        // reports the vault unlocked.
        await mirrorSignedInUserId(ownerUserId)
        setIsUnlocked(true)
        // Task 1594 fix 4: authenticated mutations now name the key's owner
        // (X-Beebeeb-Expected-User). Null when no session exists yet (signup).
        setExpectedUserId(ownerUserId)
        updateVaultUnlockDiagnostics({
          isUnlocked: true,
          unlockAttempted: true,
          unlockInFlight: unlockPromiseRef.current === unlockOperation ? false : unlockInFlightRef.current,
          lastUnlockSource: source,
          lastUnlockOutcome: 'success',
          lastUnlockAt: new Date().toISOString(),
          lastUnlockError: null,
        })
        logVaultUnlockDiagnostic('success', { source, usedRecoveryPhrase: hasRecoveryPhrase })
        logVaultUnlockDiagnostic('end', {
          source,
          outcome: 'success',
          promptExpected,
          inFlightAtRequest,
          alreadyUnlocked,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        updateVaultUnlockDiagnostics({
          isUnlocked: false,
          unlockAttempted: true,
          unlockInFlight: unlockPromiseRef.current === unlockOperation ? false : unlockInFlightRef.current,
          lastUnlockSource: source,
          lastUnlockOutcome: 'failed',
          lastUnlockAt: new Date().toISOString(),
          lastUnlockError: message,
        })
        logVaultUnlockDiagnostic('failed', { source, error: message })
        logVaultUnlockDiagnostic('end', {
          source,
          outcome: 'failed',
          promptExpected,
          inFlightAtRequest,
          alreadyUnlocked,
          error: message,
        })
        throw error
      } finally {
        // Mark the attempt as done regardless of outcome so screens waiting
        // on this flag can proceed (showing "Encrypted file" fallback if needed).
        setUnlockAttempted(true)
        if (unlockOperation != null && unlockPromiseRef.current === unlockOperation) {
          unlockPromiseRef.current = null
          unlockInFlightRef.current = false
          updateVaultUnlockDiagnostics({
            unlockAttempted: true,
            unlockInFlight: false,
          })
        } else {
          updateVaultUnlockDiagnostics({ unlockAttempted: true })
        }
      }
    })()
    unlockPromiseRef.current = unlockOperation
    await unlockOperation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockAttempted])

  const lock = useCallback(() => {
    recordRuntimeTrace('vault.lock.request', {
      hadHandle: masterKeyHandleId.current != null,
    })
    if (masterKeyHandleId.current != null) {
      // Release the native handle — Rust will zeroize and drop the key material
      void releaseHandle(masterKeyHandleId.current).catch(() => {})
      masterKeyHandleId.current = null
    }
    // Zero + drop any cached file-request R_priv buffers (0643).
    requestResolverRef.current?.clear()
    requestResolverRef.current = null
    setIsUnlocked(false)
    if (getExpectedUserId() === ownerUserId) setExpectedUserId(null)
    // A manual/signout lock is not a missing-key condition — clear the
    // recovery signal so a subsequent unlock starts from a clean slate.
    setNeedsRecoveryPhrase(false)
  }, [])

  const requireHandleId = (): number => {
    if (masterKeyHandleId.current == null) {
      recordRuntimeTrace('vault.handle.missing', { hasHandle: false })
      throw new Error('Vault is locked. Please lock and unlock the app, then try uploading again.')
    }
    return masterKeyHandleId.current
  }

  const encryptChunkFn = useCallback(
    async (fileId: string, plaintext: Uint8Array): Promise<EncryptedData> => {
      return handleEncryptChunk(requireHandleId(), fileId, plaintext)
    },
    // requireHandleId closes over masterKeyHandleId (a stable ref), so no dep needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const decryptChunkFn = useCallback(
    async (fileId: string, nonce: Uint8Array, ct: Uint8Array): Promise<Uint8Array> => {
      return handleDecryptChunk(requireHandleId(), fileId, nonce, ct)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const encryptMetadataFn = useCallback(
    async (fileId: string, metadata: string): Promise<EncryptedData> => {
      return handleEncryptMetadata(requireHandleId(), fileId, metadata)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const decryptMetadataFn = useCallback(
    async (fileId: string, nonce: Uint8Array, ct: Uint8Array): Promise<string> => {
      return handleDecryptMetadata(requireHandleId(), fileId, nonce, ct)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const decryptNamesFn = useCallback(
    async (items: BatchNameItem[]): Promise<BatchNameResult[]> => {
      return decryptNames(requireHandleId(), items)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const getFileKeyBytesFn = useCallback(
    async (fileId: string): Promise<Uint8Array> => {
      // The handle is created at unlock time on every platform (including
      // simulator — see the `createMasterKeyHandle` calls in `unlock()` and
      // `loadVerifiedMasterKeyHandle`). If the handle is missing the vault is
      // genuinely locked; we must NEVER fall back to re-reading the Keychain
      // here because that would surface a Face ID prompt during routine
      // thumbnail/preview decryption (task 0556).
      const key = await handleDeriveFileKey(requireHandleId(), fileId)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { requireOptionalNativeModule } = require('expo-modules-core')
        const Native = requireOptionalNativeModule('ThumbnailService') as {
          setFileKey?: (fileId: string, keyBytes: Uint8Array) => Promise<void>
        } | null
        await Native?.setFileKey?.(fileId, key)
      } catch {
        // best-effort
      }
      return key
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const getMasterKeyHandleIdFn = useCallback(
    (): number => {
      return requireHandleId()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const deriveX25519PrivateFromHandleFn = useCallback(
    async (): Promise<Uint8Array> => {
      return handleDeriveX25519Private(requireHandleId())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // The web client derives its search-index key with HKDF-SHA-256 over the
  // master key with `info = "beebeeb-search-index"`. Handle-only (no Keychain
  // fallback) for the same reason as `getFileKeyBytes` — every search-bar
  // keystroke can drive this path, and a Face ID prompt mid-typing would be a
  // catastrophic UX regression (task 0556).
  const getIndexKeyFn = useCallback(
    async (): Promise<Uint8Array> => {
      return handleDeriveFileKey(requireHandleId(), 'beebeeb-search-index')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const setBiometricRequirementFn = useCallback(
    async (require: boolean): Promise<void> => {
      if (Platform.OS !== 'ios' || usesSoftwareVaultFallback()) return
      recordRuntimeTrace('keychain.biometric_requirement.request', {
        require,
        hasHandle: masterKeyHandleId.current != null,
      })
      // Re-wrap the SE blob from the cached handle. The previous
      // implementation called `loadKeyFromKeychain(MASTER_KEY_LABEL)`,
      // which prompted Face ID under the old policy before we even got
      // to the re-wrap step — a noticeable double-prompt when toggling
      // biometrics from Settings (task 0556). The native function
      // exports the bytes from the in-memory handle and zeroes the
      // buffer; raw bytes never cross the JS bridge. Older builds
      // without the native function return false here, and we fall
      // back to the legacy raw-bytes path.
      const handleId = requireHandleId()
      const ok = await replaceKeychainAccessControlFromHandle(handleId, require, MASTER_KEY_LABEL)
      if (ok) {
        recordRuntimeTrace('keychain.biometric_requirement.native_rewrap_success', {
          require,
          handleId,
        })
        return
      }
      recordRuntimeTrace('keychain.biometric_requirement.legacy_fallback_request', {
        require,
        promptMayAppear: true,
      })
      const { loadKeyFromKeychain } = await import('../../modules/beebeeb-crypto')
      const raw = await loadKeyFromKeychain(MASTER_KEY_LABEL)
      if (!raw) throw new Error('Vault is locked — cannot change biometric requirement')
      try {
        await replaceKeychainAccessControl(require, raw, MASTER_KEY_LABEL)
      } finally {
        raw.fill(0)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const tryBackgroundUnlockFn = useCallback(async (): Promise<boolean> => {
    // Already unlocked — nothing to do
    if (masterKeyHandleId.current != null) {
      updateVaultUnlockDiagnostics({
        isUnlocked: true,
        unlockAttempted: true,
        unlockInFlight: false,
        lastUnlockSource: 'backup_background',
        lastUnlockOutcome: 'already_unlocked',
        lastUnlockAt: new Date().toISOString(),
        lastUnlockError: null,
        lastPromptExpected: false,
        lastAlreadyUnlocked: true,
        lastInFlightAtRequest: unlockInFlightRef.current,
      })
      logVaultUnlockDiagnostic('already_unlocked', { source: 'backup_background' })
      return true
    }

    try {
      const enabled = await getKeepVaultUnlocked()
      if (!enabled) {
        updateVaultUnlockDiagnostics({
          isUnlocked: false,
          unlockAttempted,
          unlockInFlight: false,
          lastUnlockSource: 'backup_background',
          lastUnlockOutcome: 'disabled',
          lastUnlockAt: new Date().toISOString(),
          lastUnlockError: null,
          lastPromptExpected: false,
          lastAlreadyUnlocked: false,
          lastInFlightAtRequest: unlockInFlightRef.current,
        })
        logVaultUnlockDiagnostic('disabled', { source: 'backup_background' })
        return false
      }

      await unlock(undefined, 'backup_background')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateVaultUnlockDiagnostics({
        isUnlocked: false,
        unlockAttempted: true,
        unlockInFlight: false,
        lastUnlockSource: 'backup_background',
        lastUnlockOutcome: 'failed',
        lastUnlockAt: new Date().toISOString(),
        lastUnlockError: message,
        lastPromptExpected: false,
        lastAlreadyUnlocked: false,
        lastInFlightAtRequest: unlockInFlightRef.current,
      })
      logVaultUnlockDiagnostic('failed', { source: 'backup_background', error: message })
      return false
    }
  }, [unlock, unlockAttempted])

  const getUnlockDiagnosticsFn = useCallback((): VaultUnlockDiagnostics => {
    return {
      ...getLastVaultUnlockDiagnostics(),
      isUnlocked,
      unlockAttempted,
      unlockInFlight: unlockInFlightRef.current,
    }
  }, [isUnlocked, unlockAttempted])

  const verifyRecoveryPhraseFn = useCallback(async (phrase: string): Promise<boolean> => {
    return verifyRecoveryPhraseAgainstStoredCheck(phrase, {
      getStoredCheckBase64: () => SecureStore.getItemAsync(MASTER_KEY_CHECK_LABEL).catch(() => null),
      recoverFromPhraseFn: recoverFromPhrase,
      computeRecoveryCheckFn: computeRecoveryCheck,
    })
  }, [])

  // ── File requests (0643) ──

  const createRequestKeypairFn = useCallback(
    async (): Promise<RequestKeypairResult> => {
      return createRequestKeypairWithHandle(requireHandleId())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const rebuildRequestPublicKeyFn = useCallback(
    async (wrapped: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> => {
      const rPriv = await unwrapRequestPrivateWithHandle(requireHandleId(), wrapped, nonce)
      try {
        return await deriveX25519PublicFromPrivate(rPriv)
      } finally {
        rPriv.fill(0)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const getRequestContentKeyFn = useCallback(
    async (file: RequestFileFields): Promise<Uint8Array> => {
      if (requestResolverRef.current == null) {
        requestResolverRef.current = createRequestKeyResolver(() => requireHandleId())
      }
      return requestResolverRef.current.resolveContentKey(file)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Keep BackupService in sync with vault state so folder creation/lookup
  // always encrypts/decrypts names through the crypto context.
  useEffect(() => {
    if (isUnlocked) {
      setBackupEncryption({
        encryptChunkFn: encryptChunkFn,
        decryptChunkFn: decryptChunkFn,
        encryptMetadataFn: encryptMetadataFn,
        decryptMetadataFn: decryptMetadataFn,
      })
    } else {
      setBackupEncryption(null)
    }
  }, [isUnlocked, encryptChunkFn, encryptMetadataFn, decryptMetadataFn])

  // Push session credentials to the native ThumbnailService so its actor can
  // fetch + decrypt remote thumbnails without crossing back to JS. Best-effort:
  // no-op on Android where the module isn't registered.
  useEffect(() => {
    if (!isUnlocked) return
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { requireOptionalNativeModule } = require('expo-modules-core')
        const Native = requireOptionalNativeModule('ThumbnailService') as {
          setApiCredentials?: (baseURL: string, token: string) => Promise<void>
        } | null
        if (Native?.setApiCredentials) {
          const { getToken, getApiUrl } = await import('./api')
          const token = await getToken()
          if (token) {
            await Native.setApiCredentials(getApiUrl(), token)
          }
        }
      } catch (err) {
        console.warn('[crypto-context] thumbnail native credentials sync failed', err)
      }
    })()
  }, [isUnlocked])

  return (
    <CryptoContext.Provider
      value={{
        isUnlocked,
        unlockAttempted,
        needsRecoveryPhrase,
        unlock,
        getUnlockDiagnostics: getUnlockDiagnosticsFn,
        lock,
        encryptChunk: encryptChunkFn,
        decryptChunk: decryptChunkFn,
        encryptMetadata: encryptMetadataFn,
        decryptMetadata: decryptMetadataFn,
        decryptNames: decryptNamesFn,
        getFileKeyBytes: getFileKeyBytesFn,
        getMasterKeyHandleId: getMasterKeyHandleIdFn,
        deriveX25519PrivateFromHandle: deriveX25519PrivateFromHandleFn,
        getIndexKey: getIndexKeyFn,
        setBiometricRequirement: setBiometricRequirementFn,
        tryBackgroundUnlock: tryBackgroundUnlockFn,
        createRequestKeypair: createRequestKeypairFn,
        rebuildRequestPublicKey: rebuildRequestPublicKeyFn,
        getRequestContentKey: getRequestContentKeyFn,
        verifyRecoveryPhrase: verifyRecoveryPhraseFn,
      }}
    >
      {children}
    </CryptoContext.Provider>
  )
}

export function useCrypto(): CryptoContextValue {
  const ctx = useContext(CryptoContext)
  if (!ctx) throw new Error('useCrypto must be used within <CryptoProvider>')
  return ctx
}
