import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ImageStyle, StyleProp, ViewStyle } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { WebView } from 'react-native-webview';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import type { RootStackParamList } from '../App';
import { colors, radii, shadows } from '../theme';
import type { Colors } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useToast } from '../lib/toast-context';
import { getToken, friendlyError, trustLocation, trashFiles } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import { decryptToTempFile } from '../lib/native-decrypt';
import { maybeSelfRepairThumbnailFromLocalFile } from '../lib/thumbnail-self-repair';
import { BeebeebThumbnails, type PreviewLoadProgressEvent } from '../../modules/beebeeb-crypto';
import {
  estimatedDecryptSeconds,
  formatDuration,
  getDevicePerformanceProfile,
  type DevicePerformanceProfile,
} from '../lib/device-performance';
import {
  getCachedPhoto,
  getCachedPhotoWithExtension,
  cachePhoto,
  cachePhotoWithExtension,
} from '../lib/photo-cache';
import { getCachedThumbnail } from '../lib/thumbnail-cache';
import {
  cacheLocalThumbnail,
  fetchDecryptedLargeThumbnailUri,
  fetchDecryptedThumbnailUri,
} from '../lib/thumbnail';
import {
  getPerformanceStorageSettings,
  type PerformanceStorageProfile,
} from '../lib/performance-storage-settings';
import {
  activePhotoPageIndices,
  clampPhotoIndex,
} from '../lib/photo-viewer-window';
import { DetailsSheet } from '../components/preview/DetailsSheet';
import { recordRuntimeTrace } from '../lib/runtime-trace';
import { formatBytes as formatSize } from '../lib/format';

// Preview renderers are lazy-loaded so that the libraries each one depends on
// (jszip, xlsx, mammoth, pako, react-native-pdf, highlight.js) only enter
// Hermes when the user actually opens a file of that type. This shaves a few
// MB off the main JS chunk and 200–800 ms off cold-start TTI on older iPhones.
const PdfRenderer = React.lazy(async () => {
  const m = await import('../components/preview/PdfRenderer');
  return { default: m.PdfRenderer };
});
const ArchiveRenderer = React.lazy(async () => {
  const m = await import('../components/preview/ArchiveRenderer');
  return { default: m.ArchiveRenderer };
});
const PptxRenderer = React.lazy(async () => {
  const m = await import('../components/preview/PptxRenderer');
  return { default: m.PptxRenderer };
});
const XlsxRenderer = React.lazy(async () => {
  const m = await import('../components/preview/XlsxRenderer');
  return { default: m.XlsxRenderer };
});
const DocxRenderer = React.lazy(async () => {
  const m = await import('../components/preview/DocxRenderer');
  return { default: m.DocxRenderer };
});
const ZipRenderer = React.lazy(async () => {
  const m = await import('../components/preview/ZipRenderer');
  return { default: m.ZipRenderer };
});
const CodeRenderer = React.lazy(async () => {
  const m = await import('../components/preview/CodeRenderer');
  return { default: m.CodeRenderer };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PreviewRoute = RouteProp<RootStackParamList, 'Preview'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

type PreviewOptionAction = {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  destructive?: boolean;
  run: () => void;
};


function formatDate(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString('en', { month: 'short' });
  const day = d.getDate();
  const year = d.getFullYear();
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${month} ${day}, ${year} at ${hours}:${mins}`;
}

function isEncryptedMetadataName(name: string): boolean {
  return name.trim().startsWith('{');
}

function extensionForMime(mimeType?: string, category?: Category): string {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/heic') return '.heic';
  if (mime === 'image/heif') return '.heif';
  if (mime === 'image/svg+xml') return '.svg';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/x-m4v') return '.m4v';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
  if (mime === 'application/vnd.ms-excel') return '.xls';
  if (mime === 'text/csv') return '.csv';
  if (mime === 'text/html') return '.html';
  if (mime === 'text/plain') return '.txt';
  if (mime === 'application/json') return '.json';
  if (mime === 'application/xml' || mime === 'text/xml') return '.xml';
  if (mime === 'application/zip') return '.zip';
  if (mime.startsWith('audio/')) return '.mp3';
  if (category === 'image') return '.jpg';
  if (category === 'video') return '.mp4';
  if (category === 'pdf') return '.pdf';
  if (category === 'audio') return '.mp3';
  if (category === 'docx') return '.docx';
  if (category === 'spreadsheet') return '.xlsx';
  if (category === 'html') return '.html';
  if (category === 'zip') return '.zip';
  if (category === 'doc') return '.txt';
  return '';
}

function mediaCacheExtension(mimeType: string | null | undefined, category: Category): string | null {
  const ext = extensionForMime(mimeType ?? undefined, category).replace(/^\./, '');
  return ext || null;
}

function previewDisplayName(fileName: string, category: Category): string {
  if (!isEncryptedMetadataName(fileName)) return fileName;
  if (category === 'image') return 'Photo';
  if (category === 'video') return 'Video';
  return 'Encrypted file';
}

function previewCacheName(fileName: string, mimeType: string | undefined, category: Category): string {
  const displayName = previewDisplayName(fileName, category);
  let safeName = displayName.replace(/[^a-zA-Z0-9._\-]/g, '_');
  if (!safeName) safeName = category === 'image' ? 'Photo' : 'Preview';
  if (!/\.[a-zA-Z0-9]{2,5}$/.test(safeName)) {
    safeName += extensionForMime(mimeType, category);
  }
  return safeName;
}

type Category =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'docx'
  | 'pptx'
  | 'spreadsheet'
  | 'html'
  | 'zip'
  | 'archive'
  | 'doc'
  | 'file';

function fileCategory(mimeType?: string, fileName?: string): Category {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';

  // SVG before generic image — needs WebView, not <Image>, for proper render
  if (mime === 'image/svg+xml' || ext === 'svg') return 'svg';
  if (
    mime.startsWith('image/') ||
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext)
  ) {
    return 'image';
  }
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('audio/') || ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'].includes(ext)) return 'audio';
  if (mime.startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm'].includes(ext)) return 'video';

  // HTML before generic text — needs WebView (with source-toggle), not the
  // monospace text viewer.
  if (mime === 'text/html' || ext === 'html' || ext === 'htm') return 'html';

  // ZIP archives — list contents with JSZip (no extraction yet)
  if (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/x-zip' ||
    ext === 'zip'
  ) {
    return 'zip';
  }

  // TAR / GZ / TGZ archives — handled by ArchiveRenderer
  if (
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip' ||
    ext === 'tar' ||
    ext === 'gz' ||
    ext === 'tgz'
  ) {
    return 'archive';
  }

  // PPTX (PowerPoint) — text-only slide viewer
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === 'pptx'
  ) {
    return 'pptx';
  }

  // DOCX (modern Word) — handled by mammoth. Legacy .doc is not supported.
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return 'docx';
  }

  // XLSX / CSV / other SheetJS-readable formats
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    mime.includes('spreadsheet') ||
    mime === 'text/csv' ||
    mime === 'application/csv' ||
    ext === 'xlsx' ||
    ext === 'xls' ||
    ext === 'csv' ||
    ext === 'tsv'
  ) {
    return 'spreadsheet';
  }

  if (mime.startsWith('text/') || mime.includes('document')) return 'doc';
  return 'file';
}

const CATEGORY_LABELS: Record<Category, string> = {
  image: 'Image',
  svg: 'SVG Image',
  pdf: 'PDF Document',
  audio: 'Audio',
  video: 'Video',
  docx: 'Word Document',
  pptx: 'PowerPoint',
  spreadsheet: 'Spreadsheet',
  html: 'Web Page',
  zip: 'ZIP Archive',
  archive: 'Archive',
  doc: 'Document',
  file: 'File',
};

const CATEGORY_BADGE: Record<Category, string> = {
  image: 'IMG',
  svg: 'SVG',
  pdf: 'PDF',
  audio: 'AUD',
  video: 'VID',
  docx: 'DOCX',
  pptx: 'PPTX',
  spreadsheet: 'XLS',
  html: 'HTML',
  zip: 'ZIP',
  archive: 'ARC',
  doc: 'DOC',
  file: 'FILE',
};

// (Media details sheet dimensions removed — now handled by DetailsSheet component)

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Read a (decrypted) file from the local filesystem and return its bytes.
 * Used to feed mammoth/SheetJS, which both want an ArrayBuffer/Uint8Array.
 */
async function readFileAsArrayBuffer(uri: string): Promise<ArrayBuffer> {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = base64ToUint8Array(b64);
  // Slice the underlying buffer so the offset is 0 (mammoth/jszip rely on this).
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a raw SVG string in a minimal HTML document so the WebView renders it
 * centered on a clean white background (SVGs often rely on white for contrast,
 * and our dark preview backdrop would hide white-on-transparent strokes).
 */
function buildSvgHtml(svg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8" />
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #ffffff; }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
    }
    svg { max-width: 100%; max-height: 100%; height: auto; width: auto; }
  </style>
</head>
<body>
${svg}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Code language detection (lib-free — actual highlighting lives in CodeRenderer)
// ---------------------------------------------------------------------------

const EXT_TO_HLJS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  rs: 'rust',
  go: 'go',
  swift: 'swift',
  java: 'java', kt: 'java',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml',
  css: 'css', scss: 'css', less: 'css',
  json: 'json',
  md: 'markdown', markdown: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql',
};

const MIME_TO_HLJS: Record<string, string> = {
  'text/javascript': 'javascript',
  'application/javascript': 'javascript',
  'text/typescript': 'typescript',
  'application/typescript': 'typescript',
  'text/x-typescript': 'typescript',
  'text/x-python': 'python',
  'application/x-python-code': 'python',
  'text/x-rust': 'rust',
  'text/x-go': 'go',
  'text/x-swift': 'swift',
  'text/x-java': 'java',
  'text/x-java-source': 'java',
  'text/html': 'xml',
  'text/css': 'css',
  'application/json': 'json',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/yaml': 'yaml',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/x-sh': 'bash',
  'text/x-sh': 'bash',
  'application/sql': 'sql',
  'text/x-sql': 'sql',
  'text/xml': 'xml',
  'application/xml': 'xml',
};

const LANGUAGE_LABELS: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  swift: 'Swift',
  java: 'Java',
  xml: 'XML',
  css: 'CSS',
  json: 'JSON',
  markdown: 'Markdown',
  yaml: 'YAML',
  bash: 'Bash',
  sql: 'SQL',
  plaintext: 'Plain text',
};

function detectCodeLanguage(mimeType?: string, fileName?: string): string {
  const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
  if (ext && EXT_TO_HLJS[ext]) return EXT_TO_HLJS[ext];
  const mime = (mimeType ?? '').toLowerCase();
  if (MIME_TO_HLJS[mime]) return MIME_TO_HLJS[mime];
  return 'plaintext';
}

/** Display label for the language badge — shows "HTML" for .html/.htm, "XML" otherwise. */
function languageDisplayLabel(hljsId: string, fileName?: string): string {
  if (hljsId === 'xml') {
    const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
    if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'HTML';
    return 'XML';
  }
  return LANGUAGE_LABELS[hljsId] ?? hljsId.toUpperCase();
}

// ---------------------------------------------------------------------------
// Photo swipe page — renders a single photo inside the horizontal pager
// ---------------------------------------------------------------------------

const SCREEN_WIDTH = Dimensions.get('window').width;

interface PhotoPageEntry {
  id: string;
  name_encrypted: string;
  display_name?: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: string;
  chunk_count: number;
  version_number?: number;
  storage_pool_id?: string | null;
  thumbnail_uri?: string | null;
  local_asset_id?: string | null;
}

type PhotoLoadStage = 'checking' | 'downloading' | 'decrypting' | 'caching';
type FileKeyLoader = (fileId: string) => Promise<Uint8Array>;
type MasterKeyHandleLoader = () => number;
type ImagePreviewKind = 'thumbnail' | 'large' | 'original';

const NORMAL_PREVIEW_THUMB_SIZE = 768;
const LARGE_PREVIEW_THUMB_SIZE = 1600;

function normalizePerformanceStorageProfile(value: unknown): PerformanceStorageProfile {
  return value === 'light' || value === 'balanced' || value === 'smooth'
    ? value
    : 'balanced';
}

interface ThumbnailPreviewResult {
  uri: string;
  kind: Exclude<ImagePreviewKind, 'original'>;
  source: 'photoKit' | 'remote' | 'cache' | 'local';
}

interface PhotoPreviewLoadOptions {
  profile: PerformanceStorageProfile;
  allowOriginal: boolean;
  forceOriginal?: boolean;
}

interface PreviewProgressState {
  stage: PhotoLoadStage | null;
  bytesDownloaded: number;
  bytesTotal: number;
  chunksCompleted: number;
  chunksTotal: number;
}

function emptyPreviewProgress(stage: PhotoLoadStage | null = null): PreviewProgressState {
  return {
    stage,
    bytesDownloaded: 0,
    bytesTotal: 0,
    chunksCompleted: 0,
    chunksTotal: 0,
  };
}

interface InFlightPhotoLoad {
  promise: Promise<{ uri: string; kind: ImagePreviewKind }>;
  signal: AbortSignal;
}

const inFlightPhotoLoads = new Map<string, InFlightPhotoLoad>();

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function previewErrorTraceFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, friendlyMessage: friendlyError(err) };
  }
  return { message: String(err), friendlyMessage: friendlyError(err) };
}

function throwIfPreviewAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Preview load cancelled.');
  error.name = 'AbortError';
  throw error;
}

function PreviewProgressStatus({
  color,
  isUnlocked,
  isVideo,
  progress,
  profile,
  sizeBytes,
}: {
  color: string;
  isUnlocked: boolean;
  isVideo: boolean;
  progress: PreviewProgressState;
  profile?: DevicePerformanceProfile | null;
  sizeBytes?: number | null;
}) {
  const fraction = progressFraction(progress);
  return (
    <View style={styles.previewProgressWrap}>
      <ActivityIndicator color={color} size="large" />
      <View style={styles.previewProgressTrack}>
        <View style={[styles.previewProgressFill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.imageStatusSub}>
      {progressStageText(progress, isUnlocked, isVideo, sizeBytes, profile ?? null)}
      </Text>
    </View>
  );
}

function progressStageText(
  progress: PreviewProgressState,
  isUnlocked: boolean,
  isVideo: boolean,
  sizeBytes?: number | null,
  profile?: DevicePerformanceProfile | null,
): string {
  if (!isUnlocked) return isVideo ? 'Unlock your vault to play this video.' : 'Unlock your vault to view this file.';
  if (progress.stage === 'checking') return 'Checking local copy...';
  if (progress.stage === 'downloading') {
    if (progress.bytesTotal > 0) {
      return `Downloading ${formatSize(progress.bytesDownloaded)} of ${formatSize(progress.bytesTotal)}`;
    }
    return isVideo ? 'Downloading video...' : 'Downloading encrypted file...';
  }
  if (progress.stage === 'decrypting') {
    const progressText = progress.chunksTotal > 0
      ? ` · ${Math.round((progress.chunksCompleted / progress.chunksTotal) * 100)}%`
      : '';
    const eta = formatDuration(estimatedDecryptSeconds(sizeBytes, profile ?? null));
    return eta ? `Decrypting on iPhone · about ${eta}${progressText}` : `Decrypting on iPhone${progressText}`;
  }
  if (progress.stage === 'caching') return isVideo ? 'Saving for faster playback...' : 'Saving for faster swipes...';
  return isVideo ? 'Preparing video...' : 'Loading preview...';
}

function progressFraction(progress: PreviewProgressState): number {
  if (progress.stage === 'downloading' && progress.bytesTotal > 0) {
    return Math.max(0, Math.min(1, progress.bytesDownloaded / progress.bytesTotal));
  }
  if (progress.stage === 'decrypting' && progress.chunksTotal > 0) {
    return Math.max(0, Math.min(1, progress.chunksCompleted / progress.chunksTotal));
  }
  return 0;
}

function applyNativeProgress(event: PreviewLoadProgressEvent, setProgress: React.Dispatch<React.SetStateAction<PreviewProgressState>>): void {
  if (event.stage !== 'downloading' && event.stage !== 'decrypting') return;
  const stage: PhotoLoadStage = event.stage;
  setProgress((prev) => ({
    ...prev,
    stage,
    bytesDownloaded: event.bytesDownloaded ?? prev.bytesDownloaded,
    bytesTotal: event.bytesTotal ?? prev.bytesTotal,
    chunksCompleted: event.chunksCompleted ?? prev.chunksCompleted,
    chunksTotal: event.chunksTotal ?? prev.chunksTotal,
  }));
}

async function loadNativeThumbnail(
  fileId: string,
  size: number,
  signal?: AbortSignal,
): Promise<ThumbnailPreviewResult | null> {
  if (Platform.OS !== 'ios') return null;
  try {
    const result = await BeebeebThumbnails.getThumbnail(fileId, size, size);
    throwIfPreviewAborted(signal);
    return {
      uri: result.uri,
      kind: size > NORMAL_PREVIEW_THUMB_SIZE ? 'large' : 'thumbnail',
      source: result.source === 'photoKit' ? 'photoKit' : result.source === 'remote' ? 'remote' : 'cache',
    };
  } catch {
    return null;
  }
}

async function loadNormalPreviewThumbnail(
  entry: PhotoPageEntry,
  isUnlocked: boolean,
  getFileKeyBytes: FileKeyLoader,
  signal?: AbortSignal,
): Promise<ThumbnailPreviewResult | null> {
  throwIfPreviewAborted(signal);
  if (entry.thumbnail_uri) {
    return {
      uri: entry.thumbnail_uri,
      kind: 'thumbnail',
      source: entry.local_asset_id ? 'photoKit' : 'cache',
    };
  }

  const native = await loadNativeThumbnail(entry.id, NORMAL_PREVIEW_THUMB_SIZE, signal);
  if (native) return { ...native, kind: 'thumbnail' };

  const localUri = entry.local_asset_id ? `ph://${entry.local_asset_id}` : null;
  if (localUri) {
    const local = await cacheLocalThumbnail(entry.id, localUri, entry.mime_type);
    throwIfPreviewAborted(signal);
    if (local) return { uri: local, kind: 'thumbnail', source: 'local' };
  }

  const cached = await getCachedThumbnail(entry.id, 'medium');
  throwIfPreviewAborted(signal);
  if (cached) return { uri: cached, kind: 'thumbnail', source: 'cache' };

  if (!isUnlocked) return null;
  try {
    const fileKey = await getFileKeyBytes(entry.id);
    const remote = await fetchDecryptedThumbnailUri(entry.id, fileKey, signal);
    throwIfPreviewAborted(signal);
    return remote ? { uri: remote, kind: 'thumbnail', source: 'remote' } : null;
  } catch {
    return null;
  }
}

async function loadLargePreviewThumbnail(
  entry: PhotoPageEntry,
  isUnlocked: boolean,
  getFileKeyBytes: FileKeyLoader,
  signal?: AbortSignal,
): Promise<ThumbnailPreviewResult | null> {
  throwIfPreviewAborted(signal);

  if (entry.local_asset_id) {
    const native = await loadNativeThumbnail(entry.id, LARGE_PREVIEW_THUMB_SIZE, signal);
    if (native) return { ...native, kind: 'large' };
  }

  const cached = await getCachedThumbnail(entry.id, 'large');
  throwIfPreviewAborted(signal);
  if (cached) return { uri: cached, kind: 'large', source: 'cache' };

  if (!isUnlocked) return null;
  try {
    const fileKey = await getFileKeyBytes(entry.id);
    const remote = await fetchDecryptedLargeThumbnailUri(entry.id, fileKey, signal);
    throwIfPreviewAborted(signal);
    return remote ? { uri: remote, kind: 'large', source: 'remote' } : null;
  } catch {
    return null;
  }
}

async function loadDecryptedPhotoForViewer(
  entry: PhotoPageEntry,
  isUnlocked: boolean,
  getFileKeyBytes: FileKeyLoader,
  getMasterKeyHandleId: MasterKeyHandleLoader,
  options: PhotoPreviewLoadOptions,
  onStage?: (stage: PhotoLoadStage) => void,
  onProgress?: (event: PreviewLoadProgressEvent) => void,
  signal?: AbortSignal,
): Promise<{ uri: string; kind: ImagePreviewKind }> {
  throwIfPreviewAborted(signal);
  const isVideo = !!entry.mime_type?.startsWith('video/');
  const category: Category = isVideo ? 'video' : 'image';
  const cacheExt = mediaCacheExtension(entry.mime_type, category);
  const startedAt = Date.now();
  recordRuntimeTrace('preview.photo_page.load_start', {
    fileId: entry.id,
    category,
    mimeType: entry.mime_type,
    sizeBytes: entry.size_bytes,
    chunkCount: entry.chunk_count,
    shouldUseVideoCache: isVideo,
    isUnlocked,
    profile: options.profile,
    allowOriginal: options.allowOriginal,
    forceOriginal: options.forceOriginal === true,
  });
  onStage?.('checking');
  if (isVideo || options.forceOriginal) {
    const cached = isVideo
      ? await getCachedPhotoWithExtension(entry.id, cacheExt)
      : await getCachedPhoto(entry.id);
    throwIfPreviewAborted(signal);
    if (cached) {
      recordRuntimeTrace('preview.photo_page.cache_hit', {
        fileId: entry.id,
        category,
        cacheExt,
        elapsedMs: Date.now() - startedAt,
      });
      return { uri: cached, kind: 'original' };
    }
    recordRuntimeTrace('preview.photo_page.cache_miss', {
      fileId: entry.id,
      category,
      cacheExt,
    });
  }

  const loadKey = [
    entry.id,
    isVideo ? 'video' : options.forceOriginal ? 'original' : options.profile,
    options.allowOriginal ? 'allow-original' : 'preview-only',
  ].join(':');
  const inFlight = inFlightPhotoLoads.get(loadKey);
  if (inFlight && !inFlight.signal.aborted) {
    recordRuntimeTrace('preview.photo_page.join_inflight', { fileId: entry.id, category });
    return inFlight.promise;
  }

  const loadPromise: Promise<{ uri: string; kind: ImagePreviewKind }> = (async () => {
    throwIfPreviewAborted(signal);

    if (!isVideo && !options.forceOriginal) {
      const normal = await loadNormalPreviewThumbnail(entry, isUnlocked, getFileKeyBytes, signal);
      if (normal?.source === 'photoKit' || normal?.source === 'local') {
        recordRuntimeTrace('preview.photo_page.thumbnail.success', {
          fileId: entry.id,
          source: normal.source,
          elapsedMs: Date.now() - startedAt,
        });
        return { uri: normal.uri, kind: 'thumbnail' };
      }

      if (normal) {
        recordRuntimeTrace('preview.photo_page.thumbnail.success', {
          fileId: entry.id,
          source: normal.source,
          elapsedMs: Date.now() - startedAt,
        });
        return { uri: normal.uri, kind: 'thumbnail' };
      }

      if (!options.allowOriginal) {
        recordRuntimeTrace('preview.photo_page.thumbnail.empty', { fileId: entry.id, profile: options.profile });
        throw new Error('Preview thumbnail is not available. Use View Original to download the full photo.');
      }
    }

    if (!isUnlocked) {
      recordRuntimeTrace('preview.photo_page.locked', { fileId: entry.id, category });
      throw new Error(isVideo ? 'Unlock your vault to play this video.' : 'Unlock your vault to view this image.');
    }

    if (!isVideo && !options.forceOriginal) {
      recordRuntimeTrace('preview.photo_page.original.fallback', { fileId: entry.id, profile: options.profile });
    }

    onStage?.('downloading');
    onStage?.('decrypting');
    const ext = extensionForMime(entry.mime_type ?? undefined, category);
    recordRuntimeTrace('preview.photo_page.original.request', {
      fileId: entry.id,
      category,
      extension: ext,
      sizeBytes: entry.size_bytes,
      chunkCount: entry.chunk_count,
      hasMasterKeyHandle: getMasterKeyHandleId() != null,
    });
    const decryptedUri = await decryptToTempFile(
      entry.id,
      () => getFileKeyBytes(entry.id),
      ext,
      entry.size_bytes,
      entry.chunk_count,
      getMasterKeyHandleId(),
      { onProgress, signal },
    );
    if (signal?.aborted) {
      await FileSystem.deleteAsync(decryptedUri, { idempotent: true }).catch(() => {});
      recordRuntimeTrace('preview.photo_page.original.aborted_after_decrypt', { fileId: entry.id });
      throwIfPreviewAborted(signal);
    }

    onStage?.('caching');
    const cachedUri = isVideo
      ? await cachePhotoWithExtension(entry.id, decryptedUri, cacheExt)
      : await cachePhoto(entry.id, decryptedUri);
    if (cachedUri !== decryptedUri) {
      await FileSystem.deleteAsync(decryptedUri, { idempotent: true }).catch(() => {});
    }
    throwIfPreviewAborted(signal);
    recordRuntimeTrace('preview.photo_page.original.success', {
      fileId: entry.id,
      category,
      cacheExt,
      elapsedMs: Date.now() - startedAt,
    });
    return { uri: cachedUri, kind: 'original' };
  })();

  inFlightPhotoLoads.set(loadKey, { promise: loadPromise, signal: signal ?? new AbortController().signal });
  try {
    return await loadPromise;
  } finally {
    const current = inFlightPhotoLoads.get(loadKey);
    if (current?.promise === loadPromise) inFlightPhotoLoads.delete(loadKey);
  }
}

// ---------------------------------------------------------------------------
// Task 0799 — "View Original" progressive de-blur
// ---------------------------------------------------------------------------

const PROGRESSIVE_BLUR_RADIUS = 22;

// Task 0885 (FIX #3) — failsafe: once a decrypted image uri is handed to an
// <Image>, the bytes are local so decode/render should be near-instant. If the
// image neither loads nor errors within this window, surface a "Couldn't load
// image" state instead of spinning forever. Generous enough to tolerate a slow
// full-resolution decode on older devices, but bounded so the spinner cannot
// live indefinitely.
const IMAGE_RENDER_WATCHDOG_MS = 12000;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/**
 * Renders a base preview (L0) with a blurred copy on top (L1) that fades out as
 * the encrypted original downloads + decrypts ON THIS DEVICE, then crossfades to
 * the sharp original (L2) at completion. A slim amber bar (L3) carries the
 * truthful byte/chunk progress during the download phase.
 *
 * Every visual is bound to a real signal (`progressFraction` over the existing
 * `PreviewLoadProgressEvent`): the blur "clearing up" literally means more of
 * your encrypted file has arrived and been decrypted locally. No cloud, no
 * native blur dependency — the de-blur is a crossfade between a `blurRadius`'d
 * copy and the sharp pixels, all on-device. Honors Reduce Motion (plain
 * crossfade, no de-blur) and cache hits (skips the theater entirely).
 */
const ProgressiveOriginalImage = React.memo(function ProgressiveOriginalImage({
  baseUri,
  originalUri,
  progress,
  active,
  cacheHit = false,
  reduceMotion = false,
  amber,
  containerStyle,
  imageStyle,
  baseOpacity,
  accessibilityLabel,
  onPromote,
  onImageLoad,
  onImageError,
}: {
  baseUri: string | null;
  originalUri: string | null;
  progress: PreviewProgressState;
  active: boolean;
  cacheHit?: boolean;
  reduceMotion?: boolean;
  amber: string;
  containerStyle?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  baseOpacity?: Animated.Value;
  accessibilityLabel?: string;
  onPromote?: () => void;
  // Task 0885 (FIX #3): bubble the underlying <Image> decode result up so the
  // consumer can clear the spinner (load) or surface an error (decode failure).
  onImageLoad?: () => void;
  onImageError?: () => void;
}) {
  const blurVeil = useRef(new Animated.Value(0)).current; // 0 = sharp, 1 = fully blurred
  const originalOpacity = useRef(new Animated.Value(0)).current;
  const originalScale = useRef(new Animated.Value(1)).current;
  const breathingRef = useRef<Animated.CompositeAnimation | null>(null);
  const promotedRef = useRef(false);

  const showTransition = active || originalUri != null;
  const fraction = progressFraction(progress);
  const indeterminate =
    progress.stage != null && progress.bytesTotal === 0 && progress.chunksTotal === 0;

  const stopBreathing = () => {
    breathingRef.current?.stop();
    breathingRef.current = null;
  };

  // Ramp the blur in when an original load starts (preview "softens").
  useEffect(() => {
    if (!active) return;
    promotedRef.current = false;
    originalOpacity.setValue(0);
    originalScale.setValue(1);
    if (reduceMotion || cacheHit) {
      blurVeil.setValue(0);
      return;
    }
    Animated.timing(blurVeil, {
      toValue: 1,
      duration: 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    return () => { stopBreathing(); };
  }, [active, cacheHit, reduceMotion, blurVeil, originalOpacity, originalScale]);

  // Track the blur down to real progress during the load (honest de-blur).
  useEffect(() => {
    if (!active || originalUri != null || reduceMotion || cacheHit) return;
    if (indeterminate) {
      if (!breathingRef.current) {
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(blurVeil, { toValue: 0.72, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(blurVeil, { toValue: 0.48, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          ]),
        );
        breathingRef.current = loop;
        loop.start();
      }
      return;
    }
    stopBreathing();
    Animated.timing(blurVeil, {
      toValue: lerp(1, 0.18, fraction),
      duration: 150,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, originalUri, reduceMotion, cacheHit, indeterminate, fraction, blurVeil]);

  // Closing crossfade once the sharp original is ready.
  useEffect(() => {
    if (originalUri == null || promotedRef.current) return;
    promotedRef.current = true;
    stopBreathing();
    const crossfade = cacheHit ? 120 : reduceMotion ? 150 : 240;
    originalScale.setValue(!cacheHit && !reduceMotion ? 1.015 : 1);
    Animated.parallel([
      Animated.timing(originalOpacity, {
        toValue: 1,
        duration: crossfade,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(blurVeil, {
        toValue: 0,
        duration: cacheHit ? 120 : 260,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(originalScale, {
        toValue: 1,
        duration: 260,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) onPromote?.();
    });
  }, [originalUri, cacheHit, reduceMotion, blurVeil, originalOpacity, originalScale, onPromote]);

  const showBar = active && originalUri == null && !cacheHit;

  return (
    <View style={containerStyle} pointerEvents="box-none">
      {baseUri ? (
        <Animated.Image
          source={{ uri: baseUri }}
          style={[imageStyle, baseOpacity ? { opacity: baseOpacity } : null]}
          resizeMode="contain"
          accessibilityLabel={accessibilityLabel}
          onLoad={onImageLoad}
          onError={onImageError}
        />
      ) : null}

      {baseUri && showTransition ? (
        <Animated.Image
          source={{ uri: baseUri }}
          style={[StyleSheet.absoluteFill, imageStyle, { opacity: blurVeil }]}
          resizeMode="contain"
          blurRadius={PROGRESSIVE_BLUR_RADIUS}
        />
      ) : null}

      {originalUri ? (
        <Animated.Image
          source={{ uri: originalUri }}
          style={[StyleSheet.absoluteFill, imageStyle, { opacity: originalOpacity, transform: [{ scale: originalScale }] }]}
          resizeMode="contain"
          accessibilityLabel={accessibilityLabel}
          onLoad={onImageLoad}
          onError={onImageError}
        />
      ) : null}

      {showBar ? (
        <View style={styles.progressiveBarTrack} pointerEvents="none">
          <Animated.View
            style={[
              styles.progressiveBarFill,
              { backgroundColor: amber },
              indeterminate
                ? styles.progressiveBarIndeterminate
                : { width: `${Math.round(clamp01(fraction) * 100)}%` },
            ]}
          />
        </View>
      ) : null}
    </View>
  );
});

const PhotoPage = React.memo(function PhotoPage({
  entry,
  shouldLoadFull,
  isCurrent,
  width,
  previewProfile,
  originalRequestNonce,
}: {
  entry: PhotoPageEntry;
  shouldLoadFull: boolean;
  isCurrent: boolean;
  width: number;
  previewProfile: PerformanceStorageProfile;
  originalRequestNonce: number;
}) {
  const { colors: c } = useTheme();
  const { isUnlocked, getFileKeyBytes, getMasterKeyHandleId } = useCrypto();
  const isVideoEntry = !!entry.mime_type && entry.mime_type.startsWith('video/');
  const [uri, setUri] = useState<string | null>(null);
  const [uriKind, setUriKind] = useState<ImagePreviewKind | null>(null);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<PhotoLoadStage | null>(null);
  const [progress, setProgress] = useState<PreviewProgressState>(() => emptyPreviewProgress('checking'));
  const [performanceProfile, setPerformanceProfile] = useState<DevicePerformanceProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fullImageOpacity = useRef(new Animated.Value(0)).current;
  const largePreviewAttemptRef = useRef<string | null>(null);
  // Task 0799: progressive de-blur transition for "View Original".
  const [originalUri, setOriginalUri] = useState<string | null>(null);
  const [originalActive, setOriginalActive] = useState(false);
  const [originalCacheHit, setOriginalCacheHit] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  // Task 0885 (FIX #3): track whether the mounted <Image> has actually decoded,
  // so the failsafe watchdog can tell "rendered" from "spinning forever".
  const [imageLoaded, setImageLoaded] = useState(false);
  const sawOriginalProgressRef = useRef(false);
  const player = useVideoPlayer(isVideoEntry && uri ? uri : null, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { if (mounted) setReduceMotion(value); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReduceMotion(value);
    });
    return () => { mounted = false; sub?.remove?.(); };
  }, []);

  const promoteOriginal = useCallback(() => {
    if (originalUri) {
      setUri(originalUri);
      setUriKind('original');
    }
    setOriginalUri(null);
    setOriginalActive(false);
    setOriginalCacheHit(false);
    sawOriginalProgressRef.current = false;
    AccessibilityInfo.announceForAccessibility('Original ready');
    void Haptics.selectionAsync().catch(() => {});
  }, [originalUri]);

  useEffect(() => {
    setUri(null);
    setUriKind(null);
    setError(null);
    setLoading(false);
    setStage(null);
    setProgress(emptyPreviewProgress(null));
    largePreviewAttemptRef.current = null;
    setOriginalUri(null);
    setOriginalActive(false);
    setOriginalCacheHit(false);
    setImageLoaded(false);
    sawOriginalProgressRef.current = false;
  }, [entry.id]);

  useEffect(() => {
    let cancelled = false;
    const seeded = entry.thumbnail_uri ?? null;
    if (seeded) setThumbnailUri(seeded);
    const localUri = entry.local_asset_id ? `ph://${entry.local_asset_id}` : null;
    const loadThumbnail = seeded
      ? Promise.resolve(seeded)
      : localUri
        ? cacheLocalThumbnail(entry.id, localUri, entry.mime_type)
        : getCachedThumbnail(entry.id);
    loadThumbnail
      .then((cached) => {
        if (!cancelled) setThumbnailUri(cached);
      })
      .catch(() => {
        if (!cancelled) setThumbnailUri(null);
      });
    return () => { cancelled = true; };
  }, [entry.id]);

  useEffect(() => {
    if (!shouldLoadFull) return;
    if (uri) return;
    if (Platform.OS === 'web') return;

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setStage('checking');
    setProgress(emptyPreviewProgress('checking'));
    setError(null);
    void getDevicePerformanceProfile().then((profile) => {
      if (!cancelled) setPerformanceProfile(profile);
    });

    loadDecryptedPhotoForViewer(
      entry,
      isUnlocked,
      getFileKeyBytes,
      getMasterKeyHandleId,
      {
        profile: previewProfile,
        allowOriginal: isVideoEntry,
        forceOriginal: false,
      },
      (nextStage) => {
        if (!cancelled) {
          setStage(nextStage);
          setProgress((prev) => ({ ...prev, stage: nextStage }));
        }
      },
      (event) => {
        if (!cancelled) applyNativeProgress(event, setProgress);
      },
      controller.signal,
    )
      .then((loaded) => {
        if (!cancelled) {
          recordRuntimeTrace('preview.photo_page.render_ready', {
            fileId: entry.id,
            isVideo: isVideoEntry,
            kind: loaded.kind,
          });
          setUri(loaded.uri);
          setUriKind(loaded.kind);
        }
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) {
          recordRuntimeTrace('preview.photo_page.load_failed', {
            fileId: entry.id,
            isVideo: isVideoEntry,
            ...previewErrorTraceFields(err),
          });
          setError(friendlyError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setStage(null);
          setProgress(emptyPreviewProgress(null));
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shouldLoadFull, uri, entry, isUnlocked, getFileKeyBytes, getMasterKeyHandleId, isVideoEntry, previewProfile]);

  useEffect(() => {
    if (!shouldLoadFull || !isCurrent) return;
    if (previewProfile !== 'smooth' || isVideoEntry || uriKind !== 'thumbnail' || !uri) return;
    if (Platform.OS === 'web') return;
    const attemptKey = `${entry.id}:${uri}`;
    if (largePreviewAttemptRef.current === attemptKey) return;
    largePreviewAttemptRef.current = attemptKey;

    const controller = new AbortController();
    let cancelled = false;
    const startedAt = Date.now();
    recordRuntimeTrace('preview.photo_page.large_thumbnail.upgrade_request', { fileId: entry.id });

    loadLargePreviewThumbnail(entry, isUnlocked, getFileKeyBytes, controller.signal)
      .then((large) => {
        if (cancelled || !large) {
          if (!cancelled) recordRuntimeTrace('preview.photo_page.large_thumbnail.empty', { fileId: entry.id });
          return;
        }
        recordRuntimeTrace('preview.photo_page.large_thumbnail.success', {
          fileId: entry.id,
          source: large.source,
          elapsedMs: Date.now() - startedAt,
        });
        setUri(large.uri);
        setUriKind('large');
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) {
          recordRuntimeTrace('preview.photo_page.large_thumbnail.failed', {
            fileId: entry.id,
            ...previewErrorTraceFields(err),
          });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [entry, getFileKeyBytes, isCurrent, isUnlocked, isVideoEntry, previewProfile, shouldLoadFull, uri, uriKind]);

  useEffect(() => {
    if (!originalRequestNonce || !isCurrent || isVideoEntry) return;
    if (uriKind === 'original') return;
    if (Platform.OS === 'web') return;

    const controller = new AbortController();
    let cancelled = false;
    // Task 0799: don't show the spinner status or clear `uri` — the base preview
    // stays on screen as L0 while the de-blur transition plays. We only drive
    // `progress` (for the bar/blur) and flip `originalActive` on.
    sawOriginalProgressRef.current = false;
    setOriginalCacheHit(false);
    setOriginalUri(null);
    setOriginalActive(true);
    setStage('checking');
    setProgress(emptyPreviewProgress('checking'));
    setError(null);
    AccessibilityInfo.announceForAccessibility('Loading original');
    void Haptics.selectionAsync().catch(() => {});

    loadDecryptedPhotoForViewer(
      entry,
      isUnlocked,
      getFileKeyBytes,
      getMasterKeyHandleId,
      {
        profile: previewProfile,
        allowOriginal: true,
        forceOriginal: true,
      },
      (nextStage) => {
        if (!cancelled) {
          setStage(nextStage);
          setProgress((prev) => ({ ...prev, stage: nextStage }));
        }
      },
      (event) => {
        if (!cancelled) {
          // Real download/decrypt bytes arrived → this is not a cache hit.
          if (event.stage === 'downloading' || event.stage === 'decrypting') {
            sawOriginalProgressRef.current = true;
          }
          applyNativeProgress(event, setProgress);
        }
      },
      controller.signal,
    )
      .then((loaded) => {
        if (!cancelled) {
          recordRuntimeTrace('preview.photo_page.original.render_ready', {
            fileId: entry.id,
            kind: loaded.kind,
          });
          // Task 0885 (FIX #1): when there is no base preview to de-blur (e.g. a
          // desktop-uploaded image that has no thumbnail), the de-blur crossfade
          // never runs, so `promoteOriginal` would never fire and the decrypted
          // original would never mount. Mount it directly instead — there is
          // nothing to de-blur, so skip the transition theater entirely.
          if (!uri) {
            setOriginalActive(false);
            setOriginalUri(null);
            setOriginalCacheHit(false);
            setImageLoaded(false);
            setUri(loaded.uri);
            setUriKind('original');
            return;
          }
          // Hand the sharp original to the de-blur layer; the crossfade finishes
          // and `promoteOriginal` swaps it into the base. If no real progress
          // ever fired, it was already local → skip the theater.
          setOriginalCacheHit(!sawOriginalProgressRef.current);
          setOriginalUri(loaded.uri);
        }
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) {
          recordRuntimeTrace('preview.photo_page.original.load_failed', {
            fileId: entry.id,
            ...previewErrorTraceFields(err),
          });
          setError(friendlyError(err));
          setOriginalActive(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStage(null);
          setProgress(emptyPreviewProgress(null));
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [entry, getFileKeyBytes, getMasterKeyHandleId, isCurrent, isUnlocked, isVideoEntry, originalRequestNonce, previewProfile, uriKind]);

  useEffect(() => {
    if (!uri) {
      fullImageOpacity.setValue(0);
      return;
    }
    Animated.timing(fullImageOpacity, {
      toValue: 1,
      duration: isCurrent ? 180 : 80,
      useNativeDriver: true,
    }).start();
  }, [fullImageOpacity, isCurrent, uri]);

  // Task 0885 (FIX #3): failsafe — once we hand a decrypted uri to the <Image>,
  // the bytes are local, so if it neither loads nor errors within the watchdog
  // window something is wrong (undecodable bytes, oversized texture). Surface an
  // error instead of an endless spinner. Skips video (its own player) and waits
  // for the load/error callbacks that clear or trip it.
  useEffect(() => {
    if (!uri || isVideoEntry || imageLoaded || error) return;
    const t = setTimeout(() => {
      setError((prev) => prev ?? "This image couldn't be displayed.");
    }, IMAGE_RENDER_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [uri, isVideoEntry, imageLoaded, error]);

  return (
    <View style={[styles.photoPage, { width }]}>
      {thumbnailUri && !uri && !error ? (
        <Image
          source={{ uri: thumbnailUri }}
          style={styles.photoPageThumbnail}
          resizeMode="contain"
        />
      ) : null}
      {error ? (
        <View style={styles.photoPageStatus}>
          <Text style={styles.photoPageStatusTitle}>
            {isVideoEntry ? "Couldn't load video" : "Couldn't load image"}
          </Text>
          <Text style={styles.photoPageStatusSub}>
            {error}
          </Text>
        </View>
      ) : uri && isVideoEntry ? (
        <VideoView
          player={player}
          style={styles.photoPageImage}
          contentFit="contain"
          nativeControls
          allowsFullscreen
          allowsPictureInPicture
        />
      ) : uri ? (
        <ProgressiveOriginalImage
          baseUri={uri}
          originalUri={originalUri}
          progress={progress}
          active={originalActive}
          cacheHit={originalCacheHit}
          reduceMotion={reduceMotion}
          amber={c.amber}
          containerStyle={StyleSheet.absoluteFill}
          imageStyle={styles.photoPageImage}
          baseOpacity={fullImageOpacity}
          onPromote={promoteOriginal}
          onImageLoad={() => setImageLoaded(true)}
          onImageError={() => setError((prev) => prev ?? "This image couldn't be displayed.")}
        />
      ) : (
        <View style={styles.photoPageStatus}>
          {loading || shouldLoadFull ? (
            <PreviewProgressStatus
              color={c.amber}
              isUnlocked={isUnlocked}
              isVideo={isVideoEntry}
              progress={progress.stage ? progress : { ...progress, stage }}
              profile={performanceProfile}
              sizeBytes={entry.size_bytes}
            />
          ) : null}
        </View>
      )}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PreviewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<PreviewRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { showToast } = useToast();
  const {
    fileId,
    fileName,
    mimeType,
    sizeBytes,
    createdAt,
    chunkCount,
    versionNumber,
    storagePoolId,
    photoListJson,
    initialPhotoIndex,
    performanceStorageProfile: routePerformanceStorageProfile,
    hasThumbnail,
    fileRequestId,
    senderEphemeralPubkey,
    wrappedContentKey,
  } = route.params;

  // File-request uploads (0643): when all three sealed-key fields are present
  // the file is decrypted with the request content key C, not the master-key
  // path. Only applies to the single previewed file (never the photo-swipe set).
  const requestFileFields = useMemo(
    () =>
      fileRequestId && senderEphemeralPubkey && wrappedContentKey
        ? {
            file_request_id: fileRequestId,
            sender_ephemeral_pubkey: senderEphemeralPubkey,
            wrapped_content_key: wrappedContentKey,
          }
        : null,
    [fileRequestId, senderEphemeralPubkey, wrappedContentKey],
  );

  // Parse the photo list for swipe navigation (passed from PhotosScreen)
  const photoList = useMemo<PhotoPageEntry[]>(() => {
    if (!photoListJson) return [];
    try {
      return JSON.parse(photoListJson) as PhotoPageEntry[];
    } catch {
      return [];
    }
  }, [photoListJson]);
  const hasSwipe = photoList.length > 1;
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(() => (
    clampPhotoIndex(initialPhotoIndex ?? 0, photoList.length)
  ));
  const pagerRef = useRef<FlatList<PhotoPageEntry>>(null);
  const activePhotoPageIndexes = useMemo(
    () => activePhotoPageIndices(currentPhotoIndex, photoList.length, 0),
    [currentPhotoIndex, photoList.length],
  );

  // Derive the current photo entry from the swipe index
  const currentEntry = photoList.length > 0 ? photoList[currentPhotoIndex] : null;
  const currentFileId = currentEntry?.id ?? fileId;
  const currentFileName = currentEntry?.display_name ?? currentEntry?.name_encrypted ?? fileName;
  const currentMimeType = currentEntry?.mime_type ?? mimeType;
  const currentSizeBytes = currentEntry?.size_bytes ?? sizeBytes;
  const currentCreatedAt = currentEntry?.created_at ?? createdAt;
  const currentChunkCount = currentEntry?.chunk_count ?? chunkCount;
  const currentVersionNumber = currentEntry?.version_number ?? versionNumber;
  const currentStoragePoolId = currentEntry?.storage_pool_id ?? storagePoolId;

  const [downloading, setDownloading] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [, setDownloadProgress] = useState(0);
  const [loadProgress, setLoadProgress] = useState<PreviewProgressState>(() => emptyPreviewProgress(null));
  const [performanceProfile, setPerformanceProfile] = useState<DevicePerformanceProfile | null>(null);
  const [performanceStorageProfile, setPerformanceStorageProfile] = useState<PerformanceStorageProfile>(() => (
    normalizePerformanceStorageProfile(routePerformanceStorageProfile)
  ));
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [optionsVisible, setOptionsVisible] = useState(false);
  const [originalPhotoRequest, setOriginalPhotoRequest] = useState<{ fileId: string; nonce: number } | null>(null);

  // Image inline preview state
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imagePreviewKind, setImagePreviewKind] = useState<ImagePreviewKind | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  // Task 0885 (FIX #3): track whether the mounted <Image> has actually decoded,
  // so the failsafe watchdog can distinguish "rendered" from "stuck".
  const [imageLoaded, setImageLoaded] = useState(false);
  const imageLargePreviewAttemptRef = useRef<string | null>(null);
  // Task 0799: progressive de-blur for "View Original" on the single-image path.
  const [originalImageBase, setOriginalImageBase] = useState<string | null>(null);
  const [originalImagePending, setOriginalImagePending] = useState<string | null>(null);
  const [originalImageActive, setOriginalImageActive] = useState(false);
  const [originalImageCacheHit, setOriginalImageCacheHit] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { if (mounted) setReduceMotion(value); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReduceMotion(value);
    });
    return () => { mounted = false; sub?.remove?.(); };
  }, []);

  const promoteOriginalImage = useCallback(() => {
    setOriginalImagePending((pending) => {
      if (pending) {
        setImageUri(pending);
        setImagePreviewKind('original');
      }
      return null;
    });
    setOriginalImageActive(false);
    setOriginalImageBase(null);
    setOriginalImageCacheHit(false);
    AccessibilityInfo.announceForAccessibility('Original ready');
    void Haptics.selectionAsync().catch(() => {});
  }, []);

  // PDF inline preview state — uses PdfRenderer with native react-native-pdf
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Text / code inline preview state
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  // Video inline preview state — `videoUri` is the on-disk decrypted file
  // that the VideoView plays from; cleaned up on unmount / when changed.
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const tempVideoUriRef = useRef<string | null>(null);

  // DOCX inline preview state — `docxData` holds the raw arrayBuffer; the
  // mammoth conversion runs inside the lazy DocxRenderer so the lib is not
  // bundled into the main chunk.
  const [docxData, setDocxData] = useState<ArrayBuffer | null>(null);
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState<string | null>(null);

  // Spreadsheet inline preview state — `sheetData` is the raw arrayBuffer; the
  // XLSX parsing runs inside the lazy XlsxRenderer.
  const [sheetData, setSheetData] = useState<ArrayBuffer | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);

  // SVG inline preview state — wrapped in a tiny HTML doc and shown in WebView
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [svgLoading, setSvgLoading] = useState(false);
  const [svgError, setSvgError] = useState<string | null>(null);

  // HTML inline preview state — toggled between rendered view and raw source
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [htmlLoading, setHtmlLoading] = useState(false);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const [htmlShowSource, setHtmlShowSource] = useState(false);

  // ZIP archive listing state — raw arrayBuffer; JSZip parsing inside the
  // lazy ZipRenderer.
  const [zipData, setZipData] = useState<ArrayBuffer | null>(null);
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  // Archive (TAR/GZ/TGZ) state — uses ArchiveRenderer component
  const [archiveData, setArchiveData] = useState<ArrayBuffer | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // PPTX state — uses PptxRenderer component
  const [pptxData, setPptxData] = useState<ArrayBuffer | null>(null);
  const [pptxLoading, setPptxLoading] = useState(false);
  const [pptxError, setPptxError] = useState<string | null>(null);

  useEffect(() => {
    void getDevicePerformanceProfile().then(setPerformanceProfile).catch(() => {});
    void getPerformanceStorageSettings().then((settings) => {
      setPerformanceStorageProfile(settings.profile);
    }).catch(() => {});
  }, []);

  const { isUnlocked, getFileKeyBytes, getMasterKeyHandleId, getRequestContentKey } = useCrypto();

  // Resolve the key provider + master-key handle for decryptToTempFile. For a
  // file-request upload (0643) we hand it the request content key C and a null
  // handle, which forces the explicit-key decrypt path (decryptChunksToFile)
  // instead of the native master-key derivation that would produce the wrong
  // key. Only the single previewed file can be a request upload — swiped photos
  // always take the normal path.
  const resolveDecryptKey = useCallback(
    (id: string): { keyProvider: () => Promise<Uint8Array>; handleId: number | null } => {
      if (requestFileFields && id === fileId) {
        return { keyProvider: () => getRequestContentKey(requestFileFields), handleId: null };
      }
      return { keyProvider: () => getFileKeyBytes(id), handleId: getMasterKeyHandleId() };
    },
    [requestFileFields, fileId, getRequestContentKey, getFileKeyBytes, getMasterKeyHandleId],
  );

  // Use current* values so derived state updates when swiping between photos
  const category = fileCategory(currentMimeType, currentFileName);
  const isImage = category === 'image';
  const isSvg = category === 'svg';
  const isPdf = category === 'pdf';
  const isVideo = !!currentMimeType && currentMimeType.startsWith('video/');
  const isArchive = category === 'archive';
  const isPptx = category === 'pptx';
  const isMediaPreview = isImage || isVideo;

  // Task 0885 (FIX #3): reset the decode flag whenever the displayed image uri
  // changes so the watchdog re-arms for the new source.
  useEffect(() => {
    setImageLoaded(false);
  }, [imageUri]);

  // Task 0885 (FIX #3): failsafe — once a decrypted uri is mounted the bytes are
  // local, so if the <Image> never loads or errors within the watchdog window,
  // surface an error rather than spinning forever.
  useEffect(() => {
    if (!isImage || !imageUri || imageLoaded || imageError) return;
    const t = setTimeout(() => {
      setImageError((prev) => prev ?? "This image couldn't be displayed.");
    }, IMAGE_RENDER_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [isImage, imageUri, imageLoaded, imageError]);

  useEffect(() => {
    recordRuntimeTrace('preview.open', {
      fileId: currentFileId,
      category,
      mimeType: currentMimeType ?? null,
      sizeBytes: currentSizeBytes ?? null,
      chunkCount: currentChunkCount ?? null,
      hasSwipe,
      hasPhotoList: photoList.length > 0,
      isUnlocked,
    });
  }, [category, currentChunkCount, currentFileId, currentMimeType, currentSizeBytes, hasSwipe, isUnlocked, photoList.length]);
  const isDocx = category === 'docx';
  const isSpreadsheet = category === 'spreadsheet';
  const isHtml = category === 'html';
  const isZip = category === 'zip';
  const isText =
    !isDocx &&
    !isSpreadsheet &&
    !isSvg &&
    !isHtml &&
    !isZip &&
    !isArchive &&
    !isPptx &&
    !!currentMimeType &&
    (currentMimeType.startsWith('text/') ||
      currentMimeType === 'application/json' ||
      currentMimeType === 'application/xml');
  const previewFileName = useMemo(
    () => previewDisplayName(currentFileName, category),
    [category, currentFileName],
  );
  const cacheFileName = useMemo(
    () => previewCacheName(currentFileName, currentMimeType, category),
    [category, currentFileName, currentMimeType],
  );
  const fileFormat = useMemo(() => {
    const ext = previewFileName.includes('.') ? previewFileName.split('.').pop() : null;
    return ext ? `.${ext.toUpperCase()}` : null;
  }, [previewFileName]);

  // Code highlighting — language id + display label come from the filename
  // and mime; the highlighted HTML is rebuilt only when the loaded text changes.
  const codeLanguage = useMemo(
    () => detectCodeLanguage(currentMimeType, currentFileName),
    [currentMimeType, currentFileName],
  );
  const codeLanguageLabel = useMemo(
    () => languageDisplayLabel(codeLanguage, currentFileName),
    [codeLanguage, currentFileName],
  );
  // Code highlighting moved into the lazy CodeRenderer — keep raw text here.

  // Theme-aware accent for non-image category badge
  const categoryAccent = (() => {
    switch (category) {
      case 'image':
      case 'svg': return c.amber;
      case 'pdf': return c.red;
      case 'audio': return c.green;
      case 'video':
      case 'docx':
      case 'pptx':
      case 'doc': return c.ink2;
      case 'spreadsheet': return c.green;
      case 'html': return c.amber;
      case 'zip':
      case 'archive': return c.amberDeep;
      default: return c.ink3;
    }
  })();

  const mediaDetailsRows = useMemo(() => {
    const storage = trustLocation(currentStoragePoolId);
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Name', value: previewFileName },
      { label: 'Kind', value: CATEGORY_LABELS[category] ?? 'File' },
    ];
    if (fileFormat) rows.push({ label: 'Format', value: fileFormat });
    if (currentMimeType) rows.push({ label: 'Type', value: currentMimeType });
    if (currentSizeBytes != null) rows.push({ label: 'Size', value: formatSize(currentSizeBytes) });
    if (currentCreatedAt) rows.push({ label: 'Created', value: formatDate(currentCreatedAt) });
    if (currentVersionNumber != null) rows.push({ label: 'Version', value: `v${currentVersionNumber}` });
    if (currentChunkCount != null) rows.push({ label: 'Chunks', value: String(currentChunkCount) });
    rows.push({
      label: 'Encryption',
      value: isUnlocked ? 'Decrypted on this device' : 'Client-side encrypted',
    });
    rows.push({ label: 'Storage', value: `${storage.region} · ${storage.city}` });
    return rows;
  }, [
    category,
    currentChunkCount,
    currentCreatedAt,
    fileFormat,
    isUnlocked,
    currentMimeType,
    previewFileName,
    currentSizeBytes,
    currentStoragePoolId,
    currentVersionNumber,
  ]);

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  /**
   * Download the encrypted file to cache and decrypt it (when the vault is
   * unlocked). Returns a local URI suitable for an <Image> source or sharing.
   * Falls back to the encrypted URI if crypto is unavailable.
   */
  const fetchAndDecrypt = useCallback(async (options: { signal?: AbortSignal } = {}): Promise<string> => {
    throwIfPreviewAborted(options.signal);
    const startedAt = Date.now();
    recordRuntimeTrace('preview.original.fetch_start', {
      fileId: currentFileId,
      category,
      mimeType: currentMimeType ?? null,
      sizeBytes: currentSizeBytes ?? null,
      chunkCount: currentChunkCount ?? null,
      isUnlocked,
      hasMasterKeyHandle: getMasterKeyHandleId() != null,
    });
    setLoadProgress(emptyPreviewProgress('downloading'));
    // 0803 — offline-open is handled centrally inside decryptToTempFile: it
    // prefers a local encrypted copy (no network) and raises a clear "Not
    // available offline" error when a non-pinned file is opened with no
    // connectivity. getToken reads the stored token, which is present offline.
    const token = await getToken();
    if (!token) {
      recordRuntimeTrace('preview.original.no_token', { fileId: currentFileId });
      throw new Error('Not signed in');
    }
    throwIfPreviewAborted(options.signal);

    // Keep the original extension on the cache filename — RN's <Image>,
    // expo-video, and the WebView pick the decoder from the URI suffix.
    const cacheUri = `${FileSystem.cacheDirectory}${currentFileId}_${cacheFileName}`;

    // Remove any stale copy so a previous failed download (e.g. a JSON error
    // body that 401'd) can't masquerade as a valid file.
    try {
      await FileSystem.deleteAsync(cacheUri, { idempotent: true });
      recordRuntimeTrace('preview.original.stale_cache_cleared', {
        fileId: currentFileId,
        category,
      });
    } catch {
      recordRuntimeTrace('preview.original.stale_cache_clear_failed', {
        fileId: currentFileId,
        category,
      });
      // Best-effort — proceed even if the path can't be cleared.
    }

    if (isUnlocked) {
      const ext = extensionForMime(currentMimeType, category);
      let decryptedUri: string;
      try {
        recordRuntimeTrace('preview.original.decrypt_request', {
          fileId: currentFileId,
          category,
          extension: ext || cacheFileName,
        });
        {
          const { keyProvider, handleId } = resolveDecryptKey(currentFileId);
          decryptedUri = await decryptToTempFile(
            currentFileId,
            keyProvider,
            ext || cacheFileName,
            currentSizeBytes,
            currentChunkCount,
            handleId,
            {
              onProgress: (event) => applyNativeProgress(event, setLoadProgress),
              onOfflineFallback: () => {
                showToast({ type: 'info', message: 'Offline copy unreadable. Re-downloading...' });
              },
              signal: options.signal,
            },
          );
        }
      } catch (error) {
        recordRuntimeTrace('preview.original.decrypt_failed', {
          fileId: currentFileId,
          category,
          elapsedMs: Date.now() - startedAt,
          ...previewErrorTraceFields(error),
        });
        throw error;
      }
      throwIfPreviewAborted(options.signal);
      setDownloadProgress(1);
      setLoadProgress(emptyPreviewProgress(null));
      recordRuntimeTrace('preview.original.fetch_success', {
        fileId: currentFileId,
        category,
        elapsedMs: Date.now() - startedAt,
      });
      // 0883 — auto self-repair: the full plaintext is now on disk. If this is
      // an OWNER media file the server has no thumbnail for, generate + upload
      // one from the bytes we just decrypted (fire-and-forget, never blocks the
      // open). Gated entirely inside the helper; we only feed it owner context.
      // hasThumbnail describes the *opened* file only — for swiped photos
      // (currentFileId !== fileId) we pass undefined so the helper skips.
      maybeSelfRepairThumbnailFromLocalFile({
        fileId: currentFileId,
        localPlaintextUri: decryptedUri,
        mimeType:
          currentMimeType ??
          (category === 'image' ? 'image/jpeg' : category === 'video' ? 'video/mp4' : null),
        hasServerThumbnail: currentFileId === fileId ? hasThumbnail : undefined,
        isRequestUpload: !!requestFileFields && currentFileId === fileId,
        getFileKeyBytes,
      });
      return decryptedUri;
    }

    recordRuntimeTrace('preview.original.locked', { fileId: currentFileId, category });
    throw new Error('Unlock your vault to preview this file.');
  }, [
    cacheFileName,
    category,
    currentChunkCount,
    currentFileId,
    currentMimeType,
    currentSizeBytes,
    fileId,
    hasThumbnail,
    showToast,
    requestFileFields,
    getFileKeyBytes,
    getMasterKeyHandleId,
    resolveDecryptKey,
    isUnlocked,
  ]);

  const getExportUri = useCallback(async (): Promise<{ uri: string; reusedPreview: boolean }> => {
    if (isImage && imageUri && imagePreviewKind === 'original') return { uri: imageUri, reusedPreview: true };
    if (isVideo && videoUri) return { uri: videoUri, reusedPreview: true };
    if (isPdf && pdfUri) return { uri: pdfUri, reusedPreview: true };
    return { uri: await fetchAndDecrypt(), reusedPreview: false };
  }, [fetchAndDecrypt, imagePreviewKind, imageUri, isImage, isPdf, isVideo, pdfUri, videoUri]);

  const currentPhotoPageEntry = useMemo<PhotoPageEntry>(() => ({
    id: currentFileId,
    name_encrypted: currentFileName,
    display_name: currentFileName,
    mime_type: currentMimeType ?? null,
    size_bytes: currentSizeBytes ?? 0,
    created_at: currentCreatedAt ?? new Date().toISOString(),
    chunk_count: currentChunkCount ?? 1,
    version_number: currentVersionNumber,
    storage_pool_id: currentStoragePoolId ?? null,
    thumbnail_uri: currentEntry?.thumbnail_uri ?? null,
    local_asset_id: currentEntry?.local_asset_id ?? null,
  }), [
    currentChunkCount,
    currentCreatedAt,
    currentEntry?.local_asset_id,
    currentEntry?.thumbnail_uri,
    currentFileId,
    currentFileName,
    currentMimeType,
    currentSizeBytes,
    currentStoragePoolId,
    currentVersionNumber,
  ]);

  // Auto-load image previews inline. Data saver/Balanced use the normal
  // thumbnail only; Smooth may upgrade to the large thumbnail. Originals are
  // loaded only from explicit actions.
  useEffect(() => {
    if (!isImage) return;
    if (hasSwipe) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setImageLoading(true);
    setImageError(null);
    setImagePreviewKind(null);
    setLoadProgress(emptyPreviewProgress('checking'));

    (async () => {
      const preview = await loadDecryptedPhotoForViewer(
        currentPhotoPageEntry,
        isUnlocked,
        getFileKeyBytes,
        getMasterKeyHandleId,
        {
          profile: performanceStorageProfile,
          allowOriginal: false,
          forceOriginal: false,
        },
        (nextStage) => {
          if (!cancelled) setLoadProgress((prev) => ({ ...prev, stage: nextStage }));
        },
        (event) => {
          if (!cancelled) applyNativeProgress(event, setLoadProgress);
        },
        controller.signal,
      );
      if (!cancelled) {
        recordRuntimeTrace('preview.image.preview.success', {
          fileId: currentFileId,
          kind: preview.kind,
          profile: performanceStorageProfile,
        });
        setImageUri(preview.uri);
        setImagePreviewKind(preview.kind);
      }
    })()
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) {
          recordRuntimeTrace('preview.image.load_failed', {
            fileId: currentFileId,
            ...previewErrorTraceFields(err),
          });
          setImageError(friendlyError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setImageLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    currentFileId,
    currentPhotoPageEntry,
    getFileKeyBytes,
    getMasterKeyHandleId,
    hasSwipe,
    isImage,
    isUnlocked,
    performanceStorageProfile,
  ]);

  useEffect(() => {
    if (!isImage || hasSwipe) return;
    if (performanceStorageProfile !== 'smooth' || imagePreviewKind !== 'thumbnail' || !imageUri) return;
    if (Platform.OS === 'web') return;
    const attemptKey = `${currentFileId}:${imageUri}`;
    if (imageLargePreviewAttemptRef.current === attemptKey) return;
    imageLargePreviewAttemptRef.current = attemptKey;

    const controller = new AbortController();
    let cancelled = false;
    const startedAt = Date.now();
    recordRuntimeTrace('preview.image.large_thumbnail.upgrade_request', { fileId: currentFileId });

    loadLargePreviewThumbnail(currentPhotoPageEntry, isUnlocked, getFileKeyBytes, controller.signal)
      .then((large) => {
        if (cancelled || !large) {
          if (!cancelled) recordRuntimeTrace('preview.image.large_thumbnail.empty', { fileId: currentFileId });
          return;
        }
        recordRuntimeTrace('preview.image.large_thumbnail.success', {
          fileId: currentFileId,
          source: large.source,
          elapsedMs: Date.now() - startedAt,
        });
        setImageUri(large.uri);
        setImagePreviewKind('large');
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) {
          recordRuntimeTrace('preview.image.large_thumbnail.failed', {
            fileId: currentFileId,
            ...previewErrorTraceFields(err),
          });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    currentFileId,
    currentPhotoPageEntry,
    getFileKeyBytes,
    hasSwipe,
    imagePreviewKind,
    imageUri,
    isImage,
    isUnlocked,
    performanceStorageProfile,
  ]);

  // Auto-load PDFs inline on mount — uses native decrypt + PdfRenderer.
  useEffect(() => {
    if (!isPdf) return;
    if (Platform.OS === 'web') return;
    if (!isUnlocked) return;
    const controller = new AbortController();
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);
    setPdfUri(null);
    setLoadProgress(emptyPreviewProgress('downloading'));

    (async () => {
      try {
        const { keyProvider: pdfKeyProvider, handleId: pdfHandleId } = resolveDecryptKey(currentFileId);
        const tempPath = await decryptToTempFile(
          currentFileId,
          pdfKeyProvider,
          'pdf',
          currentSizeBytes,
          currentChunkCount,
          pdfHandleId,
          {
            onProgress: (event) => applyNativeProgress(event, setLoadProgress),
            signal: controller.signal,
          },
        );
        throwIfPreviewAborted(controller.signal);
        if (!cancelled) {
          setPdfUri(tempPath);
        }
      } catch (err) {
        if (!cancelled && !isAbortError(err)) setPdfError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setPdfLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isPdf, isUnlocked, currentFileId, getFileKeyBytes, getMasterKeyHandleId, resolveDecryptKey, currentSizeBytes, currentChunkCount]);

  // Auto-load text/code/JSON inline on mount — read decrypted file as UTF-8
  useEffect(() => {
    if (!isText) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setTextLoading(true);
    setTextError(null);
    fetchAndDecrypt({ signal: controller.signal })
      .then(async (uri) => {
        throwIfPreviewAborted(controller.signal);
        const content = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        throwIfPreviewAborted(controller.signal);
        if (!cancelled) setTextContent(content);
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) setTextError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setTextLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isText, fetchAndDecrypt]);

  // Auto-load video on mount; track the on-disk URI so we can delete it on unmount
  useEffect(() => {
    if (!isVideo) return;
    if (hasSwipe) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setVideoLoading(true);
    setVideoError(null);
    fetchAndDecrypt({ signal: controller.signal })
      .then((uri) => {
        if (cancelled || controller.signal.aborted) {
          // Screen already unmounted by the time the download completed —
          // delete the file directly since the cleanup branch never sees it.
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          return;
        }
        tempVideoUriRef.current = uri;
        setVideoUri(uri);
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) setVideoError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setVideoLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasSwipe, isVideo, fetchAndDecrypt]);

  // Delete the temp video file when the screen unmounts.
  useEffect(() => {
    return () => {
      const uri = tempVideoUriRef.current;
      if (uri) {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        tempVideoUriRef.current = null;
      }
    };
  }, []);

  // expo-video player — must be called unconditionally, but a null source
  // keeps it idle until `videoUri` resolves.
  const player = useVideoPlayer(videoUri, (p) => {
    p.loop = false;
  });

  // Auto-load DOCX inline — fetch the decrypted bytes and hand them to the
  // lazy DocxRenderer, which owns the mammoth import.
  useEffect(() => {
    if (!isDocx) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setDocxLoading(true);
    setDocxError(null);
    setDocxData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt({ signal: controller.signal });
        if (cancelled) return;
        throwIfPreviewAborted(controller.signal);
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (cancelled) return;
        setDocxData(arrayBuffer);
      } catch (err) {
        if (!cancelled && !isAbortError(err)) setDocxError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setDocxLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isDocx, fetchAndDecrypt]);

  // Auto-load spreadsheets inline — bytes go to the lazy XlsxRenderer, which
  // owns the SheetJS (xlsx) import.
  useEffect(() => {
    if (!isSpreadsheet) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setSheetLoading(true);
    setSheetError(null);
    setSheetData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt({ signal: controller.signal });
        if (cancelled) return;
        throwIfPreviewAborted(controller.signal);
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (!cancelled) setSheetData(arrayBuffer);
      } catch (err) {
        if (!cancelled && !isAbortError(err)) setSheetError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setSheetLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isSpreadsheet, fetchAndDecrypt]);

  // Auto-load SVGs inline — read as UTF-8, wrap in an HTML doc, show in WebView
  useEffect(() => {
    if (!isSvg) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setSvgLoading(true);
    setSvgError(null);
    setSvgContent(null);

    fetchAndDecrypt({ signal: controller.signal })
      .then(async (uri) => {
        throwIfPreviewAborted(controller.signal);
        const content = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        throwIfPreviewAborted(controller.signal);
        if (!cancelled) setSvgContent(content);
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) setSvgError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setSvgLoading(false);
          setDownloadProgress(0);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isSvg, fetchAndDecrypt]);

  // Auto-load HTML files — read as UTF-8 string, render or show source on toggle
  useEffect(() => {
    if (!isHtml) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setHtmlLoading(true);
    setHtmlError(null);
    setHtmlContent(null);
    // Always start in rendered mode for a fresh file
    setHtmlShowSource(false);

    fetchAndDecrypt({ signal: controller.signal })
      .then(async (uri) => {
        throwIfPreviewAborted(controller.signal);
        const content = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        throwIfPreviewAborted(controller.signal);
        if (!cancelled) setHtmlContent(content);
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) setHtmlError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setHtmlLoading(false);
          setDownloadProgress(0);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isHtml, fetchAndDecrypt]);

  // Wrap the SVG content in a minimal HTML doc whenever the SVG changes
  const wrappedSvgHtml = useMemo(() => {
    if (!svgContent) return null;
    return buildSvgHtml(svgContent);
  }, [svgContent]);

  // Auto-load ZIP archives — bytes go to the lazy ZipRenderer (owns JSZip).
  useEffect(() => {
    if (!isZip) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setZipLoading(true);
    setZipError(null);
    setZipData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt({ signal: controller.signal });
        if (cancelled) return;
        throwIfPreviewAborted(controller.signal);
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (!cancelled) setZipData(arrayBuffer);
      } catch (err) {
        if (!cancelled && !isAbortError(err)) setZipError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setZipLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isZip, fetchAndDecrypt]);

  // Auto-load TAR/GZ/TGZ archives — decrypt and read as bytes for ArchiveRenderer
  useEffect(() => {
    if (!isArchive) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setArchiveLoading(true);
    setArchiveError(null);
    setArchiveData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt({ signal: controller.signal });
        if (cancelled) return;
        throwIfPreviewAborted(controller.signal);
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        throwIfPreviewAborted(controller.signal);
        if (!cancelled) setArchiveData(arrayBuffer);
      } catch (err) {
        if (!cancelled && !isAbortError(err)) setArchiveError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setArchiveLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isArchive, fetchAndDecrypt]);

  // Auto-load PPTX — decrypt and read as bytes for PptxRenderer
  useEffect(() => {
    if (!isPptx) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setPptxLoading(true);
    setPptxError(null);
    setPptxData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt({ signal: controller.signal });
        if (cancelled) return;
        throwIfPreviewAborted(controller.signal);
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        throwIfPreviewAborted(controller.signal);
        if (!cancelled) setPptxData(arrayBuffer);
      } catch (err) {
        if (!cancelled && !isAbortError(err)) setPptxError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setPptxLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isPptx, fetchAndDecrypt]);

  const handleDownload = useCallback(async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Not available', 'File download is only available on iOS and Android.');
      return;
    }
    recordRuntimeTrace('preview.download_original.press', { fileId: currentFileId, category });

    setDownloading(true);
    setDownloadProgress(0);
    setExportStatus('Preparing export options...');

    try {
      const token = await getToken();
      if (!token) {
        Alert.alert('Not signed in', 'Please sign in to download files.');
        return;
      }

      setExportStatus('Preparing a decrypted copy on this device...');
      const { uri: shareUri, reusedPreview } = await getExportUri();
      setExportStatus(
        reusedPreview
          ? 'Using the decrypted preview already on this device...'
          : 'Decrypting locally before export...',
      );
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        setExportStatus('Opening iOS export options...');
        await Sharing.shareAsync(shareUri, {
          mimeType: currentMimeType ?? 'application/octet-stream',
          dialogTitle: previewFileName,
        });
      } else {
        Alert.alert('Downloaded', `Saved to ${shareUri}`);
      }
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Download failed', friendlyError(err));
    } finally {
      setDownloading(false);
      setDownloadProgress(0);
      setExportStatus(null);
    }
  }, [category, currentFileId, currentMimeType, getExportUri, previewFileName]);

  const handleViewOriginal = useCallback(async () => {
    if (!isImage) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    recordRuntimeTrace('preview.view_original.press', {
      fileId: currentFileId,
      hasSwipe,
    });

    if (hasSwipe) {
      setOriginalPhotoRequest({ fileId: currentFileId, nonce: Date.now() });
      return;
    }

    const controller = new AbortController();
    // Task 0799: keep the current preview on screen as the de-blur base; load
    // the original into the transition layer instead of swapping `imageUri`.
    setOriginalImageBase(imageUri);
    setOriginalImagePending(null);
    setOriginalImageCacheHit(false);
    setOriginalImageActive(true);
    setImageError(null);
    setLoadProgress(emptyPreviewProgress('downloading'));
    AccessibilityInfo.announceForAccessibility('Loading original');
    try {
      const cached = await getCachedPhoto(currentFileId);
      if (cached) {
        if (!imageUri) {
          // Task 0885 (FIX #1): no base preview to de-blur (thumbnail-less,
          // e.g. desktop upload) → the crossfade/promote path never runs, so
          // mount the original directly instead of spinning forever.
          setOriginalImageActive(false);
          setOriginalImageBase(null);
          setOriginalImagePending(null);
          setImageLoaded(false);
          setImageUri(cached);
          setImagePreviewKind('original');
          recordRuntimeTrace('preview.image.view_original.cache_hit', { fileId: currentFileId });
          return;
        }
        // Already local → skip the theater; the component does a quick crossfade.
        setOriginalImageCacheHit(true);
        setOriginalImagePending(cached);
        recordRuntimeTrace('preview.image.view_original.cache_hit', { fileId: currentFileId });
        return;
      }

      const decryptedUri = await fetchAndDecrypt({ signal: controller.signal });
      throwIfPreviewAborted(controller.signal);
      let resolvedUri = decryptedUri;
      try {
        const cachedUri = await cachePhoto(currentFileId, decryptedUri);
        if (cachedUri !== decryptedUri) {
          await FileSystem.deleteAsync(decryptedUri, { idempotent: true }).catch(() => {});
        }
        resolvedUri = cachedUri;
      } catch {
        resolvedUri = decryptedUri;
      }
      if (!imageUri) {
        // Task 0885 (FIX #1): thumbnail-less original — mount it directly since
        // there is no base preview to de-blur into.
        setOriginalImageActive(false);
        setOriginalImageBase(null);
        setOriginalImagePending(null);
        setImageLoaded(false);
        setImageUri(resolvedUri);
        setImagePreviewKind('original');
      } else {
        setOriginalImagePending(resolvedUri);
      }
      recordRuntimeTrace('preview.image.view_original.success', { fileId: currentFileId });
    } catch (err) {
      if (!isAbortError(err)) {
        setImageError(friendlyError(err));
        setOriginalImageActive(false);
        setOriginalImageBase(null);
        recordRuntimeTrace('preview.image.view_original.failed', {
          fileId: currentFileId,
          ...previewErrorTraceFields(err),
        });
      } else {
        setOriginalImageActive(false);
        setOriginalImageBase(null);
      }
    } finally {
      setImageLoading(false);
      setDownloadProgress(0);
      setLoadProgress(emptyPreviewProgress(null));
    }
  }, [currentFileId, fetchAndDecrypt, hasSwipe, imageUri, isImage]);

  const handleShare = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigation.navigate('ShareSheet', { fileId: currentFileId, fileName: previewFileName, mimeType: currentMimeType, sizeBytes: currentSizeBytes });
  }, [navigation, currentFileId, previewFileName, currentMimeType, currentSizeBytes]);

  const handleCopyName = useCallback(async () => {
    await Clipboard.setStringAsync(previewFileName);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [previewFileName]);

  const handleDuplicate = useCallback(() => {
    Alert.alert(
      'Duplicate is not ready yet',
      'Duplicating encrypted files needs a server-side copy operation so the file key, metadata, and chunks stay consistent.',
    );
  }, []);

  const handleMoveToTrash = useCallback(() => {
    if (trashing) return;

    Alert.alert(
      'Move to Trash?',
      `${previewFileName} will be removed from Beebeeb.${isImage || isVideo ? ' It will not be deleted from your iPhone camera roll.' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Move to Trash',
          style: 'destructive',
          onPress: async () => {
            setTrashing(true);
            try {
              await trashFiles([currentFileId]);
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              navigation.goBack();
            } catch (err) {
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              Alert.alert('Delete failed', friendlyError(err));
            } finally {
              setTrashing(false);
            }
          },
        },
      ],
    );
  }, [currentFileId, navigation, previewFileName, trashing, isImage, isVideo]);

  const previewActions = useMemo<PreviewOptionAction[]>(() => [
    ...(isImage ? [{ label: 'View Original', icon: 'image-outline' as const, run: handleViewOriginal }] : []),
    { label: 'Share Beebeeb Link', icon: 'link-outline', run: handleShare },
    { label: 'Save Original…', icon: 'share-outline', run: handleDownload },
    { label: 'Copy File Name', icon: 'copy-outline', run: handleCopyName },
    { label: 'Duplicate', icon: 'duplicate-outline', run: handleDuplicate },
    { label: 'Move to Trash', icon: 'trash-outline', destructive: true, run: handleMoveToTrash },
  ], [handleCopyName, handleDownload, handleDuplicate, handleMoveToTrash, handleShare, handleViewOriginal, isImage]);

  const handlePreviewOptions = useCallback(() => {
    if (Platform.OS === 'ios') {
      setOptionsVisible(true);
      return;
    }

    Alert.alert(
      previewFileName,
      undefined,
      [
        ...previewActions.map((action) => ({
          text: action.label,
          style: action.destructive ? 'destructive' as const : 'default' as const,
          onPress: action.run,
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [previewActions, previewFileName]);

  // Swipe pager: only render the active page + 1 neighbor on each side
  const handlePagerScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
      if (index >= 0 && index < photoList.length && index !== currentPhotoIndex) {
        setCurrentPhotoIndex(index);
      }
    },
    [photoList.length, currentPhotoIndex],
  );

  const pagerGetItemLayout = useCallback(
    (_data: unknown, index: number) => ({
      length: SCREEN_WIDTH,
      offset: SCREEN_WIDTH * index,
      index,
    }),
    [],
  );

  const renderPhotoPage = useCallback(
    ({ item, index }: { item: PhotoPageEntry; index: number }) => (
      <PhotoPage
        entry={item}
        shouldLoadFull={activePhotoPageIndexes.has(index)}
        isCurrent={index === currentPhotoIndex}
        width={SCREEN_WIDTH}
        previewProfile={performanceStorageProfile}
        originalRequestNonce={originalPhotoRequest?.fileId === item.id ? originalPhotoRequest.nonce : 0}
      />
    ),
    [activePhotoPageIndexes, currentPhotoIndex, originalPhotoRequest, performanceStorageProfile],
  );

  const renderSharedProgress = (isVideoProgress = false) => (
    <PreviewProgressStatus
      color={c.amber}
      isUnlocked={isUnlocked}
      isVideo={isVideoProgress}
      progress={loadProgress.stage ? loadProgress : emptyPreviewProgress('downloading')}
      profile={performanceProfile}
      sizeBytes={currentSizeBytes}
    />
  );

  if (isMediaPreview) {
    // When a photo list is provided, show a horizontal swipeable pager
    const showPager = hasSwipe && (isImage || isVideo);

    return (
      <View style={styles.mediaRoot}>
        <View style={[styles.mediaHeader, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={handleClose}
            style={styles.mediaIconButton}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Close preview"
          >
            <Ionicons name="chevron-down" size={22} color={colors.white} />
          </TouchableOpacity>

          <View style={styles.mediaHeaderText}>
            <Text style={styles.mediaHeaderTitle} numberOfLines={1}>{previewFileName}</Text>
            <Text style={styles.mediaHeaderSubtitle} numberOfLines={1}>
              {showPager
                ? `${currentPhotoIndex + 1} of ${photoList.length}`
                : `${CATEGORY_LABELS[category]}${currentSizeBytes != null ? ` · ${formatSize(currentSizeBytes)}` : ''}`
              }
            </Text>
          </View>

          <TouchableOpacity
            onPress={handlePreviewOptions}
            disabled={downloading || trashing}
            style={[styles.mediaIconButton, (downloading || trashing) && styles.disabledIconButton]}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Open file options"
          >
            <Ionicons name="ellipsis-horizontal" size={21} color={colors.white} />
          </TouchableOpacity>
        </View>

        {showPager ? (
          <View
            style={[
              styles.mediaStage,
              {
                paddingTop: insets.top + 64,
                paddingBottom: 24 + Math.max(insets.bottom, 16),
              },
            ]}
          >
            <FlatList
              ref={pagerRef}
              data={photoList}
              horizontal
              pagingEnabled
              initialScrollIndex={clampPhotoIndex(initialPhotoIndex ?? 0, photoList.length)}
              getItemLayout={pagerGetItemLayout}
              keyExtractor={(item) => item.id}
              renderItem={renderPhotoPage}
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={handlePagerScroll}
              windowSize={3}
              maxToRenderPerBatch={3}
              removeClippedSubviews
              style={{ flex: 1 }}
            />
          </View>
        ) : (
          <Pressable
            style={[
              styles.mediaStage,
              {
                paddingTop: insets.top + 64,
                paddingBottom: 24 + Math.max(insets.bottom, 16),
              },
            ]}
          >
            {isImage ? (
              imageError ? (
                <View style={styles.imageStatus}>
                  <Text style={[styles.imageStatusTitle, { color: colors.white }]}>Couldn't load image</Text>
                  <Text style={styles.imageStatusSub}>{imageError}</Text>
                </View>
              ) : imageUri ? (
                originalImageActive ? (
                  <ProgressiveOriginalImage
                    baseUri={originalImageBase ?? imageUri}
                    originalUri={originalImagePending}
                    progress={loadProgress}
                    active={originalImageActive}
                    cacheHit={originalImageCacheHit}
                    reduceMotion={reduceMotion}
                    amber={c.amber}
                    containerStyle={styles.mediaImage}
                    imageStyle={styles.mediaImage}
                    accessibilityLabel={previewFileName}
                    onPromote={promoteOriginalImage}
                    onImageLoad={() => setImageLoaded(true)}
                    onImageError={() => setImageError((prev) => prev ?? "This image couldn't be displayed.")}
                  />
                ) : (
                  <Image
                    source={{ uri: imageUri }}
                    style={styles.mediaImage}
                    resizeMode="contain"
                    accessibilityLabel={previewFileName}
                    onLoad={() => setImageLoaded(true)}
                    onError={() => setImageError((prev) => prev ?? "This image couldn't be displayed.")}
                  />
                )
              ) : (
                <View style={styles.imageStatus}>
                  {renderSharedProgress(false)}
                </View>
              )
            ) : videoUri ? (
              <VideoView
                player={player}
                style={styles.mediaVideo}
                contentFit="contain"
                nativeControls
                allowsFullscreen
                allowsPictureInPicture
              />
            ) : videoError ? (
              <View style={styles.imageStatus}>
                <Text style={[styles.imageStatusTitle, { color: colors.white }]}>Couldn't load video</Text>
                <Text style={styles.imageStatusSub}>{videoError}</Text>
              </View>
            ) : (
              <View style={styles.imageStatus}>
                {renderSharedProgress(true)}
              </View>
            )}
          </Pressable>
        )}

        <DetailsSheet
          filename={previewFileName}
          kind={CATEGORY_LABELS[category] ?? 'File'}
          size={currentSizeBytes != null ? formatSize(currentSizeBytes) : 'Unknown'}
          created={currentCreatedAt ? formatDate(currentCreatedAt) : undefined}
          extraInfo={mediaDetailsRows
            .filter((r) => !['Name', 'Kind', 'Size', 'Created', 'Storage'].includes(r.label))
            .map((r) => ({ label: r.label, value: r.value }))}
          storageLocation={(() => {
            const storage = trustLocation(currentStoragePoolId);
            return `${storage.region} · ${storage.city}`;
          })()}
          onShare={handleShare}
          onDownload={handleDownload}
          downloading={downloading}
        />
        <PreviewOptionsPopover
          visible={optionsVisible}
          filename={previewFileName}
          actions={previewActions}
          onClose={() => setOptionsVisible(false)}
          top={insets.top + 62}
        />
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ---- Header ---- */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={handleClose}
          style={styles.closeButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.closeIcon}>{'×'}</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {previewFileName}
          </Text>
          <View style={styles.headerSubRow}>
            <Text style={styles.headerSub}>
              {CATEGORY_LABELS[category] ?? 'File'}
              {currentSizeBytes != null ? `  ·  ${formatSize(currentSizeBytes)}` : ''}
            </Text>
            {isText && codeLanguage !== 'plaintext' && (
              <View style={styles.langBadge}>
                <Text style={styles.langBadgeText}>{codeLanguageLabel}</Text>
              </View>
            )}
          </View>
        </View>

        <TouchableOpacity
          onPress={handlePreviewOptions}
          disabled={downloading || trashing}
          style={[styles.headerIconButton, (downloading || trashing) && styles.disabledIconButton]}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Open file options"
        >
          <Ionicons name="ellipsis-horizontal" size={21} color={colors.white} />
        </TouchableOpacity>
      </View>

      <PreviewOptionsPopover
        visible={optionsVisible}
        filename={previewFileName}
        actions={previewActions}
        onClose={() => setOptionsVisible(false)}
        top={insets.top + 58}
      />

      {/* ---- Preview area ---- */}
      <View style={styles.previewArea}>
        {isImage ? (
          imageError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load image
              </Text>
              <Text style={styles.imageStatusSub}>{imageError}</Text>
            </View>
          ) : imageUri ? (
            originalImageActive ? (
              <ProgressiveOriginalImage
                baseUri={originalImageBase ?? imageUri}
                originalUri={originalImagePending}
                progress={loadProgress}
                active={originalImageActive}
                cacheHit={originalImageCacheHit}
                reduceMotion={reduceMotion}
                amber={c.amber}
                containerStyle={styles.image}
                imageStyle={styles.image}
                accessibilityLabel={previewFileName}
                onPromote={promoteOriginalImage}
                onImageLoad={() => setImageLoaded(true)}
                onImageError={() => setImageError((prev) => prev ?? "This image couldn't be displayed.")}
              />
            ) : (
              <Image
                source={{ uri: imageUri }}
                style={styles.image}
                resizeMode="contain"
                accessibilityLabel={previewFileName}
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageError((prev) => prev ?? "This image couldn't be displayed.")}
              />
            )
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isSvg ? (
          wrappedSvgHtml ? (
            <WebView
              originWhitelist={['*']}
              source={{ html: wrappedSvgHtml }}
              style={styles.svgWebView}
              scalesPageToFit
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
            />
          ) : svgError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load SVG
              </Text>
              <Text style={styles.imageStatusSub}>{svgError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isPdf ? (
          pdfUri ? (
            <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
              <PdfRenderer filePath={pdfUri} />
            </Suspense>
          ) : pdfError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load PDF
              </Text>
              <Text style={styles.imageStatusSub}>{pdfError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isVideo ? (
          videoUri ? (
            <VideoView
              player={player}
              style={styles.video}
              contentFit="contain"
              nativeControls
              allowsFullscreen
              allowsPictureInPicture
            />
          ) : videoError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load video
              </Text>
              <Text style={styles.imageStatusSub}>{videoError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(true)}
            </View>
          )
        ) : isText ? (
          textContent != null ? (
            <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
              <CodeRenderer code={textContent} language={codeLanguage} />
            </Suspense>
          ) : textError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load file
              </Text>
              <Text style={styles.imageStatusSub}>{textError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isDocx ? (
          docxData ? (
            <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
              <DocxRenderer data={docxData} colors={c} isDark={resolved === 'dark'} />
            </Suspense>
          ) : docxError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open document
              </Text>
              <Text style={styles.imageStatusSub}>{docxError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isSpreadsheet ? (
          sheetData ? (
            <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
              <XlsxRenderer data={sheetData} colors={c} />
            </Suspense>
          ) : sheetError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open spreadsheet
              </Text>
              <Text style={styles.imageStatusSub}>{sheetError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isHtml ? (
          htmlContent != null ? (
            <View style={styles.htmlContainer}>
              {/* Toggle: rendered ↔ source. Sticky bar on top of the view. */}
              <View style={[styles.htmlToggleBar, { borderBottomColor: c.line, backgroundColor: c.paper }]}>
                <TouchableOpacity
                  onPress={() => setHtmlShowSource(false)}
                  style={[
                    styles.htmlToggleButton,
                    !htmlShowSource && { backgroundColor: c.amber },
                  ]}
                  activeOpacity={0.7}
                  accessibilityLabel="Show rendered HTML"
                >
                  <Text
                    style={[
                      styles.htmlToggleText,
                      { color: !htmlShowSource ? c.ink : c.ink3 },
                    ]}
                  >
                    Rendered
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setHtmlShowSource(true)}
                  style={[
                    styles.htmlToggleButton,
                    htmlShowSource && { backgroundColor: c.amber },
                  ]}
                  activeOpacity={0.7}
                  accessibilityLabel="Show HTML source"
                >
                  <Text
                    style={[
                      styles.htmlToggleText,
                      { color: htmlShowSource ? c.ink : c.ink3 },
                    ]}
                  >
                    Source
                  </Text>
                </TouchableOpacity>
              </View>

              {htmlShowSource ? (
                <ScrollView
                  style={[styles.codeScroll, { backgroundColor: colors.darkBg, borderRadius: 0 }]}
                  contentContainerStyle={styles.codeScrollContent}
                >
                  <ScrollView horizontal contentContainerStyle={styles.codeHorizontal}>
                    <View style={styles.codeBlock}>
                      {htmlContent.split('\n').map((line, i) => (
                        <View key={i} style={styles.codeLine}>
                          <Text style={[styles.codeLineNumber, { color: c.ink3 }]} selectable={false}>
                            {String(i + 1).padStart(4, ' ')}
                          </Text>
                          <Text style={[styles.codeLineText, { color: c.ink }]} selectable>
                            {line.length === 0 ? ' ' : line}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </ScrollView>
              ) : (
                <WebView
                  originWhitelist={['*']}
                  source={{ html: htmlContent }}
                  style={[styles.htmlWebView, { backgroundColor: c.paper }]}
                  // Sandbox: keep external network requests off so encrypted
                  // assets can't accidentally leak through embedded URLs.
                  // (HTML may include <img src="https://..."> tags.)
                  javaScriptEnabled={false}
                  domStorageEnabled={false}
                />
              )}
            </View>
          ) : htmlError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load page
              </Text>
              <Text style={styles.imageStatusSub}>{htmlError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isZip ? (
          zipData ? (
            <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
              <ZipRenderer data={zipData} colors={c} />
            </Suspense>
          ) : zipError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open archive
              </Text>
              <Text style={styles.imageStatusSub}>{zipError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isArchive ? (
          archiveData ? (
            <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
              <ArchiveRenderer
                data={archiveData}
                extension={(currentFileName ?? '').toLowerCase().split('.').pop() ?? 'tar'}
                colors={c}
              />
            </Suspense>
          ) : archiveError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open archive
              </Text>
              <Text style={styles.imageStatusSub}>{archiveError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isPptx ? (
          pptxData ? (
            <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
              <PptxRenderer data={pptxData} colors={c} />
            </Suspense>
          ) : pptxError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open presentation
              </Text>
              <Text style={styles.imageStatusSub}>{pptxError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : (
          <View style={styles.genericPlaceholder}>
            <View style={[styles.genericIcon, { backgroundColor: categoryAccent }]}>
              <Text style={styles.genericIconText}>
                {CATEGORY_BADGE[category] ?? 'FILE'}
              </Text>
            </View>
            <Text style={styles.genericTitle}>{CATEGORY_LABELS[category] ?? 'File'}</Text>
            <Text style={styles.genericSub}>
              {isUnlocked
                ? 'Download to decrypt and open this file.'
                : 'Unlock your vault to decrypt this file.'}
            </Text>
          </View>
        )}
      </View>

      {/* ---- Details sheet (handle-only, pull up to expand) ---- */}
      <DetailsSheet
        filename={previewFileName}
        kind={CATEGORY_LABELS[category] ?? 'File'}
        size={currentSizeBytes != null ? formatSize(currentSizeBytes) : 'Unknown'}
        created={currentCreatedAt ? formatDate(currentCreatedAt) : undefined}
        extraInfo={[
          ...(fileFormat ? [{ label: 'Format', value: fileFormat }] : []),
          ...(currentMimeType ? [{ label: 'Type', value: currentMimeType }] : []),
        ]}
        storageLocation={(() => {
          const storage = trustLocation(currentStoragePoolId);
          return `${storage.region} · ${storage.city}`;
        })()}
        onShare={handleShare}
        onDownload={handleDownload}
        downloading={downloading}
      />
    </View>
  );
}

interface PreviewOptionsPopoverProps {
  visible: boolean;
  filename: string;
  actions: PreviewOptionAction[];
  onClose: () => void;
  top: number;
}

function PreviewOptionsPopover({
  visible,
  filename,
  actions,
  onClose,
  top,
}: PreviewOptionsPopoverProps) {
  if (!visible) return null;

  const runAction = (action: PreviewOptionAction) => {
    onClose();
    requestAnimationFrame(() => action.run());
  };

  return (
    <View style={styles.optionsLayer} pointerEvents="box-none">
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close file options"
      />
      <View style={[styles.optionsPanel, { top }]}>
        <Text style={styles.optionsTitle} numberOfLines={1}>
          {filename}
        </Text>
        {actions.map((action, index) => {
          const showDivider = index > 0 && (action.destructive || actions[index - 1]?.destructive);
          return (
            <View key={action.label}>
              {showDivider ? <View style={styles.optionsDivider} /> : null}
              <Pressable
                onPress={() => runAction(action)}
                style={({ pressed }) => [
                  styles.optionsRow,
                  pressed && styles.optionsRowPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <Ionicons
                  name={action.icon}
                  size={21}
                  color={action.destructive ? '#FF6961' : 'rgba(255,255,255,0.92)'}
                  style={styles.optionsIcon}
                />
                <Text
                  style={[
                    styles.optionsLabel,
                    action.destructive && styles.optionsLabelDestructive,
                  ]}
                  numberOfLines={1}
                >
                  {action.label}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  mediaRoot: {
    flex: 1,
    backgroundColor: '#020203',
  },
  mediaHeader: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 12,
    backgroundColor: 'rgba(2,2,3,0.72)',
  },
  mediaIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.11)',
  },
  disabledIconButton: {
    opacity: 0.48,
  },
  mediaHeaderText: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  mediaHeaderTitle: {
    maxWidth: '100%',
    color: colors.white,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
  },
  mediaHeaderSubtitle: {
    maxWidth: '100%',
    marginTop: 2,
    color: 'rgba(255,255,255,0.58)',
    fontSize: 11,
    lineHeight: 14,
  },
  mediaStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  photoPage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoPageThumbnail: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    opacity: 0.42,
  },
  photoPageImage: {
    width: '100%',
    height: '100%',
  },
  photoPageStatus: {
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 28,
  },
  photoPageStatusTitle: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  photoPageStatusSub: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  mediaVideo: {
    width: '100%',
    height: '100%',
  },
  optionsLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 80,
  },
  optionsPanel: {
    position: 'absolute',
    right: 16,
    width: 282,
    paddingVertical: 6,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: 'rgba(37,35,31,0.94)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
    shadowColor: '#000',
    shadowOpacity: 0.36,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 18,
  },
  optionsTitle: {
    paddingHorizontal: 16,
    paddingTop: 7,
    paddingBottom: 6,
    color: 'rgba(255,255,255,0.58)',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
  },
  optionsRow: {
    minHeight: 45,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  optionsRowPressed: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  optionsIcon: {
    width: 24,
    textAlign: 'center',
  },
  optionsLabel: {
    flex: 1,
    color: 'rgba(255,255,255,0.96)',
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '400',
  },
  optionsLabelDestructive: {
    color: '#FF6961',
  },
  optionsDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
    marginVertical: 5,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  // (Media details sheet styles removed — now handled by DetailsSheet component)

  root: {
    flex: 1,
    backgroundColor: colors.darkBg,
  },

  // ---- Header ----
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIcon: {
    fontSize: 18,
    fontWeight: '400',
    color: colors.white,
  },
  headerIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.white,
  },
  headerSub: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },
  headerSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  langBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(245, 184, 0, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(245, 184, 0, 0.5)',
  },
  langBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: '#F5B800',
    textTransform: 'uppercase',
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
  },
  headerAction: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.md,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  headerActionText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.white,
  },

  // ---- Preview area ----
  previewArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },

  image: { width: '100%', height: '100%' },
  video: { width: '100%', height: '100%' },
  svgWebView: { width: '100%', height: '100%', backgroundColor: '#ffffff', borderRadius: radii.md },

  // ---- HTML viewer ----
  htmlContainer: { flex: 1, width: '100%', borderRadius: radii.md, overflow: 'hidden' },
  htmlToggleBar: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  htmlToggleButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.md,
  },
  htmlToggleText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  htmlWebView: { flex: 1, width: '100%' },

  // ---- Code / text viewer (HTML "show source" only — CodeRenderer owns its own styles) ----
  codeScroll: { flex: 1, width: '100%', borderRadius: radii.md },
  codeScrollContent: { flexGrow: 1 },
  codeHorizontal: { flexGrow: 1, paddingVertical: 12 },
  codeBlock: { paddingHorizontal: 12, minWidth: '100%' },
  codeLine: { flexDirection: 'row', alignItems: 'flex-start' },
  codeLineNumber: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    fontSize: 11,
    lineHeight: 18,
    paddingRight: 12,
    textAlign: 'right',
    minWidth: 36,
  },
  codeLineText: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    fontSize: 12,
    lineHeight: 18,
    flexShrink: 0,
  },

  imageStatus: { alignItems: 'center', gap: 12 },
  imageStatusTitle: { fontSize: 16, fontWeight: '600' },
  imageStatusSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    lineHeight: 20,
  },
  previewProgressWrap: {
    width: Math.min(SCREEN_WIDTH - 72, 360),
    alignItems: 'center',
    gap: 12,
  },
  previewProgressTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  previewProgressFill: {
    height: '100%',
    minWidth: 8,
    borderRadius: 2,
  },
  // Task 0799 — slim "bytes arriving" bar pinned to the top of the frame during
  // the View-Original download phase.
  progressiveBarTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  progressiveBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  progressiveBarIndeterminate: {
    width: '36%',
  },

  genericPlaceholder: { alignItems: 'center', gap: 16 },
  genericIcon: {
    width: 72,
    height: 72,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  genericIconText: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.white,
    letterSpacing: 0.5,
  },
  genericTitle: { fontSize: 18, fontWeight: '600', color: colors.white },
  genericSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    lineHeight: 20,
  },

  // ---- Metadata card ----
  metaCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  metaSection: { gap: 10 },
  metaSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: { fontSize: 13 },
  metaValue: {
    fontSize: 13,
    fontWeight: '500',
    maxWidth: '60%',
    textAlign: 'right',
  },
  // ---- Download bar ----
  downloadBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 8,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  downloadButton: {
    borderRadius: radii.lg,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  downloadButtonDisabled: {
    opacity: 0.7,
  },
  downloadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  downloadButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },

});
