import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { listFiles, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';
import { useBackup } from '../lib/backup-context';
import { useNetworkStatus } from '../lib/useNetworkStatus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isImageFile(entry: FileEntry): boolean {
  const mime = entry.mime_type ?? '';
  return mime.startsWith('image/');
}

/**
 * Deterministic warm swatch — used as a placeholder until the encrypted
 * thumbnail can be fetched and decrypted via the UniFFI core bindings.
 * Mirrors the swatch logic in design/hifi/hifi-ios-app.jsx.
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

const PhotoCell = React.memo(function PhotoCell({ seed }: { seed: number }) {
  return <View style={[styles.cell, { backgroundColor: swatch(seed) }]} />;
});

// ---------------------------------------------------------------------------
// Group section: header + grid
// ---------------------------------------------------------------------------

const GroupSection = React.memo(function GroupSection({ group, seedOffset }: { group: PhotoGroup; seedOffset: number }) {
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
          <PhotoCell key={photo.id} seed={seedOffset + i} />
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

  if (!isPhotoBackupEnabled) {
    return (
      <View style={[styles.banner, { backgroundColor: c.paper2, borderColor: c.line }]}>
        <View style={[styles.bannerDot, { backgroundColor: c.ink4 }]} />
        <Text style={[styles.bannerText, { color: c.ink2 }]}>Auto-backup off</Text>
        <Text style={[styles.bannerHint, { color: c.ink3 }]}>Enable in Settings</Text>
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
    return (
      <View style={[styles.banner, styles.bannerActive, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
        <ActivityIndicator size="small" color={c.green} style={{ marginRight: 2 }} />
        <Text style={[styles.bannerText, { color: c.ink }]}>
          Backing up {backupProgress.inProgress} of {remaining} remaining
        </Text>
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
  const [isScrolled, setIsScrolled] = useState(false);
  const [photos, setPhotos] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('Months');

  const fetchPhotos = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const result = await listFiles();
      const images = result
        .filter(isImageFile)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setPhotos(images);
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
    <GroupSection group={item} seedOffset={groupOffsets[index] ?? 0} />
  );

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
  bannerDot: { width: 6, height: 6, borderRadius: 3 },
  bannerDotActive: {},
  bannerText: { fontSize: 11, flex: 1 },
  bannerHint: { fontSize: 10, fontWeight: '600' },

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
