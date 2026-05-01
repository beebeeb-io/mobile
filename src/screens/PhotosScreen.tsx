import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../theme';
import { listFiles, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a file has an image mime type. */
function isImageFile(entry: FileEntry): boolean {
  const mime = entry.mime_type ?? '';
  return mime.startsWith('image/');
}

/** Warm-toned placeholder color based on index. */
function placeholderColor(index: number): string {
  const hues = [45, 30, 20, 55, 35, 50, 25, 40, 15, 60];
  const sats = [60, 50, 70, 45, 65, 55, 40, 50, 58, 48];
  const lights = [75, 60, 80, 68, 64, 78, 72, 66, 74, 62];
  const h = hues[index % hues.length];
  const s = sats[index % sats.length];
  const l = lights[index % lights.length];
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/** Group photos by relative date: Today, Yesterday, Earlier. */
interface PhotoGroup {
  title: string;
  data: FileEntry[];
}

function groupByDate(photos: FileEntry[]): PhotoGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);

  const today: FileEntry[] = [];
  const yesterday: FileEntry[] = [];
  const earlier: FileEntry[] = [];

  for (const photo of photos) {
    const date = new Date(photo.created_at);
    if (date >= todayStart) {
      today.push(photo);
    } else if (date >= yesterdayStart) {
      yesterday.push(photo);
    } else {
      earlier.push(photo);
    }
  }

  const groups: PhotoGroup[] = [];
  if (today.length > 0) groups.push({ title: 'Today', data: today });
  if (yesterday.length > 0) groups.push({ title: 'Yesterday', data: yesterday });
  if (earlier.length > 0) groups.push({ title: 'Earlier', data: earlier });
  return groups;
}

// ---------------------------------------------------------------------------
// Grid dimensions
// ---------------------------------------------------------------------------

const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_GAP = 2;
const COLS = 3;
const CELL_SIZE = (SCREEN_WIDTH - GRID_GAP * (COLS - 1)) / COLS;

// ---------------------------------------------------------------------------
// Photo cell
// ---------------------------------------------------------------------------

function PhotoCell({ index }: { index: number }) {
  return (
    <View style={[styles.cell, { backgroundColor: placeholderColor(index) }]}>
      {/* Camera icon placeholder — simple Unicode since no icon lib yet */}
      <Text style={styles.cameraIcon}>{'\u{1F4F7}'}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Group header
// ---------------------------------------------------------------------------

function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.groupHeader}>
      <Text style={styles.groupTitle}>{title}</Text>
      <Text style={styles.groupCount}>{count}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Photo grid for a single group
// ---------------------------------------------------------------------------

function PhotoGrid({ photos, indexOffset }: { photos: FileEntry[]; indexOffset: number }) {
  return (
    <View style={styles.grid}>
      {photos.map((photo, i) => (
        <PhotoCell key={photo.id} index={indexOffset + i} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PhotosScreen() {
  const insets = useSafeAreaInsets();
  const [allFiles, setAllFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Fetch all files and filter to images
  // -----------------------------------------------------------------------

  const fetchPhotos = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const result = await listFiles();
      // Filter to image files only, sort by created_at descending (newest first)
      const images = result
        .filter(isImageFile)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setAllFiles(images);
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
    fetchPhotos(true);
  }, [fetchPhotos]);

  // -----------------------------------------------------------------------
  // Group photos by date
  // -----------------------------------------------------------------------

  const groups = useMemo(() => groupByDate(allFiles), [allFiles]);

  // Build flat list items: mix of headers and grid sections
  type ListItem =
    | { type: 'header'; title: string; count: number; key: string }
    | { type: 'grid'; photos: FileEntry[]; indexOffset: number; key: string };

  const listData = useMemo(() => {
    const items: ListItem[] = [];
    let offset = 0;
    for (const group of groups) {
      items.push({
        type: 'header',
        title: group.title,
        count: group.data.length,
        key: `header-${group.title}`,
      });
      items.push({
        type: 'grid',
        photos: group.data,
        indexOffset: offset,
        key: `grid-${group.title}`,
      });
      offset += group.data.length;
    }
    return items;
  }, [groups]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === 'header') {
      return <GroupHeader title={item.title} count={item.count} />;
    }
    return <PhotoGrid photos={item.photos} indexOffset={item.indexOffset} />;
  };

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>{'\u{1F4F7}'}</Text>
        <Text style={styles.emptyTitle}>No photos yet</Text>
        <Text style={styles.emptySubtitle}>
          Upload images to see them here.
        </Text>
      </View>
    );
  };

  const renderError = () => (
    <View style={styles.errorContainer}>
      <Text style={styles.errorText}>{error}</Text>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Photos</Text>
        {allFiles.length > 0 && (
          <Text style={styles.photoCount}>
            {allFiles.length} {allFiles.length === 1 ? 'photo' : 'photos'}
          </Text>
        )}
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
          data={listData}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.amber}
              colors={[colors.amber]}
            />
          }
          contentContainerStyle={listData.length === 0 ? styles.emptyList : undefined}
          ListFooterComponent={<View style={{ height: 24 }} />}
        />
      )}
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
    alignItems: 'baseline',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: 10,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.ink,
  },
  photoCount: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.ink3,
  },

  // Group header
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 6,
    gap: 8,
  },
  groupTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
  groupCount: {
    fontSize: 11,
    fontWeight: '400',
    color: colors.ink3,
  },

  // Photo grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraIcon: {
    fontSize: 20,
    opacity: 0.3,
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
  emptyIcon: {
    fontSize: 40,
    opacity: 0.3,
    marginBottom: 8,
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
});
