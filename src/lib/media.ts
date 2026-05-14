/**
 * Shared media/MIME utilities for the mobile client.
 *
 * Mirrors the extension-to-MIME mapping in beebeeb-core so TypeScript callers
 * get the same results without crossing the native bridge. Once the native
 * module exposes `guessMimeType` and `isMedia` we can swap to native calls;
 * until then this is the single source of truth for the mobile app.
 */

const MIME_MAP: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heic',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',

  // Video
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',

  // Audio
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',

  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',

  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',

  // 3D
  '3mf': 'model/3mf',
}

/**
 * Guess the MIME type of a file from its extension.
 * Returns null for unknown extensions.
 */
export function guessMimeType(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ext ? MIME_MAP[ext] ?? null : null
}

/**
 * Whether the MIME type represents a media file (image or video).
 * Used for the `is_media` flag sent to the server during upload.
 */
export function isMedia(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false
  return mimeType.startsWith('image/') || mimeType.startsWith('video/')
}

/**
 * Determine a file type category from the MIME type string.
 * Used by the file list UI to pick icons and enable preview features.
 */
export function fileCategory(
  mimeType: string | null | undefined,
  isFolder: boolean,
): 'folder' | 'image' | 'pdf' | 'audio' | 'video' | 'doc' | 'file' {
  if (isFolder) return 'folder'
  const mime = mimeType ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('text/') || mime.includes('document') || mime.includes('spreadsheet')) return 'doc'
  return 'file'
}

/**
 * Detect MIME type from filename extension + MediaLibrary mediaType hint.
 * Falls back to `image/jpeg` for unknown photos, `video/mp4` for unknown videos.
 * Used by the photo backup runner where every asset is known to be a photo or video.
 */
export function detectMediaMimeType(filename: string, mediaType: string): string {
  const fromExt = guessMimeType(filename)
  if (fromExt) return fromExt
  return mediaType === 'video' ? 'video/mp4' : 'image/jpeg'
}
