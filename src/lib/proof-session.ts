/**
 * "Prove it" data flow (task 1593 — the #141 security review + Codex thread
 * on EncryptionProof.tsx).
 *
 * One open of the sheet = one session:
 *   - plaintext pane: the file's decrypted copy from the PREVIEW CACHE (same
 *     key the preview writes — `previewDecryptExtension`), or ONE decrypt into
 *     that cache entry when it is not there yet. Only the first PROOF_BYTES are
 *     kept in memory. A copy this session decrypted itself is deleted right
 *     after that read, so "Prove it" never leaves a plaintext file behind; a
 *     cached or shared copy belongs to the preview and is left alone.
 *   - ciphertext pane: ONLY bytes 0..PROOF_BYTES-1 of the stored object —
 *     `Range: bytes=0-511`, and if the server answers 200 with the whole body
 *     anyway, the stream is cancelled after the first PROOF_BYTES. Never a
 *     second full download of the file.
 *   - close(): aborts the decrypt + the ranged request (decryptToTempFile
 *     deletes a partial output on abort) and resets both panes, so no
 *     plaintext bytes stay in component state once the sheet is closed.
 */
import type { PreviewDecryptSource } from './native-decrypt';
import {
  PROOF_BYTES,
  PROOF_DECRYPT_MAX_BYTES,
  type PlaintextPrefixState,
} from './encryption-proof';

export type CipherPrefixState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; bytes: Uint8Array }
  | { status: 'failed' };

export interface ProofSessionDeps {
  sizeBytes: number;
  /** decryptToTempFile for this file under the preview cache key. */
  decrypt: (signal: AbortSignal, onSource: (source: PreviewDecryptSource) => void) => Promise<string>;
  /** Read the first `length` bytes of a local file. */
  readPrefix: (path: string, length: number) => Promise<Uint8Array>;
  deleteFile: (path: string) => Promise<void>;
  /** The first `length` ciphertext bytes (see fetchCiphertextPrefix). */
  fetchCiphertextPrefix: (length: number, signal: AbortSignal) => Promise<Uint8Array>;
  onPlain: (state: PlaintextPrefixState) => void;
  onCipher: (state: CipherPrefixState) => void;
}

export interface ProofSession {
  close: () => void;
}

/** The pane states while the sheet is closed: nothing held. */
export const CLOSED_PLAIN_STATE: PlaintextPrefixState = { status: 'loading' };
export const CLOSED_CIPHER_STATE: CipherPrefixState = { status: 'idle' };

export function startProofSession(deps: ProofSessionDeps): ProofSession {
  const controller = new AbortController();
  const { signal } = controller;
  let closed = false;

  // Plaintext pane.
  if (deps.sizeBytes > PROOF_DECRYPT_MAX_BYTES) {
    deps.onPlain({ status: 'too-large' });
  } else {
    deps.onPlain({ status: 'loading' });
    void (async () => {
      let source = null as PreviewDecryptSource | null;
      let path: string | null = null;
      try {
        path = await deps.decrypt(signal, (s) => {
          source = s;
        });
        const prefix = await deps.readPrefix(path, PROOF_BYTES);
        if (!closed) deps.onPlain({ status: 'ready', plaintext: prefix.slice(0, PROOF_BYTES) });
      } catch {
        if (!closed) deps.onPlain({ status: 'failed' });
      } finally {
        // Only the copy THIS session created is ours to delete.
        if (path && source === 'decrypted') {
          await deps.deleteFile(path).catch(() => {});
        }
      }
    })();
  }

  // Ciphertext pane.
  deps.onCipher({ status: 'loading' });
  void (async () => {
    try {
      const bytes = await deps.fetchCiphertextPrefix(PROOF_BYTES, signal);
      if (!closed) deps.onCipher({ status: 'ready', bytes: bytes.slice(0, PROOF_BYTES) });
    } catch {
      if (!closed) deps.onCipher({ status: 'failed' });
    }
  })();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      controller.abort();
      deps.onPlain(CLOSED_PLAIN_STATE);
      deps.onCipher(CLOSED_CIPHER_STATE);
    },
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The first `length` bytes of the stored ciphertext, without downloading the
 * rest: asks for `Range: bytes=0-(length-1)`. A 206 is read whole (it is only
 * `length` bytes). A 200 means the server ignored the Range header — the body
 * is then read from the stream only until `length` bytes have arrived, and
 * the stream + request are cancelled. With no readable stream it fails rather
 * than falling back to buffering the whole object.
 */
export async function fetchCiphertextPrefix(
  url: string,
  token: string,
  length: number,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onOuterAbort);
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: `bytes=0-${length - 1}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.status === 206) {
      return new Uint8Array(await res.arrayBuffer()).slice(0, length);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      controller.abort();
      throw new Error('Ranged read not possible: no response stream.');
    }
    const out = new Uint8Array(length);
    let filled = 0;
    try {
      while (filled < length) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        const take = Math.min(value.length, length - filled);
        out.set(value.subarray(0, take), filled);
        filled += take;
      }
    } finally {
      // Stop the transfer: nothing past `length` is ever read.
      await reader.cancel().catch(() => {});
      controller.abort();
    }
    return out.slice(0, filled);
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
