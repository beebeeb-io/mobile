import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radii, spacing, shadows } from '../theme';
import { listFiles, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';
import type { RootStackParamList } from '../App';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format bytes into a human-readable string. */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/** Format an ISO date string into a relative or short date. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  // Older than a week — show short date
  const month = date.toLocaleString('en', { month: 'short' });
  const day = date.getDate();
  const year = date.getFullYear();
  if (year === now.getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${year}`;
}

/**
 * Display name for an encrypted filename.
 * Until UniFFI crypto bindings land, we show a truncated version of the
 * encrypted name so the user can still distinguish files.
 */
function displayName(entry: FileEntry): string {
  const raw = entry.name_encrypted;
  if (!raw) return entry.is_folder ? 'Untitled folder' : 'Untitled file';
  // If it looks like base64/hex ciphertext, truncate for readability
  if (raw.length > 32) {
    return raw.slice(0, 24) + '...';
  }
  return raw;
}

/** Determine a file type category from the mime type. */
function fileCategory(entry: FileEntry): 'folder' | 'image' | 'pdf' | 'audio' | 'video' | 'doc' | 'file' {
  if (entry.is_folder) return 'folder';
  const mime = entry.mime_type ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || mime.includes('document') || mime.includes('spreadsheet')) return 'doc';
  return 'file';
}

const CATEGORY_LABELS: Record<string, string> = {
  folder: 'DIR',
  image: 'IMG',
  pdf: 'PDF',
  audio: 'AUD',
  video: 'VID',
  doc: 'DOC',
  file: 'FILE',
};

const CATEGORY_COLORS: Record<string, string> = {
  folder: colors.amberDeep,
  image: colors.amber,
  pdf: colors.red,
  audio: colors.green,
  video: colors.ink2,
  doc: colors.ink2,
  file: colors.ink3,
};

// ---------------------------------------------------------------------------
// Breadcrumb item
// ---------------------------------------------------------------------------

interface BreadcrumbEntry {
  id: string | null; // null = root
  name: string;
}

// ---------------------------------------------------------------------------
// File icon component
// ---------------------------------------------------------------------------

function FileIcon({ category }: { category: string }) {
  const bg = CATEGORY_COLORS[category] ?? colors.ink3;
  const label = CATEGORY_LABELS[category] ?? 'FILE';
  return (
    <View style={[styles.fileIcon, { backgroundColor: bg }]}>
      <Text style={styles.fileIconText}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function FilesScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  // Navigation state: stack of folders
  const [folderStack, setFolderStack] = useState<BreadcrumbEntry[]>([
    { id: null, name: 'Drive' },
  ]);
  const currentFolder = folderStack[folderStack.length - 1];

  // Data state
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // Fetch files
  // ------------------------------------------------------------------

  const fetchFiles = useCallback(async (parentId: string | null, isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const result = await listFiles(parentId ?? undefined);
      // Sort: folders first, then by updated_at descending
      result.sort((a, b) => {
        if (a.is_folder !== b.is_folder) return a.is_folder ? -1 : 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
      setFiles(result);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Fetch on mount and when folder changes
  useEffect(() => {
    fetchFiles(currentFolder.id);
  }, [currentFolder.id, fetchFiles]);

  // ------------------------------------------------------------------
  // Navigation handlers
  // ------------------------------------------------------------------

  const navigateToFolder = useCallback((folder: FileEntry) => {
    setFolderStack((prev) => [
      ...prev,
      { id: folder.id, name: displayName(folder) },
    ]);
  }, []);

  const navigateToBreadcrumb = useCallback((index: number) => {
    setFolderStack((prev) => prev.slice(0, index + 1));
  }, []);

  const openFile = useCallback(
    (file: FileEntry) => {
      if (file.is_folder) {
        navigateToFolder(file);
      } else {
        navigation.navigate('Preview', {
          fileId: file.id,
          fileName: displayName(file),
        });
      }
    },
    [navigateToFolder, navigation],
  );

  const handleRefresh = useCallback(() => {
    fetchFiles(currentFolder.id, true);
  }, [currentFolder.id, fetchFiles]);

  const handleUpload = useCallback(() => {
    Alert.alert(
      'Upload',
      'File upload will be available once crypto bindings are integrated.',
      [{ text: 'OK' }],
    );
  }, []);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const renderBreadcrumbs = () => (
    <View style={styles.breadcrumbRow}>
      {folderStack.map((entry, index) => {
        const isLast = index === folderStack.length - 1;
        return (
          <View key={entry.id ?? 'root'} style={styles.breadcrumbItem}>
            {index > 0 && <Text style={styles.breadcrumbSep}>/</Text>}
            <TouchableOpacity
              disabled={isLast}
              onPress={() => navigateToBreadcrumb(index)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              <Text
                style={[
                  styles.breadcrumbText,
                  isLast && styles.breadcrumbTextActive,
                ]}
                numberOfLines={1}
              >
                {entry.name}
              </Text>
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );

  const renderFileRow = ({ item }: { item: FileEntry }) => {
    const category = fileCategory(item);
    return (
      <TouchableOpacity
        style={styles.fileRow}
        activeOpacity={0.6}
        onPress={() => openFile(item)}
      >
        <FileIcon category={category} />
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>
            {displayName(item)}
          </Text>
          <Text style={styles.fileMeta}>
            {item.is_folder
              ? formatDate(item.updated_at)
              : `${formatSize(item.size_bytes)}  ·  ${formatDate(item.updated_at)}`}
          </Text>
        </View>
        <Text style={styles.chevron}>{'›'}</Text>
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>No files yet</Text>
        <Text style={styles.emptySubtitle}>
          {currentFolder.id === null
            ? 'Upload your first file to get started.'
            : 'This folder is empty.'}
        </Text>
      </View>
    );
  };

  const renderError = () => (
    <View style={styles.errorContainer}>
      <Text style={styles.errorText}>{error}</Text>
      <TouchableOpacity
        style={styles.retryButton}
        onPress={() => fetchFiles(currentFolder.id)}
      >
        <Text style={styles.retryButtonText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  // ------------------------------------------------------------------
  // Main render
  // ------------------------------------------------------------------

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        {folderStack.length > 1 && (
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigateToBreadcrumb(folderStack.length - 2)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.backButtonText}>{'‹'}</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.title}>{currentFolder.name}</Text>
        <View style={{ flex: 1 }} />
      </View>

      {/* Breadcrumbs (only show when navigated into a folder) */}
      {folderStack.length > 1 && renderBreadcrumbs()}

      {/* Content */}
      {error ? (
        renderError()
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.amber} size="large" />
          <Text style={styles.loadingText}>Loading files...</Text>
        </View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={renderFileRow}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.amber}
              colors={[colors.amber]}
            />
          }
          contentContainerStyle={files.length === 0 ? styles.emptyList : undefined}
        />
      )}

      {/* Floating action button */}
      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        activeOpacity={0.8}
        onPress={handleUpload}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
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
    paddingVertical: spacing.sm,
    gap: 8,
  },
  backButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 20,
    color: colors.ink2,
    fontWeight: '600',
    marginTop: -2,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.ink,
  },

  // Breadcrumbs
  breadcrumbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    flexWrap: 'wrap',
    gap: 2,
  },
  breadcrumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  breadcrumbSep: {
    fontSize: 12,
    color: colors.ink4,
    marginHorizontal: 4,
  },
  breadcrumbText: {
    fontSize: 12,
    color: colors.amberDeep,
    fontWeight: '500',
  },
  breadcrumbTextActive: {
    color: colors.ink2,
    fontWeight: '600',
  },

  // File list
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: 12,
  },
  fileIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileIconText: {
    color: colors.paper,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  fileInfo: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.ink,
  },
  fileMeta: {
    fontSize: 11,
    color: colors.ink3,
    marginTop: 2,
  },
  chevron: {
    fontSize: 18,
    color: colors.ink4,
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

  // FAB
  fab: {
    position: 'absolute',
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.amber,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.lg,
  },
  fabText: {
    fontSize: 28,
    fontWeight: '600',
    color: colors.ink,
    marginTop: -2,
  },
});
