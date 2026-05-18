import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import * as Device from 'expo-device'
import * as FileSystem from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  computeRecoveryCheck,
  handleComputeRecoveryCheck,
  handleDecryptChunk,
  handleDecryptMetadata,
  handleEncryptChunk,
  handleEncryptMetadata,
  handleDeriveX25519Private,
  loadKeyFromKeychainAsHandle,
  recoverFromPhrase,
  releaseHandle,
  replaceKeychainAccessControl,
  storeKeyInKeychain,
} from '../../modules/beebeeb-crypto'
import type { EncryptedData } from '../../modules/beebeeb-crypto'
import { setBackupEncryption, getKeepVaultUnlocked } from '../services/BackupService'

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
    const actual = await computeRecoveryCheck(candidate)
    if (!constantTimeEqual(actual, expected)) return null
    // Store into SE keychain so loadKeyFromKeychainAsHandle works,
    // then load as handle. The raw bytes are zeroed below.
    try {
      await storeKeyInKeychain(candidate, MASTER_KEY_LABEL)
    } catch {
      // SE may be unavailable — still try handle load
    }
    const handleId = await loadKeyFromKeychainAsHandle(MASTER_KEY_LABEL)
    candidate.fill(0)
    return handleId
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
  unlock: (phrase?: string) => Promise<void>
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
   * Derive the X25519 private key from the master key handle.
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

  const unlock = useCallback(async (phrase?: string) => {
    // If the vault is already open and no recovery phrase was given, skip the
    // redundant keychain load. On devices with biometric-protected Secure
    // Enclave keys, loadKeyFromKeychainAsHandle triggers a Face ID prompt —
    // calling unlock() again after BiometricLockScreen already authenticated
    // would surface a second, unnecessary Face ID dialog.
    if (!phrase && masterKeyHandleId.current != null) {
      setIsUnlocked(true)
      setUnlockAttempted(true)
      return
    }

    try {
      if (phrase) {
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
        // Zero the raw bytes — they're now persisted in the keychain
        masterKey.fill(0)
        // Load the handle from the keychain
        const handleId = await loadKeyFromKeychainAsHandle(MASTER_KEY_LABEL)
        if (handleId == null) {
          throw new Error('Failed to load master key handle after storing recovery phrase')
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
    } finally {
      // Mark the attempt as done regardless of outcome so screens waiting
      // on this flag can proceed (showing "Encrypted file" fallback if needed).
      setUnlockAttempted(true)
    }
  }, [])

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
      // For share creation we still need raw file key bytes (they are
      // per-file ephemeral, not the master key). Derive via handle.
      // TODO(P2): move file key wrapping to native too.
      const { deriveFileKey } = await import('../../modules/beebeeb-crypto')
      const { loadKeyFromKeychain } = await import('../../modules/beebeeb-crypto')
      // We need the raw master key bytes temporarily to derive the file key
      // via the old deriveFileKey path. This is a known gap until P2 moves
      // file key derivation fully native. The master key bytes are loaded from
      // keychain, used, and immediately zeroed.
      const raw = await loadKeyFromKeychain(MASTER_KEY_LABEL)
      if (!raw) throw new Error('Vault is locked — cannot derive file key')
      try {
        return await deriveFileKey(raw, fileId)
      } finally {
        raw.fill(0)
      }
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
  // master key with `info = "beebeeb-search-index"`. The handle-based path
  // uses handleDecryptChunk internally, but for the search index we need
  // the raw derived key bytes. Use the same temporary load pattern as
  // getFileKeyBytes.
  const getIndexKeyFn = useCallback(
    async (): Promise<Uint8Array> => {
      const { deriveFileKey } = await import('../../modules/beebeeb-crypto')
      const { loadKeyFromKeychain } = await import('../../modules/beebeeb-crypto')
      const raw = await loadKeyFromKeychain(MASTER_KEY_LABEL)
      if (!raw) throw new Error('Vault is locked — cannot derive index key')
      try {
        return await deriveFileKey(raw, 'beebeeb-search-index')
      } finally {
        raw.fill(0)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const setBiometricRequirementFn = useCallback(
    async (require: boolean): Promise<void> => {
      if (Platform.OS !== 'ios' || usesSoftwareVaultFallback()) return
      // replaceKeychainAccessControl needs raw key bytes to re-wrap under
      // new access control. Load transiently and zero immediately.
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
    if (masterKeyHandleId.current != null) return true

    try {
      const enabled = await getKeepVaultUnlocked()
      if (!enabled) return false

      const handleId = await loadVerifiedMasterKeyHandle()
      if (handleId == null) return false

      masterKeyHandleId.current = handleId
      setIsUnlocked(true)
      setUnlockAttempted(true)
      return true
    } catch {
      return false
    }
  }, [])

  // Keep BackupService in sync with vault state so folder creation/lookup
  // always encrypts/decrypts names through the crypto context.
  useEffect(() => {
    if (isUnlocked) {
      setBackupEncryption({
        encryptMetadataFn: encryptMetadataFn,
        decryptMetadataFn: decryptMetadataFn,
      })
    } else {
      setBackupEncryption(null)
    }
  }, [isUnlocked, encryptMetadataFn, decryptMetadataFn])

  return (
    <CryptoContext.Provider
      value={{
        isUnlocked,
        unlockAttempted,
        unlock,
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
