import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  PinchGestureHandler,
  State,
  type PinchGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { getAllImages, friendlyError, getApiUrl, getToken } from '../lib/api';
import type { FileEntry } from '../lib/api';
import { guessMimeType } from '../lib/media';
import { useBackup } from '../lib/backup-context';
import { useCrypto } from '../lib/crypto-context';
import { useNetworkStatus } from '../lib/useNetworkStatus';
import { ThumbnailImage } from '../components/ThumbnailImage';
import {
  ensureThumbnailForImage,
  prefetchDecryptedThumbnails,
  pruneThumbnailCache,
} from '../lib/thumbnail';
import { getRemoteToLocalMap } from '../services/BackupDatabase';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';

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

function photoMimeType(entry: FileEntry): string | null {
  const mediaEntry = entry as MediaEntry;
  const mime = (entry.mime_type ?? mediaEntry.mime ?? '').toLowerCase();
  if (mime.startsWith('image/')) return entry.mime_type ?? mediaEntry.mime ?? 'image/jpeg';
  if (mime.startsWith('video/')) return null;

  const category = mediaCategory(mediaEntry);
  if (category === 'image' || category === 'photo') return 'image/jpeg';
  if (category === 'video') return null;

  for (const name of filenameCandidates(mediaEntry)) {
    const guessed = guessMimeType(name);
    if (guessed?.startsWith('image/')) return guessed;
    if (guessed?.startsWith('video/')) return null;
  }

  return entry.is_media ? 'image/jpeg' : null;
}

function isImageFile(entry: FileEntry): boolean {
  return photoMimeType(entry) !== null;
}

/**
 * Parse the decrypted metadata plaintext. The server may store the filename as
 * a bare string (legacy) or as `{"name":"...", "mime_type":"..."}` (current).
 */
function parseDecryptedPhotoName(plaintext: string): string {
  try {
    const metadata = JSON.parse(plaintext) as { name?: unknown };
    if (metadata && typeof metadata === 'object' && typeof metadata.name === 'string') {
      const name = metadata.name.trim();
      if (name) return name;
    }
  } catch {
    // Legacy format: plaintext is the bare filename.
  }
  return plaintext || 'Photo';
}

async function getMediaFiles(): Promise<FileEntry[] | null> {
  const token = await getToken();
  const res = await fetch(`${getApiUrl()}/api/v1/files/media`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error?: unknown }).error ?? res.statusText)
      : res.statusText;
    throw new Error(message);
  }

  const data = await res.json() as { files?: FileEntry[] };
  return Array.isArray(data.files) ? data.files : [];
}

async function getPhotoCandidates(): Promise<FileEntry[]> {
  const mediaFiles = await getMediaFiles();
  if (mediaFiles) return mediaFiles;
  return getAllImages();
}

/**
 * Deterministic warm swatch — used as a load-time placeholder behind each
 * thumbnail so the grid never shows blank cells while images are streaming in.
 */
function swatch(seed: number): string {
  const hues = [55, 72, 28, 90, 42, 65, 18, 82];
  const sats = [22, 28, 24, 32, 26, 30, 20, 28];
  const lights = [78, 62, 84, 70, 66, 80, 72, 68];
  const h = hues[seed % hues.length];
  const s = sats[(seed * 7) % sats.length];
  const l = lights[(seed * 3) % lights.length];
  return `hsl(${h}, ${s}%, ${l}%)`;
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
    const date = new Date(photo.created_at);
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

// ---------------------------------------------------------------------------
// Grid dimensions — pinch-to-zoom changes column count (2/4/7/12)
// ---------------------------------------------------------------------------

const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_GAP = 2;
const COLUMN_STEPS = [2, 4, 7, 12];
const DEFAULT_COLS = 4;

function cellSizeForCols(cols: number): number {
  return (SCREEN_WIDTH - GRID_GAP * (cols - 1)) / cols;
}

const ACTIVE_THUMBNAIL_LIMIT = 500;

function collectThumbnailIds(groups: PhotoGroup[], visibleIndexes: number[]): Set<string> {
  if (groups.length === 0) return new Set();
  const indexes = visibleIndexes.length > 0 ? visibleIndexes : [0];
  const min = Math.max(0, Math.min(...indexes) - 1);
  const max = Math.min(groups.length - 1, Math.max(...indexes) + 1);
  const ids: string[] = [];

  for (let groupIndex = min; groupIndex <= max && ids.length < ACTIVE_THUMBNAIL_LIMIT; groupIndex++) {
    for (const photo of groups[groupIndex]?.data ?? []) {
      if (photo.has_thumbnail) ids.push(photo.id);
      if (ids.length >= ACTIVE_THUMBNAIL_LIMIT) break;
    }
  }

  return new Set(ids);
}

function collectVisiblePhotoIds(groups: PhotoGroup[], visibleIndexes: number[]): Set<string> {
  if (groups.length === 0) return new Set();
  const indexes = visibleIndexes.length > 0 ? visibleIndexes : [0];
  const min = Math.max(0, Math.min(...indexes) - 1);
  const max = Math.min(groups.length - 1, Math.max(...indexes) + 1);
  const ids: string[] = [];

  for (let groupIndex = min; groupIndex <= max && ids.length < ACTIVE_THUMBNAIL_LIMIT; groupIndex++) {
    for (const photo of groups[groupIndex]?.data ?? []) {
      ids.push(photo.id);
      if (ids.length >= ACTIVE_THUMBNAIL_LIMIT) break;
    }
  }

  return new Set(ids);
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
  onPress,
  accessibilityLabel,
  filename,
  cellSize,
  columns,
}: {
  fileId: string;
  hasThumbnail?: boolean;
  loadThumbnail: boolean;
  seed: number;
  isFromBackup: boolean;
  localAssetUri?: string | null;
  onPress?: () => void;
  accessibilityLabel: string;
  filename?: string | null;
  cellSize: number;
  columns: number;
}) {
  const { colors: c } = useTheme();
  // Hide filename overlay and badge at small sizes (7+ columns)
  const showOverlay = columns <= 4;
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={filename ? `Photo: ${filename}` : accessibilityLabel}
      style={{ width: cellSize, height: cellSize }}
    >
      <ThumbnailImage
        fileId={fileId}
        hasThumbnail={hasThumbnail}
        loadThumbnail={loadThumbnail}
        localAssetUri={localAssetUri}
        placeholderColor={swatch(seed)}
        style={StyleSheet.absoluteFill}
        accessibilityLabel={filename ? `Photo: ${filename}` : accessibilityLabel}
      />
      {showOverlay && filename ? (
        <View style={styles.filenameOverlay}>
          <Text style={styles.filenameText} numberOfLines={1}>
            {filename}
          </Text>
        </View>
      ) : null}
      {showOverlay && isFromBackup && (
        <View style={[styles.originBadge, { backgroundColor: c.amber }]}>
          <Ionicons name="camera" size={10} color={c.ink} />
        </View>
      )}
    </TouchableOpacity>
  );
});

// ---------------------------------------------------------------------------
// Group section: header + grid
// ---------------------------------------------------------------------------

const GroupSection = React.memo(function GroupSection({
  group,
  seedOffset,
  photosFolderId,
  activeThumbnailIds,
  localAssetMap,
  decryptedNames,
  onOpenPhoto,
  columns,
  cellSize,
}: {
  group: PhotoGroup;
  seedOffset: number;
  photosFolderId: string | null;
  activeThumbnailIds: Set<string>;
  localAssetMap: Map<string, string>;
  decryptedNames: Record<string, string>;
  onOpenPhoto: (entry: FileEntry) => void;
  columns: number;
  cellSize: number;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionLabel, { color: c.ink }]}>{group.label}</Text>
        <Text style={[styles.sectionCount, { color: c.ink3 }]}>
          {group.data.length} {group.data.length === 1 ? 'item' : 'items'}
        </Text>
      </View>
      <View style={styles.grid}>
        {group.data.map((photo, i) => {
          // If this photo was backed up from camera roll, use its local asset URI
          const localId = localAssetMap.get(photo.id);
          const localAssetUri = localId ? `ph://${localId}` : null;
          return (
            <PhotoCell
              key={photo.id}
              fileId={photo.id}
              hasThumbnail={photo.has_thumbnail}
              loadThumbnail={activeThumbnailIds.has(photo.id)}
              seed={seedOffset + i}
              isFromBackup={photosFolderId !== null && photo.parent_id === photosFolderId}
              localAssetUri={localAssetUri}
              filename={decryptedNames[photo.id] ?? null}
              accessibilityLabel={decryptedNames[photo.id] ? `Photo: ${decryptedNames[photo.id]}` : `Photo from ${group.label}`}
              onPress={() => onOpenPhoto(photo)}
              cellSize={cellSize}
              columns={columns}
            />
          );
        })}
      </View>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Device photos banner — shows local-library count when backup is enabled
// ---------------------------------------------------------------------------

function DevicePhotosBanner() {
  const { isPhotoBackupEnabled, backupProgress } = useBackup();
  const { colors: c } = useTheme();
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
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
        const { totalCount } = await MediaLibrary.getAssetsAsync({
          mediaType: 'photo',
          first: 0,
        });
        if (!cancelled) setDeviceCount(totalCount);
      } catch {
        // Media library unavailable (e.g. simulator without photos, web)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPhotoBackupEnabled]);

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
  if (deviceCount === null) return null;

  return (
    <View style={[styles.deviceBanner, { backgroundColor: c.paper2, borderColor: c.line }]}>
      <Ionicons name="phone-portrait-outline" size={14} color={c.ink3} />
      <Text style={[styles.deviceBannerText, { color: c.ink2 }]}>
        {deviceCount.toLocaleString()} {deviceCount === 1 ? 'photo' : 'photos'} on device
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
  const { isPhotoBackupEnabled, backupProgress, lastBackupAt } = useBackup();
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
    const remaining = backupProgress.total - backupProgress.completed;
    const ratio = backupProgress.total > 0
      ? Math.min(1, Math.max(0, backupProgress.completed / backupProgress.total))
      : 0;
    return (
      <View style={[styles.banner, styles.bannerActive, styles.bannerWithProgress, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
        <View style={styles.bannerHeaderRow}>
          <ActivityIndicator size="small" color={c.green} style={{ marginRight: 2 }} />
          <Text style={[styles.bannerText, { color: c.ink }]}>
            Backing up {backupProgress.inProgress} of {remaining} remaining
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
        {allDone ? 'All photos backed up' : 'Auto-backup on'}
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
  const { getFileKeyBytes, isUnlocked, decryptMetadata } = useCrypto();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [isScrolled, setIsScrolled] = useState(false);
  const [photos, setPhotos] = useState<FileEntry[]>([]);
  const photosCacheRef = useRef<FileEntry[]>([]);
  const photosCountRef = useRef(0);
  const [photosFolderId, setPhotosFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState(DEFAULT_COLS);
  const cellSize = useMemo(() => cellSizeForCols(columns), [columns]);
  // Column indicator — fades out after a pinch gesture changes the grid density
  const columnIndicatorOpacity = useRef(new Animated.Value(0)).current;
  const columnIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeThumbnailIds, setActiveThumbnailIds] = useState<Set<string>>(() => new Set());
  const [activePhotoIds, setActivePhotoIds] = useState<Set<string>>(() => new Set());
  const [localAssetMap, setLocalAssetMap] = useState<Map<string, string>>(new Map());
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  const groupsRef = useRef<PhotoGroup[]>([]);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

  // Decrypt filenames for visible photos. Re-runs when photos change or vault unlocks.
  useEffect(() => {
    if (!isUnlocked) {
      setDecryptedNames({});
      return;
    }
    const results: Record<string, string> = {};
    let cancelled = false;
    Promise.all(
      photos.map(async (photo) => {
        try {
          const raw = photo.name_encrypted ?? '';
          if (!raw.startsWith('{')) {
            // Not JSON-encrypted — use the raw value if it looks like a filename
            if (raw && raw.length < 200) results[photo.id] = raw;
            return;
          }
          const payload = encryptedMetadataPayloadToBytes(raw);
          if (!payload) return;
          const plaintext = await decryptMetadata(photo.id, payload.nonce, payload.ciphertext);
          results[photo.id] = parseDecryptedPhotoName(plaintext);
        } catch {
          // Decryption failure — leave unset
        }
      }),
    ).then(() => {
      if (!cancelled) setDecryptedNames({ ...results });
    });
    return () => { cancelled = true; };
  }, [photos, isUnlocked, decryptMetadata]);

  const fetchPhotos = useCallback(async (isRefresh = false) => {
    const hasVisiblePhotos = photosCountRef.current > 0;
    if (isRefresh || hasVisiblePhotos) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const allImages = await getPhotoCandidates();
      setPhotosFolderId(null);
      // Server usually returns image/media rows sorted newest first, but defend
      // against future changes by re-applying both invariants here.
      const images = allImages
        .filter(isImageFile)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      if (images.length > 0) {
        photosCacheRef.current = images;
        setPhotos(images);
      } else if (!isRefresh && photosCacheRef.current.length > 0) {
        setPhotos(photosCacheRef.current);
      } else {
        photosCacheRef.current = [];
        setPhotos([]);
      }
      void pruneThumbnailCache();

      // Build the remote_file_id → local_asset_id map for camera roll thumbnails
      void getRemoteToLocalMap().then((map) => setLocalAssetMap(map)).catch(() => {});
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchPhotos();
    }, [fetchPhotos])
  );

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchPhotos(true);
  }, [fetchPhotos]);

  const groups = useMemo(() => groupByMonth(photos), [photos]);

  // Build a flat list of all photos in display order (newest first, grouped by month)
  const flatPhotos = useMemo(() => groups.flatMap((g) => g.data), [groups]);

  const openPhoto = useCallback(
    (entry: FileEntry) => {
      Haptics.selectionAsync();
      const index = flatPhotos.findIndex((p) => p.id === entry.id);
      // Serialize photo list for swipe navigation — only the fields PreviewScreen needs
      const photoListJson = JSON.stringify(
        flatPhotos.map((p) => ({
          id: p.id,
          name_encrypted: p.name_encrypted,
          mime_type: p.mime_type,
          size_bytes: p.size_bytes,
          created_at: p.created_at,
          chunk_count: p.chunk_count,
          version_number: p.version_number,
          storage_pool_id: p.storage_pool_id ?? null,
        })),
      );
      navigation.navigate('Preview', {
        fileId: entry.id,
        fileName: decryptedNames[entry.id] ?? entry.name_encrypted ?? 'Photo',
        mimeType: photoMimeType(entry) ?? undefined,
        sizeBytes: entry.size_bytes ?? undefined,
        createdAt: entry.created_at,
        chunkCount: entry.chunk_count,
        versionNumber: entry.version_number,
        storagePoolId: entry.storage_pool_id ?? null,
        photoListJson,
        initialPhotoIndex: index >= 0 ? index : 0,
      });
    },
    [navigation, decryptedNames, flatPhotos],
  );

  useEffect(() => {
    photosCountRef.current = photos.length;
    if (photos.length > 0) photosCacheRef.current = photos;
  }, [photos]);

  useEffect(() => {
    groupsRef.current = groups;
    setActiveThumbnailIds(collectThumbnailIds(groups, [0]));
    setActivePhotoIds(collectVisiblePhotoIds(groups, [0]));
  }, [groups]);

  useEffect(() => {
    const ids = Array.from(activeThumbnailIds);
    if (ids.length === 0) return;
    void prefetchDecryptedThumbnails(ids, getFileKeyBytes);
  }, [activeThumbnailIds, getFileKeyBytes]);

  useEffect(() => {
    const missing = photos.filter((photo) => activePhotoIds.has(photo.id) && !photo.has_thumbnail).slice(0, 8);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const photo of missing) {
        const repaired = await ensureThumbnailForImage(
          photo.id,
          photo.name_encrypted,
          photo.size_bytes,
          photo.chunk_count,
          photo.mime_type,
          getFileKeyBytes,
        );
        if (cancelled) return;
        if (repaired) {
          setPhotos((prev) => prev.map((item) => (
            item.id === photo.id ? { ...item, has_thumbnail: true } : item
          )));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePhotoIds, getFileKeyBytes, photos]);

  // Compute seed offsets so swatch colors are stable across the whole screen
  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const g of groups) {
      offsets.push(acc);
      acc += g.data.length;
    }
    return offsets;
  }, [groups]);

  // Pinch-to-zoom: change grid column count
  const handlePinchStateChange = useCallback(
    (event: PinchGestureHandlerStateChangeEvent) => {
      if (event.nativeEvent.state !== State.END) return;
      const scale = event.nativeEvent.scale;
      setColumns((prev) => {
        const currentIdx = COLUMN_STEPS.indexOf(prev);
        let nextIdx = currentIdx;
        if (scale < 0.75 && currentIdx < COLUMN_STEPS.length - 1) {
          // Pinch in — more columns, smaller photos
          nextIdx = currentIdx + 1;
        } else if (scale > 1.3 && currentIdx > 0) {
          // Pinch out — fewer columns, larger photos
          nextIdx = currentIdx - 1;
        }
        const nextCols = COLUMN_STEPS[nextIdx] ?? prev;
        if (nextCols !== prev) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          // Show column indicator briefly
          columnIndicatorOpacity.setValue(1);
          if (columnIndicatorTimer.current) clearTimeout(columnIndicatorTimer.current);
          columnIndicatorTimer.current = setTimeout(() => {
            Animated.timing(columnIndicatorOpacity, {
              toValue: 0,
              duration: 400,
              useNativeDriver: true,
            }).start();
          }, 600);
        }
        return nextCols;
      });
    },
    [columnIndicatorOpacity],
  );

  const renderGroup = ({ item, index }: { item: PhotoGroup; index: number }) => (
    <GroupSection
      group={item}
      seedOffset={groupOffsets[index] ?? 0}
      photosFolderId={photosFolderId}
      activeThumbnailIds={activeThumbnailIds}
      localAssetMap={localAssetMap}
      decryptedNames={decryptedNames}
      onOpenPhoto={openPhoto}
      columns={columns}
      cellSize={cellSize}
    />
  );

  const handleViewableItemsChanged = useRef((info: { viewableItems: Array<{ index: number | null }> }) => {
    const indexes = info.viewableItems
      .map((item) => item.index)
      .filter((index): index is number => typeof index === 'number');
    setActiveThumbnailIds(collectThumbnailIds(groupsRef.current, indexes));
    setActivePhotoIds(collectVisiblePhotoIds(groupsRef.current, indexes));
  }).current;

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIconWrap}>
          <Ionicons name="images-outline" size={48} color={c.amberDeep} />
        </View>
        <Text style={[styles.emptyTitle, { color: c.ink2 }]}>No photos yet</Text>
        <Text style={[styles.emptySubtitle, { color: c.ink3 }]}>
          Photos you upload — or back up automatically — will appear here. Encrypted on your device, never visible to us.
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
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: c.paper }]}>
      {/* Header area — bottom border appears when scrolled */}
      <View style={[isScrolled && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: c.ink }]}>Photos</Text>
          <View style={{ flex: 1 }} />
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
      ) : (
        <PinchGestureHandler onHandlerStateChange={handlePinchStateChange}>
          <View style={{ flex: 1 }}>
            <FlatList
              data={groups}
              keyExtractor={(group) => group.key}
              renderItem={renderGroup}
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
              contentContainerStyle={groups.length === 0 ? styles.emptyList : undefined}
              ListFooterComponent={<View style={{ height: 12 }} />}
              onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
              scrollEventThrottle={100}
              removeClippedSubviews={true}
              windowSize={5}
              keyboardDismissMode="on-drag"
            />
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
          </View>
        </PinchGestureHandler>
      )}

      <AutoBackupBanner />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: 6, paddingBottom: 4, gap: 8 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },

  // Section (month group)
  section: { marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: spacing.lg, paddingBottom: 6, gap: 8 },
  sectionLabel: { fontSize: 13, fontWeight: '600' },
  sectionCount: { fontSize: 10 },

  // Grid
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },

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

  // Filename overlay — subtle label at bottom of each thumbnail
  filenameOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 3,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  filenameText: {
    fontSize: 8,
    fontFamily: 'JetBrains Mono',
    color: 'rgba(255,255,255,0.85)',
    lineHeight: 10,
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
