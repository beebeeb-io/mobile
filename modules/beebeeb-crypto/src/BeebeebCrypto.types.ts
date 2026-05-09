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
  /** Client finish message to send to the server */
  message: Uint8Array
  /** Shared OPAQUE session key. Authentication only; not the vault key. */
  sessionKey: Uint8Array
  /** OPAQUE export key, reserved for future credential wrapping. */
  exportKey: Uint8Array
}

// ─── Amber Constellation ─────────────────────────────────────────────────────

export interface ConstellationSessionInit {
  /** 16 bytes — opaque session identifier embedded in the visual payload. */
  sessionId: Uint8Array
  /** 32 bytes — X25519 ephemeral public key, embedded in the payload. */
  ephemeralPublicKey: Uint8Array
  /** 32 bytes — X25519 ephemeral private key. Lives only in app memory. */
  ephemeralPrivateKey: Uint8Array
  /** 32 bytes — SHA-256(domain || code) sent to the server for verification. */
  confirmCodeHash: Uint8Array
  /** 6-digit decimal code displayed under the constellation. */
  confirmCode: string
  /** Encoded payload bytes. Pass back into constellationEncode for every frame. */
  payload: Uint8Array
  /** Unix-ms expiry. */
  expiresAtUnixMs: number
}

export interface ConstellationNodeFrame {
  /** 0 = outer ring, 1 = core. */
  kind: number
  x: number
  y: number
  z: number
  /** 0..1, quantized to {0.10, 0.37, 0.63, 0.90}. */
  brightness: number
  pulsePhase: number
}

export interface ConstellationEdgeFrame {
  fromIdx: number
  toIdx: number
  weight: number
  flowSpeed: number
}

export interface ConstellationFrame {
  frameIndex: number
  seed: number
  ringPhase: number
  nodes: ConstellationNodeFrame[]
  edges: ConstellationEdgeFrame[]
}
