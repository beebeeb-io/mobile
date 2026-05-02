/**
 * Thumbnail generation for image uploads.
 *
 * After an image is uploaded, we generate a 256-pixel-wide JPEG and
 * PUT it to /api/v1/files/{id}/thumbnail so list views can preview
 * the file without re-downloading the original.
 *
 * Best-effort: a failed thumbnail must never block or rollback the
 * underlying upload. Callers should not await the result.
 */

import * as ImageManipulator from 'expo-image-manipulator';
import { uploadThumbnail } from './api';

const THUMB_WIDTH = 256;
const THUMB_QUALITY = 0.7;

const IMAGE_MIME_PREFIX = 'image/';

export function isImageMime(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.startsWith(IMAGE_MIME_PREFIX);
}

/**
 * Resize an image at `sourceUri` down to a 256-px-wide JPEG and
 * return its blob. Returns null if the source can't be processed
 * (corrupt file, unsupported format, etc.).
 */
export async function generateThumbnail(sourceUri: string): Promise<Blob | null> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: THUMB_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
    );
    const res = await fetch(result.uri);
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * Generate a thumbnail from an image URI and upload it for the given file.
 * Fire-and-forget: never throws, never blocks the caller's success flow.
 */
export async function generateAndUploadThumbnail(
  fileId: string,
  sourceUri: string,
  mimeType: string | null | undefined,
): Promise<void> {
  if (!isImageMime(mimeType)) return;
  try {
    const thumb = await generateThumbnail(sourceUri);
    if (!thumb) return;
    await uploadThumbnail(fileId, thumb);
  } catch {
    // Best-effort — swallow.
  }
}
