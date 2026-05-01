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
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radii, spacing } from '../theme';
import { listFiles, deleteFile, restoreFile, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const month = date.toLocaleString('en', { month: 'short' });
  const day = date.getDate();
  const year = date.getFullYear();
  const now = new Date();
  if (year === now.getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${year}`;
}

function displayName(entry: FileEntry): string {
  const raw = entry.name_encrypted;
  if (!raw) return entry.is_folder ? 'Untitled folder' : 'Untitled file';
  if (raw.length > 32) return raw.slice(0, 24) + '...';
  return raw;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function TrashScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTrash = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await listFiles(undefined, true);
      result.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      setFiles(result);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash]);

  const handleRestore = useCallback((item: FileEntry) => {
    Alert.alert(
      'Restore file',
      `"${displayName(item)}" will be restored to your Drive.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            try {
              await restoreFile(item.id);
              setFiles((prev) => prev.filter((f) => f.id !== item.id));
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, []);

  const handleDeletePermanently = useCallback((item: FileEntry) => {
    Alert.alert(
      'Delete permanently',
      `"${displayName(item)}" will be deleted forever. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete permanently',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteFile(item.id);
              setFiles((prev) => prev.filter((f) => f.id !== item.id));
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, []);

  const renderItem = ({ item }: { item: FileEntry }) => (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Text style={styles.rowIconText}>{item.is_folder ? 'DIR' : 'FILE'}</Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName} numberOfLines={1}>{displayName(item)}</Text>
        <Text style={styles.rowMeta}>
          {item.is_folder ? 'Folder' : formatSize(item.size_bytes)}
          {'  ·  '}
          Deleted {formatDate(item.updated_at)}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <TouchableOpacity
          style={styles.restoreBtn}
          onPress={() => handleRestore(item)}
          activeOpacity={0.7}
        >
          <Text style={styles.restoreBtnText}>Restore</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDeletePermanently(item)}
          activeOpacity={0.7}
        >
          <Text style={styles.deleteBtnText}>Delete</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>Trash is empty</Text>
        <Text style={styles.emptySubtitle}>
          Files you delete will appear here before being permanently removed.
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Trash</Text>
      </View>

      {/* Content */}
      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchTrash()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.amber} size="large" />
        </View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchTrash(true)}
              tintColor={colors.amber}
              colors={[colors.amber]}
            />
          }
          contentContainerStyle={files.length === 0 ? styles.emptyList : undefined}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: 10,
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
  backButtonText: { fontSize: 20, color: colors.ink2, fontWeight: '600', marginTop: -2 },
  title: { fontSize: 22, fontWeight: '700', color: colors.ink },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: 10,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.ink3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIconText: { color: colors.paper, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 },
  rowInfo: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13, fontWeight: '500', color: colors.ink },
  rowMeta: { fontSize: 11, color: colors.ink3, marginTop: 2 },

  rowActions: { flexDirection: 'row', gap: 6 },
  restoreBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.sm,
    backgroundColor: colors.amber,
  },
  restoreBtnText: { fontSize: 11, fontWeight: '600', color: colors.ink },
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.red,
  },
  deleteBtnText: { fontSize: 11, fontWeight: '600', color: colors.red },

  // Loading
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Empty
  emptyList: { flexGrow: 1 },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 8,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.ink2 },
  emptySubtitle: { fontSize: 13, color: colors.ink3, textAlign: 'center', lineHeight: 18 },

  // Error
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 16,
  },
  errorText: { fontSize: 14, color: colors.red, textAlign: 'center', lineHeight: 20 },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.amber,
  },
  retryButtonText: { fontSize: 14, fontWeight: '600', color: colors.ink },
});
