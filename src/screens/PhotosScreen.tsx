import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { getAllImages, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';
import { useBackup } from '../lib/backup-context';
import { useCrypto } from '../lib/crypto-context';
import { useNetworkStatus } from '../lib/useNetworkStatus';
import { ThumbnailImage } from '../components/ThumbnailImage';
import { prefetchDecryptedThumbnails, pruneThumbnailCache } from '../lib/thumbnail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isImageFile(entry: FileEntry): boolean {
  const mime = entry.mime_type ?? '';
  return mime.startsWith('image/');
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
// Grid dimensions — 4 columns to match the iOS design
// ---------------------------------------------------------------------------

const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_GAP = 2;
const COLS = 4;
const CELL_SIZE = (SCREEN_WIDTH - GRID_GAP * (COLS - 1)) / COLS;
const ACTIVE_THUMBNAIL_LIMIT = 80;

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

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

type Filter = 'All' | 'Years' | 'Months' | 'Days';
const FILTERS: Filter[] = ['All', 'Years', 'Months', 'Days'];

function FilterChips({
  active,
  onChange,
}: {
  active: Filter;
  onChange: (f: Filter) => void;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.chipRow}>
      {FILTERS.map((label) => {
        const isActive = label === active;
        return (
          <TouchableOpacity
            key={label}
            activeOpacity={0.7}
            onPress={() => onChange(label)}
            style={[
              styles.chip,
              { backgroundColor: c.paper2, borderColor: c.line },
              isActive && { backgroundColor: c.ink, borderColor: c.ink },
            ]}
            accessibilityLabel={`${label} view${isActive ? ', selected' : ''}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <Text style={[
              styles.chipText,
              { color: c.ink3 },
              isActive && { color: c.paper, fontWeight: '600' },
            ]}>
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
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
  onPress,
  accessibilityLabel,
}: {
  fileId: string;
  hasThumbnail?: boolean;
  loadThumbnail: boolean;
  seed: number;
  isFromBackup: boolean;
  onPress?: () => void;
  accessibilityLabel: string;
}) {
  const { colors: c } = useTheme();
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.cell}
    >
      <ThumbnailImage
        fileId={fileId}
        hasThumbnail={hasThumbnail}
        loadThumbnail={loadThumbnail}
        placeholderColor={swatch(seed)}
        style={StyleSheet.absoluteFill}
        accessibilityLabel={accessibilityLabel}
      />
      {isFromBackup && (
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
  onOpenPhoto,
}: {
  group: PhotoGroup;
  seedOffset: number;
  photosFolderId: string | null;
  activeThumbnailIds: Set<string>;
  onOpenPhoto: (entry: FileEntry) => void;
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
        {group.data.map((photo, i) => (
          <PhotoCell
            key={photo.id}
            fileId={photo.id}
            hasThumbnail={photo.has_thumbnail}
            loadThumbnail={activeThumbnailIds.has(photo.id)}
            seed={seedOffset + i}
            isFromBackup={photosFolderId !== null && photo.parent_id === photosFolderId}
            accessibilityLabel={`Photo from ${group.label}`}
            onPress={() => onOpenPhoto(photo)}
          />
        ))}
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
  const { getFileKeyBytes } = useCrypto();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [isScrolled, setIsScrolled] = useState(false);
  const [photos, setPhotos] = useState<FileEntry[]>([]);
  const [photosFolderId, setPhotosFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('Months');
  const [activeThumbnailIds, setActiveThumbnailIds] = useState<Set<string>>(() => new Set());
  const groupsRef = useRef<PhotoGroup[]>([]);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

  const openPhoto = useCallback(
    (entry: FileEntry) => {
      Haptics.selectionAsync();
      navigation.navigate('Preview', {
        fileId: entry.id,
        fileName: entry.name_encrypted ?? 'Photo',
        mimeType: entry.mime_type ?? undefined,
        sizeBytes: entry.size_bytes ?? undefined,
        createdAt: entry.created_at,
        chunkCount: entry.chunk_count,
      });
    },
    [navigation],
  );

  const fetchPhotos = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const allImages = await getAllImages();
      setPhotosFolderId(null);
      // Server already returns image-only, sorted newest first, but defend
      // against future changes by re-applying both invariants here.
      const images = allImages
        .filter(isImageFile)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setPhotos(images);
      void pruneThumbnailCache();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchPhotos(true);
  }, [fetchPhotos]);

  const groups = useMemo(() => groupByMonth(photos), [photos]);

  useEffect(() => {
    groupsRef.current = groups;
    setActiveThumbnailIds(collectThumbnailIds(groups, [0]));
  }, [groups]);

  useEffect(() => {
    const ids = Array.from(activeThumbnailIds);
    if (ids.length === 0) return;
    void prefetchDecryptedThumbnails(ids, getFileKeyBytes);
  }, [activeThumbnailIds, getFileKeyBytes]);

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

  const renderGroup = ({ item, index }: { item: PhotoGroup; index: number }) => (
    <GroupSection
      group={item}
      seedOffset={groupOffsets[index] ?? 0}
      photosFolderId={photosFolderId}
      activeThumbnailIds={activeThumbnailIds}
      onOpenPhoto={openPhoto}
    />
  );

  const handleViewableItemsChanged = useRef((info: { viewableItems: Array<{ index: number | null }> }) => {
    const indexes = info.viewableItems
      .map((item) => item.index)
      .filter((index): index is number => typeof index === 'number');
    setActiveThumbnailIds(collectThumbnailIds(groupsRef.current, indexes));
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

        <View style={styles.filterRow}>
          <FilterChips active={filter} onChange={setFilter} />
        </View>
      </View>

      {/* Content */}
      {error ? (
        renderError()
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.amber} size="large" />
          <Text style={[styles.loadingText, { color: c.ink3 }]}>Loading photos...</Text>
        </View>
      ) : (
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

  // Filter chips
  filterRow: { paddingHorizontal: spacing.lg, paddingTop: 8, paddingBottom: 10 },
  chipRow: { flexDirection: 'row', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.round, borderWidth: 1 },
  chipActive: {},
  chipText: { fontSize: 11, fontWeight: '400' },
  chipTextActive: {},

  // Section (month group)
  section: { marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: spacing.lg, paddingBottom: 6, gap: 8 },
  sectionLabel: { fontSize: 13, fontWeight: '600' },
  sectionCount: { fontSize: 10 },

  // Grid
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  cell: { width: CELL_SIZE, height: CELL_SIZE },

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
