/**
 * TypeScript API surface for beebeeb-crypto.
 *
 * All functions delegate to the native module via JSI. The native implementations
 * are stubs until BeebeebCore.xcframework / .so files are linked — they throw
 * "NOT_LINKED" errors at runtime until then.
 *
 * Binary data is exchanged as Uint8Array. With newArchEnabled (JSI), the bridge
 * handles the JS↔native conversion without base64 overhead.
 */

import BeebeebCryptoModule from './BeebeebCryptoModule'
import type {
  EncryptedData,
  MasterKeyResult,
  OpaqueLoginFinishResult,
  OpaqueRegistrationFinishResult,
  OpaqueStartResult,
  RecoveryPhraseResult,
} from './BeebeebCrypto.types'

// ─── Key generation & recovery ──────────────────────────────────────────────

/**
 * Generate a new 12-word BIP-39 recovery phrase and derive the master key from it.
 * The phrase must be shown to the user exactly once and never stored on-device.
 */
export async function generateRecoveryPhrase(): Promise<RecoveryPhraseResult> {
  return BeebeebCryptoModule.generateRecoveryPhrase()
}

/**
 * Derive the master key from an existing recovery phrase.
 * Use this during onboarding when restoring from a backup.
 */
export async function recoverFromPhrase(phrase: string): Promise<MasterKeyResult> {
  return BeebeebCryptoModule.recoverFromPhrase(phrase)
}

// ─── File encryption ─────────────────────────────────────────────────────────

/**
 * Encrypt a file chunk with a per-file key (AES-256-GCM).
 * Returns the nonce and ciphertext; both must be stored alongside the file.
 */
export async function encryptChunk(key: Uint8Array, plaintext: Uint8Array): Promise<EncryptedData> {
  return BeebeebCryptoModule.encryptChunk(key, plaintext)
}

/**
 * Decrypt a file chunk.
 */
export async function decryptChunk(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return BeebeebCryptoModule.decryptChunk(key, nonce, ciphertext)
}

// ─── Metadata encryption ─────────────────────────────────────────────────────

/**
 * Encrypt file metadata (name, size, MIME type) as a JSON string.
 */
export async function encryptMetadata(key: Uint8Array, metadata: string): Promise<EncryptedData> {
  return BeebeebCryptoModule.encryptMetadata(key, metadata)
}

/**
 * Decrypt file metadata, returning the original JSON string.
 */
export async function decryptMetadata(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<string> {
  return BeebeebCryptoModule.decryptMetadata(key, nonce, ciphertext)
}

// ─── OPAQUE authentication ───────────────────────────────────────────────────

/**
 * Start OPAQUE registration (client side).
 * Send `message` to POST /auth/opaque/register/start, then call registrationFinish.
 */
export async function opaqueRegistrationStart(
  username: string,
  password: string,
): Promise<OpaqueStartResult> {
  return BeebeebCryptoModule.opaqueRegistrationStart(username, password)
}

/**
 * Finish OPAQUE registration (client side).
 * `serverMessage` comes from the server's response. Upload `record` to complete.
 */
export async function opaqueRegistrationFinish(
  state: Uint8Array,
  serverMessage: Uint8Array,
): Promise<OpaqueRegistrationFinishResult> {
  return BeebeebCryptoModule.opaqueRegistrationFinish(state, serverMessage)
}

/**
 * Start OPAQUE login (client side).
 * Send `message` to POST /auth/opaque/login/start, then call loginFinish.
 */
export async function opaqueLoginStart(username: string): Promise<OpaqueStartResult> {
  return BeebeebCryptoModule.opaqueLoginStart(username)
}

/**
 * Finish OPAQUE login (client side).
 * `sessionKey` is the shared secret — use it to derive/decrypt the master key.
 */
export async function opaqueLoginFinish(
  state: Uint8Array,
  serverMessage: Uint8Array,
): Promise<OpaqueLoginFinishResult> {
  return BeebeebCryptoModule.opaqueLoginFinish(state, serverMessage)
}

// ─── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a per-file encryption key from the master key and a file ID.
 * Uses HKDF-SHA256. The same master key + fileId always yields the same file key.
 */
export async function deriveFileKey(masterKey: Uint8Array, fileId: string): Promise<Uint8Array> {
  return BeebeebCryptoModule.deriveFileKey(masterKey, fileId)
}

// ─── Keychain ────────────────────────────────────────────────────────────────

/**
 * Store a key in the platform secure enclave (iOS Keychain / Android Keystore).
 */
export async function storeKeyInKeychain(key: Uint8Array, label: string): Promise<void> {
  return BeebeebCryptoModule.storeKeyInKeychain(key, label)
}

/**
 * Load a key from the platform secure enclave. Returns null if not found.
 */
export async function loadKeyFromKeychain(label: string): Promise<Uint8Array | null> {
  return BeebeebCryptoModule.loadKeyFromKeychain(label)
}
