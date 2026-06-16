import type { EncryptedData } from '../../modules/beebeeb-crypto'

function isJsonByte(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
}

function bytesFromJsonValue(value: unknown): Uint8Array | null {
  if (typeof value === 'string') {
    try {
      const binary = atob(value)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes
    } catch {
      return null
    }
  }

  if (!Array.isArray(value)) {
    return null
  }

  const bytes = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const byte = value[i]
    if (!isJsonByte(byte)) {
      return null
    }
    bytes[i] = byte
  }
  return bytes
}

export function encryptedMetadataToJson(enc: EncryptedData): string {
  if (!enc.cipherSuite) {
    throw new Error('Missing metadata cipher suite')
  }

  return JSON.stringify({
    cipher_suite: enc.cipherSuite,
    nonce: Array.from(enc.nonce),
    ciphertext: Array.from(enc.ciphertext),
  })
}

/**
 * Optional, additive metadata fields carried inside the E2E-encrypted metadata
 * blob (task 0802). The server treats the blob as opaque ciphertext; other
 * clients parse only `name`/`mime_type` and ignore unknown keys, so adding
 * these is backward-compatible across web/desktop/mobile. All fields are
 * computed on-device (Apple Vision OCR + local summary) — never sent in
 * plaintext, never uploaded to any cloud.
 */
export interface FileMetadataExtras {
  /** On-device OCR text extracted from the document (searchable note body). */
  note?: string
  /** Short on-device summary of what the document is. */
  aiSummary?: string
  /** Detected document type, e.g. "receipt" / "invoice". */
  aiDocType?: string
  /** Marks the note/summary as AI-generated (drives the AI badge in the UI). */
  ai?: boolean
}

export function fileMetadataPlaintext(
  name: string,
  mimeType?: string | null,
  extras?: FileMetadataExtras | null,
): string {
  const payload: Record<string, unknown> = { name, mime_type: mimeType ?? null }
  if (extras) {
    if (typeof extras.note === 'string' && extras.note.length > 0) payload.note = extras.note
    if (typeof extras.aiSummary === 'string' && extras.aiSummary.length > 0) {
      payload.ai_summary = extras.aiSummary
    }
    if (typeof extras.aiDocType === 'string' && extras.aiDocType.length > 0) {
      payload.ai_doc_type = extras.aiDocType
    }
    if (extras.ai) payload.ai = true
  }
  return JSON.stringify(payload)
}

export function encryptedMetadataPayloadToBytes(
  raw: string,
): { nonce: Uint8Array; ciphertext: Uint8Array } | null {
  if (!raw.startsWith('{')) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const payload = parsed as Record<string, unknown>
  const nonce = bytesFromJsonValue(payload.nonce ?? payload.n)
  const ciphertext = bytesFromJsonValue(payload.ciphertext ?? payload.c)
  if (!nonce || !ciphertext) {
    return null
  }

  return { nonce, ciphertext }
}
