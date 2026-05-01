import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  LayoutAnimation,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import * as DocumentPicker from 'expo-document-picker';
import { radii, spacing, shadows } from '../theme';
import { useTheme } from '../lib/theme-context';
import { listFiles, createFolder, deleteFile, renameFile, moveFile, uploadFile, friendlyError } from '../lib/api';
import type { FileEntry } from '../lib/api';
import type { RootStackParamList } from '../App';
import { useCrypto } from '../lib/crypto-context';

// Tracks the currently open Swipeable so we can close it when another opens.
let _openSwipeable: Swipeable | null = null;

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
  onShare: (item: FileEntry) => void;
  onDelete: (item: FileEntry) => void;
}

const FileRowItem = React.memo(function FileRowItem({
  item,
  decryptedName,
  onPress,
  onLongPress,
  onShare,
  onDelete,
}: FileRowItemProps) {
  const { colors: c } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const category = fileCategory(item);
  const isEncryptedFallback = !decryptedName && !!item.name_encrypted?.startsWith('{');
  const nameText = decryptedName ?? displayName(item);

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
        style={[styles.swipeAction, { backgroundColor: c.amber }]}
        activeOpacity={0.8}
        onPress={() => {
          swipeableRef.current?.close();
          onShare(item);
        }}
      >
        <Ionicons name="share-outline" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Share</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: c.red }]}
        activeOpacity={0.8}
        onPress={() => {
          swipeableRef.current?.close();
          onDelete(item);
        }}
      >
        <Ionicons name="trash-outline" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Trash</Text>
      </TouchableOpacity>
    </View>
  ), [c, item, onShare, onDelete]);

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      onSwipeableOpen={handleSwipeOpen}
      onSwipeableClose={handleSwipeClose}
      overshootRight={false}
      rightThreshold={40}
    >
      <TouchableOpacity
        style={[styles.fileRow, { borderBottomColor: c.line, backgroundColor: c.paper }]}
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
    </Swipeable>
  );
});

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortOrder = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc';

const SORT_LABELS: Record<SortOrder, string> = {
  'date-desc': 'Newest first',
  'date-asc': 'Oldest first',
  'name-asc': 'Name (A → Z)',
  'name-desc': 'Name (Z → A)',
  'size-desc': 'Largest first',
  'size-asc': 'Smallest first',
};

const SORT_ORDER: SortOrder[] = ['name-asc', 'name-desc', 'date-desc', 'date-asc', 'size-desc', 'size-asc'];

function applySortOrder(
  list: FileEntry[],
  order: SortOrder,
  decryptedNames: Record<string, string>,
): FileEntry[] {
  return [...list].sort((a, b) => {
    // Folders always float to the top regardless of sort order
    if (a.is_folder !== b.is_folder) return a.is_folder ? -1 : 1;
    switch (order) {
      case 'name-asc': {
        const na = (decryptedNames[a.id] ?? a.name_encrypted ?? '').toLowerCase();
        const nb = (decryptedNames[b.id] ?? b.name_encrypted ?? '').toLowerCase();
        return na.localeCompare(nb);
      }
      case 'name-desc': {
        const na = (decryptedNames[a.id] ?? a.name_encrypted ?? '').toLowerCase();
        const nb = (decryptedNames[b.id] ?? b.name_encrypted ?? '').toLowerCase();
        return nb.localeCompare(na);
      }
      case 'date-asc':
        return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      case 'date-desc':
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      case 'size-desc':
        return (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
      case 'size-asc':
        return (a.size_bytes ?? 0) - (b.size_bytes ?? 0);
    }
  });
}

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
  const searchInputRef = useRef<TextInput>(null);

  // Sort state
  const [sortOrder, setSortOrder] = useState<SortOrder>('date-desc');

  // Crypto
  const { isUnlocked, decryptMetadata } = useCrypto();
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});

  // Upload state — shows an inline progress banner above the FAB
  const [uploadingName, setUploadingName] = useState<string | null>(null);

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
    setSearchActive(false);
    setSearchQuery('');
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

  const pickAndUploadFile = useCallback(async () => {
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch (err) {
      Alert.alert('Error', friendlyError(err));
      return;
    }
    if (picked.canceled || !picked.assets?.[0]) return;

    const asset = picked.assets[0];
    setUploadingName(asset.name);
    try {
      // Fetch the local URI into a Blob so it can be sent as a multipart chunk.
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      const uploaded = await uploadFile(
        {
          name_encrypted: asset.name,
          parent_id: currentFolder.id ?? undefined,
          mime_type: asset.mimeType ?? undefined,
          size_bytes: asset.size ?? blob.size,
        },
        [blob],
      );
      // Optimistic insert; the next refresh will reconcile.
      setFiles((prev) => [uploaded, ...prev]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Refresh to pick up server-side updates (storage usage, ordering, etc).
      fetchFiles(currentFolder.id, true);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Upload failed', friendlyError(err));
    } finally {
      setUploadingName(null);
    }
  }, [currentFolder.id, fetchFiles]);

  const handleFabPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Upload file', 'New folder', 'Cancel'],
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0) pickAndUploadFile();
          else if (index === 1) showNewFolderPrompt();
        },
      );
    } else {
      Alert.alert('Add to Drive', undefined, [
        { text: 'Upload file', onPress: pickAndUploadFile },
        { text: 'New folder', onPress: showNewFolderPrompt },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [pickAndUploadFile]);

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

  const handleSortPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const options = [...SORT_ORDER.map((o) => SORT_LABELS[o]), 'Cancel'];
    const cancelIndex = options.length - 1;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Sort by', options, cancelButtonIndex: cancelIndex },
        (index) => {
          const order = SORT_ORDER[index];
          if (order) setSortOrder(order);
        },
      );
    } else {
      Alert.alert(
        'Sort by',
        undefined,
        [
          ...SORT_ORDER.map((o) => ({ text: SORT_LABELS[o], onPress: () => setSortOrder(o) })),
          { text: 'Cancel', style: 'cancel' as const },
        ],
      );
    }
  }, []);

  const handleSearchToggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSearchActive((prev) => {
      if (prev) setSearchQuery('');
      return !prev;
    });
  }, []);

  const handleLongPress = useCallback((item: FileEntry) => {
    const name = decryptedNames[item.id] ?? displayName(item);
    const options = item.is_folder
      ? ['Rename', 'Open', 'Share', 'Delete', 'Details', 'Cancel']
      : ['Rename', 'Preview', 'Share', 'Move to Trash', 'Details', 'Cancel'];
    const destructiveIndex = 3;
    const cancelIndex = options.length - 1;

    const promptRename = () => {
      Alert.prompt(
        'Rename',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
            onPress: async (input) => {
              const next = (input ?? '').trim();
              if (!next || next === name) return;
              try {
                await renameFile(item.id, next);
                setFiles((prev) =>
                  prev.map((f) => (f.id === item.id ? { ...f, name_encrypted: next } : f)),
                );
                setDecryptedNames((prev) => ({ ...prev, [item.id]: next }));
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (err) {
                Alert.alert('Error', friendlyError(err));
              }
            },
          },
        ],
        'plain-text',
        name,
      );
    };

    const handleAction = (index: number) => {
      if (index === 0) {
        promptRename();
      } else if (index === 1) {
        openFile(item);
      } else if (index === 2) {
        navigation.navigate('ShareSheet', {
          fileId: item.id,
          fileName: name,
          mimeType: item.mime_type ?? undefined,
          sizeBytes: item.size_bytes,
        });
      } else if (index === 3) {
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
      } else if (index === 4) {
        const lines = [
          `Name:      ${name}`,
          `Type:      ${item.is_folder ? 'Folder' : (item.mime_type ?? 'Unknown')}`,
        ];
        if (!item.is_folder) {
          lines.push(`Size:      ${formatSize(item.size_bytes)}`);
        }
        lines.push(`Created:   ${formatDate(item.created_at)}`);
        lines.push(`Modified:  ${formatDate(item.updated_at)}`);
        lines.push(`ID:        ${item.id.slice(0, 8)}`);
        Alert.alert('File details', lines.join('\n'));
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
        { text: options[2], onPress: () => handleAction(2) },
        { text: options[3], style: 'destructive', onPress: () => handleAction(3) },
        { text: options[4], onPress: () => handleAction(4) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [navigation, openFile, decryptedNames]);

  // Filtered + sorted file list
  const displayedFiles = useMemo(() => {
    let result = files;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((f) => {
        const name = decryptedNames[f.id] ?? displayName(f);
        return name.toLowerCase().includes(q);
      });
    }
    return applySortOrder(result, sortOrder, decryptedNames);
  }, [files, searchQuery, decryptedNames, sortOrder]);

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

  const handleSwipeShare = useCallback((item: FileEntry) => {
    const name = decryptedNames[item.id] ?? displayName(item);
    navigation.navigate('ShareSheet', {
      fileId: item.id,
      fileName: name,
      mimeType: item.mime_type ?? undefined,
      sizeBytes: item.size_bytes,
    });
  }, [navigation, decryptedNames]);

  const handleSwipeDelete = useCallback((item: FileEntry) => {
    const name = decryptedNames[item.id] ?? displayName(item);
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
  }, [decryptedNames]);

  const renderFileRow = useCallback(({ item }: { item: FileEntry }) => (
    <FileRowItem
      item={item}
      decryptedName={decryptedNames[item.id]}
      onPress={openFile}
      onLongPress={handleLongPress}
      onShare={handleSwipeShare}
      onDelete={handleSwipeDelete}
    />
  ), [decryptedNames, openFile, handleLongPress, handleSwipeShare, handleSwipeDelete]);

  const renderEmpty = () => {
    if (loading) return null;
    if (searchQuery.trim()) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyTitle, { color: c.ink2 }]}>No results</Text>
          <Text style={[styles.emptySubtitle, { color: c.ink3 }]}>
            Nothing matches "{searchQuery.trim()}"
          </Text>
        </View>
      );
    }
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
        {folderStack.length > 1 && !searchActive && (
          <TouchableOpacity
            style={[styles.backButton, { backgroundColor: c.paper2, borderColor: c.line }]}
            onPress={() => navigateToBreadcrumb(folderStack.length - 2)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.backButtonText, { color: c.ink2 }]}>{'‹'}</Text>
          </TouchableOpacity>
        )}
        <Text style={[styles.title, { color: c.ink }]}>{currentFolder.name}</Text>
        <View style={{ flex: 1 }} />
        {!searchActive && (
          <TouchableOpacity
            onPress={handleSortPress}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.searchButton}
          >
            <Ionicons
              name="swap-vertical"
              size={20}
              color={sortOrder !== 'date-desc' ? c.amberDeep : c.ink2}
            />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={handleSearchToggle}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.searchButton}
        >
          <Ionicons
            name={searchActive ? 'close' : 'search'}
            size={20}
            color={searchActive ? c.amberDeep : c.ink2}
          />
        </TouchableOpacity>
      </View>

      {/* Search bar — slides in below header when active */}
      {searchActive && (
        <View style={styles.searchBar}>
          <TextInput
            ref={searchInputRef}
            style={[styles.searchInput, { backgroundColor: c.paper2, borderColor: c.line, color: c.ink }]}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search in this folder..."
            placeholderTextColor={c.ink4}
            autoFocus
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
          <TouchableOpacity onPress={handleSearchToggle} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={{ color: c.amberDeep, fontSize: 14, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Breadcrumbs (only show when navigated into a folder, not during search) */}
      {folderStack.length > 1 && !searchActive && renderBreadcrumbs()}

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

      {/* Inline upload progress (shown while a file is uploading) */}
      {uploadingName && (
        <View
          style={[
            styles.uploadBanner,
            {
              bottom: 24 + insets.bottom + 64,
              backgroundColor: c.paper2,
              borderColor: c.line,
            },
          ]}
        >
          <ActivityIndicator color={c.amber} size="small" />
          <Text style={[styles.uploadBannerText, { color: c.ink2 }]} numberOfLines={1}>
            Uploading {uploadingName}...
          </Text>
        </View>
      )}

      {/* Floating action button */}
      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom, backgroundColor: c.amber }]}
        activeOpacity={0.8}
        onPress={handleFabPress}
        disabled={!!uploadingName}
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
  searchBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 10 },
  searchInput: { flex: 1, height: 36, borderRadius: radii.md, paddingHorizontal: 12, fontSize: 15, borderWidth: 1 },
  searchButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  // Breadcrumbs
  breadcrumbRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, flexWrap: 'wrap', gap: 2 },
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center' },
  breadcrumbSep: { fontSize: 12, marginHorizontal: 4 },
  breadcrumbText: { fontSize: 12, fontWeight: '500' },
  breadcrumbTextActive: { fontWeight: '600' },

  // Swipe actions
  swipeActions: { flexDirection: 'row' },
  swipeAction: { width: 72, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeActionLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },

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

  // Upload progress banner
  uploadBanner: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    ...shadows.lg,
  },
  uploadBannerText: { fontSize: 13, flex: 1, fontWeight: '500' },
});
