/**
 * raw-extract — impure filesystem glue for the camera-RAW preview feature
 * (task 1569). Deliberately kept separate from `raw-preview.ts`'s pure
 * scanning/mapping core — importing `expo-file-system` at module scope
 * makes a file unimportable under this project's `bun test` runner (a
 * segfault, not a normal failure — see `raw-preview.ts`'s own top comment
 * for the reproduction). This file is the one `RawRenderer.tsx` actually
 * calls; it is not unit-tested directly, same as `AudioRenderer.tsx`'s use
 * of `expo-audio` — the pure logic it's built from (`findLargestJpegSpan`,
 * `parseTiffExifTags`, `findJpegExifTiffOffset`, `mapExifToRawInfo`) IS
 * unit-tested, in `raw-preview.test.ts`.
 */

import * as FileSystem from 'expo-file-system/legacy';
import {
  base64ToBytes,
  bytesToBase64,
  findJpegExifTiffOffset,
  mapExifToRawInfo,
  parseTiffExifTags,
  scanForLargestJpegSpan,
  type RawExifInfo,
} from './raw-preview';

export type { RawExifInfo };

/**
 * Reads at most `length` bytes from the START of a local file via a single
 * BOUNDED `readAsStringAsync({ position: 0, length })` call — never the
 * whole file. This is the one primitive `scanForLargestJpegSpan` drives with
 * a growing `length` (see that function's own doc comment for the full P1
 * fix this replaces: reading the ENTIRE RAW file through base64->atob-
 * >Uint8Array, several × its on-disk size on the JS heap for an ordinary
 * 50-150MB camera RAW). `position`/`length` are expo-file-system's own
 * documented bounded-range-read options (both required together — neither
 * has an effect alone, per that library's own types).
 */
async function readFileBytesBounded(uri: string, length: number): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position: 0,
    length,
  });
  return base64ToBytes(b64);
}

export interface RawPreviewResult {
  /** `file://` uri of the extracted embedded JPEG, written to its own cache
   * file (so `<Image>` reads a normal file uri rather than holding a
   * multi-megabyte `data:` uri in JS state) — or `null` if no usable
   * embedded preview was found (corrupt file, or a genuinely unsupported
   * container with no embedded JPEG at all). Caller's responsibility to
   * delete this file when done — `RawRenderer` does so on unmount via
   * `cleanupTrackedTempFile`. */
  previewUri: string | null;
  exif: RawExifInfo | null;
}

/**
 * Extracts the largest embedded JPEG preview + best-effort EXIF summary
 * from a decrypted RAW file already on disk (`sourceUri`). See
 * `raw-preview.ts`'s top comment for the full EXIF strategy (RAW container
 * first, extracted-JPEG's own Exif segment as fallback) and why this uses a
 * hand-rolled TIFF reader instead of `exifr` (Hermes Release-build
 * incompatibility).
 */
export async function extractRawPreview(
  sourceUri: string,
  cacheDir: string,
  cacheKey: string,
): Promise<RawPreviewResult> {
  // P1 fix (Codex review, PRs #126/#127): this used to be a single
  // `readFileBytes(sourceUri)` with no length limit at all — the ENTIRE RAW
  // file, base64-round-tripped through JS (see `readFileBytesBounded`'s own
  // doc comment for exactly how many times over its own size that put on the
  // JS heap). `scanForLargestJpegSpan` drives `readFileBytesBounded` with a
  // small initial bounded read that grows only if needed, capped at
  // `RAW_PREVIEW_SCAN_MAX_BYTES` regardless of `fileSizeBytes` — see that
  // function's own doc comment (`raw-preview.ts`) for the real-fixture
  // measurements behind the specific byte constants. `getInfoAsync` itself
  // reads only filesystem metadata (stat), never file contents.
  const info = await FileSystem.getInfoAsync(sourceUri);
  const fileSizeBytes = info.exists ? info.size : 0;
  const { bytes, span } = await scanForLargestJpegSpan(fileSizeBytes, (length) =>
    readFileBytesBounded(sourceUri, length),
  );

  let previewUri: string | null = null;
  let jpegBytes: Uint8Array | null = null;
  if (span) {
    jpegBytes = bytes.subarray(span.start, span.end);
    // Random suffix (not just `cacheKey`, the stable per-file id): while
    // chasing the real bug below (a corrupted `bytesToBase64`, now fixed in
    // `raw-preview.ts`), a deterministic filename made it briefly look like
    // stale image caching — it wasn't, but a fresh name per extraction is
    // still cheap insurance against ever reusing a uri RN's image loader may
    // have cached under a prior (however unlikely) failed/partial write.
    // Same `preview/` cache subfolder the source RAW's own decrypted temp
    // file already lives in (guaranteed to exist by the time this runs —
    // `fetchAndDecrypt` created it before this component ever mounts).
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outUri = `${cacheDir}preview/${cacheKey}-${uniqueSuffix}.raw-preview.jpg`;
    await FileSystem.writeAsStringAsync(outUri, bytesToBase64(jpegBytes), {
      encoding: FileSystem.EncodingType.Base64,
    });
    previewUri = outUri;
  }

  let exif = mapExifToRawInfo(parseTiffExifTags(bytes));
  if (!exif && jpegBytes) {
    const tiffOffset = findJpegExifTiffOffset(jpegBytes);
    if (tiffOffset != null) {
      exif = mapExifToRawInfo(parseTiffExifTags(jpegBytes, tiffOffset));
    }
  }

  return { previewUri, exif };
}
