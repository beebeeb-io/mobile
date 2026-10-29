/**
 * photo-candidates — which vault rows belong in the Photos tab (task 1687c).
 *
 * Extracted verbatim from PhotosScreen.tsx (functions `mediaMimeType`,
 * `isMediaFile`, `isEncryptedThumbnailCandidate`, `isVisibleMediaFile`,
 * `photoCandidatesFromIndex`) so the row-level decision is unit-testable
 * (the screen file imports react-native; this module stays dependency-free
 * — same convention as preview-chrome.ts / photo-viewer-window.ts).
 *
 * Task 1687c finding (2026-10-02): a freshly uploaded image used to be
 * INVISIBLE in the Photos grid and pager until its fire-and-forget
 * thumbnail PUT landed (`has_thumbnail` false) and no plaintext
 * `mime_type` exists server-side (the column was dropped; the mime is
 * encrypted inside `name_encrypted`). The row itself exists the moment
 * `upload/init` runs — with `is_media` set by the client's own
 * classification at upload time (server task 0262) — so the AC "appears
 * as soon as the upload row itself exists" means: `is_uploading` must NOT
 * exclude a row that is already a media candidate. A mid-upload photo
 * opens into the preview's honest "still uploading" card (task 1592's
 * STILL_UPLOADING_MESSAGE) instead of not existing.
 */

import { guessMimeType } from './media';

/** Minimal structural subset of `FileEntry` (src/lib/api.ts) this decision needs. */
export interface PhotoCandidateFileEntry {
  id: string;
  name_encrypted: string;
  /** @deprecated plaintext column dropped server-side; may still be filled client-side. */
  mime_type?: string | null;
  is_folder: boolean;
  is_uploading?: boolean;
  has_thumbnail?: boolean;
  is_media?: boolean;
  /** Carried for photo-library folder exclusion (ParentedEntry). */
  parent_id?: string | null;
  /** Search-index/local rows may carry these (see PhotosScreen's former MediaEntry cast). */
  mime?: string | null;
  category?: string | null;
  file_category?: string | null;
  media_type?: string | null;
  name?: string | null;
  file_name?: string | null;
}

export function stringField(value: unknown): string | null {
  // Mirrors the trim behavior PhotosScreen's original helper had — trimming
  // keeps ' Image ' style category strings comparable after toLowerCase().
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function mediaCategory(entry: PhotoCandidateFileEntry): string {
  return (
    stringField(entry.category) ??
    stringField(entry.file_category) ??
    stringField(entry.media_type) ??
    ''
  ).toLowerCase();
}

export function filenameCandidates(entry: PhotoCandidateFileEntry): string[] {
  return [
    stringField(entry.name),
    stringField(entry.file_name),
    stringField(entry.name_encrypted),
  ].filter((value): value is string => !!value && !value.startsWith('{'));
}

export function mediaMimeType(entry: PhotoCandidateFileEntry): string | null {
  const mime = (entry.mime_type ?? entry.mime ?? '').toLowerCase();
  if (mime.startsWith('image/')) return entry.mime_type ?? entry.mime ?? 'image/jpeg';
  if (mime.startsWith('video/')) return entry.mime_type ?? entry.mime ?? 'video/mp4';

  const category = mediaCategory(entry);
  if (category === 'image' || category === 'photo') return 'image/jpeg';
  if (category === 'video') return 'video/mp4';

  for (const name of filenameCandidates(entry)) {
    const guessed = guessMimeType(name);
    if (guessed?.startsWith('image/')) return guessed;
    if (guessed?.startsWith('video/')) return guessed;
  }

  return entry.is_media ? 'image/jpeg' : null;
}

export function isMediaFile(entry: PhotoCandidateFileEntry): boolean {
  return mediaMimeType(entry) !== null;
}

export function isEncryptedThumbnailCandidate(entry: PhotoCandidateFileEntry): boolean {
  return !!entry.has_thumbnail && typeof entry.name_encrypted === 'string' && entry.name_encrypted.startsWith('{');
}

export function isVisibleMediaFile(
  entry: PhotoCandidateFileEntry,
  decryptedMimeTypes: Record<string, string>,
): boolean {
  const decryptedMime = decryptedMimeTypes[entry.id]?.toLowerCase();
  if (decryptedMime) return decryptedMime.startsWith('image/') || decryptedMime.startsWith('video/');
  return isMediaFile(entry) || isEncryptedThumbnailCandidate(entry);
}

/**
 * The row-level Photos-tab decision. Task 1687c: an upload row that already
 * carries a media classification (`is_media`, a decodable mime, or a
 * thumbnail) is a photo candidate THE MOMENT IT EXISTS — `is_uploading` no
 * longer hides it. Non-media rows (documents) and folders stay out; the
 * task does not turn the Photos tab into a file list.
 */
export function photoCandidatesFromIndex<T extends PhotoCandidateFileEntry>(files: T[]): T[] {
  return files.filter((entry) => (
    !entry.is_folder &&
    (isMediaFile(entry) || isEncryptedThumbnailCandidate(entry))
  ));
}