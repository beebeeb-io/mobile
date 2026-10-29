/**
 * Task 2233 item 1 (A7) — the Photos grid row and cell, extracted so their
 * memoisation can be tested without rendering the whole screen.
 *
 * The viewport settle used to hand every row a NEW `activeThumbnailIds` Set,
 * so `PhotoRow`'s memo missed for all mounted rows and — because
 * `PhotoCell` got fresh inline `onPress`/`onLongPress` closures on each row
 * render — every visible cell re-rendered too. Now a row receives a stable
 * signature of only the thumbnail ids that concern it, and the cells dispatch
 * press/long-press through stable callbacks, so a settle that changes another
 * row renders nothing here.
 */
import React, { useCallback, useMemo } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Icon } from '../../components/Icon';
import { ThumbnailImage } from '../../components/ThumbnailImage';
import { lockAwareThumbnailFields } from '../../lib/locked-thumbnail';
import { mediaMimeType } from '../../lib/photo-candidates';
import { useTheme } from '../../lib/theme-context';
import type { FileEntry } from '../../lib/api';

export const GRID_GAP = 2;

export function swatch(seed: number): string {
  // Neutral warm-tone palette: low-saturation, no green or olive. Once
  // PhotoKit short-circuit (task 0552) is active for camera-roll-backed
  // photos, this placeholder flashes only briefly for non-PhotoKit files.
  const colors = ['#e8e2d5', '#d9d2c3', '#dcd5c5', '#d4ccba', '#e1dac9', '#d0c8b6', '#e5dfd0', '#d8d1c0'];
  return colors[seed % colors.length] ?? '#e8e2d5';
}

/** `'*'` means "every cell in this row loads" (the active set is empty). */
export const ALL_THUMBNAILS = '*';

/**
 * Stable, cheap per-row signature of the thumbnail ids this row cares about.
 *
 * Two active sets with the same membership inside `photos` produce the SAME
 * string, so a viewport settle that changes ids in other rows does not
 * invalidate this row (A7).
 */
export function thumbnailSignatureForRow(
  photos: readonly FileEntry[],
  activeThumbnailIds: ReadonlySet<string>,
): string {
  if (activeThumbnailIds.size === 0) return ALL_THUMBNAILS;
  const active: string[] = [];
  for (const photo of photos) {
    if (activeThumbnailIds.has(photo.id)) active.push(photo.id);
  }
  return active.join(',');
}

function parseSignature(signature: string): Set<string> | null {
  if (signature === ALL_THUMBNAILS) return null;
  return new Set(signature ? signature.split(',') : []);
}

export const PhotoCell = React.memo(function PhotoCell({
  entry,
  hasThumbnail,
  loadThumbnail,
  seed,
  isFromBackup,
  localAssetUri,
  mimeType,
  blurhash,
  onThumbnailUnavailable,
  onOpenPhoto,
  onTogglePhoto,
  onLongPressPhoto,
  accessibilityLabel,
  cellSize,
  columns,
  isVideo,
  isSelected,
  selectMode,
  isLocked = false,
}: {
  entry: FileEntry;
  hasThumbnail?: boolean;
  loadThumbnail: boolean;
  seed: number;
  isFromBackup: boolean;
  localAssetUri?: string | null;
  mimeType?: string | null;
  blurhash?: string | null;
  onThumbnailUnavailable: (fileId: string) => void;
  onOpenPhoto: (entry: FileEntry) => void;
  onTogglePhoto: (entry: FileEntry) => void;
  onLongPressPhoto: (entry: FileEntry) => void;
  accessibilityLabel: string;
  cellSize: number;
  columns: number;
  isVideo: boolean;
  isSelected: boolean;
  selectMode: boolean;
  /** Flow iOS-core issue 3 — draw the lock placeholder instead of an image. */
  isLocked?: boolean;
}) {
  const { colors: c } = useTheme();
  const fileId = entry.id;
  const showOverlay = columns <= 4;
  const videoBadgeSize = columns <= 4 ? 22 : 18;
  // Stable for the life of the cell (A7): the row no longer creates a new
  // closure per render, so `React.memo` on PhotoCell holds across settles.
  const handlePress = useCallback(() => {
    if (selectMode) onTogglePhoto(entry);
    else onOpenPhoto(entry);
  }, [entry, onOpenPhoto, onTogglePhoto, selectMode]);
  const handleLongPress = useCallback(() => {
    onLongPressPhoto(entry);
  }, [entry, onLongPressPhoto]);
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={250}
      accessibilityRole="button"
      accessibilityState={selectMode ? { selected: isSelected } : undefined}
      accessibilityLabel={accessibilityLabel}
      style={{ width: cellSize, height: cellSize }}
    >
      <ThumbnailImage
        fileId={fileId}
        hasThumbnail={hasThumbnail}
        loadThumbnail={loadThumbnail}
        localAssetUri={localAssetUri}
        mimeType={mimeType}
        blurhash={blurhash}
        onUnavailable={onThumbnailUnavailable}
        placeholderColor={swatch(seed)}
        style={StyleSheet.absoluteFill}
        accessibilityLabel={accessibilityLabel}
      />
      {isLocked ? (
        <View
          testID={`photo-tile-locked-${fileId}`}
          style={[StyleSheet.absoluteFill, styles.lockedTile, { backgroundColor: c.paper2 }]}
          pointerEvents="none"
        >
          <Icon name="lock" size={columns <= 4 ? 20 : 14} color={c.ink3} />
        </View>
      ) : null}
      {showOverlay && isFromBackup && (
        <View style={[styles.originBadge, { backgroundColor: c.amber }]}>
          <Ionicons name="camera" size={10} color={c.ink} />
        </View>
      )}
      {isVideo ? (
        <View
          style={[
            styles.videoBadge,
            {
              width: videoBadgeSize,
              height: videoBadgeSize,
              borderRadius: videoBadgeSize / 2,
            },
          ]}
        >
          <Ionicons name="play" size={columns <= 4 ? 12 : 10} color="#FFFFFF" />
        </View>
      ) : null}
      {selectMode ? (
        <>
          {isSelected ? <View style={styles.selectionOverlay} pointerEvents="none" /> : null}
          <View
            style={[
              styles.selectionBadge,
              {
                borderColor: isSelected ? c.amber : 'rgba(255,255,255,0.8)',
                backgroundColor: isSelected ? c.amber : 'rgba(0,0,0,0.35)',
              },
            ]}
            pointerEvents="none"
          >
            {isSelected ? <Ionicons name="checkmark" size={14} color={c.ink} /> : null}
          </View>
        </>
      ) : null}
    </TouchableOpacity>
  );
});

export const PhotoRow = React.memo(function PhotoRow({
  photos,
  photosFolderId,
  thumbnailSignature,
  localAssetMap,
  decryptedNames,
  decryptedMimeTypes,
  onThumbnailUnavailable,
  onOpenPhoto,
  onTogglePhoto,
  onLongPressPhoto,
  selectedIds,
  selectMode,
  columns,
  cellSize,
  seedOffset,
  lockedIds,
  lockStateReady,
}: {
  photos: FileEntry[];
  photosFolderId: string | null;
  thumbnailSignature: string;
  localAssetMap: Map<string, string>;
  decryptedNames: Record<string, string>;
  decryptedMimeTypes: Record<string, string>;
  onThumbnailUnavailable: (fileId: string) => void;
  onOpenPhoto: (entry: FileEntry) => void;
  onTogglePhoto: (entry: FileEntry) => void;
  onLongPressPhoto: (entry: FileEntry) => void;
  selectedIds: Set<string>;
  selectMode: boolean;
  columns: number;
  cellSize: number;
  seedOffset: number;
  lockedIds: ReadonlySet<string>;
  lockStateReady: boolean;
}) {
  const activeIds = useMemo(() => parseSignature(thumbnailSignature), [thumbnailSignature]);
  return (
    <View style={[styles.photoRow, { height: cellSize + GRID_GAP }]}>
      {photos.map((photo, i) => {
        // If this photo was backed up from camera roll, use its local asset URI
        const localId = localAssetMap.get(photo.id);
        const localAssetUri = localId ? `ph://${localId}` : null;
        const mimeType = decryptedMimeTypes[photo.id] ?? mediaMimeType(photo);
        const isVideo = !!mimeType?.startsWith('video/');
        const mediaLabel = isVideo ? 'Video' : 'Photo';
        const isSelected = selectedIds.has(photo.id);
        // Flow iOS-core issue 3 — a locked photo shows no image of any kind.
        const gated = lockAwareThumbnailFields(
          photo.id,
          { localAssetId: localAssetUri, blurhash: photo.blurhash },
          lockedIds,
          lockStateReady,
        );
        return (
          <PhotoCell
            key={photo.id}
            entry={photo}
            hasThumbnail={photo.has_thumbnail}
            loadThumbnail={!gated.hideThumbnail && (activeIds === null || activeIds.has(photo.id))}
            seed={seedOffset + i}
            isFromBackup={photosFolderId !== null && photo.parent_id === photosFolderId}
            localAssetUri={gated.localAssetId}
            mimeType={mimeType}
            blurhash={gated.blurhash}
            isLocked={gated.isLocked}
            onThumbnailUnavailable={onThumbnailUnavailable}
            onOpenPhoto={onOpenPhoto}
            onTogglePhoto={onTogglePhoto}
            onLongPressPhoto={onLongPressPhoto}
            accessibilityLabel={decryptedNames[photo.id] ? `${mediaLabel}: ${decryptedNames[photo.id]}` : mediaLabel}
            cellSize={cellSize}
            columns={columns}
            isVideo={isVideo}
            isSelected={isSelected}
            selectMode={selectMode}
          />
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  photoRow: { flexDirection: 'row', gap: GRID_GAP },
  originBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockedTile: { alignItems: 'center', justifyContent: 'center' },
  videoBadge: {
    position: 'absolute',
    top: 5,
    right: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.58)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  selectionOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(246, 192, 58, 0.25)',
    borderWidth: 2,
    borderColor: 'rgba(246, 192, 58, 0.95)',
  },
  selectionBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
