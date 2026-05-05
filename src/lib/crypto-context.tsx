import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import {
  deriveFileKey,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
  encryptMetadata,
  loadKeyFromKeychain,
  recoverFromPhrase,
  storeKeyInKeychain,
} from '../../modules/beebeeb-crypto'
import type { EncryptedData } from '../../modules/beebeeb-crypto'

const MASTER_KEY_LABEL = 'io.beebeeb.master-key'

interface CryptoContextValue {
  isUnlocked: boolean
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
}

const CryptoContext = createContext<CryptoContextValue | null>(null)

export function CryptoProvider({ children }: { children: React.ReactNode }) {
  const [isUnlocked, setIsUnlocked] = useState(false)
  // masterKeyRef holds key material in memory while the vault is open.
  // Never store in React state to avoid accidental serialisation.
  const masterKeyRef = useRef<Uint8Array | null>(null)

  const unlock = useCallback(async (phrase?: string) => {
    let masterKey: Uint8Array

    if (phrase) {
      const result = await recoverFromPhrase(phrase)
      masterKey = result.masterKey
      await storeKeyInKeychain(masterKey, MASTER_KEY_LABEL)
    } else {
      const stored = await loadKeyFromKeychain(MASTER_KEY_LABEL)
      if (!stored) {
        throw new Error('No master key in keychain — provide a recovery phrase to restore')
      }
      masterKey = stored
    }

    masterKeyRef.current = masterKey
    setIsUnlocked(true)
  }, [])

  const lock = useCallback(() => {
    if (masterKeyRef.current) {
      masterKeyRef.current.fill(0) // zero key material before releasing
      masterKeyRef.current = null
    }
    setIsUnlocked(false)
  }, [])

  const requireKey = (): Uint8Array => {
    if (!masterKeyRef.current) throw new Error('Vault is locked — call unlock() first')
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

  return (
    <CryptoContext.Provider
      value={{
        isUnlocked,
        unlock,
        lock,
        encryptChunk: encryptChunkFn,
        decryptChunk: decryptChunkFn,
        encryptMetadata: encryptMetadataFn,
        decryptMetadata: decryptMetadataFn,
        getFileKeyBytes: getFileKeyBytesFn,
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
