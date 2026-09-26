// Flow "iOS core journeys" issue 3 (P2): "Lock file" gated only the full-size
// preview. The Photos grid tile, the Files row/grid card and the Recent tile
// kept drawing the decrypted thumbnail, so anyone holding the unlocked phone
// saw the image content of a locked file.
//
// These helpers decide, per file id, whether a thumbnail may be drawn at all.
// Both fail closed: until the lock list has been read from SecureStore
// (`lockStateReady`), no thumbnail is drawn — the same rule as
// `isPagerPageGated` in preview-lock-gate.ts — but no lock glyph is shown
// either, because we do not yet know the file is locked.
//
// Scope, stated honestly (see lock-copy.ts): this hides thumbnails inside the
// Beebeeb app only. The iOS Files app (File Provider extension) does not read
// this lock list.

export interface GridThumbnailFields {
  thumbnailUri: string | null;
  localAssetId: string | null;
  blurhash: string | null;
  /** Draw no image for this tile (locked, or lock state not known yet). */
  hideThumbnail: boolean;
  /** Draw the lock placeholder (the file is known to be locked). */
  isLocked: boolean;
}

/** Whether a thumbnail may be drawn/loaded for `fileId` right now. */
export function fileThumbnailState(
  locked: boolean,
  lockStateReady: boolean,
): { loadThumbnail: boolean; showLockPlaceholder: boolean } {
  if (!lockStateReady) return { loadThumbnail: false, showLockPlaceholder: false };
  return { loadThumbnail: !locked, showLockPlaceholder: locked };
}

/**
 * The image-source fields of a Photos grid tile, with every source stripped
 * (server thumbnail, PhotoKit asset, blurhash — a blurhash still shows the
 * picture's composition and colours) when the tile may not show its image.
 */
export function lockAwareThumbnailFields(
  fileId: string,
  source: { thumbnailUri?: string | null; localAssetId?: string | null; blurhash?: string | null },
  lockedIds: ReadonlySet<string>,
  lockStateReady: boolean,
): GridThumbnailFields {
  const { loadThumbnail, showLockPlaceholder } = fileThumbnailState(lockedIds.has(fileId), lockStateReady);
  if (!loadThumbnail) {
    return { thumbnailUri: null, localAssetId: null, blurhash: null, hideThumbnail: true, isLocked: showLockPlaceholder };
  }
  return {
    thumbnailUri: source.thumbnailUri ?? null,
    localAssetId: source.localAssetId ?? null,
    blurhash: source.blurhash ?? null,
    hideThumbnail: false,
    isLocked: false,
  };
}
