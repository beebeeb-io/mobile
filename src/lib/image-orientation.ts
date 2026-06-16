/**
 * EXIF orientation normalization for captured images.
 *
 * Why this exists (task 0801): the document scanner embeds the captured JPEG
 * bytes directly into a PDF image XObject (see `minimal-pdf.ts`). PDF image
 * XObjects render the raw pixel grid and DO NOT honor the JPEG's EXIF
 * orientation tag. A photo taken in portrait is stored by the camera as a
 * landscape pixel buffer plus an "orientation = 6 (rotate 90° CW)" tag; image
 * viewers rotate on display, but the PDF embed shows the un-rotated buffer —
 * so the scanned page comes out rotated.
 *
 * The fix is to bake the orientation into the pixels before embedding:
 * `expo-image-manipulator` always decodes the source into a bitmap (honoring
 * EXIF orientation) and re-encodes it. The re-encoded JPEG has its pixels in
 * display ("up") orientation and no orientation tag, so the PDF renders it
 * upright. This is independent of which camera took the photo (back, front, or
 * any device rotation), so it covers portrait, landscape, and front-camera
 * captures uniformly.
 *
 * Loaded with a dynamic require (mirroring `thumbnail.ts`) so JS-only
 * environments without the native binding don't crash — callers fall back to
 * the original (possibly mis-oriented) capture when normalization is
 * unavailable.
 */

let ImageManipulator: typeof import('expo-image-manipulator') | null = null;
try {
  ImageManipulator = require('expo-image-manipulator');
} catch {
  ImageManipulator = null;
}

export interface NormalizedImage {
  /** file:// URI of the re-encoded JPEG with orientation baked into the pixels. */
  uri: string;
  /** Base64 of the re-encoded JPEG (no data: prefix). */
  base64: string;
  /** Pixel width AFTER orientation is applied. */
  width: number;
  /** Pixel height AFTER orientation is applied. */
  height: number;
}

/**
 * Re-encode an image so its EXIF orientation is baked into the pixel data.
 *
 * Returns `null` when expo-image-manipulator is unavailable or the re-encode
 * produced no base64 — callers should fall back to the original capture.
 *
 * @param uri      Local image URI (e.g. an expo-camera capture).
 * @param options  `quality` is the JPEG compression quality (0–1, default 0.82
 *                 to match the scanner's capture quality).
 */
export async function normalizeImageOrientation(
  uri: string,
  options: { quality?: number } = {},
): Promise<NormalizedImage | null> {
  if (!ImageManipulator) return null;

  const quality = options.quality ?? 0.82;
  // An empty action list still forces a full decode → re-encode, which is what
  // bakes the EXIF orientation into the pixels and drops the orientation tag.
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [],
    { compress: quality, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  if (!result?.base64) return null;

  return {
    uri: result.uri,
    base64: result.base64,
    width: Math.max(1, Math.round(result.width)),
    height: Math.max(1, Math.round(result.height)),
  };
}
