import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import * as Device from 'expo-device'
import * as FileSystem from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  computeRecoveryCheck,
  deriveFileKey,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
  encryptMetadata,
  loadKeyFromKeychain,
  recoverFromPhrase,
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

async function loadVerifiedMasterKey(): Promise<Uint8Array | null> {
  const checkB64 = await SecureStore.getItemAsync(MASTER_KEY_CHECK_LABEL).catch(() => null)
  if (!checkB64) return null

  const expected = base64ToUint8(checkB64)
  const verify = async (candidate: Uint8Array | null): Promise<Uint8Array | null> => {
    if (!candidate) return null
    const actual = await computeRecoveryCheck(candidate)
    return constantTimeEqual(actual, expected) ? candidate : null
  }

  // Primary: Secure Enclave-wrapped key (real devices)
  if (!usesSoftwareVaultFallback()) {
    try {
      const verified = await verify(await loadKeyFromKeychain(MASTER_KEY_LABEL))
      if (verified) return verified
    } catch {
      // SE unavailable — try fallback below
    }
  }

  // Fallback: SecureStore (simulator, or SE failure on older/unavailable devices)
  const raw = await SecureStore.getItemAsync(MASTER_KEY_FALLBACK_LABEL).catch(() => null)
  const secureStoreFallback = await verify(raw ? base64ToUint8(raw) : null)
  if (secureStoreFallback) return secureStoreFallback

  if (usesSoftwareVaultFallback() && FileSystem.documentDirectory) {
    const fileRaw = await FileSystem.readAsStringAsync(SIMULATOR_MASTER_KEY_FILE).catch(() => null)
    return verify(fileRaw ? base64ToUint8(fileRaw) : null)
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
   * Return a copy of the in-memory master key for key-agreement operations.
   * Throws if vault is locked.
   */
  getMasterKeyBytes: () => Uint8Array
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
  // masterKeyRef holds key material in memory while the vault is open.
  // Never store in React state to avoid accidental serialisation.
  const masterKeyRef = useRef<Uint8Array | null>(null)

  const unlock = useCallback(async (phrase?: string) => {
    // If the vault is already open and no recovery phrase was given, skip the
    // redundant keychain load. On devices with biometric-protected Secure
    // Enclave keys, loadKeyFromKeychain triggers a Face ID prompt — calling
    // unlock() again after BiometricLockScreen already authenticated would
    // surface a second, unnecessary Face ID dialog.
    if (!phrase && masterKeyRef.current) {
      setIsUnlocked(true)
      setUnlockAttempted(true)
      return
    }

    let masterKey: Uint8Array

    try {
      if (phrase) {
        const result = await recoverFromPhrase(phrase)
        masterKey = result.masterKey
      } else {
        const stored = await loadVerifiedMasterKey()
        if (!stored) {
          throw new Error('No master key in keychain — provide a recovery phrase to restore')
        }
        masterKey = stored
      }

      if (phrase) {
        // Persist before reporting phrase unlock as complete. The iOS
        // simulator falls back to SecureStore because Secure Enclave is not
        // available; if this races with a dev reload the next launch asks for
        // the recovery phrase again.
        await storeMasterKey(masterKey)
      }
      masterKeyRef.current = masterKey
      setIsUnlocked(true)
    } finally {
      // Mark the attempt as done regardless of outcome so screens waiting
      // on this flag can proceed (showing "Encrypted file" fallback if needed).
      setUnlockAttempted(true)
    }
  }, [])

  const lock = useCallback(() => {
    if (masterKeyRef.current) {
      masterKeyRef.current.fill(0) // zero key material before releasing
      masterKeyRef.current = null
    }
    setIsUnlocked(false)
  }, [])

  const requireKey = (): Uint8Array => {
    if (!masterKeyRef.current) throw new Error('Vault is locked. Please lock and unlock the app, then try uploading again.')
    return masterKeyRef.current
  }

  const encryptChunkFn = useCallback(
    async (fileId: string, plaintext: Uint8Array): Promise<EncryptedData> => {
      const fileKey = await deriveFileKey(requireKey(), fileId)
      return encryptChunk(fileKey, plaintext)
    },
    // requireKey closes over masterKeyRef (a stable ref), so no dep needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const decryptChunkFn = useCallback(
    async (fileId: string, nonce: Uint8Array, ct: Uint8Array): Promise<Uint8Array> => {
      const fileKey = await deriveFileKey(requireKey(), fileId)
      return decryptChunk(fileKey, nonce, ct)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const encryptMetadataFn = useCallback(
    async (fileId: string, metadata: string): Promise<EncryptedData> => {
      const fileKey = await deriveFileKey(requireKey(), fileId)
      return encryptMetadata(fileKey, metadata)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const decryptMetadataFn = useCallback(
    async (fileId: string, nonce: Uint8Array, ct: Uint8Array): Promise<string> => {
      const fileKey = await deriveFileKey(requireKey(), fileId)
      return decryptMetadata(fileKey, nonce, ct)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const getFileKeyBytesFn = useCallback(
    async (fileId: string): Promise<Uint8Array> => {
      return deriveFileKey(requireKey(), fileId)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const getMasterKeyBytesFn = useCallback(
    (): Uint8Array => {
      return new Uint8Array(requireKey())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // The web client derives its search-index key with HKDF-SHA-256 over the
  // master key with `info = "beebeeb-search-index"`. `deriveFileKey` is the
  // same HKDF construction with `info = fileId`, so passing the literal
  // info string produces the same key bytes the web side uses. This is what
  // lets a vault's index round-trip between web and mobile if both clients
  // ever load it.
  const getIndexKeyFn = useCallback(
    async (): Promise<Uint8Array> => {
      return deriveFileKey(requireKey(), 'beebeeb-search-index')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const setBiometricRequirementFn = useCallback(
    async (require: boolean): Promise<void> => {
      if (Platform.OS !== 'ios' || usesSoftwareVaultFallback()) return
      await replaceKeychainAccessControl(require, requireKey(), MASTER_KEY_LABEL)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const tryBackgroundUnlockFn = useCallback(async (): Promise<boolean> => {
    // Already unlocked — nothing to do
    if (masterKeyRef.current) return true

    try {
      const enabled = await getKeepVaultUnlocked()
      if (!enabled) return false

      const key = await loadVerifiedMasterKey()
      if (!key) return false

      masterKeyRef.current = key
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
        getMasterKeyBytes: getMasterKeyBytesFn,
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
