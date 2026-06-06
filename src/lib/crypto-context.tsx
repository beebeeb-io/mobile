import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import * as Device from 'expo-device'
import * as FileSystem from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  computeRecoveryCheck,
  createMasterKeyHandle,
  createRequestKeypairWithHandle,
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
import type { EncryptedData, RequestKeypairResult } from '../../modules/beebeeb-crypto'
import { setBackupEncryption, getKeepVaultUnlocked } from '../services/BackupService'
import { recordRuntimeTrace } from './runtime-trace'
import {
  createRequestKeyResolver,
  type RequestFileFields,
  type RequestKeyResolver,
} from './file-request-crypto'

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

const MASTER_KEY_LABEL = 'io.beebeeb.master-key'
const MASTER_KEY_CHECK_LABEL = 'io.beebeeb.master-key-check'
// Fallback storage key used when the Secure Enclave is unavailable (simulator,
// older devices). SecureStore uses the software Keychain which is still
// protected by the device passcode but lacks SE hardware binding.
const MASTER_KEY_FALLBACK_LABEL = 'io.beebeeb.master-key.fallback'
export const SIMULATOR_MASTER_KEY_FILE = `${FileSystem.documentDirectory ?? ''}beebeeb-simulator-master-key.txt`

function usesSoftwareVaultFallback(): boolean {
  return !Device.isDevice || Device.modelName?.toLowerCase().includes('simulator') === true || __DEV__
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

async function storeMasterKey(masterKey: Uint8Array): Promise<void> {
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
  if (useSoftwareFallback && FileSystem.documentDirectory) {
    await FileSystem.writeAsStringAsync(SIMULATOR_MASTER_KEY_FILE, encoded)
  }
  const check = await computeRecoveryCheck(masterKey)
  await SecureStore.setItemAsync(MASTER_KEY_CHECK_LABEL, uint8ToBase64(check))
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
type VaultLoadResult = { handleId: number } | { reason: 'no_key' } | { reason: 'transient' }

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
    } catch {
      // SE read threw — same transient story. Fall through to the SecureStore
      // fallback (real devices won't have one), then report transient.
      recordRuntimeTrace('keychain.load.native_handle_failed', { label: MASTER_KEY_LABEL })
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
}

const CryptoContext = createContext<CryptoContextValue | null>(null)

export function CryptoProvider({ children }: { children: React.ReactNode }) {
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

  useEffect(() => {
    updateVaultUnlockDiagnostics({
      isUnlocked,
      unlockAttempted,
      unlockInFlight: unlockInFlightRef.current,
    })
  }, [isUnlocked, unlockAttempted])

  const unlock = useCallback(async (phrase?: string, source: VaultUnlockSource = phrase != null ? 'recovery_phrase' : 'keychain') => {
    const hasRecoveryPhrase = phrase != null
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
          // Persist before reporting phrase unlock as complete. The iOS
          // simulator falls back to SecureStore because Secure Enclave is not
          // available; if this races with a dev reload the next launch asks for
          // the recovery phrase again.
          await storeMasterKey(masterKey)
          let handleId: number
          try {
            handleId = await createMasterKeyHandle(masterKey)
          } finally {
            // Zero the raw bytes — they're now persisted for future unlocks and
            // represented by an opaque native handle for this session.
            masterKey.fill(0)
          }
          masterKeyHandleId.current = handleId
          // A successful phrase unlock provisions a key — clear any prior
          // needs-recovery state.
          setNeedsRecoveryPhrase(false)
        } else {
          let result = await loadVerifiedMasterKeyHandle()

          // Belt-and-suspenders: a `transient` result on cold launch is almost
          // always a Secure-Enclave that isn't warm yet. Give it ONE silent
          // retry after a short delay — the SE typically warms within a frame
          // or two — before deciding anything terminal. A `no_key` result is
          // never retried (it's genuinely missing) and a success short-circuits.
          if ('reason' in result && result.reason === 'transient') {
            recordRuntimeTrace('vault.unlock.transient_retry', { source })
            await new Promise((resolve) => setTimeout(resolve, 400))
            result = await loadVerifiedMasterKeyHandle()
          }

          if ('handleId' in result) {
            masterKeyHandleId.current = result.handleId
            setNeedsRecoveryPhrase(false)
          } else if (result.reason === 'no_key') {
            // Genuine: no key was ever provisioned here (Debug-sim / device
            // restore). This is the ONLY path that arms the recovery prompt.
            setNeedsRecoveryPhrase(true)
            throw new Error('No master key in keychain — provide a recovery phrase to restore')
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

        setIsUnlocked(true)
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
        getFileKeyBytes: getFileKeyBytesFn,
        getMasterKeyHandleId: getMasterKeyHandleIdFn,
        deriveX25519PrivateFromHandle: deriveX25519PrivateFromHandleFn,
        getIndexKey: getIndexKeyFn,
        setBiometricRequirement: setBiometricRequirementFn,
        tryBackgroundUnlock: tryBackgroundUnlockFn,
        createRequestKeypair: createRequestKeypairFn,
        rebuildRequestPublicKey: rebuildRequestPublicKeyFn,
        getRequestContentKey: getRequestContentKeyFn,
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
