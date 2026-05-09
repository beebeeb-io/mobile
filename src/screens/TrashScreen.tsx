import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useToast } from '../lib/toast-context';
import {
  listFiles,
  restoreFile,
  permanentDeleteFile,
  emptyTrash,
  friendlyError,
} from '../lib/api';
import type { FileEntry } from '../lib/api';
import { requestConfirmation } from '../lib/confirm-action';
import { useCrypto } from '../lib/crypto-context';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Tracks the currently open Swipeable so we can close it when another opens.
let _openSwipeable: Swipeable | null = null;

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

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function fileTypeBadge(entry: FileEntry): { icon: IoniconName; color: string } {
  if (entry.is_folder) return { icon: 'folder', color: '#b8860b' };
  const mime = entry.mime_type ?? '';
  if (mime.startsWith('image/')) return { icon: 'image', color: '#f5b800' };
  if (mime === 'application/pdf') return { icon: 'document-text', color: '#d84040' };
  if (mime.startsWith('audio/')) return { icon: 'musical-notes', color: '#4abe4a' };
  if (mime.startsWith('video/')) return { icon: 'videocam', color: '#8a867f' };
  return { icon: 'document-outline', color: '#8a867f' };
}

function displayName(entry: FileEntry): string {
  const raw = entry.name_encrypted;
  if (!raw) return entry.is_folder ? 'Untitled folder' : 'Untitled file';
  if (raw.startsWith('{')) return entry.is_folder ? 'Encrypted folder' : 'Encrypted file';
  if (raw.length > 32) return raw.slice(0, 24) + '...';
  return raw;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseDecryptedMetadata(plaintext: string): string {
  try {
    const metadata = JSON.parse(plaintext) as { name?: unknown };
    if (metadata && typeof metadata === 'object' && typeof metadata.name === 'string') {
      const name = metadata.name.trim();
      if (name) return name;
    }
  } catch {
    // Legacy metadata format: plaintext is the bare filename.
  }
  return plaintext || '';
}

// ---------------------------------------------------------------------------
// Trash row (swipeable)
// ---------------------------------------------------------------------------

interface TrashRowProps {
  item: FileEntry;
  decryptedName: string | null;
  onRestore: (item: FileEntry) => void;
  onDelete: (item: FileEntry) => void;
}

const TrashRow = React.memo(function TrashRow({ item, decryptedName, onRestore, onDelete }: TrashRowProps) {
  const { colors: c } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const badge = fileTypeBadge(item);

  const handleSwipeOpen = useCallback((_dir: 'left' | 'right', swipeable: Swipeable) => {
    if (_openSwipeable && _openSwipeable !== swipeable) {
      _openSwipeable.close();
    }
    _openSwipeable = swipeable;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  const handleSwipeClose = useCallback(() => {
    if (_openSwipeable === swipeableRef.current) {
      _openSwipeable = null;
    }
  }, []);

  const renderRightActions = useCallback(() => (
    <View style={styles.swipeActions}>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: c.green }]}
        activeOpacity={0.8}
        onPress={() => { swipeableRef.current?.close(); onRestore(item); }}
      >
        <Ionicons name="arrow-undo-outline" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Restore</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: c.red }]}
        activeOpacity={0.8}
        onPress={() => { swipeableRef.current?.close(); onDelete(item); }}
      >
        <Ionicons name="trash-outline" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Delete</Text>
      </TouchableOpacity>
    </View>
  ), [c, item, onRestore, onDelete]);

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      onSwipeableOpen={handleSwipeOpen}
      onSwipeableClose={handleSwipeClose}
      overshootRight={false}
      rightThreshold={40}
    >
      <View style={[styles.row, { borderBottomColor: c.line, backgroundColor: c.paper }]}>
        <View style={[styles.rowIcon, { backgroundColor: badge.color }]}>
          <Ionicons name={badge.icon} size={16} color="#FFFFFF" />
        </View>
        <View style={styles.rowInfo}>
          <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={1}>
            {decryptedName ?? displayName(item)}
          </Text>
          <Text style={[styles.rowMeta, { color: c.ink3 }]}>
            {item.is_folder ? 'Folder' : formatSize(item.size_bytes)}
            {'  ·  Deleted '}
            {formatDate(item.updated_at)}
          </Text>
        </View>
        <Ionicons name="chevron-back" size={14} color={c.ink4} style={{ opacity: 0.5 }} />
      </View>
    </Swipeable>
  );
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function TrashScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { showToast } = useToast();

  const { isUnlocked, decryptMetadata } = useCrypto();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});

  // Decrypt filenames once both the file list and the vault key are ready.
  // Mirrors the FilesScreen pattern so trash rows show real names instead of
  // the "Encrypted file" placeholder.
  useEffect(() => {
    if (!isUnlocked) {
      setDecryptedNames({});
      return;
    }
    let cancelled = false;
    (async () => {
      const results: Record<string, string> = {};
      await Promise.all(
        files.map(async (file) => {
          try {
            const raw = file.name_encrypted ?? '';
            if (!raw.startsWith('{')) return;
            const parsed = JSON.parse(raw) as { nonce: string; ciphertext: string };
            const nonce = base64ToUint8Array(parsed.nonce);
            const ct = base64ToUint8Array(parsed.ciphertext);
            const plaintext = await decryptMetadata(file.id, nonce, ct);
            const name = parseDecryptedMetadata(plaintext);
            if (name) results[file.id] = name;
          } catch {
            // Leave unset so displayName() renders the "Encrypted file" fallback.
          }
        }),
      );
      if (!cancelled) setDecryptedNames(results);
    })();
    return () => { cancelled = true; };
  }, [files, isUnlocked, decryptMetadata]);

  const nameFor = useCallback(
    (item: FileEntry) => decryptedNames[item.id] ?? displayName(item),
    [decryptedNames],
  );

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
    const name = nameFor(item);
    Alert.alert(
      'Restore',
      `"${name}" will be restored to your Drive.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            try {
              await restoreFile(item.id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setFiles((prev) => prev.filter((f) => f.id !== item.id));
              showToast({ type: 'success', message: `"${name}" restored to Drive` });
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [showToast, nameFor]);

  const handleDelete = useCallback((item: FileEntry) => {
    const name = nameFor(item);
    Alert.alert(
      'Delete permanently',
      `"${name}" will be deleted forever. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete permanently',
          style: 'destructive',
          onPress: async () => {
            const token = await requestConfirmation({
              title: 'Confirm permanent delete',
              message: 'Re-enter your Beebeeb password to permanently delete this item. This cannot be undone.',
            });
            if (!token) return;
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              await permanentDeleteFile(item.id, token);
              setFiles((prev) => prev.filter((f) => f.id !== item.id));
              showToast({ type: 'info', message: `"${name}" permanently deleted` });
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [showToast, nameFor]);

  const handleEmptyTrash = useCallback(() => {
    if (files.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Empty Trash',
      `${files.length} item${files.length === 1 ? '' : 's'} will be permanently deleted. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Empty Trash',
          style: 'destructive',
          onPress: async () => {
            const token = await requestConfirmation({
              title: 'Confirm empty trash',
              message: `Re-enter your Beebeeb password to permanently delete ${files.length} item${files.length === 1 ? '' : 's'}. This cannot be undone.`,
            });
            if (!token) return;
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              await emptyTrash(token);
              setFiles([]);
              showToast({ type: 'success', message: 'Trash emptied' });
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [files.length, showToast]);

  const renderItem = useCallback(({ item }: { item: FileEntry }) => (
    <TrashRow
      item={item}
      decryptedName={decryptedNames[item.id] ?? null}
      onRestore={handleRestore}
      onDelete={handleDelete}
    />
  ), [decryptedNames, handleRestore, handleDelete]);

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="trash-outline" size={48} color={c.ink4} style={{ marginBottom: 12, opacity: 0.5 }} />
        <Text style={[styles.emptyTitle, { color: c.ink2 }]}>Trash is empty</Text>
        <Text style={[styles.emptySubtitle, { color: c.ink3 }]}>
          Files you delete will appear here before being permanently removed.
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: c.paper }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: c.line }]}>
        <TouchableOpacity
          style={[styles.backButton, { backgroundColor: c.paper2, borderColor: c.line }]}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[styles.backButtonText, { color: c.ink2 }]}>{'‹'}</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Trash</Text>
        <View style={{ flex: 1 }} />
        {files.length > 0 && (
          <TouchableOpacity
            onPress={handleEmptyTrash}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.emptyTrashBtn, { color: c.red }]}>Empty</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Swipe hint — shown until first swipe */}
      {files.length > 0 && !loading && (
        <View style={[styles.hintBanner, { backgroundColor: c.paper2, borderBottomColor: c.line }]}>
          <Text style={[styles.hintText, { color: c.ink3 }]}>
            Swipe left to restore or permanently delete
          </Text>
        </View>
      )}

      {/* Content */}
      {error ? (
        <View style={styles.errorContainer}>
          <Text style={[styles.errorText, { color: c.red }]}>{error}</Text>
          <TouchableOpacity
            style={[styles.retryButton, { backgroundColor: c.amber }]}
            onPress={() => fetchTrash()}
          >
            <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.amber} size="large" />
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
              tintColor={c.amber}
              colors={[c.amber]}
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
  root: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: { fontSize: 20, fontWeight: '600', marginTop: -2 },
  title: { fontSize: 22, fontWeight: '700' },
  emptyTrashBtn: { fontSize: 14, fontWeight: '600' },

  hintBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hintText: { fontSize: 11 },

  // Swipe actions
  swipeActions: { flexDirection: 'row' },
  swipeAction: { width: 80, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeActionLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13, fontWeight: '500' },
  rowMeta: { fontSize: 11, marginTop: 2 },

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
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptySubtitle: { fontSize: 13, textAlign: 'center', lineHeight: 18 },

  // Error
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 16,
  },
  errorText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: radii.md },
  retryButtonText: { fontSize: 14, fontWeight: '600' },
});
