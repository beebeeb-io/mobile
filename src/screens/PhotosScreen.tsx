import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  PinchGestureHandler,
  State,
  type PinchGestureHandlerGestureEvent,
  type PinchGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { NativePhotosGridView, type NativePhotoGridItem } from '../../modules/beebeeb-crypto';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { ScrollEdgeBlur } from '../components/glass';
import { ApiError, getAllImages, getFileIndex, friendlyError, trashFiles } from '../lib/api';
import type { FileEntry } from '../lib/api';
import { guessMimeType } from '../lib/media';
import { useBackup } from '../lib/backup-context';
import { useCrypto } from '../lib/crypto-context';
import { useNetworkStatus } from '../lib/useNetworkStatus';
import {
  getLocalIdentifier,
  getLocalIdentifierMapSize,
  initLocalIdentifierMap,
  refreshLocalIdentifierMap,
} from '../lib/local-identifier-map';
import { ThumbnailImage } from '../components/ThumbnailImage';
import {
  cacheLocalThumbnail,
  ensureThumbnailForImage,
  prefetchDecryptedThumbnails,
  pruneThumbnailCache,
  THUMBNAIL_REPAIR_RETRY_MS,
} from '../lib/thumbnail';
import { getCachedThumbnail, pruneThumbnailsForRemoteFiles } from '../lib/thumbnail-cache';
import { decryptToTempFile } from '../lib/native-decrypt';
import { prunePhotoCacheForRemoteFiles } from '../lib/photo-cache';
import { onFilesDeleted } from '../lib/delete-cascade';
import { removeFromFileProviderCache } from '../lib/file-provider-mount';
import { loadCachedFileIndex, saveCachedFileIndex, type CachedFileIndex } from '../lib/file-index-cache';
import { getRemoteCreatedAtMap, getRemoteToLocalMap, markRemoteDeleted } from '../services/BackupDatabase';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';
import { mapInBatches } from '../lib/async-batch';
import { perfMark } from '../lib/perf-mark';
import { recordRuntimeTrace } from '../lib/runtime-trace';
import {
  columnsForPinchScale,
  DEFAULT_PHOTO_GRID_COLUMNS,
} from '../lib/photo-grid';
import {
  DEFAULT_PERFORMANCE_STORAGE_SETTINGS,
  getPerformanceStorageSettings,
  type PerformanceStorageProfile,
} from '../lib/performance-storage-settings';
import {
  getExcludedPhotoFolderIds,
  filterByExcludedFolders,
  filterByExcludedFoldersDirect,
} from '../lib/photo-library-prefs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MediaEntry = FileEntry & {
  category?: string | null;
  file_category?: string | null;
  media_type?: string | null;
  name?: string | null;
  file_name?: string | null;
  mime?: string | null;
};

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mediaCategory(entry: MediaEntry): string {
  return (
    stringField(entry.category) ??
    stringField(entry.file_category) ??
    stringField(entry.media_type) ??
    ''
  ).toLowerCase();
}

function filenameCandidates(entry: MediaEntry): string[] {
  return [
    stringField(entry.name),
    stringField(entry.file_name),
    stringField(entry.name_encrypted),
  ].filter((value): value is string => !!value && !value.startsWith('{'));
}

function mediaMimeType(entry: FileEntry): string | null {
  const mediaEntry = entry as MediaEntry;
  const mime = (entry.mime_type ?? mediaEntry.mime ?? '').toLowerCase();
  if (mime.startsWith('image/')) return entry.mime_type ?? mediaEntry.mime ?? 'image/jpeg';
  if (mime.startsWith('video/')) return entry.mime_type ?? mediaEntry.mime ?? 'video/mp4';

  const category = mediaCategory(mediaEntry);
  if (category === 'image' || category === 'photo') return 'image/jpeg';
  if (category === 'video') return 'video/mp4';

  for (const name of filenameCandidates(mediaEntry)) {
    const guessed = guessMimeType(name);
    if (guessed?.startsWith('image/')) return guessed;
    if (guessed?.startsWith('video/')) return guessed;
  }

  return entry.is_media ? 'image/jpeg' : null;
}

function isMediaFile(entry: FileEntry): boolean {
  return mediaMimeType(entry) !== null;
}

function isEncryptedThumbnailCandidate(entry: FileEntry): boolean {
  return !!entry.has_thumbnail && typeof entry.name_encrypted === 'string' && entry.name_encrypted.startsWith('{');
}

function isVisibleMediaFile(entry: FileEntry, decryptedMimeTypes: Record<string, string>): boolean {
  const decryptedMime = decryptedMimeTypes[entry.id]?.toLowerCase();
  if (decryptedMime) return decryptedMime.startsWith('image/') || decryptedMime.startsWith('video/');
  return isMediaFile(entry) || isEncryptedThumbnailCandidate(entry);
}

function photoCandidatesFromIndex(files: FileEntry[]): FileEntry[] {
  return files.filter((entry) => (
    !entry.is_folder &&
    !entry.is_uploading &&
    (isMediaFile(entry) || isEncryptedThumbnailCandidate(entry))
  ));
}

/**
 * Parse the decrypted metadata plaintext. The server may store the filename as
 * a bare string (legacy) or as `{"name":"...", "mime_type":"..."}` (current).
 */
interface DecryptedPhotoMetadata {
  name: string;
  mimeType?: string;
}

function parseDecryptedPhotoMetadata(plaintext: string): DecryptedPhotoMetadata {
  try {
    const metadata = JSON.parse(plaintext) as { mime_type?: unknown; name?: unknown };
    if (metadata && typeof metadata === 'object' && typeof metadata.name === 'string') {
      const name = metadata.name.trim();
      const mimeType = typeof metadata.mime_type === 'string' ? metadata.mime_type.trim() : '';
      if (name) return { name, mimeType: mimeType || guessMimeType(name) || undefined };
    }
  } catch {
    // Legacy format: plaintext is the bare filename.
  }
  const name = plaintext || 'Photo';
  return { name, mimeType: guessMimeType(name) || undefined };
}

function preparePhotoEntries(entries: FileEntry[]): FileEntry[] {
  return entries
    .filter((entry) => !entry.is_folder && !entry.is_uploading)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

async function getPhotoCandidates(
  cachedIndex?: CachedFileIndex | null,
  excludedFolderIds?: Set<string>,
): Promise<FileEntry[]> {
  const excluded = excludedFolderIds ?? new Set<string>();
  try {
    const existingIndex = cachedIndex ?? await loadCachedFileIndex();
    const index = await getFileIndex(existingIndex?.hash);
    if (!index.changed && existingIndex) {
      // Pass the FULL index (folder rows included) so exclusion is transitive.
      return filterByExcludedFolders(
        existingIndex.files,
        photoCandidatesFromIndex(existingIndex.files),
        excluded,
      );
    }
    if (index.files) {
      await saveCachedFileIndex(index.hash, index.files);
      return filterByExcludedFolders(
        index.files,
        photoCandidatesFromIndex(index.files),
        excluded,
      );
    }
  } catch (err) {
    // Older API builds do not have /files/index yet. Because /files/{id}
    // also exists, those builds may treat "index" as a UUID and return 400
    // instead of 404. Fall back to the media endpoint in all unsupported-route
    // cases, but keep auth/network/server errors visible.
    if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 404 && err.status !== 405)) {
      throw err;
    }
  }

  // Legacy /files/media path has no folder tree — degrade to direct-parent
  // exclusion (transitive exclusion only matters on the index path above).
  return filterByExcludedFoldersDirect(await getAllImages(), excluded);
}

/**
 * Deterministic warm swatch — used as a load-time placeholder behind each
 * thumbnail so the grid never shows blank cells while images are streaming in.
 */
function swatch(seed: number): string {
  // Neutral warm-tone palette: low-saturation, no green or olive. Once
  // PhotoKit short-circuit (task 0552) is active for camera-roll-backed
  // photos, this placeholder flashes only briefly for non-PhotoKit files.
  const colors = ['#e8e2d5', '#d9d2c3', '#dcd5c5', '#d4ccba', '#e1dac9', '#d0c8b6', '#e5dfd0', '#d8d1c0'];
  return colors[seed % colors.length] ?? '#e8e2d5';
}

interface PhotoGroup {
  /** "September 2025" */
  label: string;
  /** Sortable key like "2025-09" */
  key: string;
  data: FileEntry[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function groupByMonth(photos: FileEntry[]): PhotoGroup[] {
  const map = new Map<string, PhotoGroup>();
  for (const photo of photos) {
    const date = parseCreatedAt(photo.created_at) ?? new Date();
    const year = date.getFullYear();
    const month = date.getMonth();
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[month]} ${year}`;
    let group = map.get(key);
    if (!group) {
      group = { label, key, data: [] };
      map.set(key, group);
    }
    group.data.push(photo);
  }
  // Sort groups newest first
  return Array.from(map.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
}

function parseCreatedAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const seconds = numeric > 10_000_000_000 ? numeric / 1000 : numeric;
    return new Date(seconds * 1000);
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeCreatedAt(value: string | null | undefined): string | null {
  const date = parseCreatedAt(value);
  return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Grid dimensions — pinch-to-zoom changes column count (2/4/7/12)
// ---------------------------------------------------------------------------

const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_GAP = 2;
const DEFAULT_COLS = DEFAULT_PHOTO_GRID_COLUMNS;
const SECTION_HEADER_HEIGHT = 28;
/**
 * 1322 — vertical space the floating tab bar occupies above the safe area
 * (capsule height plus the canvas's 22pt bottom offset and the bar's own
 * padding). Added to the grid's bottom inset so the last row can be scrolled
 * clear of the capsule instead of sitting under it.
 */
const TAB_BAR_RESERVED = 96;

const LIST_FOOTER_HEIGHT = 12;
const PHOTO_PREVIEW_WINDOW_RADIUS = 12;
const METADATA_DECRYPT_BATCH_SIZE = 8;
const INITIAL_METADATA_PREFETCH_LIMIT = 40;
const THUMBNAIL_PRELOAD_BEFORE = 24;
const THUMBNAIL_PRELOAD_AFTER = 40;

function cellSizeForCols(cols: number): number {
  return (SCREEN_WIDTH - GRID_GAP * (cols - 1)) / cols;
}

const ACTIVE_THUMBNAIL_LIMIT = 72;
const THUMBNAIL_PREFETCH_DEBOUNCE_MS = 100;

function mergeUriMap(
  prev: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  let changed = false;
  for (const [id, uri] of Object.entries(next)) {
    if (prev[id] !== uri) {
      changed = true;
      break;
    }
  }
  return changed ? { ...prev, ...next } : prev;
}

interface PhotoHeaderItem {
  type: 'header';
  key: string;
  label: string;
  count: number;
  offset: number;
  length: number;
}

interface PhotoRowItem {
  type: 'row';
  key: string;
  photos: FileEntry[];
  seedOffset: number;
  offset: number;
  length: number;
}

type PhotoListItem = PhotoHeaderItem | PhotoRowItem;

function buildPhotoListItems(groups: PhotoGroup[], columns: number, cellSize: number): PhotoListItem[] {
  const items: PhotoListItem[] = [];
  let offset = 0;
  let seedOffset = 0;
  const rowLength = cellSize + GRID_GAP;

  for (const group of groups) {
    items.push({
      type: 'header',
      key: `header-${group.key}`,
      label: group.label,
      count: group.data.length,
      offset,
      length: SECTION_HEADER_HEIGHT,
    });
    offset += SECTION_HEADER_HEIGHT;

    for (let i = 0; i < group.data.length; i += columns) {
      const photos = group.data.slice(i, i + columns);
      items.push({
        type: 'row',
        key: `row-${group.key}-${i / columns}`,
        photos,
        seedOffset: seedOffset + i,
        offset,
        length: rowLength,
      });
      offset += rowLength;
    }

    seedOffset += group.data.length;
  }

  return items;
}

function collectVisiblePhotoIds(
  items: PhotoListItem[],
  visibleIndexes: number[],
  beforeItems = 3,
  afterItems = 6,
  limit = ACTIVE_THUMBNAIL_LIMIT,
): Set<string> {
  if (items.length === 0) return new Set();
  const indexes = visibleIndexes.length > 0 ? visibleIndexes : [0];
  const min = Math.max(0, Math.min(...indexes) - beforeItems);
  const max = Math.min(items.length - 1, Math.max(...indexes) + afterItems);
  const ids: string[] = [];

  for (let itemIndex = min; itemIndex <= max && ids.length < limit; itemIndex++) {
    const item = items[itemIndex];
    if (!item || item.type !== 'row') continue;
    for (const photo of item.photos) {
      ids.push(photo.id);
      if (ids.length >= limit) break;
    }
  }

  return new Set(ids);
}

function collectInitialPhotoIds(items: PhotoListItem[]): Set<string> {
  return collectVisiblePhotoIds(items, [0, 1, 2, 3, 4, 5], 0, 0);
}

function collectBufferedPhotoIds(
  orderedPhotos: FileEntry[],
  visibleIds: Set<string>,
  before = THUMBNAIL_PRELOAD_BEFORE,
  after = THUMBNAIL_PRELOAD_AFTER,
  limit = ACTIVE_THUMBNAIL_LIMIT,
): Set<string> {
  if (orderedPhotos.length === 0 || visibleIds.size === 0) return new Set();

  const visibleIndexes = orderedPhotos
    .map((photo, index) => (visibleIds.has(photo.id) ? index : -1))
    .filter((index) => index >= 0);
  if (visibleIndexes.length === 0) return visibleIds;

  const min = Math.max(0, Math.min(...visibleIndexes) - before);
  const max = Math.min(orderedPhotos.length - 1, Math.max(...visibleIndexes) + after);
  const ids: string[] = [];

  for (const index of visibleIndexes.sort((a, b) => a - b)) {
    const id = orderedPhotos[index]?.id;
    if (id) ids.push(id);
  }

  for (let index = Math.max(...visibleIndexes) + 1; index <= max && ids.length < limit; index++) {
    const id = orderedPhotos[index]?.id;
    if (id) ids.push(id);
  }

  for (let index = Math.min(...visibleIndexes) - 1; index >= min && ids.length < limit; index--) {
    const id = orderedPhotos[index]?.id;
    if (id) ids.push(id);
  }

  return new Set(ids);
}

function collectThumbnailIdsForProfile(
  orderedPhotos: FileEntry[],
  visibleIds: Set<string>,
  columns: number,
  profile: PerformanceStorageProfile,
): Set<string> {
  if (profile === 'light') return new Set(visibleIds);
  const zoomedOut = columns >= 7;
  return collectBufferedPhotoIds(
    orderedPhotos,
    visibleIds,
    zoomedOut ? 12 : THUMBNAIL_PRELOAD_BEFORE,
    zoomedOut ? 18 : THUMBNAIL_PRELOAD_AFTER,
    zoomedOut ? 40 : ACTIVE_THUMBNAIL_LIMIT,
  );
}

function safeDisplayName(entry: FileEntry, decryptedNames: Record<string, string>): string {
  const decrypted = decryptedNames[entry.id];
  if (decrypted) return decrypted;
  const raw = entry.name_encrypted;
  if (typeof raw === 'string' && raw.trim() && !raw.startsWith('{') && raw.length < 200) {
    return raw;
  }
  return 'Photo';
}

function safeZipName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:\0]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function extensionForPhoto(entry: FileEntry, displayName: string, mimeType?: string | null): string {
  const fromName = displayName.split('.').pop();
  if (fromName && fromName.length > 0 && fromName.length <= 6 && fromName !== displayName) {
    return fromName.toLowerCase();
  }
  const mime = (mimeType ?? mediaMimeType(entry) ?? '').toLowerCase();
  if (mime.includes('heic')) return 'heic';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.startsWith('video/')) return 'mp4';
  return 'jpg';
}

function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function firstVisiblePhotoId(items: PhotoListItem[], visibleIndexes: number[]): string | null {
  const ordered = visibleIndexes
    .filter((index) => index >= 0 && index < items.length)
    .sort((a, b) => a - b);

  for (const index of ordered) {
    const item = items[index];
    if (item?.type === 'row' && item.photos[0]) return item.photos[0].id;
  }
  return null;
}

function findPhotoItemIndex(items: PhotoListItem[], photoId: string): number {
  return items.findIndex((item) => item.type === 'row' && item.photos.some((photo) => photo.id === photoId));
}

// ---------------------------------------------------------------------------
// Photo cell
// ---------------------------------------------------------------------------

const PhotoCell = React.memo(function PhotoCell({
  fileId,
  hasThumbnail,
  loadThumbnail,
  seed,
  isFromBackup,
  localAssetUri,
  mimeType,
  blurhash,
  onThumbnailUnavailable,
  onPress,
  accessibilityLabel,
  cellSize,
  columns,
  isVideo,
  isSelected,
  selectMode,
  onLongPress,
}: {
  fileId: string;
  hasThumbnail?: boolean;
  loadThumbnail: boolean;
  seed: number;
  isFromBackup: boolean;
  localAssetUri?: string | null;
  mimeType?: string | null;
  blurhash?: string | null;
  onThumbnailUnavailable: (fileId: string) => void;
  onPress?: () => void;
  accessibilityLabel: string;
  cellSize: number;
  columns: number;
  isVideo: boolean;
  isSelected: boolean;
  selectMode: boolean;
  onLongPress?: () => void;
}) {
  const { colors: c } = useTheme();
  const showOverlay = columns <= 4;
  const videoBadgeSize = columns <= 4 ? 22 : 18;
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      onLongPress={onLongPress}
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

const PhotoRow = React.memo(function PhotoRow({
  photos,
  photosFolderId,
  activeThumbnailIds,
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
}: {
  photos: FileEntry[];
  photosFolderId: string | null;
  activeThumbnailIds: Set<string>;
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
}) {
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
        return (
          <PhotoCell
            key={photo.id}
            fileId={photo.id}
            hasThumbnail={photo.has_thumbnail}
            loadThumbnail={activeThumbnailIds.size === 0 || activeThumbnailIds.has(photo.id)}
            seed={seedOffset + i}
            isFromBackup={photosFolderId !== null && photo.parent_id === photosFolderId}
            localAssetUri={localAssetUri}
            mimeType={mimeType}
            blurhash={photo.blurhash}
            onThumbnailUnavailable={onThumbnailUnavailable}
            accessibilityLabel={decryptedNames[photo.id] ? `${mediaLabel}: ${decryptedNames[photo.id]}` : mediaLabel}
            onPress={() => (selectMode ? onTogglePhoto(photo) : onOpenPhoto(photo))}
            onLongPress={() => onLongPressPhoto(photo)}
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

// ---------------------------------------------------------------------------
// Device photos banner — shows local-library count when backup is enabled
// ---------------------------------------------------------------------------

function DevicePhotosBanner() {
  const { isPhotoBackupEnabled, backupProgress, includeVideos } = useBackup();
  const { colors: c } = useTheme();
  const [deviceCounts, setDeviceCounts] = useState<{ photos: number; videos: number } | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  useEffect(() => {
    if (!isPhotoBackupEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status !== 'granted') {
          if (!cancelled) setPermissionDenied(true);
          return;
        }
        const [photoAssets, videoAssets] = await Promise.all([
          MediaLibrary.getAssetsAsync({
            mediaType: MediaLibrary.MediaType.photo,
            first: 0,
          }),
          includeVideos
            ? MediaLibrary.getAssetsAsync({
              mediaType: MediaLibrary.MediaType.video,
              first: 0,
            })
            : Promise.resolve({ totalCount: 0 }),
        ]);
        if (!cancelled) {
          setDeviceCounts({
            photos: photoAssets.totalCount,
            videos: videoAssets.totalCount,
          });
        }
      } catch {
        // Media library unavailable (e.g. simulator without photos, web)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [includeVideos, isPhotoBackupEnabled]);

  if (!isPhotoBackupEnabled) return null;
  if (permissionDenied) {
    return (
      <View style={[styles.deviceBanner, { backgroundColor: c.paper2, borderColor: c.line }]}>
        <Ionicons name="lock-closed-outline" size={14} color={c.ink3} />
        <Text style={[styles.deviceBannerText, { color: c.ink2 }]}>Photo access denied</Text>
        <Text style={[styles.deviceBannerHint, { color: c.ink3 }]}>Enable in iOS Settings</Text>
      </View>
    );
  }
  if (deviceCounts === null) return null;

  const mediaCountText = includeVideos
    ? [
      `${deviceCounts.photos.toLocaleString()} ${deviceCounts.photos === 1 ? 'photo' : 'photos'}`,
      `${deviceCounts.videos.toLocaleString()} ${deviceCounts.videos === 1 ? 'video' : 'videos'}`,
    ].join(', ')
    : `${deviceCounts.photos.toLocaleString()} ${deviceCounts.photos === 1 ? 'photo' : 'photos'}`;

  return (
    <View style={[styles.deviceBanner, { backgroundColor: c.paper2, borderColor: c.line }]}>
      <Ionicons name="phone-portrait-outline" size={14} color={c.ink3} />
      <Text style={[styles.deviceBannerText, { color: c.ink2 }]}>
        {mediaCountText} on device
      </Text>
      <Text style={[styles.deviceBannerHint, { color: c.ink3 }]}>
        {backupProgress.completed.toLocaleString()} backed up
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Auto-backup banner — shows real backup progress from BackupContext
// ---------------------------------------------------------------------------

function AutoBackupBanner() {
  const { isPhotoBackupEnabled, backupProgress, lastBackupAt, includeVideos } = useBackup();
  const isConnected = useNetworkStatus();
  const { colors: c } = useTheme();
  const navigation = useNavigation<{ navigate: (name: string) => void }>();

  if (!isPhotoBackupEnabled) {
    return (
      <View style={[styles.banner, { backgroundColor: c.paper2, borderColor: c.line }]}>
        <View style={[styles.bannerDot, { backgroundColor: c.ink4 }]} />
        <Text style={[styles.bannerText, { color: c.ink2 }]}>Auto-backup off</Text>
        <TouchableOpacity
          activeOpacity={0.6}
          onPress={() => {
            Haptics.selectionAsync();
            navigation.navigate('Settings');
          }}
          accessibilityRole="link"
          accessibilityLabel="Enable auto-backup in Settings"
        >
          <Text style={[styles.bannerHint, { color: c.amberDeep, textDecorationLine: 'underline' }]}>
            Enable in Settings
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!isConnected) {
    return (
      <View style={[styles.banner, { backgroundColor: c.paper2, borderColor: c.line }]}>
        <View style={[styles.bannerDot, { backgroundColor: c.ink4 }]} />
        <Text style={[styles.bannerText, { color: c.ink2 }]}>Backup paused</Text>
        <Text style={[styles.bannerHint, { color: c.ink3 }]}>No connection</Text>
      </View>
    );
  }

  if (backupProgress.inProgress > 0) {
    const itemLabel = includeVideos ? 'items' : 'photos';
    const ratio = backupProgress.total > 0
      ? Math.min(1, Math.max(0, backupProgress.completed / backupProgress.total))
      : 0;
    return (
      <View style={[styles.banner, styles.bannerActive, styles.bannerWithProgress, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
        <View style={styles.bannerHeaderRow}>
          <ActivityIndicator size="small" color={c.green} style={{ marginRight: 2 }} />
          <Text style={[styles.bannerText, { color: c.ink }]}>
            {backupProgress.completed} of {backupProgress.total} {itemLabel} backed up
          </Text>
          <Text style={[styles.bannerHint, { color: c.ink2 }]}>{Math.round(ratio * 100)}%</Text>
        </View>
        <View style={[styles.progressTrack, { backgroundColor: c.line }]}>
          <View style={[styles.progressFill, { width: `${ratio * 100}%`, backgroundColor: c.amber }]} />
        </View>
      </View>
    );
  }

  const allDone = backupProgress.total > 0 && backupProgress.completed === backupProgress.total;
  return (
    <View style={[styles.banner, styles.bannerActive, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
      <View style={[styles.bannerDot, styles.bannerDotActive, { backgroundColor: c.green }]} />
      <Text style={[styles.bannerText, { color: c.ink }]}>
        {allDone ? `All ${includeVideos ? 'items' : 'photos'} backed up` : 'Auto-backup on'}
      </Text>
      {lastBackupAt && (
        <Text style={[styles.bannerHint, { color: c.ink3 }]}>
          {new Date(lastBackupAt).toLocaleDateString()}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PhotosScreen() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { getFileKeyBytes, getMasterKeyHandleId, isUnlocked, decryptMetadata } = useCrypto();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [isScrolled, setIsScrolled] = useState(false);
  // 1322 — the floating header's measured height. Fed to the native grid as a
  // real contentInset so the grid scrolls UNDER the chrome instead of starting
  // below it. Not constant: the device-photos banner appears and disappears.
  const [headerHeight, setHeaderHeight] = useState(0);
  const [photos, setPhotos] = useState<FileEntry[]>([]);
  const photosCacheRef = useRef<FileEntry[]>([]);
  const photosCountRef = useRef(0);
  const [photosFolderId, setPhotosFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState(DEFAULT_COLS);
  const [isPinching, setIsPinching] = useState(false);
  const cellSize = useMemo(() => cellSizeForCols(columns), [columns]);
  // Column indicator — fades out after a pinch gesture changes the grid density
  const columnIndicatorOpacity = useRef(new Animated.Value(0)).current;
  const columnIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Task 0560 — opacity driver for the cross-fade applied when the pinch
  // gesture ends and the column count actually changes. Animating opacity
  // (rather than letting the FlatList re-layout in place) hides the brief
  // moment where every cell jumps to a new slot, so the user sees a
  // photos-app-style cross-fade rather than tiles flying across the grid.
  const gridOpacity = useRef(new Animated.Value(1)).current;
  const [activeThumbnailIds, setActiveThumbnailIds] = useState<Set<string>>(() => new Set());
  const [activePhotoIds, setActivePhotoIds] = useState<Set<string>>(() => new Set());
  const [localAssetMap, setLocalAssetMap] = useState<Map<string, string>>(new Map());
  const [localIdentifierVersion, setLocalIdentifierVersion] = useState(0);
  const [localCreatedAtMap, setLocalCreatedAtMap] = useState<Record<string, string>>({});
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  const [decryptedMimeTypes, setDecryptedMimeTypes] = useState<Record<string, string>>({});
  const [thumbnailUris, setThumbnailUris] = useState<Record<string, string>>({});
  const [thumbnailRetryTick, setThumbnailRetryTick] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<'delete' | 'share' | null>(null);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const decryptedNamesRef = useRef<Record<string, string>>({});
  const decryptedMimeTypesRef = useRef<Record<string, string>>({});
  const listRef = useRef<FlatList<PhotoListItem>>(null);
  const listItemsRef = useRef<PhotoListItem[]>([]);
  const visibleIndexesRef = useRef<number[]>([0]);
  const columnsRef = useRef(DEFAULT_COLS);
  const isScrolledRef = useRef(false);
  const isPinchingRef = useRef(false);
  const pinchStartColumnsRef = useRef(DEFAULT_COLS);
  // Task 0559 — momentum-friendly viewport tracking. While the user is
  // touch-dragging or the list is decelerating, we stash the latest visible
  // indexes in a ref instead of pushing them through setState. Setting
  // activeThumbnailIds mid-flick re-renders the grid AND fires the
  // prefetch-debounce effect, both of which steal time from the scroll
  // thread and make the deceleration hard-stop instead of glide. The
  // pending indexes are flushed on scrollEndDrag-without-momentum and on
  // momentumScrollEnd.
  const isScrollingRef = useRef(false);
  const inMomentumRef = useRef(false);
  const pendingViewportIndexesRef = useRef<number[] | null>(null);
  const pendingAnchorPhotoIdRef = useRef<string | null>(null);
  const thumbnailSeedSignatureRef = useRef<string | null>(null);
  const thumbnailRepairAttemptsRef = useRef<Map<string, number>>(new Map());
  const localThumbnailAttemptsRef = useRef<Set<string>>(new Set());
  const thumbnailRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const photosById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);
  const activeThumbnailIdsRef = useRef<Set<string>>(new Set());
  const isPhotosFocusedRef = useRef(false);
  const [isPhotosFocused, setIsPhotosFocused] = useState(false);
  const [performanceStorageProfile, setPerformanceStorageProfile] = useState<PerformanceStorageProfile>(
    DEFAULT_PERFORMANCE_STORAGE_SETTINGS.profile,
  );
  const performanceStorageProfileRef = useRef<PerformanceStorageProfile>(
    DEFAULT_PERFORMANCE_STORAGE_SETTINGS.profile,
  );
  const flatPhotosRef = useRef<FileEntry[]>([]);

  useEffect(() => {
    columnsRef.current = columns;
  }, [columns]);

  useEffect(() => {
    performanceStorageProfileRef.current = performanceStorageProfile;
  }, [performanceStorageProfile]);

  useEffect(() => () => {
    if (columnIndicatorTimer.current) clearTimeout(columnIndicatorTimer.current);
    if (thumbnailRetryTimerRef.current) clearTimeout(thumbnailRetryTimerRef.current);
  }, []);

  useEffect(() => {
    decryptedNamesRef.current = decryptedNames;
  }, [decryptedNames]);

  useEffect(() => {
    activeThumbnailIdsRef.current = activeThumbnailIds;
  }, [activeThumbnailIds]);

  useEffect(() => {
    decryptedMimeTypesRef.current = decryptedMimeTypes;
  }, [decryptedMimeTypes]);

  // Decrypt filenames for the active viewport only. Large accounts can contain
  // thousands of photos, so metadata work must follow the user's scroll window.
  useEffect(() => {
    if (!isUnlocked) {
      setDecryptedNames({});
      setDecryptedMimeTypes({});
      decryptedNamesRef.current = {};
      decryptedMimeTypesRef.current = {};
      return;
    }
    const candidateIds = activePhotoIds.size > 0
      ? activePhotoIds
      : new Set(photos.slice(0, INITIAL_METADATA_PREFETCH_LIMIT).map((photo) => photo.id));
    const candidates = Array.from(candidateIds)
      .map((id) => photosById.get(id))
      .filter((photo): photo is FileEntry => !!photo)
      .filter((photo) => (
      !decryptedNamesRef.current[photo.id] &&
      !decryptedMimeTypesRef.current[photo.id]
    ));
    if (candidates.length === 0) return;

    const nameResults: Record<string, string> = {};
    const mimeResults: Record<string, string> = {};
    let cancelled = false;
    void mapInBatches(
      candidates,
      METADATA_DECRYPT_BATCH_SIZE,
      async (photo) => {
        if (cancelled) return;
        try {
          const raw = photo.name_encrypted ?? '';
          if (!raw.startsWith('{')) {
            // Not JSON-encrypted — use the raw value if it looks like a filename
            if (raw && raw.length < 200) {
              nameResults[photo.id] = raw;
              const mimeType = guessMimeType(raw);
              if (mimeType) mimeResults[photo.id] = mimeType;
            }
            return;
          }
          const payload = encryptedMetadataPayloadToBytes(raw);
          if (!payload) return;
          const plaintext = await decryptMetadata(photo.id, payload.nonce, payload.ciphertext);
          const metadata = parseDecryptedPhotoMetadata(plaintext);
          nameResults[photo.id] = metadata.name;
          if (metadata.mimeType) mimeResults[photo.id] = metadata.mimeType;
        } catch {
          // Decryption failure — leave unset
        }
      },
    ).then(() => {
      if (!cancelled) {
        if (Object.keys(nameResults).length > 0) {
          setDecryptedNames((prev) => ({ ...prev, ...nameResults }));
        }
        if (Object.keys(mimeResults).length > 0) {
          setDecryptedMimeTypes((prev) => ({ ...prev, ...mimeResults }));
        }
      }
    });
    return () => { cancelled = true; };
  }, [activePhotoIds, photos, photosById, isUnlocked, decryptMetadata]);

  const fetchPhotos = useCallback(async (isRefresh = false) => {
    const hasVisiblePhotos = photosCountRef.current > 0;
    recordRuntimeTrace('photos.fetch.request', {
      refresh: isRefresh,
      hasVisiblePhotos,
    });
    if (isRefresh || hasVisiblePhotos) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    const endPerf = perfMark.start('photos.fetch', { refresh: isRefresh });
    let renderedCachedIndex = false;

    try {
      // Per-device folder-inclusion preference (task 0885). Read fresh on every
      // fetch so a toggle in PhotoLibrarySettings takes effect on next focus.
      const excludedFolderIds = new Set(await getExcludedPhotoFolderIds());
      const cachedIndex = await loadCachedFileIndex();
      if (!isRefresh && !hasVisiblePhotos && cachedIndex) {
        const cachedImages = preparePhotoEntries(
          filterByExcludedFolders(
            cachedIndex.files,
            photoCandidatesFromIndex(cachedIndex.files),
            excludedFolderIds,
          ),
        );
        if (cachedImages.length > 0) {
          renderedCachedIndex = true;
          photosCacheRef.current = cachedImages;
          setPhotos(cachedImages);
          setLoading(false);
          setRefreshing(true);
          recordRuntimeTrace('photos.fetch.cached_index_rendered', {
            count: cachedImages.length,
          });
        }
      }

      const allImages = await getPhotoCandidates(cachedIndex, excludedFolderIds);
      setPhotosFolderId(null);
      // Server usually returns image/media rows sorted newest first, but defend
      // against future changes by re-applying both invariants here.
      const images = preparePhotoEntries(allImages);
      const shouldPruneLocalMediaCache = images.length > 0 || photosCacheRef.current.length === 0;
      const remotePhotoIds = new Set(images.map((entry) => entry.id));
      if (images.length > 0) {
        photosCacheRef.current = images;
        setPhotos(images);
      } else if (!isRefresh && photosCacheRef.current.length > 0) {
        setPhotos(photosCacheRef.current);
      } else {
        photosCacheRef.current = [];
        setPhotos([]);
      }
      endPerf({ count: images.length });
      void pruneThumbnailCache();
      if (shouldPruneLocalMediaCache) {
        setThumbnailUris((prev) => {
          let changed = false;
          const next: Record<string, string> = {};
          for (const [fileId, uri] of Object.entries(prev)) {
            if (remotePhotoIds.has(fileId)) {
              next[fileId] = uri;
            } else {
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        void pruneThumbnailsForRemoteFiles(remotePhotoIds);
        void prunePhotoCacheForRemoteFiles(remotePhotoIds);
      }
      recordRuntimeTrace('photos.fetch.success', {
        count: images.length,
        renderedCachedIndex,
        prunedLocalMediaCache: shouldPruneLocalMediaCache,
      });

      // Build local repair maps for camera roll thumbnails and original capture dates.
      // Older native builds sent upload time as created_at; the local backup DB keeps
      // the PHAsset date after the native repair pass, so prefer it for display.
      void Promise.all([getRemoteToLocalMap(), getRemoteCreatedAtMap()])
        .then(([assetMap, createdMap]) => {
          const createdAt: Record<string, string> = {};
          for (const [fileId, value] of createdMap) {
            const normalized = normalizeCreatedAt(value);
            if (normalized) createdAt[fileId] = normalized;
          }
          setLocalAssetMap(assetMap);
          setLocalCreatedAtMap(createdAt);
        })
        .catch(() => {});
    } catch (err) {
      endPerf({ error: true });
      recordRuntimeTrace('photos.fetch.failed', {
        renderedCachedIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!renderedCachedIndex) {
        setError(friendlyError(err));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      isPhotosFocusedRef.current = true;
      setIsPhotosFocused(true);
      recordRuntimeTrace('photos.screen.focus');
      void getPerformanceStorageSettings()
        .then((settings) => {
          if (cancelled) return;
          setPerformanceStorageProfile(settings.profile);
          recordRuntimeTrace('photos.performance_storage_profile.loaded', { profile: settings.profile });
        })
        .catch(() => {});
      fetchPhotos();
      return () => {
        cancelled = true;
        isPhotosFocusedRef.current = false;
        setIsPhotosFocused(false);
        recordRuntimeTrace('photos.screen.blur');
      };
    }, [fetchPhotos])
  );

  // Task 0552: hydrate the server-side PhotoKit identifier map once the
  // vault is unlocked. The map persists to disk so subsequent app launches
  // resolve PhotoKit-backed thumbnails synchronously from cache while the
  // network refresh happens in the background.
  useEffect(() => {
    if (!isUnlocked) return;
    let cancelled = false;
    void (async () => {
      recordRuntimeTrace('photos.local_identifier_map.init_request');
      await initLocalIdentifierMap();
      if (cancelled) return;
      setLocalIdentifierVersion((value) => value + 1);
      await refreshLocalIdentifierMap();
      if (cancelled) return;
      setLocalIdentifierVersion((value) => value + 1);
      recordRuntimeTrace('photos.local_identifier_map.ready', {
        identifiers: getLocalIdentifierMapSize(),
      });
      console.info('[PhotosScreen] PhotoKit identifier map ready', {
        identifiers: getLocalIdentifierMapSize(),
      });
    })().catch((err: unknown) =>
      {
        recordRuntimeTrace('photos.local_identifier_map.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        console.warn('[PhotosScreen] initLocalIdentifierMap failed', err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isUnlocked]);

  const handleRefresh = useCallback(() => {
    recordRuntimeTrace('photos.refresh.request');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchPhotos(true);
  }, [fetchPhotos]);

  const handleThumbnailUnavailable = useCallback((fileId: string) => {
    recordRuntimeTrace('photos.thumbnail.unavailable', { fileId });
    setPhotos((prev) => prev.map((item) => (
      item.id === fileId && item.has_thumbnail ? { ...item, has_thumbnail: false } : item
    )));
  }, []);

  const visiblePhotos = useMemo(
    () => photos
      .filter((photo) => isVisibleMediaFile(photo, decryptedMimeTypes))
      .map((photo) => {
        const createdAt = localCreatedAtMap[photo.id];
        return createdAt && createdAt !== photo.created_at ? { ...photo, created_at: createdAt } : photo;
      })
      .sort((a, b) => (parseCreatedAt(b.created_at)?.getTime() ?? 0) - (parseCreatedAt(a.created_at)?.getTime() ?? 0)),
    [decryptedMimeTypes, localCreatedAtMap, photos],
  );

  const photoKitAssetMap = useMemo(() => {
    let merged: Map<string, string> | null = null;
    for (const photo of visiblePhotos) {
      if (localAssetMap.has(photo.id)) continue;
      const local = getLocalIdentifier(photo.id);
      if (!local) continue;
      if (!merged) merged = new Map(localAssetMap);
      merged.set(photo.id, local);
    }
    return merged ?? localAssetMap;
  }, [localAssetMap, localIdentifierVersion, visiblePhotos]);

  const photoKitServerIdentifierCount = useMemo(
    () => visiblePhotos.reduce((count, photo) => (
      !localAssetMap.has(photo.id) && getLocalIdentifier(photo.id) ? count + 1 : count
    ), 0),
    [localAssetMap, localIdentifierVersion, visiblePhotos],
  );

  useEffect(() => {
    if (photoKitServerIdentifierCount === 0) return;
    console.info('[PhotosScreen] PhotoKit server identifiers applied', {
      visible: photoKitServerIdentifierCount,
    });
  }, [photoKitServerIdentifierCount]);

  const groups = useMemo(() => groupByMonth(visiblePhotos), [visiblePhotos]);

  // Build a flat list of all photos in display order (newest first, grouped by month)
  const flatPhotos = useMemo(() => groups.flatMap((g) => g.data), [groups]);
  const listItems = useMemo(() => buildPhotoListItems(groups, columns, cellSize), [cellSize, columns, groups]);
  const initialThumbnailIds = useMemo(() => collectInitialPhotoIds(listItems), [listItems]);

  useEffect(() => {
    flatPhotosRef.current = flatPhotos;
  }, [flatPhotos]);

  useEffect(() => {
    const firstId = flatPhotos[0]?.id;
    if (!firstId) return;
    const signature = `${firstId}:${flatPhotos.length}:${columns}:${performanceStorageProfile}`;
    if (thumbnailSeedSignatureRef.current === signature) return;
    thumbnailSeedSignatureRef.current = signature;
    const visibleIds = initialThumbnailIds.size > 0
      ? initialThumbnailIds
      : new Set(flatPhotos.slice(0, columnsRef.current >= 7 ? 40 : 24).map((photo) => photo.id));
    const thumbnailIds = collectThumbnailIdsForProfile(
      flatPhotos,
      visibleIds,
      columnsRef.current,
      performanceStorageProfile,
    );
    setActiveThumbnailIds((prev) => (sameIdSet(prev, thumbnailIds) ? prev : thumbnailIds));
    setActivePhotoIds((prev) => (prev.size === 0 ? visibleIds : prev));
  }, [columns, flatPhotos, initialThumbnailIds, performanceStorageProfile]);

  const nativePhotoItems = useMemo<NativePhotoGridItem[]>(() => {
    const items: NativePhotoGridItem[] = [];
    let seed = 0;
    for (const group of groups) {
      for (const photo of group.data) {
        const mimeType = decryptedMimeTypes[photo.id] ?? mediaMimeType(photo);
        items.push({
          id: photo.id,
          displayName: decryptedNames[photo.id] ?? null,
          mimeType,
          monthKey: group.key,
          monthLabel: group.label,
          thumbnailUri: thumbnailUris[photo.id] ?? null,
          localAssetId: photoKitAssetMap.get(photo.id) ?? null,
          placeholderColor: swatch(seed),
          isVideo: !!mimeType?.startsWith('video/'),
          isFromBackup: photosFolderId !== null && photo.parent_id === photosFolderId,
        });
        seed += 1;
      }
    }
    return items;
  }, [decryptedMimeTypes, decryptedNames, groups, photoKitAssetMap, photosFolderId, thumbnailUris]);
  const selectedPhotos = useMemo(
    () => flatPhotos.filter((photo) => selectedIds.has(photo.id)),
    [flatPhotos, selectedIds],
  );

  useEffect(() => {
    if (!selectMode || selectedIds.size === 0) return;
    const visibleIds = new Set(flatPhotos.map((photo) => photo.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => visibleIds.has(id)));
      if (next.size === 0) {
        setSelectMode(false);
        setBulkStatus(null);
      }
      return sameIdSet(prev, next) ? prev : next;
    });
  }, [flatPhotos, selectMode, selectedIds.size]);

  const openPhoto = useCallback(
    (entry: FileEntry) => {
      Haptics.selectionAsync();
      const index = flatPhotos.findIndex((p) => p.id === entry.id);
      const selectedIndex = index >= 0 ? index : 0;
      const windowStart = Math.max(0, selectedIndex - PHOTO_PREVIEW_WINDOW_RADIUS);
      const windowEnd = Math.min(flatPhotos.length, selectedIndex + PHOTO_PREVIEW_WINDOW_RADIUS + 1);
      const previewPhotos = flatPhotos.slice(windowStart, windowEnd);
      const initialPhotoIndex = Math.max(0, selectedIndex - windowStart);
      // Serialize a bounded media window for swipe navigation — only the fields PreviewScreen needs.
      const photoListJson = JSON.stringify(
        previewPhotos.map((p) => ({
          id: p.id,
          name_encrypted: p.name_encrypted,
          display_name: safeDisplayName(p, decryptedNames),
          mime_type: decryptedMimeTypes[p.id] ?? mediaMimeType(p) ?? p.mime_type,
          size_bytes: p.size_bytes,
          created_at: p.created_at,
          chunk_count: p.chunk_count,
          version_number: p.version_number,
          storage_pool_id: p.storage_pool_id ?? null,
          thumbnail_uri: thumbnailUris[p.id] ?? null,
          local_asset_id: photoKitAssetMap.get(p.id) ?? null,
        })),
      );
      navigation.navigate('Preview', {
        fileId: entry.id,
        fileName: safeDisplayName(entry, decryptedNames),
        mimeType: decryptedMimeTypes[entry.id] ?? mediaMimeType(entry) ?? undefined,
        sizeBytes: entry.size_bytes ?? undefined,
        createdAt: entry.created_at,
        chunkCount: entry.chunk_count,
        versionNumber: entry.version_number,
        storagePoolId: entry.storage_pool_id ?? null,
        photoListJson,
        initialPhotoIndex,
        performanceStorageProfile,
        // 0883 — let Preview auto self-repair a missing thumbnail for this owner
        // photo/video from the downloaded plaintext (undefined ⇒ skip).
        hasThumbnail: entry.has_thumbnail,
      });
    },
    [navigation, decryptedMimeTypes, decryptedNames, flatPhotos, performanceStorageProfile, photoKitAssetMap, thumbnailUris],
  );

  const clearSelection = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkStatus(null);
  }, []);

  const toggleSelectedPhoto = useCallback((entry: FileEntry) => {
    Haptics.selectionAsync();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entry.id)) {
        next.delete(entry.id);
      } else {
        next.add(entry.id);
      }
      if (next.size === 0) {
        setSelectMode(false);
        setBulkStatus(null);
      }
      return next;
    });
  }, []);

  const enterSelectionMode = useCallback((entry: FileEntry) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectMode(true);
    setBulkStatus(null);
    setSelectedIds(new Set([entry.id]));
  }, []);

  const deleteSelectedPhotos = useCallback(async () => {
    if (selectedPhotos.length === 0 || bulkAction) return;
    Alert.alert(
      'Delete from Beebeeb?',
      `Delete ${selectedPhotos.length} selected ${selectedPhotos.length === 1 ? 'photo' : 'photos'} from your Beebeeb vault? This will not delete anything from iPhone Photos.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBulkAction('delete');
            setBulkStatus('Deleting from Beebeeb...');
            try {
              const selectedIds = selectedPhotos.map((photo) => photo.id);
              const result = await trashFiles(selectedIds);
              const deletedIds = new Set([...result.trashed, ...result.already_trashed]);
              await Promise.all(selectedPhotos.map(async (photo) => {
                if (!deletedIds.has(photo.id)) return;
                const localAssetId = localAssetMap.get(photo.id);
                if (localAssetId) await markRemoteDeleted(localAssetId);
              }));

              setPhotos((prev) => prev.filter((photo) => !deletedIds.has(photo.id)));
              photosCacheRef.current = photosCacheRef.current.filter((photo) => !deletedIds.has(photo.id));
              setLocalAssetMap((prev) => {
                const next = new Map(prev);
                for (const photoId of deletedIds) next.delete(photoId);
                return next;
              });
              if (deletedIds.size > 0) {
                const retainedIds = new Set(photosCacheRef.current.map((photo) => photo.id));
                void pruneThumbnailsForRemoteFiles(retainedIds);
                void prunePhotoCacheForRemoteFiles(retainedIds);
                void onFilesDeleted(Array.from(deletedIds));
                void removeFromFileProviderCache(Array.from(deletedIds));
              }
              clearSelection();
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              if (result.missing.length > 0 || deletedIds.size < selectedIds.length) {
                Alert.alert(
                  'Some photos were not moved',
                  'Beebeeb refreshed the photo list because a few selected items were already gone or unavailable.',
                );
                void fetchPhotos();
              }
            } catch (err) {
              Alert.alert('Delete failed', friendlyError(err));
              setBulkStatus(null);
            } finally {
              setBulkAction(null);
            }
          },
        },
      ],
    );
  }, [bulkAction, clearSelection, fetchPhotos, localAssetMap, selectedPhotos]);

  const shareSelectedPhotos = useCallback(async () => {
    if (selectedPhotos.length === 0 || bulkAction) return;
    if (!isUnlocked) {
      Alert.alert('Unlock required', 'Unlock your vault before sharing photos.');
      return;
    }
    const selectedSizeBytes = selectedPhotos.reduce((sum, photo) => sum + (photo.size_bytes ?? 0), 0);
    if (selectedPhotos.length > 50 || selectedSizeBytes > 250_000_000) {
      Alert.alert(
        'Too many photos',
        'ZIP sharing currently supports up to 50 photos or 250 MB at once. Select fewer photos for this export.',
      );
      return;
    }
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) {
      Alert.alert('Share failed', 'Temporary storage is unavailable on this device.');
      return;
    }
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      Alert.alert('Share unavailable', 'The iOS share sheet is not available right now.');
      return;
    }

    setBulkAction('share');
    setBulkStatus('Preparing ZIP...');
    try {
      // Lazy-load JSZip the first time the user shares a multi-select bundle.
      // Static import would parse the ~1 MB module on every cold start; this
      // path is rare so deferring to first use is a clean win for TTI.
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const usedNames = new Set<string>();
      for (let index = 0; index < selectedPhotos.length; index += 1) {
        const photo = selectedPhotos[index];
        setBulkStatus(`Preparing ${index + 1} of ${selectedPhotos.length}...`);
        const displayName = safeDisplayName(photo, decryptedNames);
        const mimeType = decryptedMimeTypes[photo.id] ?? mediaMimeType(photo);
        const extension = extensionForPhoto(photo, displayName, mimeType);
        const rawName = displayName.includes('.') ? displayName : `${displayName}.${extension}`;
        let zipName = safeZipName(rawName, `${photo.id}.${extension}`);
        if (usedNames.has(zipName)) {
          const dot = zipName.lastIndexOf('.');
          zipName = dot > 0
            ? `${zipName.slice(0, dot)}-${photo.id.slice(0, 8)}${zipName.slice(dot)}`
            : `${zipName}-${photo.id.slice(0, 8)}`;
        }
        usedNames.add(zipName);

        const decryptedUri = await decryptToTempFile(
          photo.id,
          () => getFileKeyBytes(photo.id),
          extension,
          photo.size_bytes,
          photo.chunk_count,
          getMasterKeyHandleId(),
        );
        const base64 = await FileSystem.readAsStringAsync(decryptedUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        zip.file(zipName, base64, { base64: true, binary: true, compression: 'STORE' });
      }

      setBulkStatus('Opening share sheet...');
      const zipBase64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
      const zipUri = `${cacheDir}beebeeb-photos-${Date.now()}.zip`;
      await FileSystem.writeAsStringAsync(zipUri, zipBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await Sharing.shareAsync(zipUri, {
        mimeType: 'application/zip',
        dialogTitle: 'Share Beebeeb photos',
        UTI: 'com.pkware.zip-archive',
      });
      await FileSystem.deleteAsync(zipUri, { idempotent: true }).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('Share failed', friendlyError(err));
    } finally {
      setBulkAction(null);
      setBulkStatus(null);
    }
  }, [
    bulkAction,
    decryptedMimeTypes,
    decryptedNames,
    getFileKeyBytes,
    getMasterKeyHandleId,
    isUnlocked,
    selectedPhotos,
  ]);

  const handleGridScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number } } }) => {
    const nextIsScrolled = e.nativeEvent.contentOffset.y > 0;
    if (nextIsScrolled === isScrolledRef.current) return;
    isScrolledRef.current = nextIsScrolled;
    setIsScrolled(nextIsScrolled);
  }, []);

  // Task 0559 — flush the deferred viewport once the user lets go AND the
  // scroll thread is finished decelerating. Mid-flick, viewable-item events
  // are stashed in a ref (see handleViewableItemsChanged below); this
  // recomputes the active set in a single pass at the landing position so
  // thumbnails for the new viewport start loading immediately after the
  // grid settles, without thrashing the JS thread during the glide itself.
  const flushPendingViewport = useCallback(() => {
    const indexes = pendingViewportIndexesRef.current;
    pendingViewportIndexesRef.current = null;
    if (indexes && indexes.length > 0) {
      visibleIndexesRef.current = indexes;
    }
    const visibleIds = collectVisiblePhotoIds(listItemsRef.current, visibleIndexesRef.current, 0, 0);
    const thumbnailIds = collectThumbnailIdsForProfile(
      flatPhotos,
      visibleIds,
      columnsRef.current,
      performanceStorageProfile,
    );
    setActiveThumbnailIds((prev) => (sameIdSet(prev, thumbnailIds) ? prev : thumbnailIds));
    setActivePhotoIds((prev) => (sameIdSet(prev, visibleIds) ? prev : visibleIds));
  }, [flatPhotos, performanceStorageProfile]);

  const handleScrollBeginDrag = useCallback(() => {
    isScrollingRef.current = true;
    inMomentumRef.current = false;
  }, []);

  const handleScrollEndDrag = useCallback(() => {
    // Finger lifted. RN fires momentumScrollBegin synchronously between
    // scrollEndDrag and JS receiving control — so if inMomentumRef is
    // still false on the next frame, the list has no momentum and we can
    // flush immediately. Otherwise leave isScrollingRef true and let
    // momentumScrollEnd do the flush at the actual landing position.
    requestAnimationFrame(() => {
      if (inMomentumRef.current) return;
      isScrollingRef.current = false;
      flushPendingViewport();
    });
  }, [flushPendingViewport]);

  const handleMomentumScrollBegin = useCallback(() => {
    isScrollingRef.current = true;
    inMomentumRef.current = true;
  }, []);

  const handleMomentumScrollEnd = useCallback(() => {
    isScrollingRef.current = false;
    inMomentumRef.current = false;
    flushPendingViewport();
  }, [flushPendingViewport]);

  useEffect(() => {
    photosCountRef.current = visiblePhotos.length;
    if (photos.length > 0) photosCacheRef.current = photos;
  }, [photos, visiblePhotos.length]);

  useEffect(() => {
    listItemsRef.current = listItems;
    const visibleIndexes = visibleIndexesRef.current;
    const visibleIds = collectVisiblePhotoIds(listItems, visibleIndexes, 0, 0);
    const thumbnailIds = collectThumbnailIdsForProfile(
      flatPhotos,
      visibleIds,
      columnsRef.current,
      performanceStorageProfile,
    );
    setActiveThumbnailIds((prev) => (sameIdSet(prev, thumbnailIds) ? prev : thumbnailIds));
    setActivePhotoIds((prev) => (sameIdSet(prev, visibleIds) ? prev : visibleIds));
  }, [flatPhotos, listItems, performanceStorageProfile]);

  useEffect(() => {
    if (!isPhotosFocused) return;
    const ids = Array.from(activeThumbnailIds);
    if (ids.length === 0) return;
    const serverThumbnailIds = new Set(photos.filter((photo) => photo.has_thumbnail).map((photo) => photo.id));
    const idsWithServerThumbs = ids.filter((id) => serverThumbnailIds.has(id) && !photoKitAssetMap.has(id));
    if (idsWithServerThumbs.length === 0) return;
    recordRuntimeTrace('photos.thumbnail.prefetch_queued', {
      activeIds: ids.length,
      serverThumbnailIds: idsWithServerThumbs.length,
      photoKitBackedIds: ids.length - idsWithServerThumbs.length,
    });

    let cancelled = false;
    const controller = new AbortController();

    // Trailing-edge debounce: rapid viewport changes during a flick collapse
    // into a single prefetch pass for the final visible set. The previous
    // run's AbortController is also aborted in cleanup, so any in-flight
    // fetches for IDs that left the viewport stop early.
    const debounceTimer = setTimeout(() => {
      void (async () => {
        // Batched cache lookup — keeps the FS stat fan-out modest so a
        // viewport-sized array (~72 items) doesn't spawn that many parallel
        // I/O calls on the JS thread at once.
        const cachedPairs = await mapInBatches(
          idsWithServerThumbs,
          10,
          async (id) => [id, await getCachedThumbnail(id)] as const,
        );
        if (cancelled) return;

        const cachedUris: Record<string, string> = {};
        const toFetch: string[] = [];
        for (const [id, uri] of cachedPairs) {
          if (uri) {
            cachedUris[id] = uri;
          } else {
            toFetch.push(id);
          }
        }
        if (Object.keys(cachedUris).length > 0) {
          setThumbnailUris((prev) => mergeUriMap(prev, cachedUris));
        }
        recordRuntimeTrace('photos.thumbnail.prefetch_cache_checked', {
          requested: idsWithServerThumbs.length,
          cacheHits: Object.keys(cachedUris).length,
          toFetch: toFetch.length,
        });
        if (toFetch.length === 0) {
          if (thumbnailRetryTimerRef.current) {
            clearTimeout(thumbnailRetryTimerRef.current);
            thumbnailRetryTimerRef.current = null;
          }
          return;
        }

        const fetched: Record<string, string> = {};
        const stats = await prefetchDecryptedThumbnails(
          toFetch,
          getFileKeyBytes,
          {
            signal: controller.signal,
            onLoaded: (fileId, uri) => {
              fetched[fileId] = uri;
            },
          },
        );
        if (cancelled) return;
        recordRuntimeTrace('photos.thumbnail.prefetch_result', {
          requested: toFetch.length,
          loaded: stats.loaded,
          failed: stats.failed,
          fetched: Object.keys(fetched).length,
        });
        if (Object.keys(fetched).length > 0) {
          setThumbnailUris((prev) => mergeUriMap(prev, fetched));
        }

        const everythingFailed =
          stats.failed > 0 && stats.loaded === 0 && Object.keys(fetched).length === 0;
        if (everythingFailed) {
          if (thumbnailRetryTimerRef.current) clearTimeout(thumbnailRetryTimerRef.current);
          thumbnailRetryTimerRef.current = setTimeout(() => {
            thumbnailRetryTimerRef.current = null;
            setThumbnailRetryTick((value) => value + 1);
          }, 8000);
        } else if (thumbnailRetryTimerRef.current) {
          clearTimeout(thumbnailRetryTimerRef.current);
          thumbnailRetryTimerRef.current = null;
        }
      })();
    }, THUMBNAIL_PREFETCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      controller.abort();
      if (thumbnailRetryTimerRef.current) {
        clearTimeout(thumbnailRetryTimerRef.current);
        thumbnailRetryTimerRef.current = null;
      }
    };
  }, [activeThumbnailIds, getFileKeyBytes, isPhotosFocused, photoKitAssetMap, photos, thumbnailRetryTick]);

  useEffect(() => {
    if (!isPhotosFocused) return;
    const ids = Array.from(activeThumbnailIds);
    if (ids.length === 0 || photoKitAssetMap.size === 0) return;
    const attempts = localThumbnailAttemptsRef.current;
    const candidates = ids
      .filter((id) => photoKitAssetMap.has(id) && !attempts.has(id))
      .slice(0, 10);
    if (candidates.length === 0) return;

    let cancelled = false;
    void mapInBatches(candidates, 2, async (id) => {
      attempts.add(id);
      const localId = photoKitAssetMap.get(id);
      if (!localId) return null;
      const photo = photosById.get(id);
      const mimeType = photo ? decryptedMimeTypes[id] ?? mediaMimeType(photo) : null;
      const uri = await cacheLocalThumbnail(id, `ph://${localId}`, mimeType);
      return uri ? [id, uri] as const : null;
    }).then((results) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const result of results) {
        if (result) next[result[0]] = result[1];
      }
      if (Object.keys(next).length === 0) return;
      setThumbnailUris((prev) => {
        let changed = false;
        for (const [id, uri] of Object.entries(next)) {
          if (prev[id] !== uri) {
            changed = true;
            break;
          }
        }
        return changed ? { ...prev, ...next } : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeThumbnailIds, decryptedMimeTypes, isPhotosFocused, photoKitAssetMap, photosById, thumbnailUris]);

  useEffect(() => {
    if (!isPhotosFocused) return;
    if (!isUnlocked) return;
    const repairAttempts = thumbnailRepairAttemptsRef.current;
    const now = Date.now();
    const missing = photos
      .filter((photo) => (
        activePhotoIds.has(photo.id) &&
        !photo.has_thumbnail &&
        !photoKitAssetMap.has(photo.id) &&
        now - (repairAttempts.get(photo.id) ?? 0) >= THUMBNAIL_REPAIR_RETRY_MS
      ))
      .slice(0, 8);
    if (missing.length === 0) return;
    let cancelled = false;
    recordRuntimeTrace('photos.thumbnail.repair_queued', {
      count: missing.length,
    });
    void (async () => {
      for (const photo of missing) {
        repairAttempts.set(photo.id, Date.now());
        const repaired = await ensureThumbnailForImage(
          photo.id,
          photo.name_encrypted,
          photo.size_bytes,
          photo.chunk_count,
          decryptedMimeTypes[photo.id] ?? mediaMimeType(photo),
          getFileKeyBytes,
        );
        if (cancelled) return;
        if (repaired) {
          recordRuntimeTrace('photos.thumbnail.repair_success', { fileId: photo.id });
          setPhotos((prev) => prev.map((item) => (
            item.id === photo.id ? { ...item, has_thumbnail: true } : item
          )));
        } else {
          recordRuntimeTrace('photos.thumbnail.repair_failed', { fileId: photo.id });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePhotoIds, decryptedMimeTypes, getFileKeyBytes, isPhotosFocused, isUnlocked, photoKitAssetMap, photos]);

  const showColumnIndicator = useCallback(() => {
    columnIndicatorOpacity.setValue(1);
    if (columnIndicatorTimer.current) clearTimeout(columnIndicatorTimer.current);
    columnIndicatorTimer.current = setTimeout(() => {
      Animated.timing(columnIndicatorOpacity, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 600);
  }, [columnIndicatorOpacity]);

  // Task 0560 — commit a column-count change. Always called from
  // commitPinchedColumns with a cross-fade wrapped around it; the
  // fade-out hides the brief moment where every cell jumps to its new
  // slot, the setColumns call lays out the grid at the new density
  // off-screen, and the fade-in reveals the new layout in place.
  const applyColumnCount = useCallback((nextCols: number) => {
    if (nextCols === columnsRef.current) return;
    columnsRef.current = nextCols;
    pendingAnchorPhotoIdRef.current = firstVisiblePhotoId(
      listItemsRef.current,
      visibleIndexesRef.current,
    );
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    showColumnIndicator();
    setColumns(nextCols);
  }, [showColumnIndicator]);

  // Task 0560 — during the active pinch we only update the *preview* of
  // what the column count will be. We do NOT call setColumns here, because
  // changing `columns` mid-gesture causes every PhotoCell to re-layout
  // synchronously — and the default RN behaviour is to position-tween
  // each tile from its old slot to its new slot, which looks like photos
  // flying across the screen. Instead, hold the gesture's predicted
  // column count in a ref and apply it on END with a cross-fade.
  const pendingColumnsRef = useRef(DEFAULT_COLS);

  const handlePinchGestureEvent = useCallback(
    (event: PinchGestureHandlerGestureEvent) => {
      if (!isPinchingRef.current) return;
      const predicted = columnsForPinchScale(
        pinchStartColumnsRef.current,
        event.nativeEvent.scale,
      );
      if (predicted === pendingColumnsRef.current) return;
      pendingColumnsRef.current = predicted;
      // Show the indicator so the user gets live feedback during the
      // gesture, even though the actual grid layout is held until END.
      showColumnIndicator();
    },
    [showColumnIndicator],
  );

  // Task 0560 — on gesture release: cross-fade the column-count change.
  // Fade the grid to opacity 0, swap the columns, then fade back to 1.
  // The layout shift happens while the grid is invisible so the user
  // never sees individual photos slide across the screen.
  const commitPinchedColumns = useCallback((nextCols: number) => {
    if (nextCols === columnsRef.current) {
      // No-op pinch (e.g. small scale change that snapped back). Make
      // sure opacity is restored in case a previous fade-out was in
      // flight and the user pinched again.
      gridOpacity.setValue(1);
      return;
    }
    // Fast fade-out, then snap columns, then fade-in. ~80ms each side
    // is short enough to feel like a single transition but long enough
    // for the layout pass + re-render to complete in the dark.
    Animated.timing(gridOpacity, {
      toValue: 0,
      duration: 80,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) {
        gridOpacity.setValue(1);
        return;
      }
      applyColumnCount(nextCols);
      // Wait one frame so the new layout is committed before fading back.
      requestAnimationFrame(() => {
        Animated.timing(gridOpacity, {
          toValue: 1,
          duration: 160,
          useNativeDriver: true,
        }).start();
      });
    });
  }, [applyColumnCount, gridOpacity]);

  const handlePinchStateChange = useCallback(
    (event: PinchGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.state === State.BEGAN) {
        pinchStartColumnsRef.current = columnsRef.current;
        pendingColumnsRef.current = columnsRef.current;
        isPinchingRef.current = true;
        setIsPinching(true);
        return;
      }
      if (
        event.nativeEvent.state !== State.END &&
        event.nativeEvent.state !== State.CANCELLED &&
        event.nativeEvent.state !== State.FAILED
      ) {
        return;
      }

      isPinchingRef.current = false;
      setIsPinching(false);

      if (event.nativeEvent.state !== State.END) {
        // Cancelled / failed — restore opacity in case a fade-out was in
        // flight (the .start callback handles the no-op case but this is
        // belt-and-braces).
        gridOpacity.setValue(1);
        return;
      }
      commitPinchedColumns(
        columnsForPinchScale(pinchStartColumnsRef.current, event.nativeEvent.scale),
      );
    },
    [commitPinchedColumns, gridOpacity],
  );

  useEffect(() => {
    const anchorPhotoId = pendingAnchorPhotoIdRef.current;
    if (!anchorPhotoId) return;
    pendingAnchorPhotoIdRef.current = null;
    const index = findPhotoItemIndex(listItems, anchorPhotoId);
    if (index < 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({
        index,
        animated: false,
        viewPosition: 0.15,
      });
    });
  }, [listItems]);

  const renderItem = useCallback(({ item }: { item: PhotoListItem }) => {
    if (item.type === 'header') {
      return (
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionLabel, { color: c.ink }]}>{item.label}</Text>
          <Text style={[styles.sectionCount, { color: c.ink3 }]}>
            {item.count} {item.count === 1 ? 'item' : 'items'}
          </Text>
        </View>
      );
    }

    return (
      <PhotoRow
        photos={item.photos}
        seedOffset={item.seedOffset}
        photosFolderId={photosFolderId}
        activeThumbnailIds={activeThumbnailIds.size > 0 ? activeThumbnailIds : initialThumbnailIds}
        localAssetMap={photoKitAssetMap}
        decryptedNames={decryptedNames}
        decryptedMimeTypes={decryptedMimeTypes}
        onThumbnailUnavailable={handleThumbnailUnavailable}
        onOpenPhoto={openPhoto}
        onTogglePhoto={toggleSelectedPhoto}
        onLongPressPhoto={enterSelectionMode}
        selectedIds={selectedIds}
        selectMode={selectMode}
        columns={columns}
        cellSize={cellSize}
      />
    );
  }, [
    activeThumbnailIds,
    c.ink,
    c.ink3,
    cellSize,
    columns,
    decryptedMimeTypes,
    decryptedNames,
    enterSelectionMode,
    handleThumbnailUnavailable,
    initialThumbnailIds,
    photoKitAssetMap,
    openPhoto,
    photosFolderId,
    selectMode,
    selectedIds,
    toggleSelectedPhoto,
  ]);

  const getItemLayout = useCallback((_data: ArrayLike<PhotoListItem> | null | undefined, index: number) => {
    const item = listItems[index];
    if (!item) {
      return { length: cellSize + GRID_GAP, offset: 0, index };
    }
    return { length: item.length, offset: item.offset, index };
  }, [cellSize, listItems]);

  const handleViewableItemsChanged = useRef((info: { viewableItems: Array<{ index: number | null }> }) => {
    if (isPinchingRef.current) return;
    const indexes = info.viewableItems
      .map((item) => item.index)
      .filter((index): index is number => typeof index === 'number');
    if (indexes.length === 0) return;
    // Task 0559 — during a flick or active drag, stash the latest indexes
    // in a ref and skip the setState pair. setActiveThumbnailIds re-renders
    // the grid and re-fires the prefetch effect; running either while the
    // scroll thread is decelerating starves the scroll and produces a
    // hard-stop. The pending indexes are applied in a single pass by
    // flushPendingViewport() after momentum/drag ends.
    if (isScrollingRef.current) {
      pendingViewportIndexesRef.current = indexes;
      visibleIndexesRef.current = indexes;
      return;
    }
    visibleIndexesRef.current = indexes;
    const visibleIds = collectVisiblePhotoIds(listItemsRef.current, indexes, 0, 0);
    const thumbnailIds = collectThumbnailIdsForProfile(
      flatPhotosRef.current,
      visibleIds,
      columnsRef.current,
      performanceStorageProfileRef.current,
    );
    setActiveThumbnailIds((prev) => (sameIdSet(prev, thumbnailIds) ? prev : thumbnailIds));
    setActivePhotoIds((prev) => (sameIdSet(prev, visibleIds) ? prev : visibleIds));
  }).current;

  const selectedIdArray = useMemo(() => Array.from(selectedIds), [selectedIds]);

  const handleNativePhotoPress = useCallback((event: { nativeEvent: { id: string } }) => {
    const { id } = event.nativeEvent;
    recordRuntimeTrace('photos.native.photo_press', { fileId: id });
    const photo = photosById.get(id);
    if (photo) openPhoto(photo);
  }, [openPhoto, photosById]);

  const handleNativeSelectionChange = useCallback((event: { nativeEvent: { selectedIds: string[]; selectionMode: boolean } }) => {
    const { selectedIds: nextSelectedIds, selectionMode } = event.nativeEvent;
    recordRuntimeTrace('photos.native.selection_change', {
      count: nextSelectedIds.length,
      selectionMode,
    });
    setSelectMode((prev) => (prev === selectionMode ? prev : selectionMode));
    setSelectedIds((prev) => {
      const next = new Set(nextSelectedIds);
      return sameIdSet(prev, next) ? prev : next;
    });
    setBulkStatus(null);
  }, []);

  const handleNativeVisibleIdsChange = useCallback((event: { nativeEvent: { ids: string[] } }) => {
    const { ids: nativeIds } = event.nativeEvent;
    recordRuntimeTrace('photos.native.visible_ids_change', {
      count: nativeIds.length,
      columns: columnsRef.current,
      profile: performanceStorageProfile,
    });
    const visibleIds = new Set(nativeIds);
    const thumbnailIds = collectThumbnailIdsForProfile(
      flatPhotos,
      visibleIds,
      columnsRef.current,
      performanceStorageProfile,
    );
    setActiveThumbnailIds((prev) => (sameIdSet(prev, thumbnailIds) ? prev : thumbnailIds));
    setActivePhotoIds((prev) => (sameIdSet(prev, visibleIds) ? prev : visibleIds));
  }, [flatPhotos, performanceStorageProfile]);

  const handleNativeZoomChange = useCallback((event: { nativeEvent: { columns: number } }) => {
    const { columns: nextColumns } = event.nativeEvent;
    recordRuntimeTrace('photos.native.zoom_change', { columns: nextColumns });
    columnsRef.current = nextColumns;
    setColumns((prev) => (prev === nextColumns ? prev : nextColumns));
  }, []);

  const handleNativePerfEvent = useCallback((event: { nativeEvent: Record<string, unknown> }) => {
    recordRuntimeTrace('photos.native.perf_event', event.nativeEvent);
    console.info('[BeebeebPerf] photos.native', JSON.stringify(event.nativeEvent));
  }, []);

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIconWrap}>
          <Ionicons name="images-outline" size={48} color={c.amberDeep} />
        </View>
        <Text style={[styles.emptyTitle, { color: c.ink2 }]}>No photos yet</Text>
        <Text style={[styles.emptySubtitle, { color: c.ink3 }]}>
          Photos and videos you upload — or back up automatically — will appear here. Encrypted on your device, never visible to us.
        </Text>
      </View>
    );
  };

  const renderError = () => (
    <View style={styles.errorContainer}>
      <Ionicons name="cloud-offline-outline" size={48} color={c.ink3} />
      <Text style={[styles.errorText, { color: c.ink2 }]}>{error}</Text>
      <TouchableOpacity style={[styles.retryButton, { backgroundColor: c.amber }]} onPress={() => fetchPhotos()}>
        <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      {/* 1322 — the grid bleeds edge-to-edge; the header floats over it with a
          progressive scroll-edge blur, which only appears once something is
          actually scrolled beneath it (the same rule Drive uses in 1313). The
          hairline border it used to draw is replaced by that blur. */}
      {isScrolled ? <ScrollEdgeBlur height={headerHeight || insets.top + 56} /> : null}
      <View
        style={[styles.floatingHeader, { paddingTop: insets.top }]}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          setHeaderHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
        }}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: c.ink }]}>
            {selectMode ? `${selectedIds.size} selected` : 'Photos'}
          </Text>
          <View style={{ flex: 1 }} />
          {selectMode ? (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={clearSelection}
              accessibilityRole="button"
              accessibilityLabel="Cancel selection"
              style={[styles.headerIconButton, { borderColor: c.line, backgroundColor: c.paper2 }]}
            >
              <Ionicons name="close" size={18} color={c.ink2} />
            </TouchableOpacity>
          ) : null}
        </View>

        <DevicePhotosBanner />
      </View>

      {/* Content — wrapped in PinchGestureHandler for zoom-to-change-grid */}
      {error ? (
        renderError()
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.amber} size="large" />
          <Text style={[styles.loadingText, { color: c.ink3 }]}>Loading photos...</Text>
        </View>
      ) : Platform.OS === 'ios' && nativePhotoItems.length === 0 && !loading ? (
        renderEmpty()
      ) : Platform.OS === 'ios' ? (
        <NativePhotosGridView
          style={styles.gridContainer}
          items={nativePhotoItems}
          selectedIds={selectedIdArray}
          selectionMode={selectMode}
          refreshing={refreshing}
          headerTextColor={c.ink}
          headerCountColor={c.ink3}
          contentInsetTop={headerHeight}
          contentInsetBottom={insets.bottom + TAB_BAR_RESERVED}
          onPhotoPress={handleNativePhotoPress}
          onSelectionChange={handleNativeSelectionChange}
          onVisiblePhotoIdsChange={handleNativeVisibleIdsChange}
          onRefresh={handleRefresh}
          onZoomChange={handleNativeZoomChange}
          onPerfEvent={handleNativePerfEvent}
        />
      ) : (
        <PinchGestureHandler
          onGestureEvent={handlePinchGestureEvent}
          onHandlerStateChange={handlePinchStateChange}
        >
          <Animated.View style={styles.gridContainer}>
            {/* Task 0560 — opacity-only wrapper around the FlatList. The
                column indicator sits OUTSIDE this view so it stays
                visible during the cross-fade. */}
            <Animated.View style={[styles.gridContainer, { opacity: gridOpacity }]}>
              <FlatList
                ref={listRef}
                data={listItems}
                keyExtractor={(item) => item.key}
                renderItem={renderItem}
                getItemLayout={getItemLayout}
                onViewableItemsChanged={handleViewableItemsChanged}
                viewabilityConfig={viewabilityConfig}
                ListEmptyComponent={renderEmpty}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={handleRefresh}
                    tintColor={c.amber}
                    colors={[c.amber]}
                  />
                }
                contentContainerStyle={listItems.length === 0 ? styles.emptyList : undefined}
                ListFooterComponent={<View style={{ height: LIST_FOOTER_HEIGHT }} />}
                onScroll={handleGridScroll}
                onScrollBeginDrag={handleScrollBeginDrag}
                onScrollEndDrag={handleScrollEndDrag}
                onMomentumScrollBegin={handleMomentumScrollBegin}
                onMomentumScrollEnd={handleMomentumScrollEnd}
                scrollEventThrottle={16}
                scrollEnabled={!isPinching}
                removeClippedSubviews
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                updateCellsBatchingPeriod={80}
                windowSize={5}
                keyboardDismissMode="on-drag"
              />
            </Animated.View>
            {/* Column count indicator — shows briefly on pinch gesture */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.columnIndicator,
                { backgroundColor: c.ink, opacity: columnIndicatorOpacity },
              ]}
            >
              <Text style={[styles.columnIndicatorText, { color: c.paper }]}>
                {columns} columns
              </Text>
            </Animated.View>
          </Animated.View>
        </PinchGestureHandler>
      )}

      {selectMode ? (
        <View style={[styles.selectionBar, { backgroundColor: c.paper2, borderTopColor: c.line }]}>
          <Text style={[styles.selectionStatus, { color: c.ink2 }]} numberOfLines={1}>
            {bulkStatus ?? `${selectedIds.size} selected`}
          </Text>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={shareSelectedPhotos}
            disabled={bulkAction !== null || selectedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel="Share selected photos as a ZIP"
            style={[
              styles.selectionAction,
              { borderColor: c.line, opacity: bulkAction !== null || selectedIds.size === 0 ? 0.5 : 1 },
            ]}
          >
            {bulkAction === 'share' ? (
              <ActivityIndicator size="small" color={c.amber} />
            ) : (
              <Ionicons name="share-outline" size={18} color={c.amber} />
            )}
            <Text style={[styles.selectionActionText, { color: c.amber }]}>Share ZIP</Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={deleteSelectedPhotos}
            disabled={bulkAction !== null || selectedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel="Delete selected photos from Beebeeb"
            style={[
              styles.selectionAction,
              { borderColor: c.line, opacity: bulkAction !== null || selectedIds.size === 0 ? 0.5 : 1 },
            ]}
          >
            {bulkAction === 'delete' ? (
              <ActivityIndicator size="small" color={c.red} />
            ) : (
              <Ionicons name="trash-outline" size={18} color={c.red} />
            )}
            <Text style={[styles.selectionActionText, { color: c.red }]}>Delete</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <AutoBackupBanner />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },
  gridContainer: { flex: 1 },
  floatingHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: 6, paddingBottom: 4, gap: 8 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },
  headerIconButton: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  // Section rows
  sectionHeader: { height: SECTION_HEADER_HEIGHT, flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: spacing.lg, paddingBottom: 6, gap: 8 },
  sectionLabel: { fontSize: 13, fontWeight: '600' },
  sectionCount: { fontSize: 10 },

  // Grid
  photoRow: { flexDirection: 'row', gap: GRID_GAP },

  // Column count indicator (pinch-to-zoom feedback)
  columnIndicator: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 24,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radii.round,
  },
  columnIndicatorText: {
    fontSize: 13,
    fontWeight: '600',
  },
  // Origin badge — small camera chip overlaid on iOS-backup photos
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

  // Loading state
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 13 },

  // Empty state
  emptyList: { flexGrow: 1 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: 8 },
  emptyIconWrap: { marginBottom: 8, opacity: 0.85 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptySubtitle: { fontSize: 13, textAlign: 'center', lineHeight: 18 },

  // Error state
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: 16 },
  errorText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: radii.md },
  retryButtonText: { fontSize: 14, fontWeight: '600' },

  // Auto-backup banner (sticky at bottom of tab content)
  banner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 10, borderTopWidth: 1, gap: 8 },
  bannerActive: {},
  bannerWithProgress: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  bannerHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerDot: { width: 6, height: 6, borderRadius: 3 },
  bannerDotActive: {},
  bannerText: { fontSize: 11, flex: 1 },
  bannerHint: { fontSize: 10, fontWeight: '600' },
  progressTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },

  // Selection actions
  selectionBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 10, borderTopWidth: 1, gap: 8 },
  selectionStatus: { flex: 1, fontSize: 12, fontWeight: '600' },
  selectionAction: { minHeight: 36, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  selectionActionText: { fontSize: 12, fontWeight: '700' },

  // Device photos banner (top of screen, only when backup is enabled)
  deviceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 8,
  },
  deviceBannerText: { fontSize: 12, flex: 1, fontWeight: '500' },
  deviceBannerHint: { fontSize: 11, fontWeight: '600' },
});
