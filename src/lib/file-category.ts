/**
 * Which viewer the preview routes a file to — moved verbatim out of
 * PreviewScreen.tsx (task 1587 review) so it is pure and importable: the
 * "New file" Text type derives which extensions it refuses from THIS
 * routing (lib/new-document.ts `checkTextExtension`), so the two cannot
 * drift (a `.raf` text file used to pass the refusal list and then open in
 * the RAW viewer).
 */

import { isConfidentlyNonTextMimeType, isTextLikeExtension } from './code-text-preview';
import { isRawExtension } from './raw-format';

/** Extensions the preview routes to the image viewer whatever the mime. */
export const IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'];
/** Extensions the preview routes to the audio player whatever the mime. */
export const AUDIO_EXTENSIONS: readonly string[] = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'];
/** Extensions the preview routes to the video player whatever the mime. */
export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'm4v', 'webm'];

export type Category =
  | 'image'
  | 'raw'
  | 'svg'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'docx'
  | 'pptx'
  | 'spreadsheet'
  | 'html'
  | 'zip'
  | 'archive'
  | 'doc'
  | 'file';

export function fileCategory(mimeType?: string, fileName?: string): Category {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';

  // SVG before generic image — needs WebView, not <Image>, for proper render
  if (mime === 'image/svg+xml' || ext === 'svg') return 'svg';

  // RAW before the generic image check — task 1569. Extension-first, not
  // mime-first: whether the OS reports a RAW extension's mime as `image/*`
  // at all is unreliable (task 1565 finding 4 — mobile uploads have no
  // extension-based mime fallback), and even when it does (DNG's
  // `image/x-adobe-dng` IS explicitly mapped in `media.ts`, just never
  // consulted at upload), the generic `<Image>` component still can't
  // decode CR2/CR3/ARW/NEF/RAF/DNG sensor data — only `RawRenderer`'s
  // embedded-JPEG extraction can. Mirrors web's own `PREVIEWABLE_EXTENSIONS`
  // RAW block, which is extension-driven for the same reason.
  if (isRawExtension(ext)) return 'raw';

  if (
    mime.startsWith('image/') ||
    IMAGE_EXTENSIONS.includes(ext)
  ) {
    return 'image';
  }
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext)) return 'video';

  // HTML before generic text — needs WebView (with source-toggle), not the
  // monospace text viewer.
  if (mime === 'text/html' || ext === 'html' || ext === 'htm') return 'html';

  // ZIP archives — list contents with JSZip (no extraction yet)
  if (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/x-zip' ||
    ext === 'zip'
  ) {
    return 'zip';
  }

  // TAR / GZ / TGZ archives — handled by ArchiveRenderer
  if (
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip' ||
    ext === 'tar' ||
    ext === 'gz' ||
    ext === 'tgz'
  ) {
    return 'archive';
  }

  // PPTX (PowerPoint) — text-only slide viewer
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === 'pptx'
  ) {
    return 'pptx';
  }

  // DOCX (modern Word) — handled by mammoth. Legacy .doc is not supported.
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return 'docx';
  }

  // XLSX / CSV / other SheetJS-readable formats
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    mime.includes('spreadsheet') ||
    mime === 'text/csv' ||
    mime === 'application/csv' ||
    ext === 'xlsx' ||
    ext === 'xls' ||
    ext === 'csv' ||
    ext === 'tsv'
  ) {
    return 'spreadsheet';
  }

  if (mime.startsWith('text/') || mime.includes('document')) return 'doc';

  // Task 1570 — a mime_type that isn't confidently something ELSE (image/
  // video/audio/pdf/zip/archive/office — all already ruled out by the
  // branches above) no longer falls through to the generic "file" card for
  // a known text/code extension, whether that mime_type is nil (the OS's
  // UTType lookup on the phone), the CLI/browser's generic
  // `application/octet-stream`/empty, OR a SPECIFIC-but-not-`text/`-
  // prefixed guess this app's own `media.ts` already substituted upstream
  // (e.g. `application/sql`) — see `code-text-preview.ts`'s `isTextPreview`
  // doc comment for the real bug this widening fixed (a literal
  // generic-mime-only gate missed exactly that last case for `sample.sql`).
  if (!isConfidentlyNonTextMimeType(mime) && isTextLikeExtension(ext)) return 'doc';

  return 'file';
}
