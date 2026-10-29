/**
 * The preview cache key — the ONE place that decides which extension a
 * decrypted preview is written under (`Library/Caches/preview/<fileId>.<ext>`,
 * see `decryptToTempFile` in native-decrypt.ts).
 *
 * Task 1593 (#141 security review): "Prove it" used to derive its own
 * extension from the file NAME (`notes.md` -> `md`) while the preview derives
 * it from the mime + category (`notes.md` -> `txt`). The cache is keyed by
 * fileId + extension, so opening "Prove it" on a previewed file decrypted it
 * a SECOND time and left a second plaintext copy on disk. Both now call
 * `previewDecryptExtension` below, so they hit the same cache entry.
 *
 * Moved verbatim out of PreviewScreen.tsx (extensionForMime,
 * isEncryptedMetadataName, previewDisplayName, previewCacheName) so the
 * screen and the proof share one implementation instead of two copies that
 * can drift.
 */
import { extensionForAudio } from './audio-format';
import { fileCategory, type Category } from './file-category';
import { extensionForRaw } from './raw-format';

export function isEncryptedMetadataName(name: string): boolean {
  return name.trim().startsWith('{');
}

export function extensionForMime(mimeType?: string, category?: Category, fileName?: string): string {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/heic') return '.heic';
  if (mime === 'image/heif') return '.heif';
  if (mime === 'image/svg+xml') return '.svg';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/x-m4v') return '.m4v';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
  if (mime === 'application/vnd.ms-excel') return '.xls';
  if (mime === 'text/csv') return '.csv';
  if (mime === 'text/html') return '.html';
  if (mime === 'text/plain') return '.txt';
  if (mime === 'application/json') return '.json';
  if (mime === 'application/xml' || mime === 'text/xml') return '.xml';
  if (mime === 'application/zip') return '.zip';
  if (mime.startsWith('audio/')) return extensionForAudio(mime, fileName);
  if (category === 'image') return '.jpg';
  if (category === 'video') return '.mp4';
  if (category === 'pdf') return '.pdf';
  if (category === 'audio') return extensionForAudio(mime, fileName);
  if (category === 'raw') return extensionForRaw(fileName);
  if (category === 'docx') return '.docx';
  if (category === 'spreadsheet') return '.xlsx';
  if (category === 'html') return '.html';
  if (category === 'zip') return '.zip';
  if (category === 'doc') return '.txt';
  return '';
}

export function previewDisplayName(fileName: string, category: Category): string {
  if (!isEncryptedMetadataName(fileName)) return fileName;
  if (category === 'image') return 'Photo';
  if (category === 'video') return 'Video';
  return 'Encrypted file';
}

export function previewCacheName(fileName: string, mimeType: string | undefined, category: Category): string {
  const displayName = previewDisplayName(fileName, category);
  let safeName = displayName.replace(/[^a-zA-Z0-9._\-]/g, '_');
  if (!safeName) safeName = category === 'image' ? 'Photo' : 'Preview';
  if (!/\.[a-zA-Z0-9]{2,5}$/.test(safeName)) {
    safeName += extensionForMime(mimeType, category, fileName);
  }
  return safeName;
}

/**
 * The extension `PreviewScreen`'s original-file decrypt hands
 * `decryptToTempFile` for this file (`extensionForMime(...) || cacheFileName`,
 * with the leading dot stripped exactly as `decryptToTempFile` strips it).
 * Anything else that wants "the decrypted copy of this file" — "Prove it" —
 * must use this, or it writes a second plaintext copy under another key.
 */
export function previewDecryptExtension(mimeType: string | null | undefined, fileName: string): string {
  const mime = mimeType ?? undefined;
  const category = fileCategory(mime, fileName);
  const ext = extensionForMime(mime, category, fileName);
  return (ext || previewCacheName(fileName, mime, category)).replace(/^\./, '');
}
