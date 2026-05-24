import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import * as Device from 'expo-device'
import * as FileSystem from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  computeRecoveryCheck,
  createMasterKeyHandle,
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
} from '../../modules/beebeeb-crypto'
import type { EncryptedData } from '../../modules/beebeeb-crypto'
import { setBackupEncryption, getKeepVaultUnlocked } from '../services/BackupService'

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
  try {
    await storeKeyInKeychain(masterKey, MASTER_KEY_LABEL)
    nativeKeychainStored = true
  } catch {
    // Secure Enclave unavailable — fall through to software fallback.
  }
  const useSoftwareFallback = !nativeKeychainStored || softwareFallbackRuntime
  if (useSoftwareFallback) {
    await SecureStore.setItemAsync(MASTER_KEY_FALLBACK_LABEL, encoded)
  }
  if (useSoftwareFallback && FileSystem.documentDirectory) {
    await FileSystem.writeAsStringAsync(SIMULATOR_MASTER_KEY_FILE, encoded)
  }
  const check = await computeRecoveryCheck(masterKey)
  await SecureStore.setItemAsync(MASTER_KEY_CHECK_LABEL, uint8ToBase64(check))
}

/**
 * Load the master key from persistent storage and return an opaque native
 * handle ID. The real key bytes never enter the JS heap. For fallback paths
 * (simulator, older devices) the raw bytes are loaded transiently, stored
 * into the SE-backed keychain to create a handle, then zeroed.
 *
 * Returns null if no key is stored or verification fails.
 */
async function loadVerifiedMasterKeyHandle(): Promise<number | null> {
  const checkB64 = await SecureStore.getItemAsync(MASTER_KEY_CHECK_LABEL).catch(() => null)
  if (!checkB64) return null

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

  // Primary: Secure Enclave-wrapped key (real devices)
  if (!usesSoftwareVaultFallback()) {
    try {
      const handleId = await loadKeyFromKeychainAsHandle(MASTER_KEY_LABEL)
      if (handleId != null) {
        if (await verifyHandle(handleId)) return handleId
        // Verification failed — release the handle
        await releaseHandle(handleId).catch(() => {})
      }
    } catch {
      // SE unavailable — try fallback below
    }
  }

  // Fallback: SecureStore (simulator, or SE failure on older/unavailable devices)
  const raw = await SecureStore.getItemAsync(MASTER_KEY_FALLBACK_LABEL).catch(() => null)
  const fallbackHandle = await verifyAndCreateHandle(raw ? base64ToUint8(raw) : null)
  if (fallbackHandle != null) return fallbackHandle

  if (usesSoftwareVaultFallback() && FileSystem.documentDirectory) {
    const fileRaw = await FileSystem.readAsStringAsync(SIMULATOR_MASTER_KEY_FILE).catch(() => null)
    return verifyAndCreateHandle(fileRaw ? base64ToUint8(fileRaw) : null)
  }

  return null
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
}

const CryptoContext = createContext<CryptoContextValue | null>(null)

export function CryptoProvider({ children }: { children: React.ReactNode }) {
  const [isUnlocked, setIsUnlocked] = useState(false)
  // True once the first unlock() attempt has settled (success or failure).
  // Used by FilesScreen to distinguish "still loading key" from "locked".
  const [unlockAttempted, setUnlockAttempted] = useState(false)
  // masterKeyHandleId holds an opaque numeric ID referencing the real
  // MasterKeyHandle in native memory. Raw key bytes never enter the JS
  // heap. Never store in React state to avoid accidental serialisation.
  const masterKeyHandleId = useRef<number | null>(null)
  const unlockInFlightRef = useRef(false)
  const unlockPromiseRef = useRef<Promise<void> | null>(null)

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
        } else {
          const handleId = await loadVerifiedMasterKeyHandle()
          if (handleId == null) {
            throw new Error('No master key in keychain — provide a recovery phrase to restore')
          }
          masterKeyHandleId.current = handleId
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
    if (masterKeyHandleId.current != null) {
      // Release the native handle — Rust will zeroize and drop the key material
      void releaseHandle(masterKeyHandleId.current).catch(() => {})
      masterKeyHandleId.current = null
    }
    setIsUnlocked(false)
  }, [])

  const requireHandleId = (): number => {
    if (masterKeyHandleId.current == null) throw new Error('Vault is locked. Please lock and unlock the app, then try uploading again.')
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
      return handleDeriveFileKey(requireHandleId(), fileId)
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
      if (ok) return
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

  return (
    <CryptoContext.Provider
      value={{
        isUnlocked,
        unlockAttempted,
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
