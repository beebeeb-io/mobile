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
