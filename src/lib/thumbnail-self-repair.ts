/**
 * Auto self-repair on download — task 0883.
 *
 * When an OWNER opens or saves a photo/video that has NO server thumbnail, the
 * download/decrypt step has just written the full plaintext to disk. Rather than
 * leaving that file permanently thumbnail-less (the legacy `ensureThumbnailForImage`
 * path throws on iOS), we reuse the already-on-disk plaintext to generate +
 * upload a thumbnail — a free self-repair that needs no second download.
 *
 * Design contract (all guards live here, in one place):
 *  - OWNER-ONLY. Callers must only invoke this from owner decrypt sites
 *    (PreviewScreen / FilesScreen). The non-owner SharedViewScreen decrypts with
 *    share keys and must NEVER call this.
 *  - E2E preserved. The thumbnail is encrypted under the per-file key inside
 *    `generateAndUploadThumbnail`; this module never touches raw key bytes.
 *  - Fire-and-forget. Never throws, never blocks the user's open/save.
 *  - Idempotent + storm-safe. Only runs when `has_thumbnail === false`, dedups
 *    per fileId (succeeded set + in-flight map + timestamp backoff), and caps
 *    global concurrency so rapid preview-swiping can't fan out.
 *
 * Reuses `generateAndUploadThumbnail` (thumbnail.ts): images via
 * expo-image-manipulator WebP, video via native AVAssetImageGenerator, DNG via
 * CoreImage; PUT /api/v1/files/:id/thumbnail; blurhash for medium images.
 */

import {
  generateAndUploadThumbnail,
  isThumbnailable,
  THUMBNAIL_REPAIR_RETRY_MS,
} from './thumbnail';
import { getLocalIdentifier } from './local-identifier-map';

// fileIds that have already succeeded this session — never re-attempt. The
// server flips `has_thumbnail` on success, so once the list refreshes the
// `has_thumbnail === false` guard would also catch these; this is belt-and-suspenders.
const repaired = new Set<string>();
// fileId → last attempt timestamp. Backoff window so a transient failure (or an
// in-progress decrypt that re-enters) can't loop aggressively.
const lastAttemptAt = new Map<string, number>();
// fileId → in-flight promise so concurrent callers coalesce onto one upload.
const inflight = new Map<string, Promise<boolean>>();

// Small global concurrency cap. Video frame-extraction in particular is heavy;
// a burst of opens must not run many generations at once.
const MAX_CONCURRENT = 2;
let active = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

export interface SelfRepairArgs {
  fileId: string;
  /**
   * Local plaintext file URI returned by `decryptToTempFile` — the complete
   * decrypted bytes already on disk. The thumbnail is generated from this.
   */
  localPlaintextUri: string;
  /**
   * The renderer's MIME type. Callers should synthesize `image/jpeg` /
   * `video/mp4` from their own image/video classification when the stored MIME
   * is null (the plaintext mime column is dropped server-side).
   */
  mimeType: string | null | undefined;
  /**
   * Server truth from the file list (`FileItem.has_thumbnail`). Repair ONLY runs
   * when this is explicitly `false`. `undefined`/`null` ⇒ unknown ⇒ skip (we do
   * NOT probe the network — that is how storms start).
   */
  hasServerThumbnail: boolean | null | undefined;
  /**
   * True for file-request uploads (`file_request_id`/`wrapped_content_key`).
   * Those use the request content key, not `deriveFileKey`; a thumbnail
   * encrypted under the file key would be undecryptable. Skip.
   */
  isRequestUpload?: boolean;
  /** Per-file key provider from `useCrypto()` — passed straight through. */
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>;
  /** Fired once after a successful upload so the caller can flip local state. */
  onRepaired?: (fileId: string) => void;
}

/**
 * Fire-and-forget entry point. Returns immediately; never throws, never blocks.
 */
export function maybeSelfRepairThumbnailFromLocalFile(args: SelfRepairArgs): void {
  void runSelfRepair(args).catch((err) => {
    console.warn('[thumbnail-self-repair] repair worker failed', {
      fileId: args.fileId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Best-effort — a failed self-repair must never surface to the user.
  });
}

async function runSelfRepair(args: SelfRepairArgs): Promise<boolean> {
  const {
    fileId,
    localPlaintextUri,
    mimeType,
    hasServerThumbnail,
    isRequestUpload,
    getFileKeyBytes,
    onRepaired,
  } = args;

  if (!fileId || !localPlaintextUri) return false;
  // Guard 1 — primary idempotency: only repair when the server is known to lack
  // a thumbnail. true/undefined/null all short-circuit.
  if (hasServerThumbnail !== false) return false;
  // Guard 2 — only images/videos can have thumbnails.
  if (!isThumbnailable(mimeType)) return false;
  // Guard 3 — request-upload files use a different content key. Skip.
  if (isRequestUpload) return false;
  // Guard 4 — camera-roll-backed files: the native PhotoKit/backup path owns
  // their (higher-quality, 1600px-source) thumbnails; don't race or overwrite it.
  if (getLocalIdentifier(fileId)) return false;
  // Guard 5 — already repaired this session.
  if (repaired.has(fileId)) return false;
  // Guard 6 — coalesce concurrent callers for the same file.
  const existing = inflight.get(fileId);
  if (existing) return existing;
  // Guard 7 — backoff window since the last attempt (transient-failure guard).
  const last = lastAttemptAt.get(fileId);
  if (last !== undefined && Date.now() - last < THUMBNAIL_REPAIR_RETRY_MS) return false;

  lastAttemptAt.set(fileId, Date.now());

  const promise = (async () => {
    await acquireSlot();
    try {
      const ok = await generateAndUploadThumbnail(
        fileId,
        localPlaintextUri,
        mimeType,
        getFileKeyBytes,
        'medium',
      );
      if (ok) {
        repaired.add(fileId);
        try {
          onRepaired?.(fileId);
        } catch {
          // A misbehaving callback must not break the repair result.
        }
      }
      return ok;
    } catch (err) {
      console.warn('[thumbnail-self-repair] thumbnail upload repair failed', {
        fileId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      releaseSlot();
    }
  })();

  inflight.set(fileId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(fileId);
  }
}

/** Sign-out hygiene — drop the per-session dedup state. */
export function resetThumbnailSelfRepairState(): void {
  repaired.clear();
  lastAttemptAt.clear();
  inflight.clear();
}
