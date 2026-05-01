// All binary data is passed as Uint8Array across the JSI bridge (new architecture).
// Native side: Data (Swift) / ByteArray (Kotlin).

export interface EncryptedData {
  nonce: Uint8Array
  ciphertext: Uint8Array
}

export interface RecoveryPhraseResult {
  phrase: string
  masterKey: Uint8Array
}

export interface MasterKeyResult {
  masterKey: Uint8Array
}

export interface OpaqueStartResult {
  /** Client state — must be kept secret and passed to the Finish step */
  state: Uint8Array
  /** Message to send to the server */
  message: Uint8Array
}

export interface OpaqueRegistrationFinishResult {
  /** Credential record to upload to the server */
  record: Uint8Array
}

export interface OpaqueLoginFinishResult {
  /** Exported session key — used to derive the master key */
  sessionKey: Uint8Array
}
