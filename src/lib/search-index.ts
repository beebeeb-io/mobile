/**
 * Encrypted search index — mobile client.
 *
 * Mirrors `repos/web/src/lib/search-index.ts`:
 *   - Server stores an opaque encrypted blob at GET/PUT /api/v1/index.
 *   - Client encrypts the blob with an AES-256-GCM key derived from the master
 *     key using HKDF-SHA-256 over `info = "beebeeb-search-index"`. The web
 *     uses Web Crypto's `subtle.deriveBits`; mobile reuses the native
 *     `deriveFileKey` (also HKDF-SHA-256 over the info string), so both
 *     clients land on the same 32-byte key for the same vault.
 *   - The plaintext blob is JSON: `{ version, updated_at, files: { [id]: entry } }`.
 *
 * Wire format on the wire: `nonce(12) || ciphertext(plaintext + 16-byte GCM tag)`.
 */

import { encryptChunk, decryptChunk } from '../../modules/beebeeb-crypto'
import { getApiUrl, getToken } from './api'
import { rateLimitedFetch } from './rate-limited-fetch'

export interface SearchIndexEntry {
  name: string
  path: string
  type: string
  size: number
  parent: string | null
  starred: boolean
  created: string
  modified: string
  tags: string[]
}

export interface SearchIndex {
  version: number
  updated_at: string
  files: Record<string, SearchIndexEntry>
}

function encodeUtf8(input: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i += 1
      }
    }

    if (code <= 0x7f) {
      bytes.push(code)
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(bytes)
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b1 = bytes[i]!
    if (b1 < 0x80) {
      out += String.fromCharCode(b1)
    } else if (b1 >= 0xc0 && b1 < 0xe0) {
      const b2 = bytes[++i] ?? 0
      out += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f))
    } else if (b1 >= 0xe0 && b1 < 0xf0) {
      const b2 = bytes[++i] ?? 0
      const b3 = bytes[++i] ?? 0
      out += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f))
    } else {
      const b2 = bytes[++i] ?? 0
      const b3 = bytes[++i] ?? 0
      const b4 = bytes[++i] ?? 0
      const code = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)
      const adjusted = code - 0x10000
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff))
    }
  }
  return out
}

async function encryptIndex(index: SearchIndex, indexKey: Uint8Array): Promise<Uint8Array> {
  const json = JSON.stringify(index)
  const plaintext = encodeUtf8(json)
  const { nonce, ciphertext } = await encryptChunk(indexKey, plaintext)

  const out = new Uint8Array(nonce.length + ciphertext.length)
  out.set(nonce, 0)
  out.set(ciphertext, nonce.length)
  return out
}

async function decryptIndex(data: Uint8Array, indexKey: Uint8Array): Promise<SearchIndex> {
  if (data.length <= 12) {
    throw new Error('Encrypted index is too small to decrypt')
  }
  const nonce = data.slice(0, 12)
  const ciphertext = data.slice(12)
  const plaintext = await decryptChunk(indexKey, nonce, ciphertext)
  const json = decodeUtf8(plaintext)
  return JSON.parse(json) as SearchIndex
}

export async function fetchIndex(indexKey: Uint8Array): Promise<SearchIndex | null> {
  const token = await getToken()
  if (!token) return null

  const res = await rateLimitedFetch(`${getApiUrl()}/api/v1/index`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) return null

  const blob = new Uint8Array(await (await res.blob()).arrayBuffer())
  return decryptIndex(blob, indexKey)
}

export async function saveIndex(
  index: SearchIndex,
  indexKey: Uint8Array,
  etag?: string,
): Promise<string | null> {
  const token = await getToken()
  if (!token) return null

  const encrypted = await encryptIndex(index, indexKey)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/octet-stream',
  }
  if (etag) headers['If-Match'] = etag

  const res = await rateLimitedFetch(`${getApiUrl()}/api/v1/index`, {
    method: 'PUT',
    headers,
    body: encrypted as unknown as BodyInit,
  })
  if (!res.ok) return null
  return res.headers.get('ETag')
}

export function createEmptyIndex(): SearchIndex {
  return { version: 1, updated_at: new Date().toISOString(), files: {} }
}

export function updateIndexEntry(
  index: SearchIndex,
  fileId: string,
  entry: SearchIndexEntry,
): SearchIndex {
  return {
    ...index,
    updated_at: new Date().toISOString(),
    files: { ...index.files, [fileId]: entry },
  }
}

export function removeIndexEntry(index: SearchIndex, fileId: string): SearchIndex {
  const { [fileId]: _removed, ...rest } = index.files
  return { ...index, updated_at: new Date().toISOString(), files: rest }
}

export interface SearchResult {
  id: string
  entry: SearchIndexEntry
  score: number
}

export function searchIndex(index: SearchIndex, query: string): SearchResult[] {
  if (!query.trim()) return []

  const lower = query.toLowerCase()
  const terms = lower.split(/\s+/)

  return Object.entries(index.files)
    .map(([id, entry]) => {
      let score = 0
      const name = entry.name.toLowerCase()
      const path = entry.path.toLowerCase()

      for (const term of terms) {
        if (name === term) score += 10
        else if (name.startsWith(term)) score += 5
        else if (name.includes(term)) score += 3
        else if (path.includes(term)) score += 1
        else if (entry.tags.some((t) => t.toLowerCase().includes(term))) score += 2
      }

      return { id, entry, score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
}
