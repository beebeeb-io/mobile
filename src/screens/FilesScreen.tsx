import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
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
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as DocumentPicker from 'expo-document-picker';
import { isFileLocked, lockFile, unlockFile } from '../lib/file-locks';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import * as Clipboard from 'expo-clipboard';
import { fonts, radii, spacing, shadows } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useToast } from '../lib/toast-context';
import SkeletonRow from '../components/SkeletonRow';
import PresenceAvatars from '../components/PresenceAvatars';
import TrustDetailsSheet from '../components/TrustDetailsSheet';
import { ApiError, listFiles, createFolder, deleteFile, renameFile, moveFile, uploadFile, downloadFile, friendlyError, getStorageUsage, createProofOfExistence, storageLocation, trustLocation, getFolderPresence, getUploadStatus, getApiUrl, getToken } from '../lib/api';
import { generateAndUploadThumbnail, fetchDecryptedThumbnailUri } from '../lib/thumbnail';
import type { FileEntry, StorageUsage, ProofOfExistence, PresenceUser, SyncNode } from '../lib/api';
import type { RootStackParamList, TabParamList } from '../App';
import { useCrypto } from '../lib/crypto-context';
import { useAuth } from '../lib/auth';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { useSync } from '../lib/sync-context';
import { useSearchIndex } from '../lib/use-search-index';
import type { SearchIndexEntry, SearchResult } from '../lib/search-index';

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

function guessMimeTypeFromName(name: string): string | null {
  const imageMimeType = imageMimeTypeFromName(name);
  if (imageMimeType) return imageMimeType;

  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'svg':
      return 'image/svg+xml';
    case 'pdf':
      return 'application/pdf';
    case 'zip':
      return 'application/zip';
    case '3mf':
      return 'model/3mf';
    case 'txt':
    case 'md':
      return 'text/plain';
    case 'csv':
      return 'text/csv';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default:
      return null;
  }
}

function imageMimeTypeFromName(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'heic':
      return 'image/heic';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    default:
      return null;
  }
}

async function patchFileMimeType(fileId: string, mimeType: string): Promise<void> {
  const token = await getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${getApiUrl()}/api/v1/files/${fileId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ mime_type: mimeType }),
  });
  if (!res.ok) throw new Error('Failed to patch file mime type');
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

/** Decode a base64 string to a Uint8Array. */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function encryptedMetadataToJson(enc: { nonce: Uint8Array; ciphertext: Uint8Array }): string {
  return JSON.stringify({
    nonce: uint8ArrayToBase64(enc.nonce),
    ciphertext: uint8ArrayToBase64(enc.ciphertext),
  });
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
  };
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

interface OfflineFile {
  fileId: string;
  fileName: string;
  savedAt: string;
}

const OFFLINE_KEY = 'beebeeb_offline_files';
const OFFLINE_DIR = `${FileSystem.documentDirectory}offline/`;

async function readOfflineList(): Promise<OfflineFile[]> {
  const raw = await SecureStore.getItemAsync(OFFLINE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as OfflineFile[]; } catch { return []; }
}

async function writeOfflineList(list: OfflineFile[]): Promise<void> {
  await SecureStore.setItemAsync(OFFLINE_KEY, JSON.stringify(list));
}

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
// Upload stage row — one line + progress bar in the trust upload banner
// ---------------------------------------------------------------------------

interface UploadStageRowProps {
  index: 1 | 2 | 3;
  label: string;
  done: boolean;
  active: boolean;
  percent: number;
  barColor: string;
  showCheck?: boolean;
  c: ReturnType<typeof useTheme>['colors'];
}

function UploadStageRow({ index, label, done, active, percent, barColor, showCheck, c }: UploadStageRowProps) {
  const labelColor = done ? c.ink2 : active ? c.ink : c.ink4;
  const numColor = done || active ? c.ink2 : c.ink4;
  const trackColor = c.line;
  const fillPct = Math.max(0, Math.min(100, percent));
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: numColor, width: 16 }}>
          {`0${index}`}
        </Text>
        <Text style={{ flex: 1, fontSize: 12, fontWeight: active || done ? '600' : '400', color: labelColor }} numberOfLines={1}>
          {label}
        </Text>
        {showCheck && <Ionicons name="checkmark-circle" size={14} color={c.amber} />}
      </View>
      <View style={{ height: 3, borderRadius: 1.5, backgroundColor: trackColor, overflow: 'hidden', marginLeft: 22 }}>
        <View style={{ height: '100%', width: `${fillPct}%` as `${number}%`, backgroundColor: barColor, borderRadius: 1.5 }} />
      </View>
    </View>
  );
}

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
  isOffline: boolean;
  hasProof: boolean;
  isShared: boolean;
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
  isOffline,
  hasProof,
  isShared,
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
          {isEncryptedFallback && (
            <Icon name="lock" size={11} color={c.ink4} style={styles.lockIcon} />
          )}
          <Text
            style={[styles.fileName, { color: c.ink }, isEncryptedFallback && styles.fileNameEncrypted]}
            numberOfLines={1}
          >
            {nameText}
          </Text>
          {isShared && (
            <Ionicons
              name="people-outline"
              size={12}
              color={c.ink3}
              style={styles.sharedBadge}
              accessibilityLabel="Shared folder"
            />
          )}
          {isOffline && (
            <Ionicons
              name="cloud-done"
              size={11}
              color={c.amberDeep}
              style={styles.offlineBadge}
              accessibilityLabel="Available offline"
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
        </View>
        <Text style={[styles.fileMeta, { color: c.ink3 }]}>
          {(() => {
            const loc = storageLocation(item.storage_pool_id);
            const locSuffix = loc.shortCode ? `  ·  ${loc.shortCode}` : '';
            if (item.is_folder) return `${formatDate(item.updated_at)}${locSuffix}`;
            if (isPendingUpload) return `Upload pending  ·  ${formatSize(item.size_bytes)}${locSuffix}`;
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
      {!selectMode && <Text style={[styles.chevron, { color: c.ink4 }]}>{'›'}</Text>}
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
  isOffline: boolean;
  hasProof: boolean;
  isShared: boolean;
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
  isOffline,
  hasProof,
  isShared,
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
          {isEncryptedFallback && (
            <Icon name="lock" size={10} color={c.ink4} style={styles.lockIcon} />
          )}
          <Text
            style={[styles.gridName, { color: c.ink }, isEncryptedFallback && styles.fileNameEncrypted]}
            numberOfLines={2}
          >
            {nameText}
          </Text>
          {isShared && (
            <Ionicons
              name="people-outline"
              size={11}
              color={c.ink3}
              style={styles.sharedBadge}
              accessibilityLabel="Shared folder"
            />
          )}
          {isOffline && (
            <Ionicons
              name="cloud-done"
              size={10}
              color={c.amberDeep}
              style={styles.offlineBadge}
              accessibilityLabel="Available offline"
            />
          )}
          {hasProof && (
            <Ionicons
              name="shield-checkmark"
              size={10}
              color={c.amberDeep}
              style={styles.proofBadge}
              accessibilityLabel="Proof of existence"
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
  const route = useRoute<RouteProp<TabParamList, 'Files'>>();
  const insets = useSafeAreaInsets();
  // Bottom tab bar overlaps the FAB unless we offset by its real height
  // (insets.bottom alone underestimates this on devices with a home bar).
  const tabBarHeight = useBottomTabBarHeight();
  const { colors: c } = useTheme();
  const { showToast } = useToast();
  const { phraseVerified } = useAuth();

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
  const [usage, setUsage] = useState<StorageUsage | null>(null);

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

  // Files saved for offline use — driven by the SecureStore-backed manifest.
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());

  // Proof of existence — fileId → proof. In-memory only; populated as the user
  // creates proofs. The badge shows for files in this map.
  const [proofs, setProofs] = useState<Record<string, ProofOfExistence>>({});

  // Per-file Face ID locks — set of file/folder IDs that require an extra
  // biometric confirmation before opening. Persisted in SecureStore via file-locks.ts.
  const [lockedFileIds, setLockedFileIds] = useState<Set<string>>(new Set());

  // Presence — collaborators currently viewing the folder we're inside.
  // Empty for the root view; only populated when navigated into a shared folder.
  const [presence, setPresence] = useState<PresenceUser[]>([]);

  // Crypto
  const { isUnlocked, unlockAttempted, decryptMetadata, encryptChunk, encryptMetadata, getFileKeyBytes } = useCrypto();
  const [decryptedNames, setDecryptedNames] = useState<Record<string, string>>({});
  const [decryptedMimeTypes, setDecryptedMimeTypes] = useState<Record<string, string | null>>({});
  const patchedMimeTypeIdsRef = useRef<Set<string>>(new Set());

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
  const { ready: searchIndexReady, search: searchVault, indexFile, unindexFile } = useSearchIndex();

  // Upload state — drives the 3-stage trust banner above the FAB.
  // stage 1 = encrypting · stage 2 = uploading · stage 3 = storing/done.
  type UploadStage = 1 | 2 | 3 | 'done';
  const [upload, setUpload] = useState<{
    fileName: string;
    stage: UploadStage;
    percent: number;
    city: string;
    region: string;
    chunksUploaded?: number;
    chunksTotal?: number;
    chunkSizeBytes?: number;
  } | null>(null);
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
    return decryptedMimeTypes[file.id] ?? file.mime_type ?? guessMimeTypeFromName(name);
  }, [decryptedMimeTypes, decryptedNames]);
  const withDecryptedMime = useCallback((file: FileEntry): FileEntry => {
    const mimeType = mimeTypeFor(file);
    return mimeType === file.mime_type ? file : { ...file, mime_type: mimeType };
  }, [mimeTypeFor]);

  // New-folder modal (Android — Alert.prompt is iOS-only). Drives a small
  // controlled Modal further down in the render tree.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Export state — shows banner while downloading for native share sheet
  const [exportingName, setExportingName] = useState<string | null>(null);

  // Scroll shadow — appears when list is scrolled past top
  const [isScrolled, setIsScrolled] = useState(false);

  // Decrypt filenames whenever the file list or unlock state changes.
  // Re-runs automatically when isUnlocked transitions false→true so the
  // startup race (files fetched before key is in memory) heals itself.
  useEffect(() => {
    if (!isUnlocked) {
      setDecryptedNames({});
      setDecryptedMimeTypes({});
      return;
    }
    const results: Record<string, string> = {};
    const mimeResults: Record<string, string | null> = {};
    Promise.all(
      files.map(async (file) => {
        try {
          const raw = file.name_encrypted ?? '';
          if (!raw.startsWith('{')) return; // not JSON-encrypted — displayName() handles it
          const parsed = JSON.parse(raw) as { nonce: string; ciphertext: string };
          const nonce = base64ToUint8Array(parsed.nonce);
          const ct = base64ToUint8Array(parsed.ciphertext);
          const plaintext = await decryptMetadata(file.id, nonce, ct);
          const metadata = parseDecryptedMetadata(plaintext);
          results[file.id] = metadata.name;
          mimeResults[file.id] = metadata.mimeType;
        } catch {
          // Decryption failure — leave results[file.id] unset so displayName()
          // renders "Encrypted file" rather than raw ciphertext.
        }
      }),
    ).then(() => {
      for (const file of files) {
        if (file.is_folder || file.mime_type != null) continue;
        const decryptedName = results[file.id];
        if (!decryptedName) continue;
        const imageMimeType = imageMimeTypeFromName(decryptedName);
        if (!imageMimeType) continue;
        mimeResults[file.id] = mimeResults[file.id] ?? imageMimeType;
        if (patchedMimeTypeIdsRef.current.has(file.id)) continue;
        patchedMimeTypeIdsRef.current.add(file.id);
        void patchFileMimeType(file.id, imageMimeType).catch(() => {
          patchedMimeTypeIdsRef.current.delete(file.id);
        });
      }
      setDecryptedNames({ ...results });
      setDecryptedMimeTypes({ ...mimeResults });
    });
  }, [files, isUnlocked, decryptMetadata]);

  // Load pinned folders from SecureStore on mount
  useEffect(() => {
    SecureStore.getItemAsync('beebeeb_pinned_folders')
      .then((raw) => { if (raw) setPinnedFolders(JSON.parse(raw) as { id: string; name: string }[]); })
      .catch(() => {});
  }, []);

  // Load the offline-files manifest on mount
  useEffect(() => {
    readOfflineList()
      .then((list) => setOfflineIds(new Set(list.map((f) => f.fileId))))
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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setViewMode((prev) => {
      const next = prev === 'list' ? 'grid' : 'list';
      SecureStore.setItemAsync('beebeeb_view_mode', next).catch(() => {});
      return next;
    });
  }, []);

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
  useEffect(() => {
    if (!unlockAttempted) {
      // Keep the skeleton visible while the keychain lookup is in flight
      setLoading(true);
      return;
    }

    if (sync.ready) {
      const nodes = sync.children(currentFolder.id);
      setFiles(nodes.filter((n) => !n.is_trashed).map(syncNodeToFileEntry));
      setLoading(false);
      setError(null);
      return;
    }
    fetchFiles(currentFolder.id);
    // sync.treeVersion bumps on every op — re-derive without re-fetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolder.id, fetchFiles, unlockAttempted, sync.ready, sync.treeVersion]);

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
    setFolderStack((prev) => [
      ...prev,
      { id: folder.id, name: decryptedNames[folder.id] ?? displayName(folder) },
    ]);
  }, [decryptedNames]);

  const navigateToBreadcrumb = useCallback((index: number) => {
    setFolderStack((prev) => prev.slice(0, index + 1));
  }, []);

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
      if (file.is_folder) {
        navigateToFolder(file);
      } else {
        if (!(await ensureFileReady(file))) return;
        navigation.navigate('Preview', {
          fileId: file.id,
          fileName: decryptedNames[file.id] ?? displayName(file),
          mimeType: mimeTypeFor(file) ?? undefined,
          sizeBytes: file.size_bytes,
          createdAt: file.created_at,
          chunkCount: file.chunk_count,
        });
      }
    },
    [navigateToFolder, navigation, decryptedNames, mimeTypeFor, ensureFileReady],
  );

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchFiles(currentFolder.id, true);
  }, [currentFolder.id, fetchFiles]);

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
    let uploadFileId = generateFileId();   // new UUID by default
    let uploadFileName = asset.name;       // original name by default
    let v2InitNameEncrypted: string | undefined;

    const existingFile = findConflict(asset.name);
    if (existingFile) {
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

    const loc = trustLocation(undefined);
    setUpload({ fileName: uploadFileName, stage: 1, percent: 30, city: loc.city, region: loc.region });
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
            if (progress.phase === 'preparing') {
              return { ...base, stage: 1, percent: Math.max(percent, 30), chunksUploaded: progress.chunksUploaded, chunksTotal: progress.chunksTotal, chunkSizeBytes: progress.chunkSizeBytes };
            }
            if (progress.phase === 'finalizing') {
              return { ...base, stage: 3, percent: 60, chunksUploaded: progress.chunksUploaded, chunksTotal: progress.chunksTotal, chunkSizeBytes: progress.chunkSizeBytes };
            }
            return { ...base, stage: 2, percent, chunksUploaded: progress.chunksUploaded, chunksTotal: progress.chunksTotal, chunkSizeBytes: progress.chunkSizeBytes };
          });
        },
      });
      const finalLoc = trustLocation(uploaded.storage_pool_id);
      setUpload({ fileName: uploadFileName, stage: 'done', percent: 100, city: finalLoc.city, region: finalLoc.region });
      setFiles((prev) => [uploaded, ...prev]);
      // Add to the encrypted search index so the new file is searchable
      // across the whole vault from the very next keystroke.
      indexFile(uploaded.id, toSearchIndexEntry(uploaded, uploadFileName, currentFolder.id));
      // Fire-and-forget: generate + upload a 256px thumbnail for image files.
      void generateAndUploadThumbnail(uploaded.id, asset.uri, asset.mimeType ?? null, getFileKeyBytes);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: 'success', message: `"${uploadFileName}" stored in ${finalLoc.city}` });
      fetchFiles(currentFolder.id, true);
      // Hold the "Stored · Key stayed here" flash briefly before clearing.
      setTimeout(() => setUpload((cur) => (cur && cur.stage === 'done' ? null : cur)), 1800);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showToast({ type: 'error', message: `Upload failed: ${friendlyError(err)}` });
      setUpload(null);
    }
  }, [currentFolder.id, fetchFiles, phraseVerified, showToast, findConflict, folderFileNames, encryptChunk, encryptMetadata, indexFile]);

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
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 1,
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
    for (let i = 0; i < total; i++) {
      const asset = picked.assets[i]!;
      const rawName = asset.fileName ?? `photo-${Date.now()}-${i}.jpg`;
      // Silent conflict resolution for batch photo uploads — always "keep both",
      // no prompts (the user selected multiple photos and expects them all uploaded).
      const conflict = findConflict(rawName);
      const name = conflict
        ? getUniqueMobileName(rawName, new Set([...folderFileNames(), ...usedInBatch]))
        : rawName;
      usedInBatch.add(name.toLowerCase());

      const display = total > 1 ? `${name} (${i + 1}/${total})` : name;
      lastName = display;
      setUpload({ fileName: display, stage: 1, percent: 30, city: lastLoc.city, region: lastLoc.region });
      try {
        const fileId = generateFileId();
        const uploaded = await encryptedUpload({
          fileId,
          uri: asset.uri,
          name,
          parentId: currentFolder.id ?? undefined,
          mimeType: asset.mimeType ?? 'image/jpeg',
          encryptChunkFn: encryptChunk,
          encryptMetadataFn: encryptMetadata,
          onProgress: (progress) => {
            const percent = progress.bytesTotal > 0
              ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100)
              : 0;
            setUpload((prev) => {
              const base = prev ?? { fileName: display, stage: 1 as UploadStage, percent: 0, city: lastLoc.city, region: lastLoc.region };
              if (progress.phase === 'preparing') {
                return { ...base, stage: 1, percent: Math.max(percent, 30), chunksUploaded: progress.chunksUploaded, chunksTotal: progress.chunksTotal, chunkSizeBytes: progress.chunkSizeBytes };
              }
              if (progress.phase === 'finalizing') {
                return { ...base, stage: 3, percent: 60, chunksUploaded: progress.chunksUploaded, chunksTotal: progress.chunksTotal, chunkSizeBytes: progress.chunkSizeBytes };
              }
              return { ...base, stage: 2, percent, chunksUploaded: progress.chunksUploaded, chunksTotal: progress.chunksTotal, chunkSizeBytes: progress.chunkSizeBytes };
            });
          },
        });
        lastLoc = trustLocation(uploaded.storage_pool_id);
        setFiles((prev) => [uploaded, ...prev]);
        indexFile(uploaded.id, toSearchIndexEntry(uploaded, name, currentFolder.id));
        // Fire-and-forget: image picker only returns images, so always thumbnail.
        void generateAndUploadThumbnail(uploaded.id, asset.uri, asset.mimeType ?? 'image/jpeg', getFileKeyBytes);
        successCount += 1;
      } catch (err) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast({ type: 'error', message: `${name}: ${friendlyError(err)}` });
      }
    }
    if (successCount > 0) {
      setUpload({ fileName: lastName, stage: 'done', percent: 100, city: lastLoc.city, region: lastLoc.region });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({
        type: 'success',
        message: successCount === 1
          ? `Photo stored in ${lastLoc.city}`
          : `${successCount} photos stored in ${lastLoc.city}`,
      });
      fetchFiles(currentFolder.id, true);
      setTimeout(() => setUpload((cur) => (cur && cur.stage === 'done' ? null : cur)), 1800);
    } else {
      setUpload(null);
    }
  }, [currentFolder.id, fetchFiles, phraseVerified, showToast, findConflict, folderFileNames, encryptChunk, encryptMetadata, indexFile]);

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

  const handleFabPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Upload file', 'Upload photo', 'Scan document', 'New folder', 'Cancel'],
          cancelButtonIndex: 4,
        },
        (index) => {
          if (index === 0) pickAndUploadFile();
          else if (index === 1) pickAndUploadPhotos();
          else if (index === 2) openDocumentScanner();
          else if (index === 3) showNewFolderPrompt();
        },
      );
    } else {
      Alert.alert('Add to Drive', undefined, [
        { text: 'Upload file', onPress: pickAndUploadFile },
        { text: 'Upload photo', onPress: pickAndUploadPhotos },
        { text: 'Scan document', onPress: openDocumentScanner },
        { text: 'New folder', onPress: showNewFolderPrompt },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [openDocumentScanner, pickAndUploadFile, pickAndUploadPhotos]);

  // Quick action / deep-link landing: route.params.action is set by the App
  // shortcut handler (beebeeb://upload, beebeeb://search). Trigger the right
  // surface and clear the param so subsequent focuses don't re-fire it.
  useEffect(() => {
    const action = route.params?.action;
    if (!action) return;
    navigation.setParams({ action: undefined });
    if (action === 'upload') {
      pickAndUploadFile();
    } else if (action === 'search') {
      // Tiny delay so the input has mounted before we focus, otherwise the
      // keyboard sometimes drops on iOS cold-launch.
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [route.params?.action, navigation, pickAndUploadFile]);

  const submitNewFolder = useCallback(async (rawName: string) => {
    const trimmed = rawName.trim();
    if (!trimmed) return;
    try {
      if (!isUnlocked) {
        Alert.alert('Vault is locked', 'Unlock the vault before creating folders.');
        return;
      }
      const folderId = generateFileId();
      const encName = await encryptMetadata(folderId, trimmed);
      const nameEncrypted = encryptedMetadataToJson(encName);
      const folder = await createFolder(nameEncrypted, currentFolder.id ?? undefined, folderId);
      const now = new Date().toISOString();
      const safe: FileEntry = {
        ...folder,
        created_at: folder.created_at ?? now,
        updated_at: folder.updated_at ?? now,
      };
      setFiles((prev) => [safe, ...prev]);
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
              await Promise.all(ids.map((id) => deleteFile(id)));
              setFiles((prev) => prev.filter((f) => !selectedIds.has(f.id)));
              for (const id of ids) unindexFile(id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              exitSelectMode();
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [selectedIds, exitSelectMode, unindexFile]);

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

  const handleBatchMove = useCallback(async () => {
    if (selectedIds.size === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    let folders: FileEntry[] = [];
    try {
      const all = await listFiles();
      folders = all.filter((f) => f.is_folder && !selectedIds.has(f.id));
    } catch {
      Alert.alert('Error', 'Could not load folders.');
      return;
    }
    const folderNames = folders.map((f) => decryptedNames[f.id] ?? displayName(f));
    const moveOptions = ['Drive (root)', ...folderNames, 'Cancel'];
    const moveCancelIdx = moveOptions.length - 1;

    const doMove = async (targetId: string | null) => {
      try {
        const ids = [...selectedIds];
        await Promise.all(ids.map((id) => moveFile(id, targetId)));
        for (const id of ids) {
          const moved = files.find((f) => f.id === id);
          if (!moved) continue;
          indexFile(id, toSearchIndexEntry(moved, decryptedNames[id] ?? displayName(moved), targetId));
        }
        setFiles((prev) => prev.filter((f) => !selectedIds.has(f.id)));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        exitSelectMode();
      } catch (err) {
        Alert.alert('Error', friendlyError(err));
      }
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Move to', options: moveOptions, cancelButtonIndex: moveCancelIdx },
        (idx) => {
          if (idx === moveCancelIdx) return;
          if (idx === 0) void doMove(null);
          else void doMove(folders[idx - 1]!.id);
        },
      );
    } else {
      Alert.alert('Move to', undefined, [
        { text: 'Drive (root)', onPress: () => void doMove(null) },
        ...folders.map((f, i) => ({
          text: folderNames[i] ?? displayName(f),
          onPress: () => void doMove(f.id),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, [selectedIds, files, decryptedNames, exitSelectMode, indexFile]);

  const handleSearchToggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSearchActive((prev) => {
      if (prev) setSearchQuery('');
      return !prev;
    });
  }, []);

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

  const toggleOffline = useCallback(async (item: FileEntry, fileName: string) => {
    const path = `${OFFLINE_DIR}${item.id}`;
    const wasOffline = offlineIds.has(item.id);

    if (wasOffline) {
      try {
        await FileSystem.deleteAsync(path, { idempotent: true });
        const next = (await readOfflineList()).filter((f) => f.fileId !== item.id);
        await writeOfflineList(next);
        setOfflineIds(new Set(next.map((f) => f.fileId)));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast({ type: 'info', message: 'Removed from offline' });
      } catch (err) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast({ type: 'error', message: friendlyError(err) });
      }
      return;
    }

    if (!(await ensureFileReady(item))) return;

    try {
      const dirInfo = await FileSystem.getInfoAsync(OFFLINE_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(OFFLINE_DIR, { intermediates: true });
      }
      const res = await downloadFile(item.id);
      const blob = await res.blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1] ?? '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      await FileSystem.writeAsStringAsync(path, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const filtered = (await readOfflineList()).filter((f) => f.fileId !== item.id);
      const next = [...filtered, { fileId: item.id, fileName, savedAt: new Date().toISOString() }];
      await writeOfflineList(next);
      setOfflineIds(new Set(next.map((f) => f.fileId)));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast({ type: 'success', message: 'Available offline' });
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // Best-effort cleanup: drop a partial file if the write failed mid-way
      FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
      showToast({ type: 'error', message: `Could not save: ${friendlyError(err)}` });
    }
  }, [offlineIds, showToast, ensureFileReady]);

  const handleLongPress = useCallback((item: FileEntry) => {
    const name = decryptedNames[item.id] ?? displayName(item);
    const itemMimeType = mimeTypeFor(item);
    const isPinned = pinnedFolders.some((p) => p.id === item.id);
    const pinLabel = isPinned ? 'Unpin' : 'Pin to top';
    const isImage = !item.is_folder && (itemMimeType ?? '').startsWith('image/');
    const isOffline = offlineIds.has(item.id);
    const offlineLabel = isOffline ? 'Remove offline' : 'Make available offline';
    // 'Send via Constellation' is intentionally hidden — Constellation crypto is v1 mock
    // (random bytes instead of real X25519 ECDH). Re-enable when real per-transfer
    // encryption is implemented. See task 0093.
    const fileOptions = ['Rename', 'Preview', 'Share', 'Export...'];
    if (isImage) fileOptions.push('Save to Photos');
    fileOptions.push('Move to...', offlineLabel, 'Prove existence', 'Move to Trash', 'Details');
    const options = item.is_folder
      ? ['Rename', 'Open', 'Share', 'Move to...', 'Delete', pinLabel, 'Details', 'Cancel']
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
            onPress: async (input) => {
              const next = (input ?? '').trim();
              if (!next || next === name) return;
              try {
                const encName = await encryptMetadata(item.id, next);
                const nameEncrypted = encryptedMetadataToJson(encName);
                await renameFile(item.id, nameEncrypted);
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

    const promptMove = async () => {
      let folders: FileEntry[] = [];
      try {
        const all = await listFiles();
        folders = all.filter((f) => f.is_folder && f.id !== item.id);
      } catch {
        Alert.alert('Error', 'Could not load folders.');
        return;
      }
      const folderNames = folders.map((f) => decryptedNames[f.id] ?? displayName(f));
      const moveOptions = ['Drive (root)', ...folderNames, 'Cancel'];
      const moveCancelIdx = moveOptions.length - 1;

      const doMove = async (targetId: string | null, targetName?: string) => {
        try {
          await moveFile(item.id, targetId);
          indexFile(item.id, toSearchIndexEntry(item, name, targetId));
          setFiles((prev) => prev.filter((f) => f.id !== item.id));
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          showToast({ type: 'success', message: `Moved to ${targetName ?? 'Drive'}` });
        } catch (err) {
          Alert.alert('Error', friendlyError(err));
        }
      };

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          { title: 'Move to', options: moveOptions, cancelButtonIndex: moveCancelIdx },
          (idx) => {
            if (idx === moveCancelIdx) return;
            if (idx === 0) void doMove(null, 'Drive');
            else { const fn = folderNames[idx - 1]; void doMove(folders[idx - 1]!.id, fn); }
          },
        );
      } else {
        Alert.alert('Move to', undefined, [
          { text: 'Drive (root)', onPress: () => void doMove(null, 'Drive') },
          ...folders.map((f, i) => ({
            text: folderNames[i] ?? displayName(f),
            onPress: () => void doMove(f.id, folderNames[i]),
          })),
          { text: 'Cancel', style: 'cancel' as const },
        ]);
      }
    };

    const promptExport = async () => {
      if (!(await ensureFileReady(item))) return;
      const safeName = name.replace(/[^a-zA-Z0-9._()-]/g, '_');
      const localUri = `${FileSystem.cacheDirectory}${safeName}`;
      setExportingName(name);
      try {
        const res = await downloadFile(item.id);
        const blob = await res.blob();
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1] ?? '');
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        await FileSystem.writeAsStringAsync(localUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await Sharing.shareAsync(localUri, {
          mimeType: itemMimeType ?? 'application/octet-stream',
          UTI: itemMimeType ?? 'public.data',
          dialogTitle: `Export "${name}"`,
        });
      } catch (err) {
        showToast({ type: 'error', message: `Export failed: ${friendlyError(err)}` });
      } finally {
        setExportingName(null);
        // Clean up temp file (best-effort)
        FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
      }
    };

    const saveToGallery = async () => {
      if (!(await ensureFileReady(item))) return;
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Permission required',
          'Allow photo library access to save images to Photos.',
        );
        return;
      }
      const safeName = name.replace(/[^a-zA-Z0-9._()-]/g, '_');
      const localUri = `${FileSystem.cacheDirectory}${safeName}`;
      setExportingName(name);
      try {
        const res = await downloadFile(item.id);
        const blob = await res.blob();
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1] ?? '');
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        await FileSystem.writeAsStringAsync(localUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await MediaLibrary.saveToLibraryAsync(localUri);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast({ type: 'success', message: 'Saved to Photos' });
      } catch (err) {
        showToast({ type: 'error', message: `Save failed: ${friendlyError(err)}` });
      } finally {
        setExportingName(null);
        FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
      }
    };

    const confirmDeleteFolder = () => {
      Alert.alert(
        'Delete folder',
        `"${name}" will be deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteFile(item.id);
                setFiles((prev) => prev.filter((f) => f.id !== item.id));
                unindexFile(item.id);
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
                unindexFile(item.id);
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
      const formatted = [
        'Beebeeb Proof of Existence',
        `File: ${name}`,
        `SHA-256: ${proof.hash}`,
        `Timestamp: ${proof.timestamp}`,
        `Proof ID: ${proof.proofId}`,
        `Verify: https://beebeeb.io/verify/${proof.proofId}`,
      ].join('\n');
      const summary = [
        `Hash: ${proof.hash.slice(0, 16)}…`,
        `Timestamp: ${proof.timestamp}`,
        `Proof ID: ${proof.proofId}`,
      ].join('\n\n');
      Alert.alert(
        'Proof of existence',
        summary,
        [
          {
            text: 'Copy proof',
            onPress: async () => {
              try {
                await Clipboard.setStringAsync(formatted);
                showToast({ type: 'success', message: 'Proof copied' });
              } catch (err) {
                showToast({ type: 'error', message: friendlyError(err) });
              }
            },
          },
          { text: 'Done', style: 'cancel' },
        ],
      );
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
        case 'Export...': void promptExport(); return;
        case 'Save to Photos': void saveToGallery(); return;
        case 'Move to...': void promptMove(); return;
        case 'Make available offline':
        case 'Remove offline': void toggleOffline(item, name); return;
        case 'Prove existence': void promptProveExistence(); return;
        case 'Delete': confirmDeleteFolder(); return;
        case 'Move to Trash': confirmMoveToTrash(); return;
        case 'Pin to top':
        case 'Unpin': togglePin(item, name); return;
        case 'Details': showDetails(); return;
      }
    };

    const handleAction = (index: number) => {
      if (index === cancelIndex) return;
      const option = options[index];
      if (option) dispatchAction(option);
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
      const alertButtons: Parameters<typeof Alert.alert>[2] = options
        .slice(0, cancelIndex)
        .map((opt, i) => ({
          text: opt,
          style: (i === destructiveIndex ? 'destructive' : 'default') as 'destructive' | 'default',
          onPress: () => dispatchAction(opt),
        }));
      alertButtons.push({ text: 'Cancel', style: 'cancel' as const });
      Alert.alert(name, undefined, alertButtons);
    }
  }, [
    navigation,
    openFile,
    decryptedNames,
    showToast,
    pinnedFolders,
    togglePin,
    offlineIds,
    toggleOffline,
    proofs,
    currentFolder.id,
    indexFile,
    unindexFile,
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
    let result = files;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const seen = new Set<string>();
      const vaultResults = vaultSearchMatches.map((match) => {
        seen.add(match.id);
        return searchResultToFileEntry(match);
      });
      const localFallback = files.filter((f) => {
        if (seen.has(f.id)) return false;
        const name = decryptedNames[f.id] ?? displayName(f);
        return name.toLowerCase().includes(q);
      });
      if (vaultResults.length > 0) return [...vaultResults, ...localFallback];
      result = localFallback;
    }
    return applySortOrder(result, sortOrder, decryptedNames);
  }, [files, searchQuery, decryptedNames, sortOrder, vaultSearchMatches]);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const renderBreadcrumbs = () => (
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

  // 3 most recently modified non-folder files — reuses the existing files array
  const recentFiles = useMemo(() => (
    files
      .filter((f) => !f.is_folder)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 3)
  ), [files]);

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
                <Text style={[styles.recentName, { color: c.ink }]} numberOfLines={1}>
                  {name}
                </Text>
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
              unindexFile(item.id);
            } catch (err) {
              Alert.alert('Error', friendlyError(err));
            }
          },
        },
      ],
    );
  }, [decryptedNames, unindexFile]);

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

  const renderFileRow = useCallback(({ item }: { item: FileEntry }) => (
    <FileRowItem
      item={withDecryptedMime(item)}
      decryptedName={decryptedNames[item.id]}
      onPress={openFile}
      onLongPress={handleRowLongPress}
      onShare={handleSwipeShare}
      onDelete={handleSwipeDelete}
      onTrustPress={openTrust}
      selectMode={selectMode}
      isSelected={selectedIds.has(item.id)}
      onToggleSelect={toggleSelect}
      sortOrder={sortOrder}
      isOffline={offlineIds.has(item.id)}
      hasProof={!!proofs[item.id]}
      isShared={item.is_folder && (item.share_count ?? 0) > 0}
    />
  ), [decryptedNames, withDecryptedMime, openFile, handleRowLongPress, handleSwipeShare, handleSwipeDelete, openTrust, selectMode, selectedIds, toggleSelect, sortOrder, offlineIds, proofs]);

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
      onLongPress={handleRowLongPress}
      onTrustPress={openTrust}
      selectMode={selectMode}
      isSelected={selectedIds.has(item.id)}
      onToggleSelect={toggleSelect}
      sortOrder={sortOrder}
      cardWidth={gridCardWidth}
      isOffline={offlineIds.has(item.id)}
      hasProof={!!proofs[item.id]}
      isShared={item.is_folder && (item.share_count ?? 0) > 0}
    />
  ), [decryptedNames, withDecryptedMime, openFile, handleRowLongPress, openTrust, selectMode, selectedIds, toggleSelect, sortOrder, gridCardWidth, offlineIds, proofs]);

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
      <Ionicons name="cloud-offline-outline" size={48} color={c.ink3} />
      <Text style={[styles.errorText, { color: c.ink2 }]}>{error}</Text>
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
          <Text style={[styles.title, { color: c.ink }]}>{currentFolder.name}</Text>
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
            <TouchableOpacity
              onPress={handleSortPress}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.searchButton}
              accessibilityLabel={`Sort files, current: ${SORT_LABELS[sortOrder]}`}
              accessibilityRole="button"
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
              autoFocus
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

      {/* Inline 3-stage trust upload banner (encrypt → upload → stored) */}
      {upload && !selectMode && (
        <View
          style={[
            styles.uploadBanner,
            {
              bottom: 16 + insets.bottom + 64,
              backgroundColor: c.paper2,
              borderColor: upload.stage === 'done' ? c.amber : c.line,
            },
          ]}
        >
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={[styles.uploadFileName, { color: c.ink3 }]} numberOfLines={1}>
              {upload.fileName}
            </Text>

            <UploadStageRow
              index={1}
              label="Encrypting on your device..."
              done={upload.stage !== 1}
              active={upload.stage === 1}
              percent={upload.stage === 1 ? upload.percent : 100}
              barColor={c.amber}
              c={c}
            />
            <UploadStageRow
              index={2}
              label={
                upload.chunksTotal && upload.chunkSizeBytes
                  ? `Uploading ${upload.chunksUploaded ?? 0} / ${upload.chunksTotal} chunks · chunk size ${formatSize(upload.chunkSizeBytes)}`
                  : `Uploading ciphertext to ${upload.city}`
              }
              done={upload.stage === 3 || upload.stage === 'done'}
              active={upload.stage === 2}
              percent={upload.stage === 2 ? upload.percent : (upload.stage === 1 ? 0 : 100)}
              barColor={c.ink3}
              c={c}
            />
            <UploadStageRow
              index={3}
              label={
                upload.stage === 'done'
                  ? `Stored in ${upload.region} · ${upload.city} · Key stayed here`
                  : `Storing in ${upload.region} · ${upload.city}...`
              }
              done={upload.stage === 'done'}
              active={upload.stage === 3}
              percent={upload.stage === 'done' ? 100 : upload.stage === 3 ? upload.percent : 0}
              barColor={c.amber}
              showCheck={upload.stage === 'done'}
              c={c}
            />
          </View>
        </View>
      )}

      {/* Inline export progress (shown while downloading for native share sheet) */}
      {exportingName && !selectMode && (
        <View
          style={[
            styles.uploadBanner,
            {
              bottom: 16 + insets.bottom + 64,
              backgroundColor: c.paper2,
              borderColor: c.line,
            },
          ]}
        >
          <ActivityIndicator color={c.amber} size="small" />
          <Text style={[styles.uploadBannerText, { color: c.ink2 }]} numberOfLines={1}>
            Exporting {exportingName}...
          </Text>
        </View>
      )}

      {/* Batch action bar — shown in select mode */}
      {selectMode && (
        <View style={[styles.actionBar, { backgroundColor: c.paper, borderTopColor: c.line, paddingBottom: insets.bottom }]}>
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

      {/* Floating action button — hidden in select mode */}
      {!selectMode && (
        <TouchableOpacity
          style={[styles.fab, { bottom: 16 + tabBarHeight, backgroundColor: c.amber }]}
          activeOpacity={0.8}
          onPress={handleFabPress}
          disabled={!!uploadingName}
          accessibilityLabel="Add file or folder"
          accessibilityRole="button"
        >
          <Text style={[styles.fabText, { color: c.ink }]}>+</Text>
        </TouchableOpacity>
      )}

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
                accessibilityRole="button"
                accessibilityLabel="Create folder"
              >
                <Text style={[styles.modalPrimaryText, { color: c.ink }]}>{creatingFolder ? 'Creating…' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Trust details bottom sheet — opened from the lock icon on a file row */}
      <TrustDetailsSheet
        file={trustFile}
        fileName={trustFileName}
        onClose={closeTrust}
      />
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
  title: { fontSize: 28, fontWeight: '700' },
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
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center' },
  breadcrumbChevron: { marginHorizontal: 2 },
  breadcrumbText: { fontSize: 12, fontWeight: '500' },

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
  proofBadge: { flexShrink: 0, marginLeft: 2 },
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

  // FAB — standard iOS size 56x56
  fab: { position: 'absolute', right: 20, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', ...shadows.lg },
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
  uploadFileName: { fontSize: 11, fontWeight: '500' },
  sharedBadge: { marginLeft: 4 },
  presenceWrap: { flexDirection: 'row', alignItems: 'center', marginRight: 8 },

  // Android new-folder modal
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
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
});
