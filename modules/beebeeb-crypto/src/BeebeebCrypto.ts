/**
 * TypeScript API surface for beebeeb-crypto.
 *
 * All functions delegate to the native module via JSI. The native implementations
 * are stubs until BeebeebCore.xcframework / .so files are linked — they throw
 * "NOT_LINKED" errors at runtime until then.
 *
 * Most binary data is exchanged as Uint8Array. OPAQUE messages use base64 at
 * the native boundary so auth bytes are preserved exactly across the bridge.
 */

import BeebeebCryptoModule, { isNativeAvailable as nativeFlag } from './BeebeebCryptoModule'
import type {
  ConstellationFrame,
  ConstellationSessionInit,
  EncryptedData,
  FileProviderDomainInfo,
  FileProviderDomainRegistrationResult,
  FileProviderPrivacyState,
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function coerceBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? base64ToBytes(value) : value
}

// ─── Key generation & recovery ──────────────────────────────────────────────

/**
 * Generate a new 12-word BIP-39 recovery phrase and derive the master key from it.
 * The phrase must be shown to the user exactly once and never stored on-device.
 */
export async function generateRecoveryPhrase(): Promise<RecoveryPhraseResult> {
  const result = await BeebeebCryptoModule.generateRecoveryPhrase()
  return {
    phrase: result.phrase,
    masterKey: coerceBytes(result.masterKey),
  }
}

export async function generateRandomBytes(length: number): Promise<Uint8Array> {
  return coerceBytes(await BeebeebCryptoModule.generateRandomBytes(length))
}

/**
 * Derive the master key from an existing recovery phrase.
 * Use this during onboarding when restoring from a backup.
 */
export async function recoverFromPhrase(phrase: string): Promise<MasterKeyResult> {
  const result = await BeebeebCryptoModule.recoverFromPhrase(phrase)
  return { masterKey: coerceBytes(result.masterKey) }
}

/**
 * Compute the server-verifiable recovery check for a master key.
 * Sent during account setup so server-side phrase recovery can verify the
 * mnemonic without learning the master key or phrase.
 */
export async function computeRecoveryCheck(masterKey: Uint8Array): Promise<Uint8Array> {
  return coerceBytes(await BeebeebCryptoModule.computeRecoveryCheck(masterKey))
}

/**
 * Derive the Curve25519 public key associated with the vault master key.
 * Used by the server for sharing identity metadata.
 */
export async function deriveX25519PublicKey(masterKey: Uint8Array): Promise<Uint8Array> {
  const privateKey = coerceBytes(await BeebeebCryptoModule.deriveX25519Private(masterKey))
  return coerceBytes(await BeebeebCryptoModule.deriveX25519Public(privateKey))
}

// ─── File encryption ─────────────────────────────────────────────────────────

/**
 * Encrypt a file chunk with a per-file key (AES-256-GCM).
 * Returns the nonce and ciphertext; both must be stored alongside the file.
 */
export async function encryptChunk(key: Uint8Array, plaintext: Uint8Array): Promise<EncryptedData> {
  const result = await BeebeebCryptoModule.encryptChunk(key, plaintext)
  return {
    cipherSuite: result.cipherSuite,
    nonce: coerceBytes(result.nonce),
    ciphertext: coerceBytes(result.ciphertext),
  }
}

/**
 * Decrypt a file chunk.
 */
export async function decryptChunk(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return coerceBytes(await BeebeebCryptoModule.decryptChunk(key, nonce, ciphertext))
}

// ─── Metadata encryption ─────────────────────────────────────────────────────

/**
 * Encrypt file metadata (name, size, MIME type) as a JSON string.
 */
export async function encryptMetadata(key: Uint8Array, metadata: string): Promise<EncryptedData> {
  const result = await BeebeebCryptoModule.encryptMetadata(key, metadata)
  return {
    cipherSuite: result.cipherSuite,
    nonce: coerceBytes(result.nonce),
    ciphertext: coerceBytes(result.ciphertext),
  }
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
  const result = await BeebeebCryptoModule.opaqueRegistrationStart(username, password)
  return {
    state: coerceBytes(result.state),
    message: coerceBytes(result.message),
  }
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
  const result = await BeebeebCryptoModule.opaqueRegistrationFinish(
    bytesToBase64(state),
    bytesToBase64(serverMessage),
    password,
  )
  return { record: coerceBytes(result.record) }
}

/**
 * Start OPAQUE login (client side).
 * Send `message` to POST /auth/opaque/login/start, then call loginFinish.
 * `password` is required by the OPAQUE OPRF — it must be forwarded to loginFinish too.
 */
export async function opaqueLoginStart(username: string, password: string): Promise<OpaqueStartResult> {
  const result = await BeebeebCryptoModule.opaqueLoginStart(username, password)
  return {
    state: coerceBytes(result.state),
    message: coerceBytes(result.message),
  }
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
  const result = await BeebeebCryptoModule.opaqueLoginFinish(
    bytesToBase64(state),
    bytesToBase64(serverMessage),
    password,
  )
  return {
    message: coerceBytes(result.message),
    sessionKey: coerceBytes(result.sessionKey),
    exportKey: coerceBytes(result.exportKey),
  }
}

// ─── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a per-file encryption key from the master key and a file ID.
 * Uses HKDF-SHA256. The same master key + fileId always yields the same file key.
 */
export async function deriveFileKey(masterKey: Uint8Array, fileId: string): Promise<Uint8Array> {
  return coerceBytes(await BeebeebCryptoModule.deriveFileKey(masterKey, fileId))
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
  const key = await BeebeebCryptoModule.loadKeyFromKeychain(label)
  return key ? coerceBytes(key) : null
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

/**
 * Switch the SE wrapping key using the already-unlocked master key.
 * This avoids prompting under the old access policy during Settings changes.
 */
export async function replaceKeychainAccessControl(
  require: boolean,
  key: Uint8Array,
  label: string,
): Promise<boolean> {
  return BeebeebCryptoModule.replaceKeychainAccessControl(require, key, label)
}

/**
 * Mirror auth state into the iOS App Group so the File Provider can upload,
 * download, and update encrypted files from the system Files app.
 */
export async function mirrorSessionToAppGroup(
  token: string | null,
  baseUrl: string | null,
): Promise<boolean> {
  if (typeof BeebeebCryptoModule.mirrorSessionToAppGroup !== 'function') return false
  return BeebeebCryptoModule.mirrorSessionToAppGroup(token, baseUrl)
}

/**
 * Legacy cleanup shim. Older debug simulator builds mirrored the raw master key
 * into App Group defaults for File Provider QA. Current builds never persist
 * raw vault keys in App Group storage; native iOS removes any stale value and
 * returns false.
 */
export async function mirrorSimulatorFileProviderMasterKey(masterKeyBase64: string | null): Promise<boolean> {
  if (typeof BeebeebCryptoModule.mirrorSimulatorFileProviderMasterKey !== 'function') return false
  return BeebeebCryptoModule.mirrorSimulatorFileProviderMasterKey(masterKeyBase64)
}

/**
 * Register the app's iOS File Provider domain so Beebeeb appears under
 * Files.app Locations. The native implementation is idempotent.
 */
export async function registerFileProviderDomain(): Promise<FileProviderDomainRegistrationResult> {
  if (typeof BeebeebCryptoModule.registerFileProviderDomain !== 'function') {
    return {
      supported: false,
      identifier: 'io.beebeeb.files',
      displayName: 'Beebeeb',
      registered: false,
      added: false,
      removedBeforeAdd: false,
      domainCount: 0,
      rootEnumerationSignaled: false,
      workingSetEnumerationSignaled: false,
    }
  }
  return BeebeebCryptoModule.registerFileProviderDomain()
}

/** List registered File Provider domains. Intended for QA/debug tooling. */
export async function listFileProviderDomains(): Promise<FileProviderDomainInfo[]> {
  if (typeof BeebeebCryptoModule.listFileProviderDomains !== 'function') return []
  return BeebeebCryptoModule.listFileProviderDomains()
}

/** Remove the Beebeeb File Provider domain and revoke any active Files access window. */
export async function unregisterFileProviderDomain(): Promise<FileProviderDomainRegistrationResult> {
  if (typeof BeebeebCryptoModule.unregisterFileProviderDomain !== 'function') {
    return {
      supported: false,
      identifier: 'io.beebeeb.files',
      displayName: 'Beebeeb',
      registered: false,
      added: false,
      removedBeforeAdd: false,
      domainCount: 0,
      rootEnumerationSignaled: false,
      workingSetEnumerationSignaled: false,
    }
  }
  return BeebeebCryptoModule.unregisterFileProviderDomain()
}

/** Show or hide Beebeeb under iOS Files.app Locations. */
export async function setFileProviderEnabled(enabled: boolean): Promise<FileProviderDomainRegistrationResult> {
  if (typeof BeebeebCryptoModule.setFileProviderEnabled !== 'function') {
    return {
      supported: false,
      identifier: 'io.beebeeb.files',
      displayName: 'Beebeeb',
      registered: false,
      added: false,
      removedBeforeAdd: false,
      domainCount: 0,
      rootEnumerationSignaled: false,
      workingSetEnumerationSignaled: false,
    }
  }
  return BeebeebCryptoModule.setFileProviderEnabled(enabled)
}

export async function getFileProviderPrivacyState(): Promise<FileProviderPrivacyState> {
  if (typeof BeebeebCryptoModule.getFileProviderPrivacyState !== 'function') {
    return {
      supported: false,
      showInFiles: false,
      trustedMountEnabled: false,
      mounted: false,
      requireDeviceAuth: true,
      unlockedUntilMs: 0,
      unlockWindowSeconds: 0,
      locked: true,
    }
  }
  return BeebeebCryptoModule.getFileProviderPrivacyState()
}

/** Mount Beebeeb as a trusted iOS Files location. Device-owner auth happens before this call. */
export async function mountFileProviderAccess(): Promise<FileProviderDomainRegistrationResult> {
  if (typeof BeebeebCryptoModule.mountFileProviderAccess !== 'function') {
    return {
      supported: false,
      identifier: 'io.beebeeb.files',
      displayName: 'Beebeeb',
      registered: false,
      added: false,
      removedBeforeAdd: false,
      domainCount: 0,
      rootEnumerationSignaled: false,
      workingSetEnumerationSignaled: false,
    }
  }
  return BeebeebCryptoModule.mountFileProviderAccess()
}

/** Remove the trusted iOS Files mount and revoke all File Provider shared state. */
export async function removeFileProviderAccess(): Promise<FileProviderDomainRegistrationResult> {
  if (typeof BeebeebCryptoModule.removeFileProviderAccess !== 'function') {
    return unregisterFileProviderDomain()
  }
  return BeebeebCryptoModule.removeFileProviderAccess()
}

export async function setFileProviderAuthRequired(required: boolean): Promise<FileProviderPrivacyState> {
  if (typeof BeebeebCryptoModule.setFileProviderAuthRequired !== 'function') {
    return getFileProviderPrivacyState()
  }
  return BeebeebCryptoModule.setFileProviderAuthRequired(required)
}

export async function unlockFileProviderAccess(): Promise<FileProviderPrivacyState> {
  if (typeof BeebeebCryptoModule.unlockFileProviderAccess !== 'function') {
    return getFileProviderPrivacyState()
  }
  return BeebeebCryptoModule.unlockFileProviderAccess()
}

export async function lockFileProviderAccess(): Promise<FileProviderPrivacyState> {
  if (typeof BeebeebCryptoModule.lockFileProviderAccess !== 'function') {
    return getFileProviderPrivacyState()
  }
  return BeebeebCryptoModule.lockFileProviderAccess()
}

/**
 * Remove and re-add the Beebeeb File Provider domain. Intended for QA/debug
 * resets when Files.app state is stale.
 */
export async function resetFileProviderDomain(): Promise<FileProviderDomainRegistrationResult> {
  if (typeof BeebeebCryptoModule.resetFileProviderDomain !== 'function') {
    return {
      supported: false,
      identifier: 'io.beebeeb.files',
      displayName: 'Beebeeb',
      registered: false,
      added: false,
      removedBeforeAdd: false,
      domainCount: 0,
      rootEnumerationSignaled: false,
      workingSetEnumerationSignaled: false,
    }
  }
  return BeebeebCryptoModule.resetFileProviderDomain()
}

// ─── Backup management ──────────────────────────────────────────────────────

export interface NativeBackupProgress {
  total: number
  completed: number
  inProgress: number
  lastBackupAt: string | null
}

export type NativeBackupCategory = 'camera_roll' | 'contacts' | 'calendar'

/** Set the server folder native backup workers should upload new items into. */
export async function configureBackupFolder(category: NativeBackupCategory, parentFolderId: string | null): Promise<void> {
  if (typeof BeebeebCryptoModule.configureBackupFolder !== 'function') return
  return BeebeebCryptoModule.configureBackupFolder(category, parentFolderId)
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

/** Resume contacts backup observers without forcing an immediate export. */
export async function resumeContactsBackup(authToken: string): Promise<void> {
  if (typeof BeebeebCryptoModule.resumeContactsBackup !== 'function') {
    return BeebeebCryptoModule.enableContactsBackup(authToken)
  }
  return BeebeebCryptoModule.resumeContactsBackup(authToken)
}

export async function disableContactsBackup(): Promise<void> {
  return BeebeebCryptoModule.disableContactsBackup()
}

/** Start calendar backup. Requests EKEventStore access and uploads an encrypted iCal. */
export async function enableCalendarBackup(authToken: string): Promise<void> {
  return BeebeebCryptoModule.enableCalendarBackup(authToken)
}

/** Resume calendar backup observers without forcing an immediate export. */
export async function resumeCalendarBackup(authToken: string): Promise<void> {
  if (typeof BeebeebCryptoModule.resumeCalendarBackup !== 'function') {
    return BeebeebCryptoModule.enableCalendarBackup(authToken)
  }
  return BeebeebCryptoModule.resumeCalendarBackup(authToken)
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

/** Remove one pending share from the App Group after a successful upload. iOS only. */
export async function acknowledgePendingShare(id: string): Promise<boolean> {
  return BeebeebCryptoModule.acknowledgePendingShare(id)
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
