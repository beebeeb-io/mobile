import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { radii, spacing, shadows } from '../theme';
import { useTheme } from '../lib/theme-context';
import { listFiles, createFolder, deleteFile, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';
import type { RootStackParamList } from '../App';
import { useCrypto } from '../lib/crypto-context';

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
 * Fallback display name for an encrypted filename when crypto is unavailable.
 * Returns a friendly label for JSON-encrypted names instead of raw ciphertext.
 */
function displayName(entry: FileEntry): string {
  const raw = entry.name_encrypted;
  if (!raw) return entry.is_folder ? 'Untitled folder' : 'Untitled file';
  if (raw.startsWith('{')) return entry.is_folder ? 'Encrypted folder' : 'Encrypted file';
  if (raw.length > 32) return raw.slice(0, 24) + '...';
  return raw;
}

/** Decode a base64 string to a Uint8Array. */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

const FileIcon = React.memo(function FileIcon({ category }: { category: string }) {
  const { colors: c } = useTheme();
  const CATEGORY_COLORS: Record<string, string> = {
    folder: c.amberDeep,
    image: c.amber,
    pdf: c.red,
    audio: c.green,
    video: c.ink2,
    doc: c.ink2,
    file: c.ink3,
  };
  const bg = CATEGORY_COLORS[category] ?? c.ink3;
  const label = CATEGORY_LABELS[category] ?? 'FILE';
  return (
    <View style={[styles.fileIcon, { backgroundColor: bg }]}>
      <Text style={styles.fileIconText}>{label}</Text>
    </View>
  );
});

// ---------------------------------------------------------------------------
// File row item (memoized to prevent unnecessary re-renders in FlatList)
// ---------------------------------------------------------------------------

interface FileRowItemProps {
  item: FileEntry;
  decryptedName: string | undefined;
  onPress: (item: FileEntry) => void;
  onLongPress: (item: FileEntry) => void;
}

const FileRowItem = React.memo(function FileRowItem({
  item,
  decryptedName,
  onPress,
  onLongPress,
}: FileRowItemProps) {
  const { colors: c } = useTheme();
  const category = fileCategory(item);
  const isEncryptedFallback = !decryptedName && !!item.name_encrypted?.startsWith('{');
  const nameText = decryptedName ?? displayName(item);
  return (
    <TouchableOpacity
      style={[styles.fileRow, { borderBottomColor: c.line }]}
      activeOpacity={0.6}
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress(item)}
      delayLongPress={400}
    >
      <FileIcon category={category} />
      <View style={styles.fileInfo}>
        <View style={styles.fileNameRow}>
          {isEncryptedFallback && (
            <Ionicons name="lock-closed" size={11} color={c.ink4} style={styles.lockIcon} />
          )}
          <Text
            style={[styles.fileName, { color: c.ink }, isEncryptedFallback && styles.fileNameEncrypted]}
            numberOfLines={1}
          >
            {nameText}
          </Text>
        </View>
        <Text style={[styles.fileMeta, { color: c.ink3 }]}>
          {item.is_folder
            ? formatDate(item.updated_at)
            : `${formatSize(item.size_bytes)}  ·  ${formatDate(item.updated_at)}`}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: c.ink4 }]}>{'›'}</Text>
    </TouchableOpacity>
  );
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function FilesScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();

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

  // Search state
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Crypto
  const { isUnlocked, decryptMetadata } = useCrypto();
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});

  // Decrypt filenames whenever the file list or unlock state changes
  useEffect(() => {
    if (!isUnlocked) {
      setDecryptedNames({});
      return;
    }
    const results: Record<string, string> = {};
    Promise.all(
      files.map(async (file) => {
        try {
          const parsed = JSON.parse(file.name_encrypted) as { nonce: string; ciphertext: string };
          const nonce = base64ToUint8Array(parsed.nonce);
          const ct = base64ToUint8Array(parsed.ciphertext);
          results[file.id] = await decryptMetadata(file.id, nonce, ct);
        } catch {
          // Not JSON-encrypted or crypto unavailable — fall back to truncated raw name
        }
      }),
    ).then(() => setDecryptedNames({ ...results }));
  }, [files, isUnlocked, decryptMetadata]);

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
      { id: folder.id, name: decryptedNames[folder.id] ?? displayName(folder) },
    ]);
  }, [decryptedNames]);

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
          fileName: decryptedNames[file.id] ?? displayName(file),
          mimeType: file.mime_type ?? undefined,
          sizeBytes: file.size_bytes,
          createdAt: file.created_at,
        });
      }
    },
    [navigateToFolder, navigation, decryptedNames],
  );

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchFiles(currentFolder.id, true);
  }, [currentFolder.id, fetchFiles]);

  const handleFabPress = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['New folder', 'Upload file', 'Cancel'],
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0) showNewFolderPrompt();
          else if (index === 1) showUploadAlert();
        },
      );
    } else {
      Alert.alert('Add to Drive', undefined, [
        { text: 'New folder', onPress: showNewFolderPrompt },
        { text: 'Upload file', onPress: showUploadAlert },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [currentFolder]);

  const showUploadAlert = useCallback(() => {
    const cryptoNote = isUnlocked
      ? 'Vault unlocked — files will be encrypted before upload.'
      : 'Unlock your vault first to enable encrypted uploads.';
    Alert.alert(
      'Upload',
      `File upload requires a document picker integration (coming soon).\n\n${cryptoNote}`,
      [{ text: 'OK' }],
    );
  }, [isUnlocked]);

  const showNewFolderPrompt = useCallback(() => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'New folder',
        'Enter a name for the new folder',
        async (name) => {
          const trimmed = name?.trim();
          if (!trimmed) return;
          try {
            const folder = await createFolder(trimmed, currentFolder.id ?? undefined);
            setFiles((prev) => [folder, ...prev]);
          } catch (err) {
            Alert.alert('Error', friendlyError(err));
          }
        },
        'plain-text',
        '',
        'default',
      );
    } else {
      // Android: use a state-based modal (simple Alert without prompt)
      Alert.alert(
        'New folder',
        'Folder creation prompt is iOS-only for now. Please use the iOS app.',
        [{ text: 'OK' }],
      );
    }
  }, [currentFolder.id]);

  const handleSearchToggle = useCallback(() => {
    setSearchActive((prev) => {
      if (prev) setSearchQuery('');
      return !prev;
    });
  }, []);

  const handleLongPress = useCallback((item: FileEntry) => {
    const name = decryptedNames[item.id] ?? displayName(item);
    const options = item.is_folder
      ? ['Open', 'Share', 'Delete', 'Cancel']
      : ['Preview', 'Share', 'Move to Trash', 'Cancel'];
    const destructiveIndex = item.is_folder ? 2 : 2;
    const cancelIndex = options.length - 1;

    const handleAction = (index: number) => {
      if (index === 0) {
        openFile(item);
      } else if (index === 1) {
        navigation.navigate('ShareSheet', {
          fileId: item.id,
          fileName: name,
          mimeType: item.mime_type ?? undefined,
          sizeBytes: item.size_bytes,
        });
      } else if (index === 2) {
        Alert.alert(
          'Move to Trash',
          `"${name}" will be moved to Trash.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Move to Trash',
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
      }
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: name,
          options,
          destructiveButtonIndex: destructiveIndex,
          cancelButtonIndex: cancelIndex,
        },
        handleAction,
      );
    } else {
      // Android / web: use Alert with buttons
      Alert.alert(name, undefined, [
        { text: options[0], onPress: () => handleAction(0) },
        { text: options[1], onPress: () => handleAction(1) },
        { text: options[2], style: 'destructive', onPress: () => handleAction(2) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [navigation, openFile, decryptedNames]);

  // Filtered file list for search
  const displayedFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const q = searchQuery.toLowerCase();
    return files.filter((f) => {
      const name = decryptedNames[f.id] ?? displayName(f);
      return name.toLowerCase().includes(q);
    });
  }, [files, searchQuery, decryptedNames]);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const renderBreadcrumbs = () => (
    <View style={styles.breadcrumbRow}>
      {folderStack.map((entry, index) => {
        const isLast = index === folderStack.length - 1;
        return (
          <View key={entry.id ?? 'root'} style={styles.breadcrumbItem}>
            {index > 0 && <Text style={[styles.breadcrumbSep, { color: c.ink4 }]}>/</Text>}
            <TouchableOpacity
              disabled={isLast}
              onPress={() => navigateToBreadcrumb(index)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              <Text
                style={[
                  styles.breadcrumbText,
                  { color: c.amberDeep },
                  isLast && [styles.breadcrumbTextActive, { color: c.ink2 }],
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

  const renderFileRow = useCallback(({ item }: { item: FileEntry }) => (
    <FileRowItem
      item={item}
      decryptedName={decryptedNames[item.id]}
      onPress={openFile}
      onLongPress={handleLongPress}
    />
  ), [decryptedNames, openFile, handleLongPress]);

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyTitle, { color: c.ink2 }]}>No files yet</Text>
        <Text style={[styles.emptySubtitle, { color: c.ink3 }]}>
          {currentFolder.id === null
            ? 'Upload your first file to get started.'
            : 'This folder is empty.'}
        </Text>
      </View>
    );
  };

  const renderError = () => (
    <View style={styles.errorContainer}>
      <Text style={[styles.errorText, { color: c.red }]}>{error}</Text>
      <TouchableOpacity
        style={[styles.retryButton, { backgroundColor: c.amber }]}
        onPress={() => fetchFiles(currentFolder.id)}
      >
        <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  // ------------------------------------------------------------------
  // Main render
  // ------------------------------------------------------------------

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: c.paper }]}>
      {/* Header */}
      <View style={styles.header}>
        {!searchActive && folderStack.length > 1 && (
          <TouchableOpacity
            style={[styles.backButton, { backgroundColor: c.paper2, borderColor: c.line }]}
            onPress={() => navigateToBreadcrumb(folderStack.length - 2)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.backButtonText, { color: c.ink2 }]}>{'‹'}</Text>
          </TouchableOpacity>
        )}
        {searchActive ? (
          <TextInput
            style={[styles.searchInput, { backgroundColor: c.paper2, borderColor: c.line, color: c.ink }]}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search files..."
            placeholderTextColor={c.ink4}
            autoFocus
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : (
          <Text style={[styles.title, { color: c.ink }]}>{currentFolder.name}</Text>
        )}
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={handleSearchToggle}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.searchButton}
        >
          <Text style={[styles.searchButtonText, { color: c.ink2 }]}>{searchActive ? '✕' : '⌕'}</Text>
        </TouchableOpacity>
      </View>

      {/* Breadcrumbs (only show when navigated into a folder) */}
      {folderStack.length > 1 && renderBreadcrumbs()}

      {/* Content */}
      {error ? (
        renderError()
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.amber} size="large" />
          <Text style={[styles.loadingText, { color: c.ink3 }]}>Loading files...</Text>
        </View>
      ) : (
        <FlatList
          data={displayedFiles}
          keyExtractor={(item) => item.id}
          renderItem={renderFileRow}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={c.amber}
              colors={[c.amber]}
            />
          }
          contentContainerStyle={displayedFiles.length === 0 ? styles.emptyList : undefined}
          removeClippedSubviews={true}
          windowSize={5}
        />
      )}

      {/* Floating action button */}
      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom, backgroundColor: c.amber }]}
        activeOpacity={0.8}
        onPress={handleFabPress}
      >
        <Text style={[styles.fabText, { color: c.ink }]}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 8 },
  backButton: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 20, fontWeight: '600', marginTop: -2 },
  title: { fontSize: 28, fontWeight: '700' },
  searchInput: { flex: 1, height: 36, borderRadius: radii.md, paddingHorizontal: 12, fontSize: 15, borderWidth: 1 },
  searchButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  searchButtonText: { fontSize: 20 },

  // Breadcrumbs
  breadcrumbRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, flexWrap: 'wrap', gap: 2 },
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center' },
  breadcrumbSep: { fontSize: 12, marginHorizontal: 4 },
  breadcrumbText: { fontSize: 12, fontWeight: '500' },
  breadcrumbTextActive: { fontWeight: '600' },

  // File list
  fileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: spacing.lg, borderBottomWidth: 1, gap: 12 },
  fileIcon: { width: 32, height: 32, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  fileIconText: { color: '#FFFFFF', fontSize: 8, fontWeight: '700', letterSpacing: 0.3 },
  fileInfo: { flex: 1, minWidth: 0 },
  fileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  lockIcon: { flexShrink: 0 },
  fileName: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  fileNameEncrypted: { fontStyle: 'italic' },
  fileMeta: { fontSize: 11, marginTop: 2 },
  chevron: { fontSize: 18 },

  // Loading state
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 13 },

  // Empty state
  emptyList: { flexGrow: 1 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptySubtitle: { fontSize: 13, textAlign: 'center', lineHeight: 18 },

  // Error state
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: 16 },
  errorText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: radii.md },
  retryButtonText: { fontSize: 14, fontWeight: '600' },

  // FAB
  fab: { position: 'absolute', right: 20, width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', ...shadows.lg },
  fabText: { fontSize: 28, fontWeight: '600', marginTop: -2 },
});
