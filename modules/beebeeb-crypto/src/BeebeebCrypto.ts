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

import BeebeebCryptoModule, { isNativeAvailable as nativeFlag } from './BeebeebCryptoModule'
import type {
  ConstellationFrame,
  ConstellationSessionInit,
  EncryptedData,
  MasterKeyResult,
  OpaqueLoginFinishResult,
  OpaqueRegistrationFinishResult,
  OpaqueStartResult,
  RecoveryPhraseResult,
} from './BeebeebCrypto.types'

/**
 * True when the native BeebeebCrypto module is linked. False in Expo Go (or any
 * build that didn't include the xcframework / .so), where every method on the
 * module would throw. Check this before invoking crypto and fall back to the
 * plain-auth / preview-disabled paths instead of catching the throw.
 */
export const isNativeAvailable: boolean = nativeFlag

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
 * `password` must be the same password passed to opaqueRegistrationStart.
 */
export async function opaqueRegistrationFinish(
  state: Uint8Array,
  serverMessage: Uint8Array,
  password: string,
): Promise<OpaqueRegistrationFinishResult> {
  return BeebeebCryptoModule.opaqueRegistrationFinish(state, serverMessage, password)
}

/**
 * Start OPAQUE login (client side).
 * Send `message` to POST /auth/opaque/login/start, then call loginFinish.
 * `password` is required by the OPAQUE OPRF — it must be forwarded to loginFinish too.
 */
export async function opaqueLoginStart(username: string, password: string): Promise<OpaqueStartResult> {
  return BeebeebCryptoModule.opaqueLoginStart(username, password)
}

/**
 * Finish OPAQUE login (client side).
 * `sessionKey` is the shared secret — use it to derive/decrypt the master key.
 * `password` must be the same password passed to opaqueLoginStart.
 */
export async function opaqueLoginFinish(
  state: Uint8Array,
  serverMessage: Uint8Array,
  password: string,
): Promise<OpaqueLoginFinishResult> {
  return BeebeebCryptoModule.opaqueLoginFinish(state, serverMessage, password)
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
 * Triggers a biometric or passcode prompt if the SE access control requires it.
 */
export async function loadKeyFromKeychain(label: string): Promise<Uint8Array | null> {
  return BeebeebCryptoModule.loadKeyFromKeychain(label)
}

/**
 * Delete the Secure Enclave wrapping key and all wrapped key blobs. Irreversible.
 * Use during sign-out or account deletion.
 */
export async function deleteKeyFromKeychain(): Promise<boolean> {
  return BeebeebCryptoModule.deleteKeyFromKeychain()
}

/**
 * Switch the SE wrapping key between .devicePasscode (background OK) and
 * .biometryAny (foreground only). Re-wraps the stored master key under a new SE key
 * with the updated access control. Requires the user to authenticate with the current
 * policy before the switch takes effect.
 */
export async function setRequireBiometric(require: boolean): Promise<boolean> {
  return BeebeebCryptoModule.setRequireBiometric(require)
}

// ─── Backup management ──────────────────────────────────────────────────────

export interface NativeBackupProgress {
  total: number
  completed: number
  inProgress: number
  lastBackupAt: string | null
}

/** Start camera roll backup. Registers PHPhotoLibrary observer and schedules BGProcessingTask. */
export async function enablePhotoBackup(authToken: string): Promise<void> {
  return BeebeebCryptoModule.enablePhotoBackup(authToken)
}

export async function disablePhotoBackup(): Promise<void> {
  return BeebeebCryptoModule.disablePhotoBackup()
}

/** Start contacts backup. Requests CNContactStore access and uploads an encrypted vCard. */
export async function enableContactsBackup(authToken: string): Promise<void> {
  return BeebeebCryptoModule.enableContactsBackup(authToken)
}

export async function disableContactsBackup(): Promise<void> {
  return BeebeebCryptoModule.disableContactsBackup()
}

/** Start calendar backup. Requests EKEventStore access and uploads an encrypted iCal. */
export async function enableCalendarBackup(authToken: string): Promise<void> {
  return BeebeebCryptoModule.enableCalendarBackup(authToken)
}

export async function disableCalendarBackup(): Promise<void> {
  return BeebeebCryptoModule.disableCalendarBackup()
}

/** Returns live backup queue statistics from the on-device SQLite store. */
export async function getBackupProgress(): Promise<NativeBackupProgress> {
  return BeebeebCryptoModule.getBackupProgress()
}

/** Trigger an immediate batch (up to 50 items) without waiting for BGProcessingTask. */
export async function triggerImmediateBackup(authToken: string): Promise<void> {
  return BeebeebCryptoModule.triggerImmediateBackup(authToken)
}

// ─── Share Extension dropbox (iOS only) ─────────────────────────────────────
//
// The Share Extension drops files into the App Group container and the main
// app picks them up here. Android share-target intents are a separate flow.

export interface PendingShareSummary {
  /** UUID assigned by the extension when the share landed. */
  id: string
  /** User-facing filename, e.g. "IMG_1234.jpg". */
  filename: string
  /** MIME type if the extension could detect one. */
  mimeType?: string
  sizeBytes: number
  /** Unix epoch seconds when the share was saved. */
  timestamp: number
  /** "image" | "video" | "file" | "url" | "text" | "data" */
  kind: string
}

export interface PendingShareResource extends PendingShareSummary {
  /** file:// URI inside the main-app sandbox, ready for `fetch().blob()`. */
  uri: string
}

/** List the pending shares currently in the App Group dropbox. iOS only. */
export async function listPendingShares(): Promise<PendingShareSummary[]> {
  return BeebeebCryptoModule.listPendingShares()
}

/** Move a single share from the App Group into the main-app sandbox. iOS only. */
export async function consumePendingShare(id: string): Promise<PendingShareResource> {
  return BeebeebCryptoModule.consumePendingShare(id)
}

/** Wipe the App Group dropbox. Returns the number of files removed. iOS only. */
export async function clearAllPendingShares(): Promise<number> {
  return BeebeebCryptoModule.clearAllPendingShares()
}

// ─── Amber Constellation — display side ─────────────────────────────────────

/**
 * Initialise a new pairing session: derives an ephemeral X25519 keypair, the
 * 6-digit confirmation code, and the encoded payload that gets transmitted via
 * the visual constellation. Defaults to a 5-minute expiry.
 */
export async function constellationNewSession(
  expiresInSecs = 300,
): Promise<ConstellationSessionInit> {
  return BeebeebCryptoModule.constellationNewSession(expiresInSecs)
}

/**
 * Encode the next frame for a given pairing payload. Returns deterministic
 * node positions and quantized brightness values that the renderer applies.
 * Call this every ~200ms (5 fps data rate) advancing `frameIndex` each tick.
 */
export async function constellationEncode(
  payload: Uint8Array,
  frameIndex: number,
): Promise<ConstellationFrame> {
  return BeebeebCryptoModule.constellationEncode(payload, frameIndex)
}
