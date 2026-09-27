/**
 * Task 1593 round 3 (#141 Codex P1 "Drain all plaintext writers before the
 * final cache sweep") — SharedViewScreen's download → decrypt → write of a
 * shared-link file, as a plaintext writer under the purge gate.
 *
 * Before: `handleDecrypt` had no abort check after its async download and
 * decrypt, so a forced sign-out (session expired, account deleted elsewhere)
 * could purge `Library/Caches` and THEN this wrote `shared_<token>_<name>`.
 * Now the whole span holds a lease: a purge that closes the gate while the
 * download or decrypt is running waits for it (bounded), and the write finds
 * the lease invalid and writes nothing (or deletes what it wrote).
 *
 * Pure orchestration with injected I/O, so the ordering is unit-tested
 * (shared-view-decrypt.test.ts) without React Native.
 */
import {
  plaintextGate,
  withPlaintextLease,
  writePlaintext,
  type PlaintextGate,
} from './plaintext-gate';

export interface SharedBlob {
  encryptedBytes: Uint8Array;
  chunkCount: number | null;
  chunkSize: number | null;
  originalSize: number | null;
}

export interface SharedDecryptDeps<Name> {
  download: () => Promise<SharedBlob>;
  resolveFileKey: () => Promise<Uint8Array>;
  resolveName: () => Promise<Name | null>;
  decryptBytes: (
    fileKey: Uint8Array,
    encrypted: Uint8Array,
    chunkCount: number,
    sizeBytes: number,
    chunkSize?: number,
  ) => Promise<Uint8Array>;
  inferChunkCount: (encryptedSize: number, plaintextSize: number) => number | null;
  /** Absolute cache URI for the decrypted file (a registered `shared_` name). */
  cacheUri: (name: Name | null) => string;
  toBase64: (bytes: Uint8Array) => string;
  fs: {
    deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
    writeBase64: (uri: string, base64: string) => Promise<void>;
  };
  gate?: PlaintextGate;
}

export interface SharedInfoSizes {
  size_bytes?: number | null;
  chunk_count?: number | null;
}

export async function decryptSharedFileToCache<Name>(
  info: SharedInfoSizes,
  deps: SharedDecryptDeps<Name>,
): Promise<{ uri: string; name: Name | null }> {
  return withPlaintextLease(
    'shared-link decrypt',
    async (lease) => {
      const { encryptedBytes, chunkCount, chunkSize, originalSize } = await deps.download();
      lease.assertValid();
      // 1. Per-file key (unwrapping K_c for a double-encrypted share).
      const fileKey = await deps.resolveFileKey();
      // The decrypted name drives the saved file's name + extension.
      const name = await deps.resolveName();

      // 2. Canonical chunk metadata: server headers, then share info, then
      // byte-math inference (same precedence as PreviewScreen).
      const effectiveOriginalSize = originalSize ?? info.size_bytes ?? encryptedBytes.length - 28;
      if (effectiveOriginalSize <= 0) {
        throw new Error('Could not determine plaintext size for decryption.');
      }
      const inferred = deps.inferChunkCount(encryptedBytes.length, effectiveOriginalSize);
      const effectiveChunkCount = chunkCount ?? info.chunk_count ?? inferred ?? 1;
      const effectiveChunkSize = chunkSize && chunkSize > 0 ? chunkSize : undefined;

      // 3. Decrypt natively.
      lease.assertValid();
      const decrypted = await deps.decryptBytes(
        fileKey,
        encryptedBytes,
        effectiveChunkCount,
        effectiveOriginalSize,
        effectiveChunkSize,
      );

      // 4. Persist for the system share sheet — only while the lease holds.
      const uri = deps.cacheUri(name);
      await writePlaintext(lease, uri, deps.fs, async () => {
        await deps.fs.deleteAsync(uri, { idempotent: true }).catch(() => {});
        await deps.fs.writeBase64(uri, deps.toBase64(decrypted));
      });
      return { uri, name };
    },
    deps.gate ?? plaintextGate,
  );
}
