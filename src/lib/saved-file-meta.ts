/**
 * saved-file-meta — the size the preview SHOWS after an in-app save
 * (task 1592 item 5; also 1585 item 1).
 *
 * The preview's size comes from the route params / the pager entry, captured
 * when the file was opened. Saving a new version from the editor changed the
 * file on the server but not that captured value, so the header pill and the
 * Info sheet kept the pre-edit size (15 B while the list said 33 B).
 *
 * After a save the screen records the saved file's fresh metadata here and
 * displays it for THAT file only (a swipe to another page must not inherit
 * it). Display only: the decrypt path keeps its own inputs (on the network
 * path the server's X-Original-Size header wins anyway).
 */

export interface SavedFileMeta {
  fileId: string;
  sizeBytes: number;
}

/**
 * Builds the post-save record: the server's `size_bytes` when a fresh read
 * returned one, else the UTF-8 byte length of the text just saved (what the
 * server stores as the plaintext size of a text file).
 */
export function savedFileMetaFrom(
  fileId: string,
  savedText: string,
  fresh?: { size_bytes?: number | null } | null,
): SavedFileMeta {
  const serverSize = fresh?.size_bytes;
  const sizeBytes =
    typeof serverSize === 'number' && Number.isFinite(serverSize) && serverSize >= 0
      ? serverSize
      : new TextEncoder().encode(savedText).length;
  return { fileId, sizeBytes };
}

/** The size to display for `fileId`: the saved one if it is this file's. */
export function displayedSizeBytes(
  fileId: string,
  openedSizeBytes: number | null | undefined,
  saved: SavedFileMeta | null,
): number | null | undefined {
  return saved && saved.fileId === fileId ? saved.sizeBytes : openedSizeBytes;
}
