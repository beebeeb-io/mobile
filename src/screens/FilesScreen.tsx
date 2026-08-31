import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { Icon } from '../components/Icon';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as DocumentPicker from 'expo-document-picker';
import { isFileLocked, lockFile, unlockFile } from '../lib/file-locks';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Clipboard from 'expo-clipboard';
import { fonts, radii, spacing, shadows } from '../theme';
import { useTheme } from '../lib/theme-context';
import { UploadActivityCard } from '../components/UploadActivityCard';
import type { UploadActivityState, UploadStage } from '../components/UploadActivityCard';
import { useToast } from '../lib/toast-context';
import SkeletonRow from '../components/SkeletonRow';
import PresenceAvatars from '../components/PresenceAvatars';
import TrustDetailsSheet from '../components/TrustDetailsSheet';
import FolderPickerModal, { type PickerFolder } from '../components/FolderPickerModal';
import ExportProgressBanner, { type ExportProgressBannerHandle } from '../components/ExportProgressBanner';
import { ApiError, listAllFiles, getFileIndex, createFolder, deleteFile, trashFiles, renameFile, moveFile, uploadFile, friendlyError, getStorageUsage, createProofOfExistence, storageLocation, trustLocation, getFolderPresence, getUploadStatus, getApiUrl, getToken } from '../lib/api';
import { guessMimeType, fileCategory as fileCategoryFromMime } from '../lib/media';
import { generateAndUploadThumbnail, fetchDecryptedThumbnailUri } from '../lib/thumbnail';
import { maybeSelfRepairThumbnailFromLocalFile } from '../lib/thumbnail-self-repair';
import { getCachedThumbnail } from '../lib/thumbnail-cache';
import { getLocalIdentifier } from '../lib/local-identifier-map';
import type { FileEntry, StorageUsage, ProofOfExistence, PresenceUser, SyncNode } from '../lib/api';
import type { RootStackParamList, TabParamList } from '../App';
import { useCrypto } from '../lib/crypto-context';
import { decryptMetadata as decryptMetadataWithKey } from '../../modules/beebeeb-crypto';
import { isRequestUpload } from '../lib/file-request-crypto';
import { encryptedMetadataPayloadToBytes, encryptedMetadataToJson, fileMetadataPlaintext } from '../lib/encrypted-metadata';
import { syncDecryptedEntriesToFileProvider, removeFromFileProviderCache } from '../lib/file-provider-mount';
import { useAuth } from '../lib/auth';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { useSync } from '../lib/sync-context';
import { useSearchIndex } from '../lib/use-search-index';
import { onFilesDeleted } from '../lib/delete-cascade';
import { loadNameCache, scheduleSaveNameCache, type NameCache } from '../lib/name-cache';
import { recordRuntimeTrace } from '../lib/runtime-trace';
import { offlineManager, type OfflineStatus } from '../lib/offline-manager';
import { useOfflineVersion } from '../lib/use-offline';
import { decryptToTempFile } from '../lib/native-decrypt';
import { BBActionSheet, type ActionSheetRow, type ActionSheetFileHeader } from '../components/BBActionSheet';
import { MenuView, type MenuAction, type NativeActionEvent } from '@react-native-menu/menu';
import { useBackup } from '../lib/backup-context';
import type { SearchIndexEntry, SearchResult } from '../lib/search-index';
import { donateSiriShortcut } from '../lib/siri-shortcuts';
import { perfMark } from '../lib/perf-mark';
import { loadCachedFileIndex, saveCachedFileIndex, type CachedFileIndex } from '../lib/file-index-cache';
import { formatBytes as formatSize } from '../lib/format';
import {
  appendFolderToBreadcrumbStack,
  filterSelfChildEntries,
  folderCacheKey,
  shouldApplyFilesForFolderToVisibleRows,
  shouldApplyFolderRequestToVisibleState,
  type BreadcrumbEntry,
} from '../lib/folder-navigation';

// Tracks the currently open Swipeable so we can close it when another opens.
let _openSwipeable: Swipeable | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an ISO date string into a relative or short date. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'just now';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return 'just now';
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

async function copyPhotoAssetToUploadCache(sourceUri: string, fileId: string, name: string): Promise<string> {
  if (!FileSystem.cacheDirectory) return sourceUri;
  const safeName = name.replace(/[^a-zA-Z0-9._()-]/g, '_');
  const targetUri = `${FileSystem.cacheDirectory}upload-${fileId}-${safeName || 'photo.jpg'}`;
  await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => {});
  await FileSystem.copyAsync({ from: sourceUri, to: targetUri });
  return targetUri;
}

/**
 * Fallback display name for an encrypted filename when crypto is unavailable.
 * Returns a friendly label for JSON-encrypted names instead of raw ciphertext.
 */
function displayName(entry: FileEntry): string {
  const raw = entry.name_encrypted;
  if (!raw) return entry.is_folder ? 'Untitled folder' : 'Untitled file';
  if (raw.startsWith('{')) return '';
  if (raw.length > 32) return raw.slice(0, 24) + '...';
  return raw;
}


function toSearchIndexEntry(file: FileEntry, name: string, parent: string | null): SearchIndexEntry {
  return {
    name,
    path: name,
    type: file.is_folder ? 'folder' : (file.mime_type ?? ''),
    size: file.size_bytes ?? 0,
    parent,
    starred: false,
    created: file.created_at,
    modified: file.updated_at,
    tags: [],
  };
}

function searchResultToFileEntry(result: SearchResult): FileEntry {
  const isFolder = result.entry.type === 'folder';
  return {
    id: result.id,
    name_encrypted: result.entry.name,
    mime_type: isFolder ? null : (result.entry.type || null),
    size_bytes: result.entry.size,
    is_folder: isFolder,
    chunk_count: 0,
    created_at: result.entry.created,
    updated_at: result.entry.modified,
  };
}

function parseDecryptedMetadata(plaintext: string): { name: string; mimeType: string | null } {
  try {
    const metadata = JSON.parse(plaintext) as { name?: unknown; mime_type?: unknown };
    if (metadata && typeof metadata === 'object' && typeof metadata.name === 'string') {
      const name = metadata.name.trim();
      if (name) {
        return {
          name,
          mimeType: typeof metadata.mime_type === 'string' ? metadata.mime_type : null,
        };
      }
    }
  } catch {
    // Legacy metadata format: plaintext is the bare filename.
  }
  return { name: plaintext || 'Encrypted file', mimeType: null };
}

// 0777 — map a row-action label to its leading icon for the BBActionSheet.
function rowActionIcon(label: string): React.ComponentProps<typeof Ionicons>['name'] {
  switch (label) {
    case 'Rename': return 'pencil-outline';
    case 'Preview': return 'eye-outline';
    case 'Open': return 'folder-open-outline';
    case 'Share': return 'link-outline';
    case 'Save to Files': return 'download-outline';
    case 'Save to Photos': return 'images-outline';
    case 'Move to...': return 'folder-outline';
    case 'Make available offline':
    case 'Remove offline': return 'arrow-down-circle-outline';
    case 'Create proof': return 'shield-checkmark-outline';
    case 'Lock file': return 'lock-closed-outline';
    case 'Unlock file': return 'lock-open-outline';
    case 'Pin to top':
    case 'Unpin': return 'pin-outline';
    case 'Move to Trash':
    case 'Delete': return 'trash-outline';
    case 'Details': return 'information-circle-outline';
    default: return 'ellipsis-horizontal';
  }
}

// 1104 — stable testID for a row-action so Maestro/E2E can tap it by id
// (RN testID → iOS accessibilityIdentifier). Toggle labels collapse to one
// stable id (offline/lock/pin/delete/preview) so a flow doesn't depend on the
// current toggle state.
function sheetActionTestId(label: string): string {
  switch (label) {
    case 'Rename': return 'sheet-action-rename';
    case 'Preview':
    case 'Open': return 'sheet-action-preview';
    case 'Share': return 'sheet-action-share';
    case 'Save to Files': return 'sheet-action-save-files';
    case 'Save to Photos': return 'sheet-action-save-photos';
    case 'Move to...': return 'sheet-action-move';
    case 'Make available offline':
    case 'Remove offline': return 'sheet-action-offline';
    case 'Create proof': return 'sheet-action-proof';
    case 'Lock file':
    case 'Unlock file': return 'sheet-action-lock';
    case 'Pin to top':
    case 'Unpin': return 'sheet-action-pin';
    case 'Move to Trash':
    case 'Delete': return 'sheet-action-delete';
    case 'Details': return 'sheet-action-details';
    default:
      return `sheet-action-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  }
}

/**
 * Project a SyncNode (CRDT tree node) onto the FileEntry shape the rest of
 * the screen consumes. Both shapes already share most fields — this is a
 * narrowing pick so we can swap data sources without changing the UI.
 */
function syncNodeToFileEntry(node: SyncNode): FileEntry {
  return {
    id: node.id,
    name_encrypted: node.name_encrypted,
    mime_type: node.mime_type,
    size_bytes: node.size_bytes,
    is_folder: node.is_folder,
    is_uploading: node.is_uploading,
    chunk_count: node.chunk_count ?? 1,
    created_at: node.created_at,
    updated_at: node.updated_at,
    storage_pool_id: node.storage_pool_id,
    parent_id: node.parent_id,
    has_thumbnail: node.has_thumbnail,
    is_starred: node.is_starred,
  };
}

function uniqueFileEntries(entries: FileEntry[]): FileEntry[] {
  const seen = new Set<string>();
  const unique: FileEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function upsertFileEntry(entries: FileEntry[], entry: FileEntry): FileEntry[] {
  return [entry, ...entries.filter((current) => current.id !== entry.id)];
}

function filesForFolderFromIndex(index: CachedFileIndex, parentId: string | null): FileEntry[] {
  return filterSelfChildEntries(
    index.files.filter((entry) => (entry.parent_id ?? null) === parentId),
    parentId,
  );
}

/** Determine a file type category from the mime type. */
function fileCategory(entry: FileEntry): 'folder' | 'image' | 'pdf' | 'audio' | 'video' | 'doc' | 'file' {
  return fileCategoryFromMime(entry.mime_type, entry.is_folder);
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const CATEGORY_ICONS: Record<string, IoniconName> = {
  folder: 'folder',
  image: 'image',
  pdf: 'document-text',
  audio: 'musical-notes',
  video: 'videocam',
  doc: 'document',
  file: 'document-outline',
};

// ---------------------------------------------------------------------------
// Duplicate-file conflict helpers
// ---------------------------------------------------------------------------

/**
 * Return a unique filename by appending (1), (2), … until there's no
 * collision with `existingNames` (lowercased names of files in the folder).
 */
function getUniqueMobileName(name: string, existingNames: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext  = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  let candidate = name;
  while (existingNames.has(candidate.toLowerCase())) {
    candidate = `${base} (${n})${ext}`;
    n++;
  }
  return candidate;
}

type ConflictChoice =
  | { action: 'replace'; existingId: string }
  | { action: 'keep-both'; finalName: string }
  | { action: 'cancel' };

/**
 * Show a native Alert dialog asking the user what to do when a filename
 * already exists in the current folder.
 * Returns a Promise that resolves with the user's choice.
 */
function promptFileConflict(
  filename: string,
  existingId: string,
  uniqueName: string,
): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    Alert.alert(
      `"${filename}" already exists`,
      'What would you like to do?',
      [
        {
          text: 'Replace',
          onPress: () => resolve({ action: 'replace', existingId }),
        },
        {
          text: 'Keep both',
          onPress: () => resolve({ action: 'keep-both', finalName: uniqueName }),
        },
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => resolve({ action: 'cancel' }),
        },
      ],
    );
  });
}

// ---------------------------------------------------------------------------
// Offline files
// ---------------------------------------------------------------------------

// Offline files + folders are owned by the process-wide `offlineManager`
// (src/lib/offline-manager.ts) — download queue, byte progress, manifest.

// ---------------------------------------------------------------------------
// Offline status indicator (0793) — queued → downloading N% → available
// ---------------------------------------------------------------------------

const OfflineIndicator = React.memo(function OfflineIndicator({
  status,
  variant = 'row',
}: {
  status?: OfflineStatus;
  variant?: 'row' | 'grid';
}) {
  const { colors: c } = useTheme();
  if (!status) return null;
  const iconSize = variant === 'grid' ? 11 : 18;

  if (status.state === 'available') {
    return (
      <Ionicons
        name="arrow-down-circle"
        size={iconSize}
        color={c.amberDeep}
        style={variant === 'grid' ? styles.offlineBadge : styles.offlineIndicator}
        accessibilityLabel="Available offline"
      />
    );
  }
  if (status.state === 'error') {
    return (
      <Ionicons
        name="alert-circle"
        size={iconSize}
        color={c.red}
        style={variant === 'grid' ? styles.offlineBadge : styles.offlineIndicator}
        accessibilityLabel="Offline download failed"
      />
    );
  }
  // queued | downloading
  const pct = Math.round((status.progress ?? 0) * 100);
  if (variant === 'grid') {
    return <ActivityIndicator size="small" color={c.amber} style={styles.offlineBadge} />;
  }
  return (
    <View
      style={styles.offlineIndicator}
      accessibilityLabel={status.state === 'queued' ? 'Queued for offline' : `Downloading, ${pct} percent`}
    >
      <ActivityIndicator size="small" color={c.amber} />
      {status.state === 'downloading' && (
        <Text style={[styles.offlinePct, { color: c.amberDeep }]}>{pct}%</Text>
      )}
    </View>
  );
});


// ---------------------------------------------------------------------------
// Breadcrumb item
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// File icon component
// ---------------------------------------------------------------------------

const FileIcon = React.memo(function FileIcon({
  category, size = 32, fileId, hasThumbnail,
}: { category: string; size?: number; fileId?: string; hasThumbnail?: boolean }) {
  const { colors: c } = useTheme();
  const { getFileKeyBytes } = useCrypto();
  const [thumbUri, setThumbUri] = useState<string | null>(null);

  useEffect(() => {
    if (!fileId || !hasThumbnail) return;
    let cancelled = false;
    (async () => {
      try {
        // PhotoKit-backed files have their cache file written by the Photos
        // tab's PhotoKit short-circuit. Don't run the encrypted-blob fetch
        // here — it would race the PhotoKit path and overwrite the higher-
        // quality render with the lower-quality server thumbnail (task 0563).
        // If a cached version exists already, use it directly. Otherwise the
        // category icon fallback below is fine for the small list-row icon.
        if (getLocalIdentifier(fileId)) {
          const cached = await getCachedThumbnail(fileId);
          if (cached && !cancelled) setThumbUri(cached);
          return;
        }
        const fileKey = await getFileKeyBytes(fileId);
        if (!fileKey || cancelled) return;
        const uri = await fetchDecryptedThumbnailUri(fileId, fileKey);
        if (uri && !cancelled) setThumbUri(uri);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [fileId, hasThumbnail, getFileKeyBytes]);
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
  const icon: IoniconName = CATEGORY_ICONS[category] ?? 'document-outline';
  const iconSize = Math.round(size * 0.5);
  const borderRadius = size >= 48 ? radii.lg : size >= 40 ? radii.md : radii.sm;
  if (thumbUri) {
    return (
      <Image
        source={{ uri: thumbUri }}
        style={[styles.fileIcon, { width: size, height: size, borderRadius }]}
        resizeMode="cover"
      />
    );
  }
  return (
    <View style={[styles.fileIcon, { backgroundColor: bg, width: size, height: size, borderRadius }]}>
      <Ionicons name={icon} size={iconSize} color="#FFFFFF" />
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
  onTrustPress: (item: FileEntry) => void;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: (item: FileEntry) => void;
  sortOrder: SortOrder;
  offlineStatus: OfflineStatus | undefined;
  hasProof: boolean;
  isShared: boolean;
  isLocked: boolean;
}

const FileRowItem = React.memo(function FileRowItem({
  item,
  decryptedName,
  onPress,
  onLongPress,
  onShare,
  onDelete,
  onTrustPress,
  selectMode,
  isSelected,
  onToggleSelect,
  sortOrder,
  offlineStatus,
  hasProof,
  isShared,
  isLocked,
}: FileRowItemProps) {
  const { colors: c } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const category = fileCategory(item);
  const isEncryptedFallback = !decryptedName && !!item.name_encrypted?.startsWith('{');
  const nameText = decryptedName ?? displayName(item);
  const isPendingUpload = !item.is_folder && item.is_uploading === true;

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

  // Right side (revealed by swiping right-to-left) is the destructive
  // Trash action; left side (swiping left-to-right) is the constructive
  // Share action — matches iOS Mail / Files conventions and the runbook.
  const renderRightActions = useCallback(() => (
    <View style={styles.swipeActions}>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: c.red }]}
        activeOpacity={0.8}
        onPress={() => {
          swipeableRef.current?.close();
          onDelete(item);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Move ${nameText} to trash`}
      >
        <Icon name="trash" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Trash</Text>
      </TouchableOpacity>
    </View>
  ), [c.red, item, onDelete, nameText]);

  const renderLeftActions = useCallback(() => (
    <View style={styles.swipeActions}>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: c.amber }]}
        activeOpacity={0.8}
        onPress={() => {
          swipeableRef.current?.close();
          onShare(item);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Share ${nameText}`}
      >
        <Icon name="share" size={20} color="#fff" />
        <Text style={styles.swipeActionLabel}>Share</Text>
      </TouchableOpacity>
    </View>
  ), [c.amber, item, onShare, nameText]);

  const rowContent = (
    <TouchableOpacity
      style={[styles.fileRow, { borderBottomColor: c.line, backgroundColor: c.paper }]}
      activeOpacity={0.6}
      onPress={() => selectMode ? onToggleSelect(item) : onPress(item)}
      onLongPress={selectMode ? undefined : () => onLongPress(item)}
      delayLongPress={400}
      accessibilityLabel={selectMode ? `${isSelected ? 'Deselect' : 'Select'} ${nameText}` : `${nameText}${isPendingUpload ? ', upload pending' : ''}`}
      accessibilityRole="button"
      accessibilityState={selectMode ? { selected: isSelected } : undefined}
    >
      {selectMode && (
        <View style={[
          styles.checkbox,
          { borderColor: isSelected ? c.amber : c.line2 },
          isSelected && { backgroundColor: c.amber },
        ]}>
          {isSelected && <Icon name="check" size={13} color="#fff" />}
        </View>
      )}
      <FileIcon category={category} fileId={item.id} hasThumbnail={item.has_thumbnail} />
      <View style={styles.fileInfo}>
        <View style={styles.fileNameRow}>
          {isEncryptedFallback ? (
            <View style={{ height: 14, width: 100 + (item.id.charCodeAt(0) % 100), borderRadius: 4, backgroundColor: c.line }} />
          ) : (
            <Text
              style={[styles.fileName, { color: c.ink }]}
              numberOfLines={2}
            >
              {nameText}
            </Text>
          )}
          {isShared && (
            <Ionicons
              name="people-outline"
              size={12}
              color={c.ink3}
              style={styles.sharedBadge}
              accessibilityLabel="Shared folder"
            />
          )}
          {hasProof && (
            <Ionicons
              name="shield-checkmark"
              size={11}
              color={c.amberDeep}
              style={styles.proofBadge}
              accessibilityLabel="Proof of existence"
            />
          )}
          {isLocked && (
            <Icon
              name="lock"
              size={11}
              color={c.ink3}
              style={styles.lockedBadge}
            />
          )}
        </View>
        <Text style={[styles.fileMeta, { color: c.ink3 }]}>
          {(() => {
            const loc = storageLocation(item.storage_pool_id);
            const locSuffix = loc.shortCode ? `  ·  ${loc.shortCode}` : '';
            if (item.is_folder) return `${formatDate(item.updated_at)}${locSuffix}`;
            if (isPendingUpload) return `Upload pending  ·  ${formatSize(item.size_bytes)}  ·  started ${formatDate(item.created_at)}${locSuffix}`;
            if (sortOrder === 'size-desc' || sortOrder === 'size-asc') return `${formatSize(item.size_bytes)}${locSuffix}`;
            return `${formatSize(item.size_bytes)}  ·  ${formatDate(item.updated_at)}${locSuffix}`;
          })()}
        </Text>
        {!item.is_folder && (
          <Text style={[styles.cryptoMeta, { color: c.ink4 }]} numberOfLines={1}>
            {isPendingUpload
              ? 'Waiting for encrypted chunks'
              : `AES-256-GCM · ${trustLocation(item.storage_pool_id).region} · ${trustLocation(item.storage_pool_id).city}`}
          </Text>
        )}
      </View>
      {!selectMode && <OfflineIndicator status={offlineStatus} variant="row" />}
      {!selectMode && !item.is_folder && !isPendingUpload && (
        <TouchableOpacity
          onPress={() => onTrustPress(item)}
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
          style={styles.trustLock}
          accessibilityRole="button"
          accessibilityLabel={`Encryption details for ${nameText}`}
        >
          <Icon name="lock" size={13} color={c.amberDeep} />
        </TouchableOpacity>
      )}
      {!selectMode && (
        <TouchableOpacity
          onPress={() => onLongPress(item)}
          hitSlop={{ top: 10, right: 6, bottom: 10, left: 10 }}
          style={styles.moreButton}
          accessibilityRole="button"
          accessibilityLabel={`Actions for ${nameText}`}
          // Maestro/E2E cannot target this by accessibilityLabel — on this app only
          // testID (→ iOS accessibilityIdentifier) matches reliably (see 1284, filed as 1206). Without
          // it, every flow that opens a row menu is stuck with brittle coordinate taps.
          // Keyed by file id so sibling rows are unambiguous.
          testID={`file-row-actions-${item.id}`}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={c.ink3} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );

  if (selectMode) return rowContent;

  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      onSwipeableOpen={handleSwipeOpen}
      onSwipeableClose={handleSwipeClose}
      overshootLeft={false}
      overshootRight={false}
      leftThreshold={40}
      rightThreshold={40}
    >
      {rowContent}
    </Swipeable>
  );
});

// ---------------------------------------------------------------------------
// File grid item (memoized)
// ---------------------------------------------------------------------------

interface FileGridItemProps {
  item: FileEntry;
  decryptedName: string | undefined;
  onPress: (item: FileEntry) => void;
  onLongPress: (item: FileEntry) => void;
  onTrustPress: (item: FileEntry) => void;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: (item: FileEntry) => void;
  sortOrder: SortOrder;
  cardWidth: number;
  offlineStatus: OfflineStatus | undefined;
  hasProof: boolean;
  isShared: boolean;
  isLocked: boolean;
}

const FileGridItem = React.memo(function FileGridItem({
  item,
  decryptedName,
  onPress,
  onLongPress,
  onTrustPress,
  selectMode,
  isSelected,
  onToggleSelect,
  sortOrder,
  cardWidth,
  offlineStatus,
  hasProof,
  isShared,
  isLocked,
}: FileGridItemProps) {
  const { colors: c } = useTheme();
  const category = fileCategory(item);
  const isEncryptedFallback = !decryptedName && !!item.name_encrypted?.startsWith('{');
  const nameText = decryptedName ?? displayName(item);
  const isFolder = item.is_folder;
  const isPendingUpload = !isFolder && item.is_uploading === true;

  const loc = storageLocation(item.storage_pool_id);
  const locSuffix = loc.shortCode ? ` · ${loc.shortCode}` : '';
  const metaText = isFolder
    ? `${formatDate(item.updated_at)}${locSuffix}`
    : isPendingUpload
      ? `Upload pending · ${formatSize(item.size_bytes)}${locSuffix}`
    : (sortOrder === 'size-desc' || sortOrder === 'size-asc')
      ? `${formatSize(item.size_bytes)}${locSuffix}`
      : `${formatSize(item.size_bytes)} · ${formatDate(item.updated_at)}${locSuffix}`;

  return (
    <TouchableOpacity
      style={[
        styles.gridCard,
        {
          width: cardWidth,
          backgroundColor: isFolder ? c.amberBg : c.paper,
          borderColor: isSelected ? c.amber : c.line,
          borderWidth: isSelected ? 2 : StyleSheet.hairlineWidth,
        },
        shadows.sm,
      ]}
      activeOpacity={0.7}
      onPress={() => selectMode ? onToggleSelect(item) : onPress(item)}
      onLongPress={selectMode ? undefined : () => onLongPress(item)}
      delayLongPress={400}
      accessibilityLabel={selectMode ? `${isSelected ? 'Deselect' : 'Select'} ${nameText}` : `${nameText}${isPendingUpload ? ', upload pending' : ''}`}
      accessibilityRole="button"
      accessibilityState={selectMode ? { selected: isSelected } : undefined}
    >
      {selectMode && (
        <View style={[
          styles.gridCheckbox,
          { borderColor: isSelected ? c.amber : c.line2, backgroundColor: isSelected ? c.amber : c.paper },
        ]}>
          {isSelected && <Icon name="check" size={12} color="#fff" />}
        </View>
      )}
      <View style={styles.gridIconWrap}>
        <FileIcon category={category} size={isFolder ? 56 : 48} fileId={item.id} hasThumbnail={item.has_thumbnail} />
      </View>
      <View style={styles.gridTextWrap}>
        <View style={styles.gridNameRow}>
          {isEncryptedFallback ? (
            <View style={{ height: 12, width: 60 + (item.id.charCodeAt(0) % 40), borderRadius: 3, backgroundColor: c.line }} />
          ) : (
            <Text
              style={[styles.gridName, { color: c.ink }]}
              numberOfLines={2}
            >
              {nameText}
            </Text>
          )}
          {isShared && (
            <Ionicons
              name="people-outline"
              size={11}
              color={c.ink3}
              style={styles.sharedBadge}
              accessibilityLabel="Shared folder"
            />
          )}
          <OfflineIndicator status={offlineStatus} variant="grid" />
          {hasProof && (
            <Ionicons
              name="shield-checkmark"
              size={10}
              color={c.amberDeep}
              style={styles.proofBadge}
              accessibilityLabel="Proof of existence"
            />
          )}
          {isLocked && (
            <Icon
              name="lock"
              size={10}
              color={c.ink3}
              style={styles.lockedBadge}
            />
          )}
        </View>
        <Text style={[styles.gridMeta, { color: c.ink3 }]} numberOfLines={1}>
          {metaText}
        </Text>
        {!isFolder && (
          <Text style={[styles.cryptoMetaGrid, { color: c.ink4 }]} numberOfLines={1}>
            {isPendingUpload ? 'Waiting for chunks' : `AES-256-GCM · ${trustLocation(item.storage_pool_id).city}`}
          </Text>
        )}
      </View>
      {!selectMode && !isFolder && !isPendingUpload && (
        <TouchableOpacity
          onPress={() => onTrustPress(item)}
          hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
          style={styles.gridTrustLock}
          accessibilityRole="button"
          accessibilityLabel={`Encryption details for ${nameText}`}
        >
          <Icon name="lock" size={11} color={c.amberDeep} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
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

// 0789 — trailing SF Symbol per sort row in the native iOS UIMenu pull-down.
// The symbol names the sort key (name / date / size); the active row also gets
// the system checkmark (MenuAction.state = 'on'). iOS renders SF Symbols on the
// trailing edge of a UIMenu row, exactly the Apple Music pattern Guus asked for.
const SORT_SF_SYMBOL: Record<SortOrder, string> = {
  'name-asc': 'textformat',
  'name-desc': 'textformat',
  'date-desc': 'calendar',
  'date-asc': 'calendar',
  'size-desc': 'arrow.up.arrow.down',
  'size-asc': 'arrow.up.arrow.down',
};

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
// ProofDetailModal — full-screen modal showing a proof of existence
// ---------------------------------------------------------------------------

interface ProofDetailModalProps {
  proof: ProofOfExistence;
  fileName: string;
  onClose: () => void;
  showToast: (opts: { type: 'success' | 'error'; message: string }) => void;
}

function ProofDetailModal({ proof, fileName, onClose, showToast }: ProofDetailModalProps) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [sharing, setSharing] = useState(false);

  // ISO timestamp + formatted local time
  const isoTime = proof.timestamp;
  const localTime = (() => {
    try {
      return new Date(isoTime).toLocaleString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short',
      });
    } catch {
      return isoTime;
    }
  })();

  const proofText = [
    'Beebeeb Proof of Existence',
    '',
    `File: ${fileName}`,
    `SHA-256: ${proof.hash}`,
    `Timestamp (ISO 8601): ${isoTime}`,
    `Timestamp (local): ${localTime}`,
    `Proof ID: ${proof.proofId}`,
    '',
    'Proof stored on Beebeeb servers. This timestamp proves the file existed at this moment.',
    `Verify: https://beebeeb.io/verify/${proof.proofId}`,
  ].join('\n');

  const handleShare = async () => {
    setSharing(true);
    try {
      if (await Sharing.isAvailableAsync()) {
        // Write to a temp .txt file so the share sheet treats it as a document
        const tmpPath = `${FileSystem.cacheDirectory}beebeeb-proof-${proof.proofId.slice(0, 8)}.txt`;
        await FileSystem.writeAsStringAsync(tmpPath, proofText, { encoding: FileSystem.EncodingType.UTF8 });
        await Sharing.shareAsync(tmpPath, {
          mimeType: 'text/plain',
          dialogTitle: 'Share proof',
          UTI: 'public.plain-text',
        });
        FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
      } else {
        // Fallback: copy to clipboard
        await Clipboard.setStringAsync(proofText);
        showToast({ type: 'success', message: 'Proof copied to clipboard' });
      }
    } catch {
      showToast({ type: 'error', message: 'Could not share proof' });
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={[proofStyles.root, { backgroundColor: c.paper }]}>
      {/* Header */}
      <View style={[proofStyles.header, { borderBottomColor: c.line, paddingTop: insets.top + 16 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[proofStyles.title, { color: c.ink }]}>Proof of existence</Text>
          <Text style={[proofStyles.subtitle, { color: c.ink3 }]} numberOfLines={1}>{fileName}</Text>
        </View>
        <TouchableOpacity onPress={onClose} accessibilityLabel="Close" style={proofStyles.closeBtn}>
          <Ionicons name="close" size={22} color={c.ink2} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={proofStyles.scroll}
        contentContainerStyle={[proofStyles.scrollContent, { paddingBottom: insets.bottom + 120 }]}
      >
        {/* SHA-256 hash */}
        <View style={[proofStyles.field, { borderColor: c.line, backgroundColor: c.paper2 }]}>
          <Text style={[proofStyles.fieldLabel, { color: c.ink3 }]}>SHA-256 hash</Text>
          <Text style={[proofStyles.hashText, { color: c.ink, borderColor: c.line }]} selectable>
            {proof.hash}
          </Text>
        </View>

        {/* Timestamps */}
        <View style={[proofStyles.field, { borderColor: c.line, backgroundColor: c.paper2 }]}>
          <Text style={[proofStyles.fieldLabel, { color: c.ink3 }]}>Timestamp</Text>
          <Text style={[proofStyles.monoText, { color: c.ink }]} selectable>{isoTime}</Text>
          <Text style={[proofStyles.localTime, { color: c.ink2 }]}>{localTime}</Text>
        </View>

        {/* Proof ID */}
        <View style={[proofStyles.field, { borderColor: c.line, backgroundColor: c.paper2 }]}>
          <Text style={[proofStyles.fieldLabel, { color: c.ink3 }]}>Proof ID</Text>
          <Text style={[proofStyles.monoText, { color: c.ink }]} selectable>{proof.proofId}</Text>
        </View>

        {/* Explanation */}
        <View style={[proofStyles.notice, { borderColor: c.amberDeep, backgroundColor: c.amberBg }]}>
          <Ionicons name="shield-checkmark-outline" size={16} color={c.amberDeep} />
          <Text style={[proofStyles.noticeText, { color: c.ink2 }]}>
            Proof stored on Beebeeb servers. This timestamp proves the file existed at this moment.
          </Text>
        </View>
      </ScrollView>

      {/* Footer with Share button */}
      <View style={[proofStyles.footer, { borderTopColor: c.line, paddingBottom: insets.bottom || 16, backgroundColor: c.paper }]}>
        <TouchableOpacity
          style={[proofStyles.shareBtn, { backgroundColor: c.amber, opacity: sharing ? 0.6 : 1 }]}
          onPress={() => void handleShare()}
          disabled={sharing}
          accessibilityRole="button"
          accessibilityLabel="Share proof"
        >
          {sharing ? (
            <ActivityIndicator color={c.ink} size="small" />
          ) : (
            <Ionicons name="share-outline" size={16} color={c.ink} />
          )}
          <Text style={[proofStyles.shareBtnText, { color: c.ink }]}>
            {sharing ? 'Preparing…' : 'Share proof'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const proofStyles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg, gap: spacing.md },
  field: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 6,
  },
  fieldLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  hashText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: 15,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    marginTop: 2,
  },
  monoText: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
  localTime: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: radii.md,
    gap: 8,
  },
  shareBtnText: { fontSize: 15, fontWeight: '600' },
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function FilesScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<TabParamList, 'Files'>>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved: themeScheme } = useTheme();
  const { showToast } = useToast();
  const { user, phraseVerified } = useAuth();
  const isAuthenticated = user !== null;
  const { backupProgress, includeVideos, isPhotoBackupEnabled } = useBackup();

  // Navigation state: stack of folders
  const [folderStack, setFolderStack] = useState<BreadcrumbEntry[]>([
    { id: null, name: 'Drive' },
  ]);
  const currentFolder = folderStack[folderStack.length - 1];

  // Breadcrumb collapsed-path popover. A deep path collapses to "Drive … current";
  // tapping "…" opens a CUSTOM popover anchored under the chip that draws the
  // in-between folders as an indented tree (the native UIMenu can't indent).
  const [breadcrumbPopoverOpen, setBreadcrumbPopoverOpen] = useState(false);
  const [breadcrumbAnchor, setBreadcrumbAnchor] =
    useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const breadcrumbChipRef = useRef<View>(null);

  // Data state
  const [files, setFiles] = useState<FileEntry[]>([]);
  const folderFilesCacheRef = useRef<Record<string, FileEntry[]>>({});
  const filesFolderKeyRef = useRef(folderCacheKey(currentFolder.id));
  const filesCountRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  // True once a fetch (or a non-empty sync snapshot) has produced an
  // authoritative result for this screen. Gates the empty-state copy so
  // "Upload your first file" never flashes before the first load completes.
  // Per-folder is excessive — login race is the only place this matters.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const hasLoadedOnceRef = useRef(false);
  const setHasLoadedOnceTrue = useCallback(() => {
    if (hasLoadedOnceRef.current) return;
    hasLoadedOnceRef.current = true;
    setHasLoadedOnce(true);
  }, []);

  // Search state
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput>(null);

  // Sort state
  const [sortOrder, setSortOrder] = useState<SortOrder>('date-desc');

  // View mode (list / grid) — persisted in SecureStore
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Pinned folders
  const [pinnedFolders, setPinnedFolders] = useState<{ id: string; name: string }[]>([]);

  // Offline state is owned by the process-wide offlineManager; this subscribes
  // the screen to its version counter so rows re-render on download progress.
  const offlineVersion = useOfflineVersion();

  // Proof of existence — fileId → proof. In-memory only; populated as the user
  // creates proofs. The badge shows for files in this map.
  const [proofs, setProofs] = useState<Record<string, ProofOfExistence>>({});

  // Proof modal — null when closed, populated when showing a created proof.
  const [proofModal, setProofModal] = useState<{ proof: ProofOfExistence; name: string } | null>(null);

  // Recent filter — true when the "Recent Files" quick action is active.
  // Filters the file list to files modified in the last 24 hours.
  const [recentFilterActive, setRecentFilterActive] = useState(false);

  // Per-file Face ID locks — set of file/folder IDs that require an extra
  // biometric confirmation before opening. Persisted in SecureStore via file-locks.ts.
  const [lockedFileIds, setLockedFileIds] = useState<Set<string>>(new Set());

  // Presence — collaborators currently viewing the folder we're inside.
  // Empty for the root view; only populated when navigated into a shared folder.
  const [presence, setPresence] = useState<PresenceUser[]>([]);

  // Crypto
  const { isUnlocked, unlockAttempted, decryptMetadata, decryptNames, encryptChunk, encryptMetadata, getFileKeyBytes, getRequestContentKey, getMasterKeyHandleId } = useCrypto();
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  // Task 0807: persistent (fileId,version) name cache + a ref mirror of
  // decryptedNames so the per-folder decrypt effect can read the latest names
  // without re-running on every name update (which would loop).
  const nameCacheRef = useRef<NameCache>({});
  const decryptedNamesRef = useRef<Record<string, string>>({});
  const decryptedMimeTypesRef = useRef<Record<string, string | null>>({});
  const [decryptedMimeTypes, setDecryptedMimeTypes] = useState<Record<string, string | null>>({});

  // Task 0807: keep a ref mirror of decryptedNames so the per-folder decrypt
  // effect can read the latest resolved names WITHOUT listing decryptedNames as
  // a dependency (which would re-fire the effect on every name update → loop).
  useEffect(() => {
    decryptedNamesRef.current = decryptedNames;
  }, [decryptedNames]);

  useEffect(() => {
    decryptedMimeTypesRef.current = decryptedMimeTypes;
  }, [decryptedMimeTypes]);

  // Task 0807 (Pillar 2): load the persistent (fileId,version) name cache from
  // disk ONCE and seed the in-memory maps from it, so a COLD launch renders real
  // names immediately — before the index round-trip and with zero on-device
  // decrypts. The per-folder effect later validates each name by version_number.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cache = await loadNameCache();
      if (cancelled) return;
      nameCacheRef.current = cache;
      const ids = Object.keys(cache);
      if (ids.length === 0) return;
      const seedNames: Record<string, string> = {};
      const seedMimes: Record<string, string | null> = {};
      for (const id of ids) {
        seedNames[id] = cache[id]!.name;
        if (cache[id]!.mime != null) seedMimes[id] = cache[id]!.mime;
      }
      // Existing (fresher) in-memory names win over the disk seed.
      setDecryptedNames((prev) => ({ ...seedNames, ...prev }));
      setDecryptedMimeTypes((prev) => ({ ...seedMimes, ...prev }));
    })();
    return () => { cancelled = true; };
  }, []);

  /** Find a non-folder file in the current folder whose decrypted name matches `filename`. */
  const findConflict = useCallback((filename: string): FileEntry | null => {
    if (!isUnlocked || Object.keys(decryptedNames).length === 0) return null;
    const lower = filename.toLowerCase();
    for (const f of files) {
      if (f.is_folder) continue;
      const decrypted = decryptedNames[f.id];
      if (decrypted?.toLowerCase() === lower) return f;
    }
    return null;
  }, [files, decryptedNames, isUnlocked]);

  /** Set of lowercased decrypted names of non-folder files in the current folder. */
  const folderFileNames = useCallback((): Set<string> => {
    const set = new Set<string>();
    for (const f of files) {
      if (f.is_folder) continue;
      const name = decryptedNames[f.id];
      if (name) set.add(name.toLowerCase());
    }
    return set;
  }, [files, decryptedNames]);

  // CRDT sync — when ready, the file list derives from the in-memory tree
  // and stays live (SSE pushes). Until then we fall back to listFiles().
  const sync = useSync();

  // Encrypted search index — fetched on unlock, queried on every keystroke
  // when the search bar is open. Powers the "in your vault" results hint
  // below the search bar; also kept in sync after create, rename, move, and delete.
  const { ready: searchIndexReady, search: searchVault, indexFile, getIndexedIds, allEntries } = useSearchIndex();

  // Task 0807 (Pillar 3): the unlock reconcile already decrypts the whole vault
  // into the search index — so seed decryptedNames from it as soon as it's ready.
  // Most folder opens (and re-opens) then resolve names with ZERO on-device
  // decrypts; only files missing from the index hit the batch decrypt.
  const indexSeededRef = useRef(false);
  useEffect(() => {
    if (!isUnlocked) {
      indexSeededRef.current = false;
      return;
    }
    if (!searchIndexReady || indexSeededRef.current) return;
    indexSeededRef.current = true;
    const entries = allEntries();
    const seedNames: Record<string, string> = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (entry?.name) seedNames[id] = entry.name;
    }
    if (Object.keys(seedNames).length > 0) {
      // Existing (version-validated) in-memory names win over the index seed.
      setDecryptedNames((prev) => ({ ...seedNames, ...prev }));
    }
  }, [isUnlocked, searchIndexReady, allEntries]);

  // 0778A — recursive search. The encrypted index is populated INCREMENTALLY (on
  // upload/rename), so files created on another device/client aren't in it and a
  // term that lives only in a nested folder returns "No results" (IMG_5520). Once
  // per unlock, reconcile the index against the FULL vault tree (sync.allNodes()):
  // decrypt + index every node not already present, so searchVault covers every
  // subtree. The index persists + syncs, so this is a one-time build per vault.
  const searchReconciledRef = useRef(false);
  useEffect(() => {
    if (!isUnlocked) {
      searchReconciledRef.current = false;
      return;
    }
    if (!searchIndexReady || !sync.ready || searchReconciledRef.current) return;
    searchReconciledRef.current = true;

    let cancelled = false;
    void (async () => {
      const indexed = getIndexedIds();
      const missing = sync
        .allNodes()
        .filter(
          (n) => !n.is_trashed && !indexed.has(n.id) && (n.name_encrypted ?? '').startsWith('{'),
        );
      const BATCH = 12;
      for (let i = 0; i < missing.length && !cancelled; i += BATCH) {
        await Promise.all(
          missing.slice(i, i + BATCH).map(async (node) => {
            try {
              const payload = encryptedMetadataPayloadToBytes(node.name_encrypted ?? '');
              if (!payload) return;
              const plaintext = await decryptMetadata(node.id, payload.nonce, payload.ciphertext);
              const { name } = parseDecryptedMetadata(plaintext);
              if (cancelled || !name) return;
              indexFile(node.id, {
                name,
                path: name,
                type: node.is_folder ? 'folder' : '',
                size: node.size_bytes ?? 0,
                parent: node.parent_id,
                starred: false,
                created: '',
                modified: '',
                tags: [],
              });
            } catch {
              // request-upload (content-key) or a transient decrypt failure — it
              // gets indexed when its folder is opened. Non-fatal.
            }
          }),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isUnlocked, searchIndexReady, sync, getIndexedIds, indexFile, decryptMetadata]);

  // 0789 — Sort + "+" add menus are now the real iOS UIMenu pull-down (MenuView),
  // anchored under the button. Only the file-row long-press still routes through the
  // reusable <BBActionSheet> (rowSheet); converting it to a native context menu is a
  // tracked follow-up (dynamic per-row actions + Swipeable gesture interplay).
  const [rowSheet, setRowSheet] = useState<{ header: ActionSheetFileHeader; rows: ActionSheetRow[] } | null>(null);
  const [rowSheetOpen, setRowSheetOpen] = useState(false);

  // 0796 — native nested folder picker for "Move". `null` = closed.
  const [movePicker, setMovePicker] = useState<{
    ids: string[];
    title: string;
    folders: PickerFolder[];
    currentParentId: string | null;
  } | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);

  // Upload state — drives the Live-Activity upload card above the FAB (1301).
  // stage 1 = encrypting · stage 2 = uploading · stage 3 = storing/done.
  const [upload, setUpload] = useState<UploadActivityState | null>(null);
  const uploadingName = upload?.fileName ?? null;

  // Trust details sheet — opened by tapping the lock icon on a row/grid cell.
  const [trustFile, setTrustFile] = useState<FileEntry | null>(null);
  const openTrust = useCallback((file: FileEntry) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTrustFile(file);
  }, []);
  const closeTrust = useCallback(() => setTrustFile(null), []);
  const trustFileName = trustFile
    ? (decryptedNames[trustFile.id] ?? displayName(trustFile))
    : '';
  const mimeTypeFor = useCallback((file: FileEntry): string | null => {
    const name = decryptedNames[file.id] ?? displayName(file);
    return decryptedMimeTypes[file.id] ?? file.mime_type ?? guessMimeType(name);
  }, [decryptedMimeTypes, decryptedNames]);
  const shouldAutoVersionUpload = useCallback((
    existingFile: FileEntry,
    incomingName: string,
    incomingMimeType: string | null | undefined,
    incomingSizeBytes: number | null | undefined,
  ): boolean => {
    const existingName = decryptedNames[existingFile.id] ?? displayName(existingFile);
    const existingMimeType = mimeTypeFor(existingFile) ?? guessMimeType(existingName);
    const resolvedIncomingMimeType = incomingMimeType ?? guessMimeType(incomingName);
    const sameType =
      !existingMimeType ||
      !resolvedIncomingMimeType ||
      existingMimeType.toLowerCase() === resolvedIncomingMimeType.toLowerCase();
    if (!sameType) return false;

    // Mobile does not have a stable hash for all picker assets yet. Size is the
    // cheap signal we have; when the picker omits size, prefer versioning over
    // creating "name (1)" duplicates for same-name, same-type uploads.
    return incomingSizeBytes == null || existingFile.size_bytes !== incomingSizeBytes;
  }, [decryptedNames, mimeTypeFor]);
  const withDecryptedMime = useCallback((file: FileEntry): FileEntry => {
    const mimeType = mimeTypeFor(file);
    return mimeType === file.mime_type ? file : { ...file, mime_type: mimeType };
  }, [mimeTypeFor]);

  // New-folder modal (Android — Alert.prompt is iOS-only). Drives a small
  // controlled Modal further down in the render tree.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Export state (1177) — a top-of-Files "Exporting…" indicator shown for the
  // whole prepare phase (download + decrypt → temp) of Save to Files / Save to
  // Photos, so a large file no longer looks frozen before the native sheet.
  // 1180 — `exporting` is ONLY a show/hide + name toggle. It flips exactly twice
  // per export (on start, on clear), never per progress tick — the per-tick
  // percentage lives inside <ExportProgressBanner/> and is fed imperatively via
  // `exportBannerRef` so a progress tick NEVER re-renders FilesScreen / its
  // FlatList (that render churn is what crashed 1177 on a 3 GB file, #188).
  const [exporting, setExporting] = useState<{ name: string } | null>(null);
  const exportBannerRef = useRef<ExportProgressBannerHandle>(null);

  // Scroll shadow — appears when list is scrolled past top
  const [isScrolled, setIsScrolled] = useState(false);

  // Resolve filenames for the current folder (task 0807 — folder-load perf).
  //
  // Cache/index FIRST, decrypt only the misses, and ONE batched native call for
  // the whole folder instead of N per-file bridge crossings:
  //   1. A name whose persistent (fileId,version) cache entry matches the row's
  //      version_number is a hit → 0 decrypts.
  //   2. A name already in the session map / search-index seed (no version
  //      conflict) is a hit → 0 decrypts.
  //   3. Everything else is a miss → ONE `decryptNames` batch call (master-key
  //      stays in the SE handle, 0556). Request-uploads (content-key) fall back
  //      to a per-file decrypt (rare).
  // The session map is NOT cleared per folder (it was at the old :1406); only on
  // lock. Results write through to the persistent cache for instant cold launch.
  useEffect(() => {
    if (!isUnlocked) {
      setDecryptedNames({});
      setDecryptedMimeTypes({});
      return;
    }
    const folderId = currentFolder.id;
    const folderKey = folderCacheKey(folderId);

    const encrypted = files.filter((f) => (f.name_encrypted ?? '').startsWith('{'));
    if (encrypted.length === 0) return;

    // ── Phase 1: seed from cache/index, collect misses ──────────────────────
    const knownNames = decryptedNamesRef.current;
    const knownMimes = decryptedMimeTypesRef.current;
    const cache = nameCacheRef.current;
    const seedNames: Record<string, string> = {};
    const seedMimes: Record<string, string | null> = {};
    const misses: FileEntry[] = [];
    let cacheHits = 0;

    for (const f of encrypted) {
      const version = f.version_number ?? 0;
      const cached = cache[f.id];
      if (cached && cached.version === version) {
        // Valid persistent-cache hit — surface it if not already shown.
        if (knownNames[f.id] == null) seedNames[f.id] = cached.name;
        if (cached.mime != null && knownMimes[f.id] == null) seedMimes[f.id] = cached.mime;
        cacheHits += 1;
        continue;
      }
      if (!cached && knownNames[f.id] != null) {
        // Index/session seed already provides the name and the row carries no
        // stale-version signal we can detect → trust it (index is kept current).
        cacheHits += 1;
        continue;
      }
      // No cache, or cache version is stale (renamed elsewhere) → must decrypt.
      misses.push(f);
    }

    if (Object.keys(seedNames).length > 0) setDecryptedNames((prev) => ({ ...seedNames, ...prev }));
    if (Object.keys(seedMimes).length > 0) setDecryptedMimeTypes((prev) => ({ ...seedMimes, ...prev }));

    if (misses.length === 0) {
      recordRuntimeTrace('files.folder_decrypt', {
        folderId, total: encrypted.length, cacheHits, batchDecrypted: 0, batchCalls: 0,
      });
      return;
    }

    // ── Phase 2: batch-decrypt the misses (ONE call) ────────────────────────
    let cancelled = false;
    let batchCalls = 0;
    void (async () => {
      const requestUploads = misses.filter((f) => isRequestUpload(f));
      const normal = misses.filter((f) => !isRequestUpload(f));
      const appliedNames: Record<string, string> = {};
      const appliedMimes: Record<string, string | null> = {};

      if (normal.length > 0) {
        try {
          batchCalls += 1;
          const results = await decryptNames(
            normal.map((f) => ({ fileId: f.id, nameEncrypted: f.name_encrypted ?? '' })),
          );
          if (cancelled) return;
          results.forEach((r, i) => {
            const f = normal[i];
            if (!f || !r || r.error || !r.name) return;
            appliedNames[f.id] = r.name;
            appliedMimes[f.id] = r.mimeType ?? null;
          });
        } catch {
          // Batch unavailable (JS-only build / locked) — leave misses unresolved;
          // displayName() shows "Encrypted file" rather than ciphertext.
        }
      }

      // Request-upload names (rare): per-file content-key decrypt.
      await Promise.all(
        requestUploads.map(async (f) => {
          if (cancelled) return;
          try {
            const payload = encryptedMetadataPayloadToBytes(f.name_encrypted ?? '');
            if (!payload) return;
            const plaintext = await decryptMetadataWithKey(
              await getRequestContentKey(f),
              payload.nonce,
              payload.ciphertext,
            );
            const md = parseDecryptedMetadata(plaintext);
            appliedNames[f.id] = md.name;
            appliedMimes[f.id] = md.mimeType;
          } catch {
            // leave unset
          }
        }),
      );

      if (cancelled) return;

      // Enrich MIME from the decrypted filename when the row has none.
      for (const f of misses) {
        if (f.is_folder || f.mime_type != null) continue;
        const nm = appliedNames[f.id];
        if (!nm || appliedMimes[f.id] != null) continue;
        const guessed = guessMimeType(nm);
        if (guessed) appliedMimes[f.id] = guessed;
      }

      // Write through to the persistent (fileId,version) cache + persist.
      let cacheChanged = false;
      for (const f of misses) {
        const nm = appliedNames[f.id];
        if (nm == null) continue;
        nameCacheRef.current[f.id] = {
          name: nm,
          mime: appliedMimes[f.id] ?? null,
          version: f.version_number ?? 0,
        };
        cacheChanged = true;
      }
      if (cacheChanged) scheduleSaveNameCache(nameCacheRef.current);

      if (Object.keys(appliedNames).length > 0) {
        setDecryptedNames((prev) => ({ ...prev, ...appliedNames }));
      }
      if (Object.keys(appliedMimes).length > 0) {
        setDecryptedMimeTypes((prev) => ({ ...prev, ...appliedMimes }));
      }

      recordRuntimeTrace('files.folder_decrypt', {
        folderId,
        total: encrypted.length,
        cacheHits,
        batchDecrypted: normal.length,
        requestUploads: requestUploads.length,
        batchCalls,
      });

      // Push decrypted names to the File Provider cache so the iOS Files app
      // shows real filenames instead of "Encrypted file".
      if (filesFolderKeyRef.current === folderKey) {
        void syncDecryptedEntriesToFileProvider(
          files,
          { ...decryptedNamesRef.current, ...appliedNames },
          folderId,
        ).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [currentFolder.id, files, isUnlocked, decryptNames, getRequestContentKey]);

  // Load pinned folders from SecureStore on mount
  useEffect(() => {
    SecureStore.getItemAsync('beebeeb_pinned_folders')
      .then((raw) => { if (raw) setPinnedFolders(JSON.parse(raw) as { id: string; name: string }[]); })
      .catch(() => {});
  }, []);

  // Hydrate the offline manager's manifest on mount (idempotent).
  useEffect(() => {
    void offlineManager.init();
  }, []);

  // Load per-file lock state on mount
  useEffect(() => {
    SecureStore.getItemAsync('beebeeb.locked_files')
      .then((raw) => { if (raw) setLockedFileIds(new Set(JSON.parse(raw) as string[])); })
      .catch(() => {});
  }, []);

  // Persist pinned folders whenever they change
  useEffect(() => {
    SecureStore.setItemAsync('beebeeb_pinned_folders', JSON.stringify(pinnedFolders)).catch(() => {});
  }, [pinnedFolders]);

  // Load persisted view mode on mount
  useEffect(() => {
    SecureStore.getItemAsync('beebeeb_view_mode')
      .then((raw) => { if (raw === 'grid' || raw === 'list') setViewMode(raw); })
      .catch(() => {});
  }, []);

  const toggleViewMode = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setViewMode((prev) => {
      const next = prev === 'list' ? 'grid' : 'list';
      SecureStore.setItemAsync('beebeeb_view_mode', next).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    filesCountRef.current = files.length;
    if (filesFolderKeyRef.current !== folderCacheKey(currentFolder.id)) return;
    if (files.length === 0) return;
    folderFilesCacheRef.current[folderCacheKey(currentFolder.id)] = files;
    // Run ONLY when `files` actually changes — NEVER on a bare folder change.
    // On the root→child navigation commit, the layout effect (above) has already
    // advanced filesFolderKeyRef to the new folder, but the closure `files` still
    // holds the PREVIOUS folder's rows (setFiles is async). With `currentFolder.id`
    // in the deps this effect fired on that boundary render and wrote the old
    // folder's rows under the NEW folder's cache key — poisoning e.g. a child's
    // cache with root's contents (the "open Backups, see root" bug). On a sparse
    // cold-start tree that poison then became session-permanent (the focus effect
    // trusts the poisoned cache instead of fetching). Depending on `files` alone
    // is sufficient: optimistic edits (upload/move/delete) all change the `files`
    // reference, and filesFolderKeyRef only advances in lock-step with a real
    // setFiles, so key↔content stay consistent. (Co-defect: sync-client flips
    // ready=true on a sparse catch-up tree — filed separately.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const applyFilesForFolder = useCallback((
    parentId: string | null,
    nextFiles: FileEntry[],
    options: { preserveCachedOnEmpty?: boolean } = {},
  ): boolean => {
    const unique = uniqueFileEntries(filterSelfChildEntries(nextFiles, parentId));
    const cacheKey = folderCacheKey(parentId);
    const shouldRender = shouldApplyFilesForFolderToVisibleRows(parentId, filesFolderKeyRef.current);
    if (unique.length > 0) {
      folderFilesCacheRef.current[cacheKey] = unique;
      if (!shouldRender) return false;
      filesFolderKeyRef.current = cacheKey;
      setFiles(unique);
      return true;
    }

    const cached = folderFilesCacheRef.current[cacheKey];
    if (options.preserveCachedOnEmpty && cached && cached.length > 0) {
      if (!shouldRender) return false;
      filesFolderKeyRef.current = cacheKey;
      setFiles(cached);
      return true;
    }

    delete folderFilesCacheRef.current[cacheKey];
    if (!shouldRender) return false;
    filesFolderKeyRef.current = cacheKey;
    setFiles([]);
    return true;
  }, []);

  // 0797 — Replace the visible listing the instant the folder changes so the
  // PREVIOUS folder's items never flash while the new folder loads. `files`
  // is a single state slice shared across folders, so without this the FlatList
  // keeps rendering the old folder's rows until the async fetch/sync-derive
  // resolves — exactly the "empty nested folder briefly shows other items" bug.
  //
  // Runs in a layout effect (before paint) and is source-agnostic: it covers
  // tapping into a folder, breadcrumb jumps, and the back button. When we have
  // the destination folder's entries cached we render them immediately (instant,
  // then reconciled by the sync derive below); otherwise we clear to an empty
  // list under the loading skeleton until authoritative data arrives.
  const renderedFolderKeyRef = useRef(folderCacheKey(currentFolder.id));
  useLayoutEffect(() => {
    const key = folderCacheKey(currentFolder.id);
    if (renderedFolderKeyRef.current === key) return;
    renderedFolderKeyRef.current = key;
    filesFolderKeyRef.current = key;
    const cached = folderFilesCacheRef.current[key];
    if (cached && cached.length > 0) {
      filesCountRef.current = cached.length;
      setFiles(cached);
    } else {
      // No cached content for the destination — show the loading skeleton
      // (not the "empty folder" copy) until the fetch/sync derive resolves.
      filesCountRef.current = 0;
      setFiles([]);
      setLoading(true);
    }
    setRefreshing(false);
    setError(null);
  }, [currentFolder.id]);

  // ------------------------------------------------------------------
  // Fetch files
  // ------------------------------------------------------------------

  const fetchFiles = useCallback(async (parentId: string | null, isRefresh = false) => {
    const isRequestStillVisible = () =>
      shouldApplyFolderRequestToVisibleState(parentId, filesFolderKeyRef.current);
    const hasVisibleFiles = filesCountRef.current > 0;
    if (isRequestStillVisible()) {
      if (isRefresh || hasVisibleFiles) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
    }
    if (isRequestStillVisible()) {
      setError(null);
    }
    const endPerf = perfMark.start('files.fetch', {
      parent: parentId ?? 'root',
      refresh: isRefresh,
    });
    let renderedCachedIndex = false;

    try {
      const cachedIndex = await loadCachedFileIndex();
      if (!isRefresh && !hasVisibleFiles && cachedIndex) {
        const cachedFiles = filesForFolderFromIndex(cachedIndex, parentId);
        if (cachedFiles.length > 0) {
          renderedCachedIndex = true;
          if (applyFilesForFolder(parentId, cachedFiles, { preserveCachedOnEmpty: true })) {
            setLoading(false);
            setRefreshing(true);
          }
        }
      }

      try {
        const index = await getFileIndex(cachedIndex?.hash);
        const sourceIndex = !index.changed && cachedIndex
          ? cachedIndex
          : index.files
            ? { hash: index.hash, files: index.files, storedAt: Date.now() }
            : null;
        if (index.files) {
          await saveCachedFileIndex(index.hash, index.files);
        }
        if (sourceIndex) {
          const result = filesForFolderFromIndex(sourceIndex, parentId);
          const rendered = applyFilesForFolder(parentId, result, { preserveCachedOnEmpty: !isRefresh });
          endPerf({ count: result.length, source: 'index' });
          if (rendered) setHasLoadedOnceTrue();
          return;
        }
      } catch (err) {
        if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 404 && err.status !== 405)) {
          throw err;
        }
      }

      const result = await listAllFiles(parentId ?? undefined);
      const rendered = applyFilesForFolder(parentId, result, { preserveCachedOnEmpty: !isRefresh });
      endPerf({ count: result.length, source: 'folder' });
      if (rendered) setHasLoadedOnceTrue();
    } catch (err) {
      endPerf({ error: true });
      if (isRequestStillVisible() && !renderedCachedIndex) {
        setError(friendlyError(err));
      }
    } finally {
      if (isRequestStillVisible()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyFilesForFolder, setHasLoadedOnceTrue]);

  // Track the folder ID we last loaded for so re-focus from a child screen
  // (e.g. Preview) does not redundantly re-derive the file list. Replaced by
  // a separate useEffect for live sync updates while the screen is focused.
  const lastLoadedFolderRef = useRef<string | null | undefined>(undefined);

  // Fetch on mount and when folder changes. When the CRDT sync engine is
  // ready, derive the list from the in-memory tree instead of hitting
  // /api/v1/files — that path stays as a fallback (server too old, or
  // sync still booting).
  //
  // Guard: wait for the vault unlock attempt to settle before fetching.
  // This prevents the brief "Encrypted file" flash that occurs when files
  // arrive before the master key is loaded from the Secure Enclave.
  // BiometricGuard triggers the auto-unlock on startup; unlockAttempted
  // becomes true once it completes (success or failure).
  useFocusEffect(
    useCallback(() => {
      if (!unlockAttempted) {
        // Keep the skeleton visible while the keychain lookup is in flight
        setLoading(true);
        return;
      }

      // When returning from a child screen (e.g. Preview), skip the
      // re-derive / re-fetch if we already have data for this folder.
      // This prevents a race condition where the sync tree or API returns
      // a partial result during re-focus, replacing the full file list.
      const folderKey = folderCacheKey(currentFolder.id);
      const cachedFolderFiles = folderFilesCacheRef.current[folderKey];
      if (
        lastLoadedFolderRef.current === currentFolder.id &&
        cachedFolderFiles &&
        cachedFolderFiles.length > 0
      ) {
        // Data is already loaded for this folder — preserve it.
        // Live sync updates are handled by the useEffect below.
        return;
      }

      if (sync.ready) {
        const liveNodes = sync.children(currentFolder.id).filter((n) => !n.is_trashed);
        // The CRDT engine flips `ready` once `start()` resolves, which can
        // beat the actual snapshot for catch-up paths or when the server
        // returns an empty initial frame. Falling through to fetchFiles in
        // that case prevents the Files tab from rendering the empty state
        // for an existing account on first paint after login.
        //
        // 0797 — For a NESTED folder we navigated into, its own node is present
        // in the in-memory tree, which means the snapshot for this subtree has
        // loaded. An empty children list is therefore authoritative: render the
        // empty folder instantly from memory instead of falling through to a
        // slow network fetch (the cause of the laggy empty-folder load). The
        // root (id === null) keeps the conservative guard so an existing account
        // never flashes the empty state during the catch-up race.
        const folderResolvedInTree =
          currentFolder.id !== null && sync.getNode(currentFolder.id) !== undefined;
        const haveAuthoritativeData =
          liveNodes.length > 0 || (cachedFolderFiles?.length ?? 0) > 0 || folderResolvedInTree;
        if (haveAuthoritativeData) {
          applyFilesForFolder(
            currentFolder.id,
            liveNodes.map(syncNodeToFileEntry),
            // When the folder is resolved-empty in the tree, don't preserve a
            // stale cache — clear to the real (empty) state.
            { preserveCachedOnEmpty: !folderResolvedInTree },
          );
          lastLoadedFolderRef.current = currentFolder.id;
          setLoading(false);
          setError(null);
          setHasLoadedOnceTrue();
          return;
        }
      }
      fetchFiles(currentFolder.id);
      lastLoadedFolderRef.current = currentFolder.id;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentFolder.id, fetchFiles, unlockAttempted, sync.ready, setHasLoadedOnceTrue])
  );

  // Live sync updates: when treeVersion changes while the screen is focused
  // and sync is ready, re-derive the file list from the CRDT tree. This is
  // separate from the useFocusEffect above so that returning from a child
  // screen does NOT redundantly re-derive (which caused a race where only
  // a partial result replaced the full list).
  useEffect(() => {
    if (!sync.ready || !unlockAttempted) return;
    if (lastLoadedFolderRef.current !== currentFolder.id) return;
    const liveNodes = sync.children(currentFolder.id).filter((n) => !n.is_trashed);
    if (liveNodes.length > 0) {
      applyFilesForFolder(
        currentFolder.id,
        liveNodes.map(syncNodeToFileEntry),
        { preserveCachedOnEmpty: true },
      );
    }
    // Re-derive whenever the tree mutates (treeVersion bumps on every op).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.treeVersion]);

  // Belt-and-braces: on auth+unlock transition, ensure at least one fetch has
  // been kicked even if the focus effect was suppressed. Idempotent — the
  // ref guard prevents firing more than once per login and we skip when the
  // focus effect already produced authoritative data.
  const loginFetchKickedRef = useRef(false);
  useEffect(() => {
    if (!isAuthenticated || !unlockAttempted) {
      loginFetchKickedRef.current = false;
      lastLoadedFolderRef.current = undefined;
      return;
    }
    if (loginFetchKickedRef.current) return;
    if (hasLoadedOnceRef.current) {
      loginFetchKickedRef.current = true;
      return;
    }
    loginFetchKickedRef.current = true;
    void fetchFiles(currentFolder.id, false);
  }, [isAuthenticated, unlockAttempted, currentFolder.id, fetchFiles]);

  // Load presence for the current folder. The endpoint silently returns []
  // when the folder isn't shared or the API doesn't exist yet.
  useEffect(() => {
    if (!currentFolder.id) {
      setPresence([]);
      return;
    }
    let cancelled = false;
    getFolderPresence(currentFolder.id)
      .then((users) => { if (!cancelled) setPresence(users); })
      .catch(() => { if (!cancelled) setPresence([]); });
    return () => { cancelled = true; };
  }, [currentFolder.id]);

  // Storage usage — fetched once on mount, refreshed alongside pull-to-refresh
  const fetchUsage = useCallback(async () => {
    try {
      setUsage(await getStorageUsage());
    } catch {
      // Endpoint may be unavailable in dev — silently skip the banner
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  // ------------------------------------------------------------------
  // Navigation handlers
  // ------------------------------------------------------------------

  const navigateToFolder = useCallback((folder: FileEntry) => {
    setSearchActive(false);
    setSearchQuery('');
    setFolderStack((prev) => appendFolderToBreadcrumbStack(prev, {
      id: folder.id,
      name: decryptedNames[folder.id] ?? displayName(folder),
    }));
  }, [decryptedNames]);

  const navigateToBreadcrumb = useCallback((index: number) => {
    setFolderStack((prev) => prev.slice(0, index + 1));
  }, []);

  // Open the collapsed-breadcrumb popover, measuring the "…" chip so the popover
  // hangs directly under it.
  const openBreadcrumbPopover = useCallback(() => {
    Haptics.selectionAsync();
    breadcrumbChipRef.current?.measureInWindow((x, y, width, height) => {
      setBreadcrumbAnchor({ x, y, width, height });
      setBreadcrumbPopoverOpen(true);
    });
  }, []);

  const onBreadcrumbCrumbPress = useCallback((stackIndex: number) => {
    setBreadcrumbPopoverOpen(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigateToBreadcrumb(stackIndex);
  }, [navigateToBreadcrumb]);

  // 1303 — a pending (never-finalized) upload placeholder gets a real
  // affordance instead of a dead-end toast: tap → status + Discard. Discard
  // trashes the row server-side (stale_upload_cleanup reaps its blobs at the
  // 7-day mark regardless) and drops it from the visible list immediately.
  const discardPendingUpload = useCallback(async (file: FileEntry) => {
    try {
      await deleteFile(file.id);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      showToast({ type: 'success', message: 'Pending upload discarded' });
      fetchFiles(currentFolder.id, true);
    } catch (err) {
      showToast({ type: 'error', message: `Couldn't discard: ${friendlyError(err)}` });
    }
  }, [currentFolder.id, fetchFiles, showToast]);

  const handlePendingUpload = useCallback(async (file: FileEntry) => {
    let detail = 'This upload never finished.';
    try {
      const status = await getUploadStatus(file.id);
      if (!status.is_uploading) {
        // Server says it actually completed — the local flag is stale; reconcile.
        fetchFiles(currentFolder.id, true);
        return;
      }
      detail = `${status.uploaded_chunks.length} of ${status.chunk_count} encrypted chunks were stored before the upload stopped.`;
    } catch {
      // keep the generic line — the dialog still offers the way out
    }
    Alert.alert(
      'Upload pending',
      `${detail}\n\nDiscarding removes this placeholder and its stored chunks. To upload the file, add it again from its source.`,
      [
        { text: 'Discard upload', style: 'destructive', onPress: () => { void discardPendingUpload(file); } },
        { text: 'Keep', style: 'cancel' },
      ],
    );
  }, [currentFolder.id, discardPendingUpload, fetchFiles]);

  const ensureFileReady = useCallback(async (file: FileEntry): Promise<boolean> => {
    if (file.is_folder) return true;
    if (file.is_uploading === true) {
      showToast({ type: 'info', message: 'Upload is still pending. Finish or retry the upload before opening this file.' });
      return false;
    }
    if (file.is_uploading === false) return true;

    try {
      const status = await getUploadStatus(file.id);
      if (status.is_uploading) {
        const uploaded = status.uploaded_chunks.length;
        showToast({
          type: 'info',
          message: `Upload is still pending (${uploaded}/${status.chunk_count} chunks stored).`,
        });
        return false;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && /upload already completed/i.test(err.message)) {
        return true;
      }
      return true;
    }
    return true;
  }, [showToast]);

  const openFile = useCallback(
    async (file: FileEntry) => {
      try {
        // Per-file Face ID lock check — applies to both files and folders.
        if (await isFileLocked(file.id)) {
          const result = await LocalAuthentication.authenticateAsync({
            promptMessage: 'Authenticate to open this file',
            disableDeviceFallback: true,
          });
          if (!result.success) return;
        }
        if (file.is_folder) {
          navigateToFolder(file);
        } else if (file.is_uploading === true) {
          await handlePendingUpload(file);
          return;
        } else {
          if (!(await ensureFileReady(file))) return;
          navigation.navigate('Preview', {
            fileId: file.id,
            fileName: decryptedNames[file.id] ?? displayName(file),
            mimeType: mimeTypeFor(file) ?? undefined,
            sizeBytes: file.size_bytes,
            createdAt: file.created_at,
            chunkCount: file.chunk_count,
            versionNumber: file.version_number,
            storagePoolId: file.storage_pool_id ?? null,
            // 0883 — let Preview auto self-repair a missing thumbnail for this
            // owner media file from the downloaded plaintext (undefined ⇒ skip).
            hasThumbnail: file.has_thumbnail,
            // File-request uploads (0643): pass the sealed-key fields so Preview
            // decrypts with the request content key, not the master-key path.
            fileRequestId: file.file_request_id ?? null,
            senderEphemeralPubkey: file.sender_ephemeral_pubkey ?? null,
            wrappedContentKey: file.wrapped_content_key ?? null,
          });
        }
      } catch {
        showToast({ type: 'error', message: "Couldn't open file" });
      }
    },
    [navigateToFolder, navigation, decryptedNames, mimeTypeFor, ensureFileReady, handlePendingUpload, showToast],
  );

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchFiles(currentFolder.id, true);
  }, [currentFolder.id, fetchFiles]);

  const handleReviewBackup = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    (navigation.navigate as any)('Tabs', { screen: 'Settings' });
  }, [navigation]);

  const pickAndUploadFile = useCallback(async () => {
    if (!phraseVerified) {
      Alert.alert(
        'Save your recovery phrase first',
        'Verify your recovery phrase before uploading. Go to Settings → Security to complete verification.',
        [{ text: 'OK' }],
      );
      return;
    }
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

    // ── Conflict check ────────────────────────────────────────────────────
    let uploadFileId = await generateFileId();   // new UUID by default
    let uploadFileName = asset.name;       // original name by default
    let v2InitNameEncrypted: string | undefined;

    const existingFile = findConflict(asset.name);
    if (existingFile) {
      if (shouldAutoVersionUpload(existingFile, asset.name, asset.mimeType, asset.size)) {
        uploadFileId = existingFile.id;
        v2InitNameEncrypted = existingFile.name_encrypted;
      } else {
        const uniqueName = getUniqueMobileName(asset.name, folderFileNames());
        const choice = await promptFileConflict(asset.name, existingFile.id, uniqueName);
        if (choice.action === 'cancel') return;
        if (choice.action === 'replace') {
          // Reuse existing file ID → server auto-creates a version
          uploadFileId = existingFile.id;
          v2InitNameEncrypted = existingFile.name_encrypted;
        } else {
          // Keep both: upload under the suffixed name with a fresh ID
          uploadFileName = choice.finalName;
        }
      }
    }

    const loc = trustLocation(undefined);
    setUpload({ fileName: uploadFileName, stage: 1, percent: 0, city: loc.city, region: loc.region });
    try {
      const uploaded = await encryptedUpload({
        fileId: uploadFileId,
        uri: asset.uri,
        name: uploadFileName,
        parentId: currentFolder.id ?? undefined,
        mimeType: asset.mimeType ?? undefined,
        v2InitNameEncrypted,
        encryptChunkFn: encryptChunk,
        encryptMetadataFn: encryptMetadata,
        onProgress: (progress) => {
          const percent = progress.bytesTotal > 0
            ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100)
            : 0;
          setUpload((prev) => {
            const base = prev ?? { fileName: asset.name, stage: 1 as UploadStage, percent: 0, city: loc.city, region: loc.region };
            const stage: UploadStage = progress.phase === 'preparing' ? 1 : progress.phase === 'finalizing' ? 3 : 2;
            return {
              ...base,
              stage,
              percent,
              chunksUploaded: progress.chunksUploaded,
              chunksTotal: progress.chunksTotal,
              chunkSizeBytes: progress.chunkSizeBytes,
              bytesUploaded: progress.bytesUploaded,
              bytesTotal: progress.bytesTotal,
              cryptoBytesPerSec: progress.cryptoBytesPerSec,
            };
          });
        },
      });
      const finalLoc = trustLocation(uploaded.storage_pool_id);
      setUpload({ fileName: uploadFileName, stage: 'done', percent: 100, city: finalLoc.city, region: finalLoc.region });
      setFiles((prev) => upsertFileEntry(prev, uploaded));
      // Add to the encrypted search index so the new file is searchable
      // across the whole vault from the very next keystroke.
      indexFile(uploaded.id, toSearchIndexEntry(uploaded, uploadFileName, currentFolder.id));
      // Fire-and-forget: generate + upload medium and large encrypted thumbnails for media files.
      void generateAndUploadThumbnail(uploaded.id, asset.uri, asset.mimeType ?? null, getFileKeyBytes);
      void generateAndUploadThumbnail(uploaded.id, asset.uri, asset.mimeType ?? null, getFileKeyBytes, 'large');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      donateSiriShortcut('upload');
      showToast({ type: 'success', message: `"${uploadFileName}" stored in ${finalLoc.city}` });
      fetchFiles(currentFolder.id, true);
      // Hold the "Stored · Key stayed here" flash briefly before clearing.
      setTimeout(() => setUpload((cur) => (cur && cur.stage === 'done' ? null : cur)), 1800);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showToast({ type: 'error', message: `Upload failed: ${friendlyError(err)}` });
      setUpload(null);
    }
  }, [currentFolder.id, fetchFiles, phraseVerified, showToast, findConflict, shouldAutoVersionUpload, folderFileNames, encryptChunk, encryptMetadata, indexFile]);

  const pickAndUploadPhotos = useCallback(async () => {
    if (!phraseVerified) {
      Alert.alert(
        'Save your recovery phrase first',
        'Verify your recovery phrase before uploading. Go to Settings → Security to complete verification.',
        [{ text: 'OK' }],
      );
      return;
    }
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Allow photo library access to upload photos.');
      return;
    }

    let picked: ImagePicker.ImagePickerResult;
    try {
      picked = await ImagePicker.launchImageLibraryAsync({
        // 1292 — the menu item says "Upload photo or video"; the picker excluded videos.
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 1,
        // 1294 follow-up (Guus, device: "i select videos but doesnt work. photo does work."):
        // by default PHPicker TRANSCODES videos to a "compatible" representation (H.265 -> H.264)
        // before resolving — a minutes-long, zero-feedback export for a real camera video, which
        // reads as the picker doing nothing (confirmed on sim: a 12.8 MB HEVC arrived as 38 MB
        // H.264). We are an E2E storage app: store the user's ORIGINAL bytes, don't transcode.
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
    } catch (err) {
      Alert.alert('Error', friendlyError(err));
      return;
    }
    if (picked.canceled || picked.assets.length === 0) return;

    const total = picked.assets.length;
    let successCount = 0;
    let lastLoc = trustLocation(undefined);
    let lastName = '';
    // Track names already used in this batch to avoid duplicate suffixes
    const usedInBatch = new Set<string>();
    let exportFailures = 0;
    for (let i = 0; i < total; i++) {
      const asset = picked.assets[i]!;
      if (!asset.uri) {
        // iCloud-offloaded originals can fail to export (network, storage); a missing uri
        // would previously just skip with no signal — count and report honestly below.
        exportFailures += 1;
        continue;
      }
      const isVideoAsset = asset.type === 'video';
      const rawName =
        asset.fileName ?? `${isVideoAsset ? 'video' : 'photo'}-${Date.now()}-${i}.${isVideoAsset ? 'mp4' : 'jpg'}`;
      const conflict = findConflict(rawName);
      const shouldVersion = !!conflict && shouldAutoVersionUpload(
        conflict,
        rawName,
        asset.mimeType ?? (isVideoAsset ? 'video/mp4' : 'image/jpeg'),
        asset.fileSize,
      );
      // Batch photo uploads stay silent. Same-name, same-type changed files
      // become versions; unresolved collisions still keep both with a suffix.
      const name = conflict && !shouldVersion
        ? getUniqueMobileName(rawName, new Set([...folderFileNames(), ...usedInBatch]))
        : rawName;
      usedInBatch.add(name.toLowerCase());

      const display = total > 1 ? `${name} (${i + 1}/${total})` : name;
      lastName = display;
      setUpload({ fileName: display, stage: 1, percent: 0, city: lastLoc.city, region: lastLoc.region });
      try {
        const fileId = shouldVersion && conflict ? conflict.id : await generateFileId();
        const v2InitNameEncrypted = shouldVersion && conflict ? conflict.name_encrypted : undefined;
        const uploadUri = await copyPhotoAssetToUploadCache(asset.uri, fileId, name);
        const uploaded = await encryptedUpload({
          fileId,
          uri: uploadUri,
          name,
          parentId: currentFolder.id ?? undefined,
          mimeType: asset.mimeType ?? (isVideoAsset ? 'video/mp4' : 'image/jpeg'),
          v2InitNameEncrypted,
          encryptChunkFn: encryptChunk,
          encryptMetadataFn: encryptMetadata,
          onProgress: (progress) => {
            const percent = progress.bytesTotal > 0
              ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100)
              : 0;
            setUpload((prev) => {
              const base = prev ?? { fileName: display, stage: 1 as UploadStage, percent: 0, city: lastLoc.city, region: lastLoc.region };
              const stage: UploadStage = progress.phase === 'preparing' ? 1 : progress.phase === 'finalizing' ? 3 : 2;
              return {
                ...base,
                stage,
                percent,
                chunksUploaded: progress.chunksUploaded,
                chunksTotal: progress.chunksTotal,
                chunkSizeBytes: progress.chunkSizeBytes,
                bytesUploaded: progress.bytesUploaded,
                bytesTotal: progress.bytesTotal,
                cryptoBytesPerSec: progress.cryptoBytesPerSec,
              };
            });
          },
        });
        lastLoc = trustLocation(uploaded.storage_pool_id);
        setFiles((prev) => upsertFileEntry(prev, uploaded));
        indexFile(uploaded.id, toSearchIndexEntry(uploaded, name, currentFolder.id));
        // Fire-and-forget: image picker only returns images, so always thumbnail (medium + large).
        void generateAndUploadThumbnail(uploaded.id, uploadUri, asset.mimeType ?? 'image/jpeg', getFileKeyBytes);
        void generateAndUploadThumbnail(uploaded.id, uploadUri, asset.mimeType ?? 'image/jpeg', getFileKeyBytes, 'large');
        successCount += 1;
      } catch (err) {
        console.warn('[UPLOAD] Error type:', typeof err, err instanceof Error ? err.constructor.name : 'unknown');
        console.warn('[UPLOAD] Error message:', err instanceof Error ? err.message : String(err));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast({ type: 'error', message: `${name}: ${friendlyError(err)}` });
      }
    }
    if (successCount > 0) {
      setUpload({ fileName: lastName, stage: 'done', percent: 100, city: lastLoc.city, region: lastLoc.region });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      donateSiriShortcut('upload');
      showToast({
        type: 'success',
        message: successCount === 1
          ? `Item stored in ${lastLoc.city}`
          : `${successCount} items stored in ${lastLoc.city}`,
      });
      fetchFiles(currentFolder.id, true);
      setTimeout(() => setUpload((cur) => (cur && cur.stage === 'done' ? null : cur)), 1800);
    } else {
      setUpload(null);
    }
    if (exportFailures > 0) {
      // 1294 follow-up — an asset the system could not export (iCloud original that failed to
      // download, storage pressure) used to vanish silently. Say so.
      Alert.alert(
        'Some items could not be read',
        `${exportFailures} ${exportFailures === 1 ? 'item' : 'items'} could not be exported from your photo library. Check that originals are downloadable (iCloud) and try again.`,
      );
    }
  }, [currentFolder.id, fetchFiles, phraseVerified, showToast, findConflict, shouldAutoVersionUpload, folderFileNames, encryptChunk, encryptMetadata, indexFile]);

  const openDocumentScanner = useCallback(() => {
    if (!phraseVerified) {
      Alert.alert(
        'Save your recovery phrase first',
        'Verify your recovery phrase before scanning documents. Go to Settings → Security to complete verification.',
        [{ text: 'OK' }],
      );
      return;
    }
    navigation.navigate('DocumentScanner', { parentId: currentFolder.id ?? undefined });
  }, [currentFolder.id, navigation, phraseVerified]);

  // 0777 — FAB button feedback (Medium), then the native add sheet.
  // 0789 — the "+" FAB opens the native iOS UIMenu pull-down (see addMenuActions /
  // onAddAction below, declared once the four upload handlers are in scope).

  // Quick action / deep-link landing: route.params.action is set by the App
  // shortcut handler (beebeeb://upload, beebeeb://search, beebeeb://scan,
  // beebeeb://recent) and by the Files tab reselect handler. Trigger the
  // right surface and clear the param so subsequent focuses don't re-fire it.
  useEffect(() => {
    const action = route.params?.action;
    if (!action) return;
    navigation.setParams({ action: undefined });
    if (action === 'root') {
      setSearchActive(false);
      setSearchQuery('');
      setRecentFilterActive(false);
      setSelectMode(false);
      setSelectedIds(new Set());
      setFolderStack([{ id: null, name: 'Drive' }]);
    } else if (action === 'upload') {
      pickAndUploadFile();
    } else if (action === 'search') {
      setSearchActive(true);
      // Tiny delay so the input has mounted before we focus, otherwise the
      // keyboard sometimes drops on iOS cold-launch.
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else if (action === 'scan') {
      openDocumentScanner();
    } else if (action === 'recent') {
      setRecentFilterActive(true);
    }
  }, [route.params?.action, navigation, pickAndUploadFile, openDocumentScanner]);

  const submitNewFolder = useCallback(async (rawName: string) => {
    const trimmed = rawName.trim();
    if (!trimmed) return;
    try {
      if (!isUnlocked) {
        Alert.alert('Vault is locked', 'Unlock the vault before creating folders.');
        return;
      }
      const folderId = await generateFileId();
      const encName = await encryptMetadata(folderId, fileMetadataPlaintext(trimmed, null));
      const nameEncrypted = encryptedMetadataToJson(encName);
      const folder = await createFolder(nameEncrypted, currentFolder.id ?? undefined, folderId);
      const now = new Date().toISOString();
      const safe: FileEntry = {
        ...folder,
        created_at: folder.created_at ?? now,
        updated_at: folder.updated_at ?? now,
      };
      setFiles((prev) => upsertFileEntry(prev, safe));
      setDecryptedNames((prev) => ({ ...prev, [safe.id]: trimmed }));
      indexFile(safe.id, toSearchIndexEntry(safe, trimmed, currentFolder.id));
    } catch (err) {
      Alert.alert('Error', friendlyError(err));
    }
  }, [currentFolder.id, encryptMetadata, indexFile, isUnlocked]);

  const showNewFolderPrompt = useCallback(() => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'New folder',
        'Enter a name for the new folder',
        (name) => {
          if (name) void submitNewFolder(name);
        },
        'plain-text',
        '',
        'default',
      );
    } else {
      // Android: Alert.prompt isn't supported, so drive a controlled Modal
      // with a TextInput. State lives at the screen level so the modal
      // re-renders cleanly and we can disable the action while creating.
      setNewFolderName('');
      setCreatingFolder(false);
      setNewFolderOpen(true);
    }
  }, [submitNewFolder]);

  // 0789 — "+" add menu as native iOS UIMenu items, with trailing SF Symbols.
  // (Placed after all four upload handlers are declared.)
  // 0791 — `imageColor` MUST be set explicitly. On the New Architecture the
  // Fabric bridge always forwards `imageColor` as `@(action.imageColor)` (a C++
  // int that defaults to 0 when JS omits it); native then tints the symbol with
  // `RCTConvert.uiColor(0)` = fully transparent, so the glyph renders blank with
  // its space reserved. Passing the label color tints it visibly on both arches.
  const addMenuActions = useMemo<MenuAction[]>(
    () => [
      { id: 'photo', title: 'Upload photo or video', image: 'photo.on.rectangle', imageColor: c.ink },
      { id: 'file', title: 'Upload file', image: 'doc', imageColor: c.ink },
      { id: 'scan', title: 'Scan document', image: 'doc.viewfinder', imageColor: c.ink },
      { id: 'folder', title: 'New folder', image: 'folder.badge.plus', imageColor: c.ink },
    ],
    [c.ink],
  );

  const onAddAction = useCallback(({ nativeEvent }: NativeActionEvent) => {
    switch (nativeEvent.event) {
      case 'photo': pickAndUploadPhotos(); return;
      case 'file': pickAndUploadFile(); return;
      case 'scan': openDocumentScanner(); return;
      case 'folder': showNewFolderPrompt(); return;
    }
  }, [pickAndUploadPhotos, pickAndUploadFile, openDocumentScanner, showNewFolderPrompt]);

  const confirmNewFolderModal = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setCreatingFolder(true);
    try {
      await submitNewFolder(trimmed);
      setNewFolderOpen(false);
      setNewFolderName('');
    } finally {
      setCreatingFolder(false);
    }
  }, [newFolderName, submitNewFolder]);

  // 0789 — sort options as native iOS UIMenu items: trailing SF Symbol per row,
  // the active sort carries the system checkmark (state 'on').
  const sortMenuActions = useMemo<MenuAction[]>(
    () =>
      SORT_ORDER.map((o) => ({
        id: o,
        title: SORT_LABELS[o],
        image: SORT_SF_SYMBOL[o],
        // 0791 — explicit tint so the SF Symbol renders (see addMenuActions note).
        imageColor: c.ink,
        state: o === sortOrder ? 'on' : 'off',
      })),
    [sortOrder, c.ink],
  );

  const onSortAction = useCallback(({ nativeEvent }: NativeActionEvent) => {
    const order = nativeEvent.event as SortOrder;
    if ((SORT_ORDER as string[]).includes(order)) setSortOrder(order);
  }, []);

  // 0800 — Long-pressing the (single-line, truncated) folder title opens a
  // native UIMenu whose header is the FULL folder name, plus a Copy action.
  const folderTitleMenuActions = useMemo<MenuAction[]>(
    () => [{ id: 'copy', title: 'Copy name', image: 'doc.on.doc', imageColor: c.ink }],
    [c.ink],
  );
  const onFolderTitleAction = useCallback(({ nativeEvent }: NativeActionEvent) => {
    if (nativeEvent.event === 'copy') {
      void Clipboard.setStringAsync(currentFolder.name);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: 'success', message: 'Folder name copied' });
    }
  }, [currentFolder.name, showToast]);

  // Deep breadcrumbs collapse to "root … current" — tapping the "…" opens a
  // native iOS UIMenu of the in-between folders; the action id is the folderStack
  // index to jump to. (Guus request — keep the breadcrumb to 3 segments max.)
  // ------------------------------------------------------------------
  // Multi-select handlers
  // ------------------------------------------------------------------

  const enterSelectMode = useCallback((initialId?: string) => {
    _openSwipeable?.close();
    _openSwipeable = null;
    setSelectMode(true);
    setSelectedIds(initialId ? new Set([initialId]) : new Set());
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((item: FileEntry) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback((allIds: string[]) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedIds((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds),
    );
  }, []);

  const handleBatchTrash = useCallback(() => {
    if (selectedIds.size === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const count = selectedIds.size;
    Alert.alert(
      'Move to Trash',
      `${count} item${count === 1 ? '' : 's'} will be moved to Trash.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Move to Trash',
          style: 'destructive',
          onPress: async () => {
            try {
              const ids = [...selectedIds];
              const result = await trashFiles(ids);
              const trashedIds = new Set([...result.trashed, ...result.already_trashed]);
              setFiles((prev) => prev.filter((f) => !trashedIds.has(f.id)));
              // 0818 — fan the delete out to EVERY derived store, expanding any
              // trashed folder to its full subtree (the old per-id unindex missed
              // descendants + 4 of the 6 stores).
              const subtree = sync.collectSubtreeIds([...trashedIds]);
              void onFilesDeleted(subtree, { subtree: true });
              // Drop the trashed rows from the iOS File Provider cache so they
              // disappear from Files.app immediately (not just from this view).
              void removeFromFileProviderCache(subtree);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              exitSelectMode();
              if (result.missing.length > 0 || trashedIds.size < ids.length) {
                Alert.alert(
                  'Some items were not moved',
                  'Beebeeb refreshed the folder because a few selected items were already gone or unavailable.',
                );
                void fetchFiles(currentFolder.id, true);
              }
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [currentFolder.id, exitSelectMode, fetchFiles, selectedIds, sync]);

  const handleBatchShare = useCallback(() => {
    if (selectedIds.size === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (selectedIds.size > 1) {
      Alert.alert('Share', 'Select one file to share.');
      return;
    }
    const id = [...selectedIds][0]!;
    const item = files.find((f) => f.id === id);
    if (!item) return;
    const name = decryptedNames[id] ?? displayName(item);
    void (async () => {
      if (!(await ensureFileReady(item))) return;
      exitSelectMode();
      navigation.navigate('ShareSheet', {
        fileId: id,
        fileName: name,
        mimeType: mimeTypeFor(item) ?? undefined,
        sizeBytes: item.size_bytes,
      });
    })();
  }, [selectedIds, files, decryptedNames, exitSelectMode, navigation, mimeTypeFor, ensureFileReady]);

  // 0796 — Build the FULL selectable folder tree for the Move picker. Folder
  // STRUCTURE comes from the authoritative in-memory sync tree (`sync.allNodes`),
  // names from the cached search index → in-memory decryptedNames → on-demand
  // decrypt → display fallback. The moved items and their entire subtree are
  // excluded so a folder can never be moved into itself or a descendant.
  const buildPickerFolders = useCallback(async (movingIds: string[]): Promise<PickerFolder[]> => {
    let folderNodes: SyncNode[] = sync.allNodes().filter((n) => n.is_folder && !n.is_trashed);
    if (folderNodes.length === 0) {
      // Sync not ready — fall back to a flat root listing (better than nothing).
      try {
        const all = await listAllFiles();
        folderNodes = all.filter((f) => f.is_folder).map((f) => ({
          id: f.id,
          name_encrypted: f.name_encrypted ?? '',
          parent_id: f.parent_id ?? null,
          is_folder: true,
          size_bytes: f.size_bytes ?? 0,
          content_hash: null,
          version_number: 1,
          has_thumbnail: false,
          storage_pool_id: f.storage_pool_id ?? null,
          is_trashed: false,
          is_starred: false,
          created_at: f.created_at,
          updated_at: f.updated_at,
        }));
      } catch {
        folderNodes = [];
      }
    }

    // Exclude the moved folders + their descendants.
    const childrenOf = new Map<string | null, SyncNode[]>();
    for (const n of folderNodes) {
      const list = childrenOf.get(n.parent_id) ?? [];
      list.push(n);
      childrenOf.set(n.parent_id, list);
    }
    const excluded = new Set<string>();
    const movingSet = new Set(movingIds);
    const queue = folderNodes.filter((n) => movingSet.has(n.id));
    for (const node of queue) excluded.add(node.id);
    while (queue.length > 0) {
      const node = queue.pop()!;
      for (const child of childrenOf.get(node.id) ?? []) {
        if (!excluded.has(child.id)) {
          excluded.add(child.id);
          queue.push(child);
        }
      }
    }

    // Resolve decrypted names.
    const indexEntries = allEntries();
    const nameCache: Record<string, string> = {};
    const toDecrypt: SyncNode[] = [];
    for (const n of folderNodes) {
      if (excluded.has(n.id)) continue;
      const cached = decryptedNames[n.id] ?? indexEntries[n.id]?.name;
      if (cached) nameCache[n.id] = cached;
      else if ((n.name_encrypted ?? '').startsWith('{')) toDecrypt.push(n);
      else nameCache[n.id] = displayName(syncNodeToFileEntry(n)) || 'Untitled folder';
    }
    const BATCH = 12;
    for (let i = 0; i < toDecrypt.length; i += BATCH) {
      await Promise.all(
        toDecrypt.slice(i, i + BATCH).map(async (n) => {
          try {
            const payload = encryptedMetadataPayloadToBytes(n.name_encrypted ?? '');
            if (payload) {
              const plaintext = await decryptMetadata(n.id, payload.nonce, payload.ciphertext);
              const { name } = parseDecryptedMetadata(plaintext);
              if (name) {
                nameCache[n.id] = name;
                return;
              }
            }
          } catch {
            // fall through to display fallback
          }
          nameCache[n.id] = displayName(syncNodeToFileEntry(n)) || 'Untitled folder';
        }),
      );
    }

    return folderNodes
      .filter((n) => !excluded.has(n.id))
      .map((n) => ({ id: n.id, name: nameCache[n.id] ?? 'Untitled folder', parentId: n.parent_id }));
  }, [sync, allEntries, decryptedNames, decryptMetadata]);

  const openMovePicker = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const folders = await buildPickerFolders(ids);
      setMovePicker({
        ids,
        title: ids.length === 1 ? 'Move' : `Move ${ids.length} items`,
        folders,
        currentParentId: currentFolder.id,
      });
    } catch {
      Alert.alert('Error', 'Could not load folders.');
    }
  }, [buildPickerFolders, currentFolder.id]);

  const performMove = useCallback(async (targetId: string | null) => {
    const picker = movePicker;
    if (!picker || moveBusy) return;
    const ids = picker.ids;
    const destName = targetId === null
      ? 'Drive'
      : picker.folders.find((f) => f.id === targetId)?.name ?? 'folder';
    setMoveBusy(true);
    try {
      // R11 — per-item moves so a partial failure reconciles correctly.
      // Promise.all rejected on the first failure, so items that had already
      // moved server-side were never removed from this view or reindexed (UI
      // diverged from server until a manual refresh). allSettled lets us apply
      // the successes and leave the failed items exactly where they were.
      const results = await Promise.allSettled(ids.map((id) => moveFile(id, targetId)));
      const movedIds: string[] = [];
      let firstError: unknown;
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          movedIds.push(ids[i]!);
        } else if (firstError === undefined) {
          firstError = result.reason;
        }
      });
      for (const id of movedIds) {
        const moved = files.find((f) => f.id === id);
        if (!moved) continue;
        indexFile(id, toSearchIndexEntry(moved, decryptedNames[id] ?? displayName(moved), targetId));
        // R13 — mirror the move into the sync tree (the source the list
        // re-derives from on focus / treeVersion), so it isn't reverted before
        // the server's SSE echo lands.
        sync.applyLocalOp(moved.is_folder ? 'folder_move' : 'file_move', {
          id,
          old_parent_id: currentFolder.id,
          new_parent_id: targetId,
        });
      }
      const movedSet = new Set(movedIds);
      setFiles((prev) => prev.filter((f) => !movedSet.has(f.id)));
      const failedCount = ids.length - movedIds.length;
      if (movedIds.length === 0) {
        // Nothing moved — surface the error and keep the picker open to retry.
        Alert.alert('Error', friendlyError(firstError));
      } else if (failedCount === 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast({
          type: 'success',
          message: ids.length === 1 ? `Moved to ${destName}` : `Moved ${ids.length} items to ${destName}`,
        });
        setMovePicker(null);
        if (selectMode) exitSelectMode();
      } else {
        // Partial failure — reconcile what moved, tell the user what didn't.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        showToast({
          type: 'info',
          message: `Moved ${movedIds.length} of ${ids.length} to ${destName}; ${failedCount} could not be moved`,
        });
        setMovePicker(null);
        if (selectMode) exitSelectMode();
      }
    } catch (err) {
      Alert.alert('Error', friendlyError(err));
    } finally {
      setMoveBusy(false);
    }
  }, [movePicker, moveBusy, files, decryptedNames, indexFile, showToast, selectMode, exitSelectMode, sync, currentFolder.id]);

  const handleBatchMove = useCallback(() => {
    if (selectedIds.size === 0) return;
    void openMovePicker([...selectedIds]);
  }, [selectedIds, openMovePicker]);

  const handleSearchToggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSearchActive((prev) => {
      if (!prev) donateSiriShortcut('search');
      else setSearchQuery('');
      return !prev;
    });
  }, []);

  useEffect(() => {
    if (!searchActive || selectMode) return;
    const timer = setTimeout(() => searchInputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [searchActive, selectMode]);

  const navigateToPinned = useCallback((pf: { id: string; name: string }) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSearchActive(false);
    setSearchQuery('');
    setFolderStack([{ id: null, name: 'Drive' }, { id: pf.id, name: pf.name }]);
  }, []);

  const togglePin = useCallback((item: FileEntry, name: string) => {
    setPinnedFolders((prev) => {
      const isPinned = prev.some((p) => p.id === item.id);
      if (isPinned) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return prev.filter((p) => p.id !== item.id);
      }
      if (prev.length >= 5) {
        Alert.alert('Max pins reached', 'You can pin up to 5 folders. Unpin one to add another.');
        return prev;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return [...prev, { id: item.id, name }];
    });
  }, []);

  // Parent→children index of the whole (non-trashed) vault, rebuilt only when
  // the sync tree changes — lets a folder's descendant files be gathered cheaply
  // for recursive offline (0794).
  const nodesByParent = useMemo(() => {
    const map = new Map<string | null, SyncNode[]>();
    for (const n of sync.allNodes()) {
      if (n.is_trashed) continue;
      const list = map.get(n.parent_id) ?? [];
      list.push(n);
      map.set(n.parent_id, list);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, sync.treeVersion]);

  const folderDescendantFileIds = useCallback((folderId: string): string[] => {
    const out: string[] = [];
    const stack: string[] = [folderId];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      for (const child of nodesByParent.get(pid) ?? []) {
        if (child.is_folder) stack.push(child.id);
        else out.push(child.id);
      }
    }
    return out;
  }, [nodesByParent]);

  // 0793 — toggle a single FILE offline. The offlineManager owns the queued →
  // downloading N% → available pipeline (with real byte progress); the row
  // indicator reflects it live. The encrypted blob is stored as-is (decrypted
  // client-side at open time) — no plaintext at rest, no cloud round-trip.
  const toggleOffline = useCallback(async (item: FileEntry, fileName: string) => {
    if (offlineManager.getStatus(item.id)) {
      await offlineManager.removeFile(item.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: 'info', message: 'Removed from offline' });
      return;
    }
    if (!(await ensureFileReady(item))) return;
    offlineManager.makeFilesAvailable([{ id: item.id, name: fileName }]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    showToast({ type: 'info', message: 'Saving for offline…' });
  }, [showToast, ensureFileReady]);

  // 0794 — make a FOLDER available offline: recursively enqueue every nested
  // file (walked from the cached sync tree, reusing the same subtree pattern as
  // the move picker). The folder row shows aggregate progress; removing it
  // cancels/clears the whole subtree.
  const toggleFolderOffline = useCallback(async (folder: FileEntry) => {
    const fileIds = folderDescendantFileIds(folder.id);
    if (offlineManager.isFolderOffline(folder.id)) {
      await offlineManager.removeFolder(folder.id, fileIds);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: 'info', message: 'Folder removed from offline' });
      return;
    }
    offlineManager.markFolderOffline(folder.id);
    if (fileIds.length === 0) {
      showToast({ type: 'info', message: 'Folder is empty — nothing to download' });
      return;
    }
    const index = allEntries();
    const files = fileIds.map((id) => ({ id, name: index[id]?.name ?? decryptedNames[id] ?? 'File' }));
    offlineManager.makeFilesAvailable(files);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    showToast({
      type: 'info',
      message: `Saving ${fileIds.length} file${fileIds.length === 1 ? '' : 's'} offline…`,
    });
  }, [folderDescendantFileIds, allEntries, decryptedNames, showToast]);

  const handleLongPress = useCallback((item: FileEntry) => {
    const name = decryptedNames[item.id] ?? displayName(item);
    const itemMimeType = mimeTypeFor(item);
    const isPinned = pinnedFolders.some((p) => p.id === item.id);
    const pinLabel = isPinned ? 'Unpin' : 'Pin to top';
    const isImage = !item.is_folder && (itemMimeType ?? '').startsWith('image/');
    const isVideo = !item.is_folder && (itemMimeType ?? '').startsWith('video/');
    const isMedia = isImage || isVideo;
    const offlineTracked = item.is_folder
      ? offlineManager.isFolderOffline(item.id)
      : offlineManager.getStatus(item.id) != null;
    const offlineLabel = offlineTracked ? 'Remove offline' : 'Make available offline';
    const isLocked = lockedFileIds.has(item.id);
    const lockLabel = isLocked ? 'Unlock file' : 'Lock file';
    // 'Send via Constellation' is intentionally hidden — Constellation crypto is v1 mock
    // (random bytes instead of real X25519 ECDH). Re-enable when real per-transfer
    // encryption is implemented. See task 0093.
    const fileOptions = ['Rename', 'Preview', 'Share', 'Save to Files'];
    if (isMedia) fileOptions.push('Save to Photos');
    fileOptions.push('Move to...', offlineLabel, 'Create proof', lockLabel, 'Move to Trash', 'Details');
    const options = item.is_folder
      ? ['Rename', 'Open', 'Share', 'Move to...', offlineLabel, 'Delete', pinLabel, lockLabel, 'Details', 'Cancel']
      : [...fileOptions, 'Cancel'];
    const destructiveIndex = options.indexOf(item.is_folder ? 'Delete' : 'Move to Trash');
    const cancelIndex = options.length - 1;

    const promptRename = () => {
      Alert.prompt(
        'Rename',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
            onPress: async (input?: string) => {
              const next = (input ?? '').trim();
              if (!next || next === name) return;
              try {
                const encName = await encryptMetadata(item.id, fileMetadataPlaintext(next, mimeTypeFor(item)));
                const nameEncrypted = encryptedMetadataToJson(encName);
                await renameFile(item.id, nameEncrypted);
                // R13 — mirror the rename into the sync tree so a focus /
                // treeVersion re-derive doesn't flash the old name before the
                // server's SSE echo lands.
                sync.applyLocalOp(item.is_folder ? 'folder_rename' : 'file_rename', {
                  id: item.id,
                  new_name_encrypted: nameEncrypted,
                });
                setFiles((prev) =>
                  prev.map((f) => (
                    f.id === item.id
                      ? { ...f, name_encrypted: nameEncrypted, updated_at: new Date().toISOString() }
                      : f
                  )),
                );
                setDecryptedNames((prev) => ({ ...prev, [item.id]: next }));
                indexFile(item.id, toSearchIndexEntry(
                  { ...item, name_encrypted: nameEncrypted, updated_at: new Date().toISOString() },
                  next,
                  currentFolder.id,
                ));
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                showToast({ type: 'success', message: `Renamed to "${next}"` });
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

    // 0796 — open the native nested folder picker (drill-in + breadcrumb).
    const promptMove = () => { void openMovePicker([item.id]); };

    // 0795 — decrypt the file to a sandboxed temp via the same native streaming
    // path the previewer uses, then hand it to the native save sheet. Decryption
    // is client-side; downloads hit only our own API. (Replaces the old export
    // path that wrote the still-ENCRYPTED blob straight to disk.)
    // 1181 — map a MIME type to a real media file extension. Slicing the MIME
    // subtype (the old behaviour) produced 'bin' for anything with a subtype
    // longer than 5 chars (video/quicktime, image/svg+xml) and mislabelled
    // others (image/jpeg -> 'jpeg'), which the native Photos importer then
    // classifies as .unknown and refuses to save. A correct extension gives
    // the saved temp the right UTI so Photos accepts it.
    const MIME_TO_EXT: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/pjpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/heic': 'heic',
      'image/heif': 'heif',
      'image/webp': 'webp',
      'image/tiff': 'tiff',
      'image/bmp': 'bmp',
      'video/quicktime': 'mov',
      'video/mp4': 'mp4',
      'video/mpeg': 'mpg',
      'video/x-m4v': 'm4v',
      'video/3gpp': '3gp',
      'video/webm': 'webm',
      'video/x-msvideo': 'avi',
      'video/x-matroska': 'mkv',
    };
    const extForSave = (): string => {
      const dot = name.lastIndexOf('.');
      if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
      const mime = (itemMimeType ?? '').toLowerCase();
      if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
      const fromMime = mime.split('/')[1];
      return (fromMime && fromMime.length <= 5 ? fromMime : 'bin').toLowerCase();
    };
    const decryptForSave = async (): Promise<string> => {
      const requestUpload = isRequestUpload(item);
      const { keyProvider, handleId } = requestUpload
        ? { keyProvider: () => getRequestContentKey(item), handleId: null as number | null }
        : { keyProvider: () => getFileKeyBytes(item.id), handleId: getMasterKeyHandleId() };
      const decryptedUri = await decryptToTempFile(
        item.id, keyProvider, extForSave(), item.size_bytes, item.chunk_count, handleId,
        {
          // 1180 — crash-safe Save progress. The native handle path
          // (downloadAndDecryptFileNative, handleId != null) streams to disk, so
          // onProgress is memory-safe. Push each event into the ISOLATED banner
          // via its ref — this does NOT setState on FilesScreen, so the FlatList
          // never re-renders per tick (the #188/1177 crash cause).
          onProgress: (event) => exportBannerRef.current?.setProgress(event),
          onOfflineFallback: () => {
            showToast({ type: 'info', message: 'Offline copy unreadable. Re-downloading...' });
          },
        },
      );
      // 0883 — auto self-repair: the plaintext is now on disk. If this owner
      // media file has no server thumbnail, generate + upload one from those
      // bytes (fire-and-forget, never blocks the save). Request uploads use a
      // different content key and are skipped inside the helper.
      maybeSelfRepairThumbnailFromLocalFile({
        fileId: item.id,
        localPlaintextUri: decryptedUri,
        mimeType: itemMimeType,
        hasServerThumbnail: item.has_thumbnail,
        isRequestUpload: requestUpload,
        getFileKeyBytes,
        onRepaired: (id) => {
          setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, has_thumbnail: true } : f)));
        },
      });
      return decryptedUri;
    };

    const saveToFiles = async () => {
      if (!(await ensureFileReady(item))) return;
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Not available', 'Saving is not available on this device.');
        return;
      }
      const safeName = (name.replace(/[^a-zA-Z0-9._()-]/g, '_') || 'file');
      const namedUri = `${FileSystem.cacheDirectory}${safeName}`;
      setExporting({ name });
      try {
        const decryptedUri = await decryptForSave();
        // Copy to a correctly-named temp so the saved file keeps its real name
        // (the decrypt cache keys files by id), then drop the copy afterwards.
        await FileSystem.deleteAsync(namedUri, { idempotent: true }).catch(() => {});
        await FileSystem.copyAsync({ from: decryptedUri, to: namedUri });
        // Prepare phase done — dismiss the indicator the moment the native
        // sheet opens (shareAsync only resolves once it's dismissed).
        setExporting(null);
        await Sharing.shareAsync(namedUri, {
          mimeType: itemMimeType ?? 'application/octet-stream',
          UTI: itemMimeType ?? 'public.data',
          dialogTitle: `Save "${name}"`,
        });
      } catch (err) {
        showToast({ type: 'error', message: `Could not save: ${friendlyError(err)}` });
      } finally {
        setExporting(null);
        FileSystem.deleteAsync(namedUri, { idempotent: true }).catch(() => {});
      }
    };

    const saveToGallery = async () => {
      if (!(await ensureFileReady(item))) return;
      // 1181 — Photos only accepts images and videos. The menu already gates
      // this action to media, but guard defensively: never let a non-media file
      // reach the save path and surface a false "Saved to Photos".
      if (!isMedia) {
        showToast({
          type: 'error',
          message: "This file type can't be saved to Photos. Use Save to Files instead.",
        });
        return;
      }
      // Videos need post-import verification so we can avoid a false success
      // toast when PhotoKit creates a placeholder but no visible video. Full
      // read/write permission lets getAssetInfoAsync validate the new asset.
      const perm = await MediaLibrary.requestPermissionsAsync(!isVideo);
      if (perm.status !== 'granted') {
        Alert.alert(
          'Permission required',
          'Allow Photos access to save to your library.',
        );
        return;
      }
      setExporting({ name });
      try {
        const decryptedUri = await decryptForSave();
        // Prepare phase done — clear the indicator before the (fast) native save.
        setExporting(null);
        // 1181 — createAssetAsync imports the ORIGINAL file via PhotoKit and
        // resolves with the created asset (unlike saveToLibraryAsync, which
        // re-encodes via the legacy UIImageWriteToSavedPhotosAlbum API and
        // resolves on a nil-error even when nothing durable was written — e.g.
        // under Limited access). We only report success once Photos confirms a
        // real asset id, so "Saved to Photos" is always honest. The decrypted
        // temp is kept until this await resolves so import can read it.
        const asset = await MediaLibrary.createAssetAsync(decryptedUri);
        if (!asset?.id) {
          throw new Error('Photos did not confirm the save');
        }
        const assetInfo = await MediaLibrary.getAssetInfoAsync(asset, {
          shouldDownloadFromNetwork: false,
        });
        const expectedMediaType = isVideo ? MediaLibrary.MediaType.video : MediaLibrary.MediaType.photo;
        if (assetInfo.mediaType !== expectedMediaType) {
          throw new Error(`Photos saved an unexpected asset type: ${assetInfo.mediaType}`);
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast({ type: 'success', message: 'Saved to Photos' });
      } catch (err) {
        showToast({ type: 'error', message: `Save failed: ${friendlyError(err)}` });
      } finally {
        setExporting(null);
      }
    };

    const confirmDeleteFolder = () => {
      Alert.alert(
        'Move folder to Trash',
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
                // 0818 — cascade the delete to every derived store; expand the
                // folder's subtree so descendants aren't orphaned.
                const subtree = sync.collectSubtreeIds([item.id]);
                void onFilesDeleted(subtree, { subtree: item.is_folder });
                void removeFromFileProviderCache(subtree);
                showToast({ type: 'info', message: `"${name}" moved to Trash` });
              } catch (err) {
                Alert.alert('Error', friendlyError(err));
              }
            },
          },
        ],
      );
    };

    const confirmMoveToTrash = () => {
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
                // 0818 — cascade the delete to every derived store; expand the
                // folder's subtree so descendants aren't orphaned.
                const subtree = sync.collectSubtreeIds([item.id]);
                void onFilesDeleted(subtree, { subtree: item.is_folder });
                void removeFromFileProviderCache(subtree);
                showToast({ type: 'info', message: `"${name}" moved to Trash` });
              } catch (err) {
                Alert.alert('Error', friendlyError(err));
              }
            },
          },
        ],
      );
    };

    const showProof = (proof: ProofOfExistence) => {
      setProofModal({ proof, name });
    };

    const promptProveExistence = async () => {
      if (!(await ensureFileReady(item))) return;
      const existing = proofs[item.id];
      if (existing) {
        showProof(existing);
        return;
      }
      try {
        const proof = await createProofOfExistence(item.id);
        setProofs((prev) => ({ ...prev, [item.id]: proof }));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast({ type: 'success', message: 'Proof created' });
        showProof(proof);
      } catch (err) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Could not create proof', friendlyError(err));
      }
    };

    const showDetails = () => {
      const loc = storageLocation(item.storage_pool_id);
      const storedIn = loc.flag ? `${loc.flag} ${loc.label}` : loc.label;
      const lines = item.is_folder
        ? [
            `Name:      ${name}`,
            `Type:      Folder`,
            `Created:   ${formatDate(item.created_at)}`,
            `Modified:  ${formatDate(item.updated_at)}`,
            `Stored in: ${storedIn}`,
            `ID:        ${item.id.slice(0, 8)}`,
          ]
        : [
            `Name:      ${name}`,
            `Type:      ${itemMimeType ?? 'File'}`,
            `Size:      ${formatSize(item.size_bytes)}`,
            `Created:   ${formatDate(item.created_at)}`,
            `Modified:  ${formatDate(item.updated_at)}`,
            `Stored in: ${storedIn}`,
            `ID:        ${item.id.slice(0, 8)}`,
          ];
      Alert.alert(item.is_folder ? 'Folder details' : 'File details', lines.join('\n'));
    };

    const dispatchAction = (option: string) => {
      switch (option) {
        case 'Rename': promptRename(); return;
        case 'Open':
        case 'Preview': openFile(item); return;
        case 'Share':
          void (async () => {
            if (!(await ensureFileReady(item))) return;
            navigation.navigate('ShareSheet', {
              fileId: item.id,
              fileName: name,
              mimeType: itemMimeType ?? undefined,
              sizeBytes: item.size_bytes,
            });
          })();
          return;
        case 'Send via Constellation':
          // Safety net — Constellation crypto is v1 mock (random bytes instead of
          // real X25519 ECDH). Hidden from the action menu until real per-transfer
          // encryption is implemented. See task 0093.
          return;
        case 'Save to Files': void saveToFiles(); return;
        case 'Save to Photos': void saveToGallery(); return;
        case 'Move to...': void promptMove(); return;
        case 'Make available offline':
        case 'Remove offline':
          if (item.is_folder) void toggleFolderOffline(item);
          else void toggleOffline(item, name);
          return;
        case 'Create proof': void promptProveExistence(); return;
        case 'Delete': confirmDeleteFolder(); return;
        case 'Move to Trash': confirmMoveToTrash(); return;
        case 'Pin to top':
        case 'Unpin': togglePin(item, name); return;
        case 'Lock file':
          void (async () => {
            await lockFile(item.id);
            setLockedFileIds((prev) => new Set([...prev, item.id]));
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            showToast({ type: 'success', message: `"${name}" is now locked` });
          })();
          return;
        case 'Unlock file':
          void (async () => {
            const result = await LocalAuthentication.authenticateAsync({
              promptMessage: 'Authenticate to unlock this file',
              disableDeviceFallback: true,
            });
            if (!result.success) return;
            await unlockFile(item.id);
            setLockedFileIds((prev) => {
              const next = new Set(prev);
              next.delete(item.id);
              return next;
            });
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            showToast({ type: 'success', message: `"${name}" is now unlocked` });
          })();
          return;
        case 'Details': showDetails(); return;
      }
    };

    // 0777 — present via the reusable native bottom sheet instead of
    // ActionSheetIOS/Alert. Reuses the dynamic options + dispatchAction.
    const sheetRows: ActionSheetRow[] = options.slice(0, cancelIndex).map((opt, i) => ({
      key: opt,
      label: opt,
      icon: rowActionIcon(opt),
      destructive: i === destructiveIndex,
      testID: sheetActionTestId(opt),
      onPress: () => dispatchAction(opt),
    }));
    const subtitle = item.is_folder
      ? 'Folder'
      : `${formatSize(item.size_bytes)}  ·  ${formatDate(item.updated_at)}`;
    setRowSheet({
      header: {
        name,
        subtitle,
        thumbnail: <Ionicons name={item.is_folder ? 'folder' : 'document'} size={20} color={c.ink3} />,
      },
      rows: sheetRows,
    });
    setRowSheetOpen(true);
  }, [
    navigation,
    openFile,
    decryptedNames,
    showToast,
    pinnedFolders,
    togglePin,
    toggleOffline,
    toggleFolderOffline,
    proofs,
    lockedFileIds,
    currentFolder.id,
    indexFile,
    sync,
    encryptMetadata,
    mimeTypeFor,
    ensureFileReady,
  ]);

  // Filtered + sorted file list
  const vaultSearchMatches = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return [];
    return searchVault(query);
  }, [searchQuery, searchVault, searchIndexReady]);

  const displayedFiles = useMemo(() => {
    let result = uniqueFileEntries(files);
    if (recentFilterActive) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      result = result.filter((f) => !f.is_folder && new Date(f.updated_at).getTime() >= cutoff);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const seen = new Set<string>();
      const vaultResults = vaultSearchMatches.map((match) => {
        seen.add(match.id);
        return searchResultToFileEntry(match);
      });
      const localFallback = result.filter((f) => {
        if (seen.has(f.id)) return false;
        const name = decryptedNames[f.id] ?? displayName(f);
        return name.toLowerCase().includes(q);
      });
      if (vaultResults.length > 0) return uniqueFileEntries([...vaultResults, ...localFallback]);
      result = localFallback;
    }
    return applySortOrder(result, sortOrder, decryptedNames);
  }, [files, searchQuery, decryptedNames, sortOrder, vaultSearchMatches, recentFilterActive]);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const renderBreadcrumbs = () => {
    // Deep paths collapse to exactly 3 segments: root  …  current. The "…" is a
    // native iOS UIMenu of every in-between folder, so any ancestor is reachable
    // in one tap without a long horizontal scroll. Shallow paths (≤3) render in
    // full. (Guus request.)
    if (folderStack.length > 3) {
      const root = folderStack[0];
      const current = folderStack[folderStack.length - 1];
      return (
        <View style={[styles.breadcrumbRow, styles.breadcrumbCollapsedRow]}>
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigateToBreadcrumb(0);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            testID="breadcrumb-crumb-0"
            accessibilityLabel={`Navigate to ${root.name}`}
            accessibilityRole="button"
          >
            <Text style={[styles.breadcrumbText, { color: c.amberDeep }]} numberOfLines={1}>
              {root.name}
            </Text>
          </TouchableOpacity>

          <Ionicons name="chevron-forward" size={12} color={c.ink4} style={styles.breadcrumbChevron} />

          <TouchableOpacity
            onPress={openBreadcrumbPopover}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            testID="breadcrumb-collapse"
            accessibilityLabel="Show folders in between"
            accessibilityRole="button"
          >
            <View ref={breadcrumbChipRef} collapsable={false} style={styles.breadcrumbEllipsis}>
              <Text style={[styles.breadcrumbText, { color: c.amberDeep, fontWeight: '600' }]}>…</Text>
            </View>
          </TouchableOpacity>

          <Ionicons name="chevron-forward" size={12} color={c.ink4} style={styles.breadcrumbChevron} />

          <Text
            testID={`breadcrumb-crumb-${folderStack.length - 1}`}
            style={[styles.breadcrumbText, { color: c.ink, fontWeight: '600', flexShrink: 1 }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {current.name}
          </Text>
        </View>
      );
    }
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.breadcrumbScroll}
        contentContainerStyle={styles.breadcrumbRow}
      >
        {folderStack.map((entry, index) => {
          const isLast = index === folderStack.length - 1;
          return (
            <View key={entry.id ?? 'root'} style={styles.breadcrumbItem}>
              {index > 0 && (
                <Ionicons
                  name="chevron-forward"
                  size={12}
                  color={c.ink4}
                  style={styles.breadcrumbChevron}
                />
              )}
              <TouchableOpacity
                disabled={isLast}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  navigateToBreadcrumb(index);
                }}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                testID={`breadcrumb-crumb-${index}`}
                accessibilityLabel={`Navigate to ${entry.name}`}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.breadcrumbText,
                    { color: c.amberDeep },
                    isLast && { color: c.ink, fontWeight: '600' },
                  ]}
                  numberOfLines={1}
                >
                  {entry.name}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    );
  };

  // 3 most recently modified non-folder files — reuses the existing files array
  const recentFiles = useMemo(() => (
    uniqueFileEntries(files)
      .filter((f) => !f.is_folder)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 3)
  ), [files]);
  const backupPendingCount = backupProgress.pending ?? 0;
  const showBackupContinueBanner =
    isPhotoBackupEnabled &&
    backupPendingCount > 0 &&
    backupProgress.state === 'waitingForAppOpen' &&
    folderStack.length === 1 &&
    !selectMode &&
    !searchActive;
  const backupItemLabel = includeVideos
    ? backupPendingCount === 1 ? 'item is' : 'items are'
    : backupPendingCount === 1 ? 'photo is' : 'photos are';

  const renderRecentSection = () => {
    if (recentFiles.length === 0 || folderStack.length > 1 || selectMode || searchActive) return null;
    return (
      <View style={[styles.pinnedSection, { borderBottomColor: c.line }]}>
        <Text style={[styles.pinnedLabel, { color: c.ink3 }]}>Recent</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pinnedRow}
        >
          {recentFiles.map((item) => {
            const effectiveItem = withDecryptedMime(item);
            const category = fileCategory(effectiveItem);
            const name = decryptedNames[item.id] ?? displayName(item);
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.recentCard, { backgroundColor: c.paper2, borderColor: c.line }]}
                onPress={() => openFile(item)}
                activeOpacity={0.7}
                accessibilityLabel={`Open recent file ${name}`}
                accessibilityRole="button"
              >
                <FileIcon category={category} fileId={item.id} hasThumbnail={item.has_thumbnail} />
                {name ? (
                  <Text style={[styles.recentName, { color: c.ink }]} numberOfLines={1}>
                    {name}
                  </Text>
                ) : (
                  <View style={{ height: 12, width: 80, borderRadius: 3, backgroundColor: c.line, marginTop: 4 }} />
                )}
                <Text style={[styles.recentDate, { color: c.ink4 }]} numberOfLines={1}>
                  {formatDate(item.updated_at)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  const renderPinnedSection = () => {
    if (pinnedFolders.length === 0 || selectMode || searchActive) return null;
    return (
      <View style={[styles.pinnedSection, { borderBottomColor: c.line }]}>
        <Text style={[styles.pinnedLabel, { color: c.ink3 }]}>Pinned</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pinnedRow}
        >
          {pinnedFolders.map((pf) => (
            <TouchableOpacity
              key={pf.id}
              style={[styles.pinnedChip, { borderColor: c.amber, backgroundColor: c.amberBg }]}
              onPress={() => navigateToPinned(pf)}
              activeOpacity={0.7}
              accessibilityLabel={`Open pinned folder ${pf.name}`}
              accessibilityRole="button"
            >
              <Icon name="folder" size={13} color={c.amberDeep} />
              <Text style={[styles.pinnedChipText, { color: c.amberDeep }]} numberOfLines={1}>
                {pf.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const handleSwipeShare = useCallback((item: FileEntry) => {
    const name = decryptedNames[item.id] ?? displayName(item);
    void (async () => {
      if (!(await ensureFileReady(item))) return;
      navigation.navigate('ShareSheet', {
        fileId: item.id,
        fileName: name,
        mimeType: mimeTypeFor(item) ?? undefined,
        sizeBytes: item.size_bytes,
      });
    })();
  }, [navigation, decryptedNames, mimeTypeFor, ensureFileReady]);

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
              // 0818 — cascade to every derived store, subtree-expanded.
              const subtree = sync.collectSubtreeIds([item.id]);
              void onFilesDeleted(subtree, { subtree: item.is_folder });
              void removeFromFileProviderCache(subtree);
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [decryptedNames, sync]);

  // Long-press enters multi-select with the pressed row already selected,
  // matching the runbook expectation. The previous ActionSheet (rename,
  // pin, prove-existence, etc.) is reachable from the multi-select toolbar
  // and via swipe; if more single-row actions need to come back, attach a
  // discrete trigger (e.g. a tappable "..." chip) instead of overloading
  // long-press.
  const handleRowLongPress = useCallback((item: FileEntry) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    enterSelectMode(item.id);
  }, [enterSelectMode]);

  // Per-item offline status for the row indicator. Files read the manager
  // directly; folders aggregate over their descendant files (0794). Depends on
  // offlineVersion so the FlatList re-renders rows as downloads progress.
  const offlineStatusFor = useCallback((item: FileEntry): OfflineStatus | undefined => {
    if (item.is_folder) {
      if (!offlineManager.isFolderOffline(item.id)) return undefined;
      const fileIds = folderDescendantFileIds(item.id);
      const agg = offlineManager.aggregate(fileIds);
      return { state: agg.state, progress: agg.progress };
    }
    return offlineManager.getStatus(item.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineVersion, folderDescendantFileIds]);

  const renderFileRow = useCallback(({ item }: { item: FileEntry }) => (
    <FileRowItem
      item={withDecryptedMime(item)}
      decryptedName={decryptedNames[item.id]}
      onPress={openFile}
      onLongPress={handleLongPress}
      onShare={handleSwipeShare}
      onDelete={handleSwipeDelete}
      onTrustPress={openTrust}
      selectMode={selectMode}
      isSelected={selectedIds.has(item.id)}
      onToggleSelect={toggleSelect}
      sortOrder={sortOrder}
      offlineStatus={offlineStatusFor(item)}
      hasProof={!!proofs[item.id]}
      isShared={item.is_folder && (item.share_count ?? 0) > 0}
      isLocked={lockedFileIds.has(item.id)}
    />
  ), [decryptedNames, withDecryptedMime, openFile, handleLongPress, handleSwipeShare, handleSwipeDelete, openTrust, selectMode, selectedIds, toggleSelect, sortOrder, offlineStatusFor, proofs, lockedFileIds]);

  // Grid sizing — 3 columns, evenly spaced, responsive to screen width
  const GRID_COLUMNS = 3;
  const GRID_GAP = 10;
  const screenWidth = Dimensions.get('window').width;
  const gridCardWidth = useMemo(() => {
    const totalGutter = spacing.lg * 2 + GRID_GAP * (GRID_COLUMNS - 1);
    return Math.floor((screenWidth - totalGutter) / GRID_COLUMNS);
  }, [screenWidth]);

  const renderFileGrid = useCallback(({ item }: { item: FileEntry }) => (
    <FileGridItem
      item={withDecryptedMime(item)}
      decryptedName={decryptedNames[item.id]}
      onPress={openFile}
      onLongPress={handleLongPress}
      onTrustPress={openTrust}
      selectMode={selectMode}
      isSelected={selectedIds.has(item.id)}
      onToggleSelect={toggleSelect}
      sortOrder={sortOrder}
      cardWidth={gridCardWidth}
      offlineStatus={offlineStatusFor(item)}
      hasProof={!!proofs[item.id]}
      isShared={item.is_folder && (item.share_count ?? 0) > 0}
      isLocked={lockedFileIds.has(item.id)}
    />
  ), [decryptedNames, withDecryptedMime, openFile, handleLongPress, openTrust, selectMode, selectedIds, toggleSelect, sortOrder, gridCardWidth, offlineStatusFor, proofs, lockedFileIds]);

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
    // Wait for at least one authoritative fetch before claiming the folder
    // is empty. Otherwise existing accounts see "Upload your first file" on
    // the first paint after login while the index is still being fetched.
    // The unlock guard is intentionally additive — `loading` already covers
    // most of this, but the sync-ready branch can transition us out of
    // `loading` before any data is on disk.
    const stillResolving = !hasLoadedOnce && (refreshing || !unlockAttempted);
    if (stillResolving) {
      return (
        <View style={styles.emptyContainer}>
          <ActivityIndicator color={c.amber} />
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

  const renderError = () => {
    const isOffline = !!error && /offline|network|connection|internet|unreachable|reach|fetch/i.test(error);
    return (
      <View style={styles.errorContainer}>
        <Ionicons name={isOffline ? 'cloud-offline-outline' : 'alert-circle-outline'} size={48} color={c.ink3} />
        <Text style={[styles.errorText, { color: c.ink2 }]}>{error}</Text>
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: c.amber }]}
          onPress={() => fetchFiles(currentFolder.id)}
        >
          <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  };

  // ------------------------------------------------------------------
  // Main render
  // ------------------------------------------------------------------

  const allDisplayedIds = displayedFiles.map((f) => f.id);
  const allSelected = selectedIds.size === allDisplayedIds.length && allDisplayedIds.length > 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: c.paper }]}>
      {/* Header area wrapper — shows bottom shadow when list is scrolled */}
      <View style={[styles.headerArea, isScrolled && { borderBottomColor: c.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      {/* Header — select mode vs normal mode */}
      {selectMode ? (
        <View style={styles.header}>
          <TouchableOpacity onPress={exitSelectMode} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={{ color: c.amberDeep, fontSize: 16, fontWeight: '500' }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.selectTitle, { color: c.ink }]}>
            {selectedIds.size === 0 ? 'Select items' : `${selectedIds.size} selected`}
          </Text>
          <TouchableOpacity
            onPress={() => handleSelectAll(allDisplayedIds)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ color: c.amberDeep, fontSize: 13, fontWeight: '500' }}>
              {allSelected ? 'Deselect All' : 'Select All'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
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
          {/* 0800 — single line, tail-truncated (never stacks vertically);
              long-press surfaces the full name via a native UIMenu header. */}
          <MenuView
            title={currentFolder.name}
            onPressAction={onFolderTitleAction}
            actions={folderTitleMenuActions}
            shouldOpenOnLongPress
            themeVariant={themeScheme}
            style={styles.titleMenu}
          >
            <Text
              style={[styles.title, { color: c.ink }]}
              numberOfLines={1}
              ellipsizeMode="tail"
              accessibilityLabel={currentFolder.name}
            >
              {currentFolder.name}
            </Text>
          </MenuView>
          {!searchActive && presence.length > 0 && (
            <View style={styles.presenceWrap}>
              <PresenceAvatars users={presence} />
            </View>
          )}
          <View style={{ flex: 1 }} />
          {!searchActive && files.length > 0 && (
            <TouchableOpacity
              onPress={() => enterSelectMode()}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.searchButton}
              accessibilityLabel="Select files"
              accessibilityRole="button"
            >
              <Ionicons name="checkmark-circle-outline" size={20} color={c.ink2} />
            </TouchableOpacity>
          )}
          {!searchActive && (
            <TouchableOpacity
              onPress={toggleViewMode}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.searchButton}
              accessibilityLabel={`Switch to ${viewMode === 'list' ? 'grid' : 'list'} view`}
              accessibilityRole="button"
            >
              <Ionicons
                name={viewMode === 'list' ? 'grid-outline' : 'list-outline'}
                size={20}
                color={c.ink2}
              />
            </TouchableOpacity>
          )}
          {!searchActive && (
            <MenuView
              title="Sort by"
              onPressAction={onSortAction}
              actions={sortMenuActions}
              shouldOpenOnLongPress={false}
              themeVariant={themeScheme}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.searchButton}
            >
              <View
                style={styles.searchButton}
                accessibilityLabel={`Sort files, current: ${SORT_LABELS[sortOrder]}`}
                accessibilityRole="button"
              >
                <Ionicons
                  name="swap-vertical"
                  size={20}
                  color={sortOrder !== 'date-desc' ? c.amberDeep : c.ink2}
                />
              </View>
            </MenuView>
          )}
          <TouchableOpacity
            onPress={handleSearchToggle}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.searchButton}
            accessibilityLabel={searchActive ? 'Close search' : 'Search files'}
            accessibilityRole="button"
          >
            <Ionicons
              name={searchActive ? 'close' : 'search'}
              size={20}
              color={searchActive ? c.amberDeep : c.ink2}
            />
          </TouchableOpacity>
        </View>
      )}

      {/* Storage warning — shown when nearing or exceeding plan limit */}
      {!selectMode && usage && usage.plan_limit_bytes > 0 && (() => {
        const ratio = usage.used_bytes / usage.plan_limit_bytes;
        if (ratio < 0.9) return null;
        const isFull = ratio >= 1;
        const message = isFull
          ? 'Storage full — delete files or upgrade'
          : `Storage almost full — ${formatSize(usage.used_bytes)} of ${formatSize(usage.plan_limit_bytes)} used`;
        return (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => Alert.alert(
              isFull ? 'Storage full' : 'Storage almost full',
              'Free up space by deleting files or upgrade your plan in Settings.',
            )}
            style={[
              styles.storageBanner,
              {
                backgroundColor: isFull ? c.red : c.amberBg,
                borderColor: isFull ? c.red : c.amber,
              },
            ]}
          >
            <Ionicons
              name="warning-outline"
              size={16}
              color={isFull ? '#fff' : c.amberDeep}
            />
            <Text
              style={[styles.storageBannerText, { color: isFull ? '#fff' : c.ink }]}
              numberOfLines={1}
            >
              {message}
            </Text>
            <Text style={[styles.storageBannerHint, { color: isFull ? '#fff' : c.amberDeep }]}>
              {isFull ? 'Upgrade' : 'Manage'}
            </Text>
          </TouchableOpacity>
        );
      })()}

      {showBackupContinueBanner && (
        <View style={[styles.backupContinueBanner, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <View style={[styles.backupContinueIcon, { backgroundColor: c.amberBg }]}>
            <Ionicons name="cloud-upload-outline" size={17} color={c.amberDeep} />
          </View>
          <View style={styles.backupContinueTextWrap}>
            <Text style={[styles.backupContinueTitle, { color: c.ink }]} numberOfLines={1}>
              Backup waiting
            </Text>
            <Text style={[styles.backupContinueSubtitle, { color: c.ink3 }]} numberOfLines={1}>
              {backupPendingCount.toLocaleString()} {backupItemLabel} waiting
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.backupContinueButton, { backgroundColor: c.amber }]}
            onPress={handleReviewBackup}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Review backup settings"
          >
            <Text style={[styles.backupContinueButtonText, { color: c.ink }]}>Review</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 1180 — top-of-Files "Exporting…" indicator for Save to Files / Save to
          Photos. Shown for the whole download + decrypt prepare phase so a large
          file no longer looks frozen before the native sheet appears. The banner
          owns its own progress state and is fed IMPERATIVELY via exportBannerRef
          (see decryptForSave onProgress) — a progress tick re-renders ONLY this
          ~40pt banner, never FilesScreen or its FlatList. That isolation is the
          whole point: it is what makes the restored "Downloading N% / Decrypting
          X/Y (N%)" progress crash-safe on a 3 GB export (1177/#188 regression). */}
      {exporting && !selectMode && (
        <ExportProgressBanner ref={exportBannerRef} name={exporting.name} />
      )}

      {/* Search bar — slides in below header when active */}
      {searchActive && !selectMode && (
        <>
          <View style={styles.searchBar}>
            <TextInput
              ref={searchInputRef}
              style={[styles.searchInput, { backgroundColor: c.paper2, borderColor: c.line, color: c.ink }]}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search your vault..."
              placeholderTextColor={c.ink4}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
            <TouchableOpacity
              onPress={handleSearchToggle}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Cancel search"
              accessibilityRole="button"
            >
              <Text style={{ color: c.amberDeep, fontSize: 14, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
          {/* Vault-wide search hint — surfaces matches outside the current
              folder so users know there's more to find than the local
              filter shows. Falls back silently when the index isn't
              loaded yet (vault still locked) or when there are no extra
              matches. */}
          {(() => {
            const q = searchQuery.trim()
            if (!q) return null
            const inFolderIds = new Set(files.map((f) => f.id))
            const elsewhere = vaultSearchMatches.filter((m) => !inFolderIds.has(m.id)).length
            if (elsewhere === 0) return null
            return (
              <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                <Text style={{ color: c.ink3, fontSize: 12 }}>
                  {elsewhere} match{elsewhere === 1 ? '' : 'es'} elsewhere in your vault
                </Text>
              </View>
            )
          })()}
        </>
      )}

      {/* Breadcrumbs (only show when navigated into a folder, not during search or select) */}
      {folderStack.length > 1 && !searchActive && !selectMode && renderBreadcrumbs()}
      </View>{/* end headerArea */}

      {/* Pinned folders */}
      {renderPinnedSection()}

      {/* Recent files */}
      {renderRecentSection()}

      {/* Recent filter banner — shown when the "Recent Files" quick action is active */}
      {recentFilterActive && (
        <View style={[styles.recentFilterBanner, { backgroundColor: c.amberBg, borderColor: c.amberDeep }]}>
          <Ionicons name="time-outline" size={14} color={c.amberDeep} />
          <Text style={[styles.recentFilterText, { color: c.amberDeep }]}>Showing files from the last 24 hours</Text>
          <TouchableOpacity onPress={() => setRecentFilterActive(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color={c.amberDeep} />
          </TouchableOpacity>
        </View>
      )}

      {/* Content */}
      {error ? (
        renderError()
      ) : loading && !refreshing ? (
        <View>
          {[0, 1, 2, 3, 4].map((i) => <SkeletonRow key={i} />)}
        </View>
      ) : (
        <FlatList
          // FlatList does not allow numColumns to change at runtime — remount with a key
          key={viewMode}
          data={displayedFiles}
          keyExtractor={(item) => item.id}
          renderItem={viewMode === 'grid' ? renderFileGrid : renderFileRow}
          // Re-render rows as offline downloads progress (0793).
          extraData={offlineVersion}
          numColumns={viewMode === 'grid' ? GRID_COLUMNS : 1}
          columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
          ListEmptyComponent={renderEmpty}
          onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
          scrollEventThrottle={100}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={selectMode ? undefined : handleRefresh}
              tintColor={c.amber}
              colors={[c.amber]}
            />
          }
          contentContainerStyle={[
            displayedFiles.length === 0 ? styles.emptyList : undefined,
            viewMode === 'grid' ? styles.gridContent : undefined,
            { paddingBottom: 80 + insets.bottom },
          ]}
          removeClippedSubviews={true}
          windowSize={5}
          keyboardDismissMode="on-drag"
        />
      )}

      {/* 1301 — Live-Activity upload card (C2): measured AES rate + net rate + ETA */}
      {upload && !selectMode && (
        <UploadActivityCard upload={upload} bottom={16 + insets.bottom + 64} />
      )}

      {/* Batch action bar — shown in select mode */}
      {selectMode && (
        <View style={[styles.actionBar, { backgroundColor: c.paper, borderTopColor: c.line }]}>
          <TouchableOpacity
            style={styles.actionBarButton}
            onPress={handleBatchShare}
            disabled={selectedIds.size === 0}
          >
            <Icon name="share" size={22} color={selectedIds.size === 0 ? c.ink4 : c.ink2} />
            <Text style={[styles.actionBarLabel, { color: selectedIds.size === 0 ? c.ink4 : c.ink2 }]}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBarButton}
            onPress={() => void handleBatchMove()}
            disabled={selectedIds.size === 0}
          >
            <Icon name="folder" size={22} color={selectedIds.size === 0 ? c.ink4 : c.ink2} />
            <Text style={[styles.actionBarLabel, { color: selectedIds.size === 0 ? c.ink4 : c.ink2 }]}>Move</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBarButton}
            onPress={handleBatchTrash}
            disabled={selectedIds.size === 0}
          >
            <Icon name="trash" size={22} color={selectedIds.size === 0 ? c.ink4 : c.red} />
            <Text style={[styles.actionBarLabel, { color: selectedIds.size === 0 ? c.ink4 : c.red }]}>Trash</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Floating action button — hidden in select mode. Opens the native iOS
          UIMenu pull-down (0789). While an upload is in flight the FAB is a plain
          disabled button so the menu can't fire mid-upload. */}
      {!selectMode && (
        uploadingName ? (
          <TouchableOpacity
            style={[styles.fab, { bottom: 16, backgroundColor: c.amber }]}
            activeOpacity={0.8}
            disabled
            testID="fab-add"
            accessibilityLabel="Add file or folder"
            accessibilityRole="button"
          >
            <Text style={[styles.fabText, { color: c.ink }]}>+</Text>
          </TouchableOpacity>
        ) : (
          <MenuView
            // 1284 — the menu ROWS are a native UIMenu and cannot carry RN testIDs; target them
            // by their visible titles. This id covers opening the menu without coordinate taps.
            testID="fab-add"
            onPressAction={onAddAction}
            actions={addMenuActions}
            shouldOpenOnLongPress={false}
            themeVariant={themeScheme}
            style={[styles.fab, { bottom: 16, backgroundColor: c.amber }]}
          >
            <View
              style={styles.fabInner}
              accessibilityLabel="Add file or folder"
              accessibilityRole="button"
            >
              <Text style={[styles.fabText, { color: c.ink }]}>+</Text>
            </View>
          </MenuView>
        )
      )}

      {/* 0789 — file-row long-press still uses the reusable bottom sheet; sort + "+"
          are now native UIMenus (above). Converting the long-press to a native
          context menu is a tracked follow-up. */}
      <BBActionSheet
        visible={rowSheetOpen}
        onClose={() => setRowSheetOpen(false)}
        header={rowSheet?.header}
        rows={rowSheet?.rows ?? []}
      />

      {/* 0796 — native nested folder picker for "Move" */}
      <FolderPickerModal
        visible={movePicker !== null}
        title={movePicker?.title ?? 'Move'}
        folders={movePicker?.folders ?? []}
        currentParentId={movePicker?.currentParentId ?? null}
        busy={moveBusy}
        onCancel={() => { if (!moveBusy) setMovePicker(null); }}
        onConfirm={(targetId) => void performMove(targetId)}
      />

      {/* Android new-folder modal — Alert.prompt is iOS-only. */}
      <Modal
        visible={newFolderOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setNewFolderOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={styles.modalBackdrop}
            onPress={() => !creatingFolder && setNewFolderOpen(false)}
          />
          <View style={[styles.modalCard, { backgroundColor: c.paper, borderColor: c.line }]}>
            <Text style={[styles.modalTitle, { color: c.ink }]}>New folder</Text>
            <Text style={[styles.modalBody, { color: c.ink3 }]}>Enter a name for the new folder.</Text>
            <TextInput
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="Folder name"
              placeholderTextColor={c.ink4}
              autoFocus
              autoCapitalize="sentences"
              returnKeyType="done"
              onSubmitEditing={() => void confirmNewFolderModal()}
              editable={!creatingFolder}
              style={[styles.modalInput, { color: c.ink, borderColor: c.line2, backgroundColor: c.paper2 }]}
              testID="create-folder-input"
              accessibilityLabel="Folder name"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalSecondary}
                onPress={() => setNewFolderOpen(false)}
                disabled={creatingFolder}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[styles.modalSecondaryText, { color: c.ink2 }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalPrimary, { backgroundColor: c.amber, opacity: !newFolderName.trim() || creatingFolder ? 0.5 : 1 }]}
                onPress={() => void confirmNewFolderModal()}
                disabled={!newFolderName.trim() || creatingFolder}
                testID="create-folder-confirm"
                accessibilityRole="button"
                accessibilityLabel="Create folder"
              >
                <Text style={[styles.modalPrimaryText, { color: c.ink }]}>{creatingFolder ? 'Creating…' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Breadcrumb collapsed-path popover — indented tree of the in-between
          folders, anchored under the "…" chip. The native UIMenu can't draw an
          indent, so we render our own. Indent caps at 3 columns; folders deeper
          than that get an amber "…" and an "in <parent>" annotation. */}
      <Modal
        visible={breadcrumbPopoverOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setBreadcrumbPopoverOpen(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={StyleSheet.absoluteFill}
          onPress={() => setBreadcrumbPopoverOpen(false)}
        />
        {breadcrumbAnchor ? (() => {
          const screenW = Dimensions.get('window').width;
          const screenH = Dimensions.get('window').height;
          const popW = Math.min(300, screenW - 24);
          const left = Math.max(8, Math.min(breadcrumbAnchor.x - 10, screenW - popW - 8));
          const top = breadcrumbAnchor.y + breadcrumbAnchor.height + 4;
          const middle = folderStack.slice(1, folderStack.length - 1);
          return (
            <View
              style={[
                styles.breadcrumbPopover,
                { backgroundColor: c.paper, borderColor: c.line, width: popW, left, top },
              ]}
            >
              <ScrollView style={{ maxHeight: screenH * 0.5 }} bounces={false}>
                {middle.map((entry, i) => {
                  const stackIndex = i + 1;
                  const indent = Math.min(i, 2);
                  const showEllipsis = i >= 2;
                  const annotation = i >= 3 ? `in ${folderStack[i].name}` : null;
                  return (
                    <TouchableOpacity
                      key={entry.id ?? `crumb-${stackIndex}`}
                      onPress={() => onBreadcrumbCrumbPress(stackIndex)}
                      style={[styles.breadcrumbPopoverRow, { paddingLeft: 12 + indent * 18 }]}
                      testID={`breadcrumb-crumb-${stackIndex}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Go to ${entry.name}`}
                    >
                      {showEllipsis ? (
                        <Text style={[styles.breadcrumbPopoverEllipsis, { color: c.amber }]}>…</Text>
                      ) : null}
                      <Ionicons
                        name="folder-outline"
                        size={18}
                        color={c.amberDeep}
                        style={styles.breadcrumbPopoverIcon}
                      />
                      <Text
                        style={[styles.breadcrumbPopoverLabel, { color: c.ink }]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {entry.name}
                        {annotation ? <Text style={{ color: c.ink3 }}>{`  ${annotation}`}</Text> : null}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          );
        })() : null}
      </Modal>

      {/* Trust details bottom sheet — opened from the lock icon on a file row */}
      <TrustDetailsSheet
        file={trustFile}
        fileName={trustFileName}
        onClose={closeTrust}
      />

      {/* Proof of existence modal */}
      <Modal
        visible={proofModal !== null}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        onRequestClose={() => setProofModal(null)}
      >
        {proofModal && (
          <ProofDetailModal
            proof={proofModal.proof}
            fileName={proofModal.name}
            onClose={() => setProofModal(null)}
            showToast={showToast}
          />
        )}
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Header
  headerArea: {},
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 8 },
  selectTitle: { flex: 1, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  backButton: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 20, fontWeight: '600', marginTop: -2 },
  // 0800 — flexShrink lets a long folder name yield space to the trailing
  // action icons (truncating with "…") instead of wrapping to a second line.
  titleMenu: { flexShrink: 1 },
  title: { fontSize: 28, fontWeight: '700', flexShrink: 1 },
  searchBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 10 },
  searchInput: { flex: 1, height: 36, borderRadius: radii.md, paddingHorizontal: 12, fontSize: 15, borderWidth: 1 },
  searchButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  // Pinned folders
  pinnedSection: { paddingTop: 8, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  pinnedLabel: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: spacing.lg, marginBottom: 6 },
  pinnedRow: { paddingHorizontal: spacing.lg, gap: 8, paddingBottom: 10 },
  pinnedChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.round, borderWidth: 1, maxWidth: 140 },
  pinnedChipText: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  recentCard: { width: 120, borderRadius: radii.md, borderWidth: 1, padding: 10, gap: 6 },
  recentName: { fontSize: 12, fontWeight: '500' },
  recentDate: { fontSize: 10 },

  // Breadcrumbs
  breadcrumbScroll: { flexGrow: 0, paddingBottom: spacing.sm },
  breadcrumbRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, gap: 2 },
  breadcrumbCollapsedRow: { paddingBottom: spacing.sm },
  breadcrumbEllipsis: { paddingHorizontal: 6, paddingVertical: 2, minWidth: 24, alignItems: 'center' },
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center' },
  breadcrumbChevron: { marginHorizontal: 2 },
  breadcrumbText: { fontSize: 12, fontWeight: '500' },
  breadcrumbPopover: {
    position: 'absolute',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  breadcrumbPopoverRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 14, paddingVertical: 10 },
  breadcrumbPopoverEllipsis: { width: 14, fontSize: 15, fontWeight: '700', textAlign: 'center', marginRight: 2 },
  breadcrumbPopoverIcon: { marginRight: 8 },
  breadcrumbPopoverLabel: { fontSize: 15, flexShrink: 1 },

  // Swipe actions
  swipeActions: { flexDirection: 'row' },
  swipeAction: { width: 72, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeActionLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },

  // Multi-select
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  actionBar: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  actionBarButton: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, gap: 3 },
  actionBarLabel: { fontSize: 10, fontWeight: '600' },

  // File list
  fileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: spacing.lg, borderBottomWidth: 1, gap: 12 },
  fileIcon: { alignItems: 'center', justifyContent: 'center' },
  fileInfo: { flex: 1, minWidth: 0 },
  fileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  lockIcon: { flexShrink: 0 },
  offlineBadge: { flexShrink: 0, marginLeft: 2 },
  // 0793 — trailing offline indicator slot on the list row (loader + % aligned).
  offlineIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 3,
    minWidth: 30,
    marginRight: 2,
  },
  offlinePct: { fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
  proofBadge: { flexShrink: 0, marginLeft: 2 },
  lockedBadge: { flexShrink: 0, marginLeft: 2 },
  fileName: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  fileNameEncrypted: { fontStyle: 'italic' },
  fileMeta: { fontSize: 11, marginTop: 2 },
  cryptoMeta: { fontFamily: fonts.mono, fontSize: 10, marginTop: 1, letterSpacing: 0.2 },
  trustLock: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  chevron: { fontSize: 18 },
  moreButton: { paddingHorizontal: 4, paddingVertical: 4 },

  // File grid
  gridContent: { paddingHorizontal: spacing.lg, paddingTop: 12 },
  gridRow: { gap: 10, marginBottom: 10 },
  gridCard: {
    borderRadius: radii.lg,
    paddingVertical: 14,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 10,
    minHeight: 130,
    position: 'relative',
  },
  gridIconWrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 4 },
  gridTextWrap: { width: '100%', alignItems: 'center', gap: 2 },
  gridNameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 3, justifyContent: 'center' },
  gridName: { fontSize: 12, fontWeight: '600', textAlign: 'center', lineHeight: 15 },
  gridMeta: { fontSize: 10, textAlign: 'center' },
  cryptoMetaGrid: { fontFamily: fonts.mono, fontSize: 9, textAlign: 'center', marginTop: 1, letterSpacing: 0.2 },
  gridTrustLock: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  gridCheckbox: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },

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

  // Storage warning banner
  storageBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 8,
  },
  storageBannerText: { flex: 1, fontSize: 12, fontWeight: '500' },
  storageBannerHint: { fontSize: 12, fontWeight: '700' },

  // 1177 — top-of-Files "Exporting…" indicator (Save to Files / Save to Photos
  // prepare phase). Matches the storage/backup banner shape; the amber spinner
  // + tabular-% mirrors the offline download indicator's visual language.
  // 1180 — export banner styles moved into ExportProgressBanner.tsx (isolated,
  // memoized, imperatively-updated) so progress ticks never re-render this screen.

  // Backup continuation banner
  backupContinueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 10,
  },
  backupContinueIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backupContinueTextWrap: { flex: 1, minWidth: 0 },
  backupContinueTitle: { fontSize: 13, fontWeight: '700' },
  backupContinueSubtitle: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  backupContinueButton: {
    minWidth: 78,
    height: 34,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  backupContinueButtonText: { fontSize: 12, fontWeight: '700' },

  // FAB — standard iOS size 56x56
  fab: { position: 'absolute', right: 20, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', ...shadows.lg },
  fabInner: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  fabText: { fontSize: 28, fontWeight: '600', marginTop: -2 },

  sharedBadge: { marginLeft: 4 },
  presenceWrap: { flexDirection: 'row', alignItems: 'center', marginRight: 8 },

  // Android new-folder modal
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  modalBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 20,
    gap: 12,
    ...shadows.lg,
  },
  modalTitle: { fontSize: 17, fontWeight: '600' },
  modalBody: { fontSize: 13 },
  modalInput: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 4 },
  modalSecondary: { paddingVertical: 8, paddingHorizontal: 12 },
  modalSecondaryText: { fontSize: 15, fontWeight: '500' },
  modalPrimary: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: radii.md },
  modalPrimaryText: { fontSize: 15, fontWeight: '600' },

  // Recent filter banner
  recentFilterBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: spacing.lg,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  recentFilterText: { flex: 1, fontSize: 12, fontWeight: '500' },
});
