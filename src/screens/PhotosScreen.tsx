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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import { colors, radii, spacing } from '../theme';
import { listFiles, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';

const CAMERA_BACKUP_KEY = 'beebeeb_camera_backup';

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
  return (
    <View style={styles.chipRow}>
      {FILTERS.map((label) => {
        const isActive = label === active;
        return (
          <TouchableOpacity
            key={label}
            activeOpacity={0.7}
            onPress={() => onChange(label)}
            style={[styles.chip, isActive && styles.chipActive]}
          >
            <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
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

function PhotoCell({ seed }: { seed: number }) {
  return <View style={[styles.cell, { backgroundColor: swatch(seed) }]} />;
}

// ---------------------------------------------------------------------------
// Group section: header + grid
// ---------------------------------------------------------------------------

function GroupSection({ group, seedOffset }: { group: PhotoGroup; seedOffset: number }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{group.label}</Text>
        <Text style={styles.sectionCount}>
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
}

// ---------------------------------------------------------------------------
// Auto-backup banner — reads the camera backup preference
// ---------------------------------------------------------------------------

function AutoBackupBanner() {
  const [backupEnabled, setBackupEnabled] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(CAMERA_BACKUP_KEY).then((val) => {
      setBackupEnabled(val === 'true');
    }).catch(() => {});
  }, []);

  return (
    <View style={[styles.banner, backupEnabled && styles.bannerActive]}>
      <View style={[styles.bannerDot, backupEnabled && styles.bannerDotActive]} />
      <Text style={styles.bannerText}>
        {backupEnabled ? 'Auto-backup on' : 'Auto-backup off'}
      </Text>
      {!backupEnabled && <Text style={styles.bannerHint}>Enable in Settings</Text>}
      {backupEnabled && <Text style={styles.bannerHint}>Waiting for crypto bindings</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PhotosScreen() {
  const insets = useSafeAreaInsets();
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
        <Text style={styles.emptyTitle}>No photos yet</Text>
        <Text style={styles.emptySubtitle}>
          Photos you upload — or back up automatically — will appear here. Encrypted on your device, never visible to us.
        </Text>
      </View>
    );
  };

  const renderError = () => (
    <View style={styles.errorContainer}>
      <Text style={styles.errorText}>{error}</Text>
      <TouchableOpacity style={styles.retryButton} onPress={() => fetchPhotos()}>
        <Text style={styles.retryButtonText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Photos</Text>
        <View style={{ flex: 1 }} />
        <View style={styles.headerCircle}>
          <Text style={styles.headerGlyph}>{'⦿'}</Text>
        </View>
      </View>

      <View style={styles.filterRow}>
        <FilterChips active={filter} onChange={setFilter} />
      </View>

      {/* Content */}
      {error ? (
        renderError()
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.amber} size="large" />
          <Text style={styles.loadingText}>Loading photos...</Text>
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
              tintColor={colors.amber}
              colors={[colors.amber]}
            />
          }
          contentContainerStyle={groups.length === 0 ? styles.emptyList : undefined}
          ListFooterComponent={<View style={{ height: 12 }} />}
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
  root: {
    flex: 1,
    backgroundColor: colors.paper,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: 6,
    paddingBottom: 4,
    gap: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.5,
  },
  headerCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerGlyph: {
    fontSize: 12,
    color: colors.ink2,
  },

  // Filter chips
  filterRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: 8,
    paddingBottom: 10,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.round,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  chipText: {
    fontSize: 11,
    color: colors.ink3,
    fontWeight: '400',
  },
  chipTextActive: {
    color: colors.paper,
    fontWeight: '600',
  },

  // Section (month group)
  section: {
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: spacing.lg,
    paddingBottom: 6,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  sectionCount: {
    fontSize: 10,
    color: colors.ink3,
  },

  // Grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
  },

  // Loading state
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    color: colors.ink3,
  },

  // Empty state
  emptyList: {
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink2,
  },
  emptySubtitle: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 18,
  },

  // Error state
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 16,
  },
  errorText: {
    fontSize: 14,
    color: colors.red,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.amber,
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },

  // Auto-backup banner (sticky at bottom of tab content)
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    backgroundColor: colors.amberBg,
    borderTopWidth: 1,
    borderTopColor: '#f0e3a8',
    gap: 8,
  },
  bannerActive: {
    backgroundColor: '#e8f7ec',
    borderTopColor: '#b8dfc0',
  },
  bannerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.amberDeep,
  },
  bannerDotActive: {
    backgroundColor: colors.green,
  },
  bannerText: {
    fontSize: 11,
    color: colors.ink2,
    flex: 1,
  },
  bannerHint: {
    fontSize: 10,
    color: colors.amberDeep,
    fontWeight: '600',
  },
});
