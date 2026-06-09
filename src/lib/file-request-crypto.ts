// ─── File-request owner decrypt path (0643) ─────────────────────────────────
//
// Files that arrive through a file request are NOT encrypted with the owner's
// normal per-file key. Instead the anonymous uploader sealed a random content
// key C to the request's public key R_pub (ECIES), and the server stored, on
// the file row:
//   - file_request_id          → which request this belongs to
//   - sender_ephemeral_pubkey  → the uploader's ephemeral X25519 public key E_pub
//   - wrapped_content_key      → C sealed under ECDH(E, R_pub)
//
// To decrypt, the owner:
//   1. looks up the owning request → wrapped_private_key + wrap_nonce,
//   2. unwraps R_priv via the master-key handle (native; master key never
//      enters JS),
//   3. C = openRequestUpload(R_priv, E_pub, wrapped_content_key),
//   4. uses C as the file key for chunk + filename decryption.
//
// This mirrors repos/web/src/lib/file-request-crypto.ts. The only platform
// difference: R_priv is unwrapped through the opaque master-key handle
// (`unwrapRequestPrivateWithHandle`) instead of a raw master key, because mobile
// never holds raw master-key bytes in JS (task 0556).

import type { FileEntry } from './api'
import { listFileRequests, type FileRequest } from './api'
import { openRequestUpload, unwrapRequestPrivateWithHandle } from '../../modules/beebeeb-crypto'

export type RequestFileFields = Pick<
  FileEntry,
  'file_request_id' | 'sender_ephemeral_pubkey' | 'wrapped_content_key'
>

/** Decode a standard base64 string to bytes (atob is polyfilled on Hermes ≥0.74). */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Standard base64-encode bytes (for wire fields: wrapped_private_key, wrap_nonce). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** URL-safe base64 without padding — for the link fragment `#<R_pub>`. Matches
 *  the web client's `toBase64url` so links round-trip cross-client. */
export function toBase64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** True when a file must be decrypted via the request-key path, not the normal
 *  master-key-derived per-file key. */
export function isRequestUpload(file: RequestFileFields): boolean {
  return Boolean(file.file_request_id && file.sender_ephemeral_pubkey && file.wrapped_content_key)
}

/**
 * Caching resolver for the owner-decrypt path — mirrors the web/CLI resolvers.
 * It fetches GET /file-requests once (memoised) and unwraps each request's
 * R_priv at most once (cached by request id), so naming + opening many
 * request-uploaded files does O(requests) unwraps rather than O(files). A cache
 * miss (a file whose request isn't in the loaded set yet — e.g. created after
 * the first load) triggers exactly one reload.
 *
 * R_priv buffers live for the resolver's lifetime (the unlocked session).
 * `clear()` zeroes them — the crypto context calls it on vault lock.
 */
export interface RequestKeyResolver {
  /** Recover the content key C for a request-uploaded file. */
  resolveContentKey(file: RequestFileFields): Promise<Uint8Array>
  /** Zero cached R_priv buffers and drop the memoised request list. */
  clear(): void
}

/**
 * @param getHandleId returns the current master-key handle id; throws if the
 *                    vault is locked. Used to unwrap R_priv natively.
 */
export function createRequestKeyResolver(getHandleId: () => number): RequestKeyResolver {
  let requestsPromise: Promise<Map<string, FileRequest>> | null = null
  const rPrivCache = new Map<string, Uint8Array>()

  const loadRequests = (force: boolean): Promise<Map<string, FileRequest>> => {
    if (force || !requestsPromise) {
      requestsPromise = listFileRequests().then(
        ({ file_requests }) => new Map(file_requests.map((r) => [r.id, r])),
      )
    }
    return requestsPromise
  }

  return {
    async resolveContentKey(file: RequestFileFields): Promise<Uint8Array> {
      if (!isRequestUpload(file)) {
        throw new Error('resolveContentKey called on a non-request file')
      }
      const requestId = file.file_request_id!

      // Reuse the unwrapped R_priv if we've already opened a file for this request.
      let rPriv = rPrivCache.get(requestId)
      if (!rPriv) {
        let reqMap = await loadRequests(false)
        let req = reqMap.get(requestId)
        if (!req) {
          // The request may have been created after our first load — reload once.
          reqMap = await loadRequests(true)
          req = reqMap.get(requestId)
        }
        if (!req || !req.wrapped_private_key || !req.wrap_nonce) {
          throw new Error('owning file request (or its wrapped key) not found — cannot decrypt')
        }
        rPriv = await unwrapRequestPrivateWithHandle(
          getHandleId(),
          fromBase64(req.wrapped_private_key),
          fromBase64(req.wrap_nonce),
        )
        rPrivCache.set(requestId, rPriv)
      }

      const ePub = fromBase64(file.sender_ephemeral_pubkey!)
      const wrappedKey = fromBase64(file.wrapped_content_key!)
      return openRequestUpload(rPriv, ePub, wrappedKey)
    },

    clear() {
      for (const k of rPrivCache.values()) k.fill(0)
      rPrivCache.clear()
      requestsPromise = null
    },
  }
}
