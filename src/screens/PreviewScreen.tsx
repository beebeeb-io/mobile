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
import type { GestureResponderEvent, ImageStyle, StyleProp, ViewStyle } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { StatusBar } from 'expo-status-bar';
import {
  PanGestureHandler,
  State,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { WebView } from 'react-native-webview';
import { useVideoPlayer, VideoView } from 'expo-video';
import NetInfo from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';
import type { RootStackParamList } from '../App';
import { colors, fonts, radii, shadows } from '../theme';
import type { Colors } from '../theme';
import { useTheme } from '../lib/theme-context';
import { GLASS_CIRCLE_SIZES, GlassCapsule, GlassCircle, PREVIEW_CHROME_MATERIAL, SCROLL_EDGE, ScrollEdgeBlur, glassMaterial } from '../components/glass';
import { bandColors, type Stop } from '../components/glass/gradient';
import { useToast } from '../lib/toast-context';
import { getToken, friendlyError, trustLocation, trashFiles, getFile, getFileCurrentVersion, listAllFiles, moveFile, type UploadProgress } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import { generateFileId } from '../lib/encrypted-upload';
import { encryptedMetadataToJson, encryptedMetadataPayloadToBytes, fileMetadataPlaintext } from '../lib/encrypted-metadata';
import { collectAllFolders, movePickerFolderFallbackName, type MovePickerFolderNode } from '../lib/move-picker-folders';
import FolderPickerModal, { type PickerFolder } from '../components/FolderPickerModal';
import { evaluateTextEditGate } from '../lib/text-edit-gate';
import {
  abandonTextFileUpload,
  buildKeepBothName,
  createSingleFlight,
  refreshMetaForConflict,
  runTextSaveConfirmingClear,
  saveFailedAfterUploadStarted,
  saveTextFileVersion,
} from '../lib/text-file-save';
import { decryptToTempFile, invalidatePreviewCache, releasePreviewCopy } from '../lib/native-decrypt';
import { isLoopbackStreamUri, streamBufferPctFromEvent } from '../lib/video-stream';
import { offlineManager } from '../lib/offline-manager';
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
} from '../lib/thumbnail';
import { fetchThumbnailUriOnce } from '../lib/use-thumbnail';
import {
  getPerformanceStorageSettings,
  type PerformanceStorageProfile,
} from '../lib/performance-storage-settings';
import {
  activePhotoPageIndices,
  clampPhotoIndex,
  PHOTO_PAGE_LOAD_RADIUS,
} from '../lib/photo-viewer-window';
import { InfoSheet } from '../components/preview/InfoSheet';
import { PreviewBottomBar } from '../components/preview/PreviewBottomBar';
import { recordRuntimeTrace } from '../lib/runtime-trace';
import { formatBytes as formatSize } from '../lib/format';
import { PARTIAL_DECRYPT_MESSAGE, STILL_UPLOADING_MESSAGE, previewLoadErrorMessage } from '../lib/preview-load-error';
import { displayedSizeBytes, savedFileMetaFrom, type SavedFileMeta } from '../lib/saved-file-meta';
import { checkLockedFileIds, isPagerPageGated } from '../lib/preview-lock-gate';
import { computePreviewContentInset } from '../lib/preview-content-inset';
import { FILES_APP_LOCK_CAVEAT } from '../lib/lock-copy';
import { formatPdfPageCounter, nextBarsVisible, pagerTapAction } from '../lib/preview-chrome';
import { buildInfoSheetRows, type InfoSheetFocus } from '../lib/preview-info';
import { extensionForAudio } from '../lib/audio-format';
import { extensionForRaw, rawFormatLabel } from '../lib/raw-format';
import type { RawExifInfo } from '../lib/raw-preview';
import { cleanupTrackedTempFile } from '../lib/preview-temp-file';
import { isTextPreview } from '../lib/code-text-preview';
import { fileCategory, type Category } from '../lib/file-category';
import { extensionForMime, previewCacheName, previewDecryptExtension, previewDisplayName } from '../lib/preview-cache-key';
// Task 1569 — imported EAGERLY (not React.lazy, unlike every other renderer
// below), and rendered directly (no Suspense) in the JSX. Found on-device
// (bb-ios27, Release): `<Suspense><RawRenderer/></Suspense>` inside
// `mediaStage` rendered NOTHING — no fallback, no content, silently — while
// a plain hardcoded View in the exact same JSX slot rendered correctly.
// Every OTHER lazy-loaded renderer below is used from the DOC branch's
// `previewArea`; isImage/isVideo (the only two pre-existing MEDIA branch
// categories) never use React.lazy/Suspense at all — RawRenderer would have
// been the first inside `mediaStage`. Given the isolated proof the plain
// JSX slot itself works fine, and this task's time budget not allowing
// root-causing Suspense-in-mediaStage further, the lower-risk fix matching
// the media branch's own existing precedent (isImage/isVideo: eager import,
// no lazy) is used instead.
import { RawRenderer } from '../components/preview/RawRenderer';
import { ZoomableImage } from '../components/preview/ZoomableImage';
import { PhotoPageVideo } from '../components/preview/PhotoPageVideo';
import { previewSurfaceIsDark, statusBarStyleFor } from '../lib/status-bar-style';

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
const AudioRenderer = React.lazy(async () => {
  const m = await import('../components/preview/AudioRenderer');
  return { default: m.AudioRenderer };
});
const MarkdownRenderer = React.lazy(async () => {
  const m = await import('../components/preview/MarkdownRenderer');
  return { default: m.MarkdownRenderer };
});
const TextEditorView = React.lazy(async () => {
  const m = await import('../components/preview/TextEditorView');
  return { default: m.TextEditorView };
});

// Preview's floating bottom bar sits at `Math.max(insets.bottom, 16) + 8` and
// its glass content is roughly 68pt tall. expo-video draws native controls
// inside the VideoView bounds, so the view itself needs this extra bottom
// clearance or the playhead lands behind Beebeeb's bottom chrome.
const PREVIEW_VIDEO_CONTROLS_BOTTOM_CLEARANCE = 84;

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

function mediaCacheExtension(mimeType: string | null | undefined, category: Category): string | null {
  const ext = extensionForMime(mimeType ?? undefined, category).replace(/^\./, '');
  return ext || null;
}

const CATEGORY_LABELS: Record<Category, string> = {
  image: 'Image',
  raw: 'RAW Image',
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
  raw: 'RAW',
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
  // Task 1570 — the remaining `code-text-preview.ts` extensions that need a
  // highlight.js grammar too (added in `CodeRenderer.tsx` alongside these).
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  // hljs's `ini` grammar covers TOML too (it registers `toml` as an alias
  // of the same grammar) — `languageDisplayLabel` below still shows "TOML"
  // vs "INI" per the real extension, same pattern as its existing xml/html
  // override.
  ini: 'ini', cfg: 'ini', toml: 'ini',
  dockerfile: 'dockerfile',
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
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  ini: 'INI',
  dockerfile: 'Dockerfile',
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
  // Task 1570 — hljs's `ini` grammar renders TOML too (registered as an
  // alias), but the two extensions should still show their own real name.
  if (hljsId === 'ini') {
    const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
    if (ext === 'toml') return 'TOML';
    return 'INI';
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
  streaming: boolean;
}

function emptyPreviewProgress(stage: PhotoLoadStage | null = null): PreviewProgressState {
  return {
    stage,
    bytesDownloaded: 0,
    bytesTotal: 0,
    chunksCompleted: 0,
    chunksTotal: 0,
    streaming: false,
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

/**
 * Task 1539 (finding 1, P0): thrown by `fetchAndDecrypt` when the current
 * file is locked and not yet authenticated this session. This is the single
 * choke point every single-file preview path (image/pdf/video/docx/
 * spreadsheet/html/zip/text/pptx/"view original") funnels through, so
 * guarding it here means none of those ~10 call sites can ever start a
 * download+decrypt for a locked file — not just hide the result behind an
 * overlay. Effects that see this error do not surface it as a load failure
 * (the dedicated lock-gate UI, not an error card, is what's shown); it is
 * recognized by name, matching the existing `AbortError` convention just
 * above.
 */
class PreviewLockedError extends Error {
  constructor() {
    super('This file is locked.');
    this.name = 'PreviewLockedError';
  }
}

function isPreviewLockedError(err: unknown): boolean {
  return err instanceof Error && err.name === 'PreviewLockedError';
}

function PreviewProgressStatus({
  color,
  // 1346 — textColor/trackColor are required, not defaulted: this component
  // has no useTheme() of its own (it takes its palette from the caller, same
  // as `color`), and both PreviewScreen call sites always sit on a ground
  // that's either forced dark (the media pager/stage) or scheme-following
  // (the doc branch's renderer Suspense fallbacks) — there is no safe
  // default that would be right for both, so the caller must decide.
  textColor,
  trackColor,
  isUnlocked,
  isVideo,
  progress,
  profile,
  sizeBytes,
}: {
  color: string;
  textColor: string;
  trackColor: string;
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
      <View style={[styles.previewProgressTrack, { backgroundColor: trackColor }]}>
        <View style={[styles.previewProgressFill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.imageStatusSub, { color: textColor }]}>
      {progressStageText(progress, isUnlocked, isVideo, sizeBytes, profile ?? null)}
      </Text>
    </View>
  );
}

function StreamingBufferBadge({ pct, bottomInset = 24 }: { pct: number; bottomInset?: number }) {
  return (
    <View style={[styles.streamBadgeLayer, { bottom: bottomInset }]} pointerEvents="none">
      <View style={styles.streamBadge}>
        <Text style={styles.streamBadgeText}>{pct}% buffered</Text>
      </View>
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
  if (progress.streaming) {
    const buffered = progress.chunksTotal > 0
      ? Math.round((progress.chunksCompleted / progress.chunksTotal) * 100)
      : 0;
    return `Streaming · ${buffered}% buffered`;
  }
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
    streaming: event.streaming ?? prev.streaming,
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
  // 1290 — when false, only the LOCAL rungs run (entry uri / native service / PhotoKit / cache);
  // the remote fetch tail is skipped. Used for offline-pinned files, which must never touch the
  // network for a preview.
  allowRemote: boolean = true,
): Promise<ThumbnailPreviewResult | null> {
  throwIfPreviewAborted(signal);
  if (entry.thumbnail_uri) {
    return {
      uri: entry.thumbnail_uri,
      kind: 'thumbnail',
      source: entry.local_asset_id ? 'photoKit' : 'cache',
    };
  }

  // 1290 — the native BeebeebThumbnails service fetches from the SERVER when it has no cached
  // copy (its result.source can be 'remote'), so for offline-pinned files (allowRemote=false)
  // this rung is skipped entirely: a pinned file must never touch the network for a preview.
  // The remaining rungs (PhotoKit asset, JS cache) are genuinely local; when they miss, the
  // caller falls through to decrypting the pinned local original instead.
  if (allowRemote) {
    const native = await loadNativeThumbnail(entry.id, NORMAL_PREVIEW_THUMB_SIZE, signal);
    if (native) return { ...native, kind: 'thumbnail' };
  }

  const localUri = entry.local_asset_id ? `ph://${entry.local_asset_id}` : null;
  if (localUri) {
    const local = await cacheLocalThumbnail(entry.id, localUri, entry.mime_type);
    throwIfPreviewAborted(signal);
    if (local) return { uri: local, kind: 'thumbnail', source: 'local' };
  }

  const cached = await getCachedThumbnail(entry.id, 'medium');
  throwIfPreviewAborted(signal);
  if (cached) return { uri: cached, kind: 'thumbnail', source: 'cache' };

  if (!allowRemote) return null;
  if (!isUnlocked) return null;
  try {
    const fileKey = await getFileKeyBytes(entry.id);
    // 1321 — was fetchDecryptedThumbnailUri, which throws unconditionally on
    // iOS since the BeebeebThumbnails migration. The catch below turned that
    // into a silently missing preview thumbnail.
    const remote = await fetchThumbnailUriOnce(entry.id, fileKey, { signal });
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
    // 1286 — set when an image had no server thumbnail and we auto-loaded the original.
    let autoOriginalFallback = false;

    if (!isVideo && !options.forceOriginal) {
      // 1290 (Guus) — an offline-pinned file must ALWAYS use what is on the device: local
      // thumbnail rungs are fine (PhotoKit asset, caches), but the network preview fetch is
      // skipped, and when no local thumbnail exists we fall straight through to the original
      // path below — decryptToTempFile prefers the pinned local copy (zero network).
      await offlineManager.init().catch(() => {});
      const pinnedLocal = offlineManager.isAvailable(entry.id);
      recordRuntimeTrace('preview.photo_page.pin_probe', {
        fileId: entry.id,
        pinnedLocal,
        status: offlineManager.getStatus(entry.id)?.state ?? 'none',
      });
      const normal = await loadNormalPreviewThumbnail(entry, isUnlocked, getFileKeyBytes, signal, !pinnedLocal);
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

      if (pinnedLocal) {
        recordRuntimeTrace('preview.photo_page.offline_first', { fileId: entry.id });
        autoOriginalFallback = false;
      } else if (!options.allowOriginal) {
        // 1013 — offline, nothing can be downloaded: tell the user the real reason and the
        // one action that fixes it (mirrors native-decrypt.ts:279).
        //
        // 1286 (Guus, 2026-08-29) — ONLINE, a missing thumbnail is no longer a dead end that
        // tells the user to press View Original themselves: we fall through and load the
        // original automatically (same progressive UI), and on success self-repair uploads
        // the missing thumbnail (0883) so the file is healed for every device. This changes
        // ONLY the no-thumbnail case — files with a thumbnail keep the cheap preview-only path.
        const net = await NetInfo.fetch().catch(() => null);
        const offline = net?.isConnected === false;
        recordRuntimeTrace('preview.photo_page.thumbnail.empty', {
          fileId: entry.id,
          profile: options.profile,
          offline,
          autoOriginal: !offline,
        });
        if (offline) {
          throw new Error(
            'Not available offline. Connect to the internet, or mark this file available offline first.',
          );
        }
        autoOriginalFallback = true;
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
      // Task 1593 round 2 (P2-F) — give the shared preview copy back instead of
      // deleting it: the full preview or "Prove it" may be using the same file.
      await releasePreviewCopy(entry.id, ext);
      recordRuntimeTrace('preview.photo_page.original.aborted_after_decrypt', { fileId: entry.id });
      throwIfPreviewAborted(signal);
    }
    if (isVideo && isLoopbackStreamUri(decryptedUri)) {
      return { uri: decryptedUri, kind: 'original' };
    }

    onStage?.('caching');
    const cachedUri = isVideo
      ? await cachePhotoWithExtension(entry.id, decryptedUri, cacheExt)
      : await cachePhoto(entry.id, decryptedUri);
    if (cachedUri !== decryptedUri) {
      await releasePreviewCopy(entry.id, ext); // task 1593 round 2 (P2-F)
    }
    throwIfPreviewAborted(signal);
    recordRuntimeTrace('preview.photo_page.original.success', {
      fileId: entry.id,
      category,
      cacheExt,
      elapsedMs: Date.now() - startedAt,
    });
    if (autoOriginalFallback) {
      // 1286 — the plaintext original is now in the preview cache and we have just PROVEN the
      // server thumbnail is missing (the thumbnail fetch above returned empty — no probing,
      // honoring 0883's no-storm contract). Generate + upload the thumbnail from these bytes so
      // the grid stops being blank everywhere. Fire-and-forget; never blocks or throws. Scoped
      // to the image auto-fallback only — video decrypt-completion regen stays untouched (1203).
      maybeSelfRepairThumbnailFromLocalFile({
        fileId: entry.id,
        localPlaintextUri: cachedUri,
        mimeType: entry.mime_type ?? 'image/jpeg',
        hasServerThumbnail: false,
        getFileKeyBytes,
      });
    }
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

/**
 * Task 1570 (Codex P2 follow-up, PR #126 review): decrypts a swipe-pager
 * entry's RAW source file to a per-session temp file, for `PhotoPage` to hand
 * to `RawRenderer` — the per-entry counterpart to the single-file `isRaw`
 * effect's `fetchAndDecrypt()` call, which is bound to the CURRENT file only
 * and can't be reused per swipe-pager entry. Deliberately NOT routed through
 * `loadDecryptedPhotoForViewer`'s thumbnail-first / persistent-photo-cache
 * logic above: `<Image>` can't decode camera RAW sensor data at all, so
 * there is no thumbnail rung to try, and RAW's own preview is extracted by
 * `RawRenderer`+`raw-extract.ts` from this decrypted SOURCE file, not cached
 * as a directly-displayable photo — matching the existing single-file `isRaw`
 * effect's own temp-file (not persistent-cache) pattern exactly, including
 * its caller-owns-cleanup contract (`PhotoPage`'s own cleanup effect, mirror
 * of `PreviewScreen`'s `tempRawUriRef`).
 */
async function loadDecryptedRawSourceForViewer(
  entry: PhotoPageEntry,
  getFileKeyBytes: FileKeyLoader,
  getMasterKeyHandleId: MasterKeyHandleLoader,
  onStage?: (stage: PhotoLoadStage) => void,
  onProgress?: (event: PreviewLoadProgressEvent) => void,
  signal?: AbortSignal,
): Promise<{ uri: string; kind: ImagePreviewKind }> {
  throwIfPreviewAborted(signal);
  const entryFileName = entry.display_name ?? entry.name_encrypted;
  const ext = extensionForRaw(entryFileName);
  onStage?.('downloading');
  onStage?.('decrypting');
  const decryptedUri = await decryptToTempFile(
    entry.id,
    () => getFileKeyBytes(entry.id),
    ext,
    entry.size_bytes,
    entry.chunk_count,
    getMasterKeyHandleId(),
    { onProgress, signal },
  );
  throwIfPreviewAborted(signal);
  return { uri: decryptedUri, kind: 'original' };
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

/**
 * Task 1687a — raw touch handlers for a pager page's locked-state wrapper.
 * Stopping propagation here (the same pattern ZoomableImage documents and
 * uses) keeps the pager FlatList's own onTouchStart/onTouchEnd tap detector
 * from ALSO seeing the tap and calling handleContentTap — two toggles would
 * cancel out and the tap would read as dead. The descendant Pressable is
 * unaffected: stopPropagation only ends bubbling ABOVE this wrapper.
 */
const stopPageTouchPropagation = (e: GestureResponderEvent) => {
  e.stopPropagation();
};

export const PhotoPage = React.memo(function PhotoPage({
  entry,
  shouldLoadFull,
  isCurrent,
  width,
  previewProfile,
  originalRequestNonce,
  locked,
  unlocking,
  onRequestUnlock,
  onExifInfo,
  onZoomChange,
  onSingleTap,
  videoControlsBottomInset,
}: {
  entry: PhotoPageEntry;
  shouldLoadFull: boolean;
  isCurrent: boolean;
  width: number;
  previewProfile: PerformanceStorageProfile;
  originalRequestNonce: number;
  /**
   * Task 1539 (finding 1, P0): true when this specific swipe-pager entry is
   * locked and not yet authenticated this session. This is the enforcement
   * point for "swipe to a locked neighbor bypasses the gate" — every effect
   * below that would start a thumbnail or full decrypt checks this FIRST,
   * per entry.id, independent of every other page in the pager.
   */
  locked: boolean;
  /** True while THIS entry's Face ID prompt is in flight (disables its own unlock control only). */
  unlocking: boolean;
  onRequestUnlock: (fileId: string) => void;
  /**
   * Task 1570 (Codex P2 follow-up, PR #126 review): bubbles a RAW entry's
   * parsed EXIF summary up to `PreviewScreen`'s Info sheet, same contract as
   * `RawRenderer`'s own `onExifInfo` prop, plus this page's file id.
   * Round 2: up to 3 RAW pages (current +-1) mount a `RawRenderer` at once.
   * Round 3: the parent stores EXIF KEYED BY FILE ID and the Info sheet reads
   * the entry for the CURRENT file, so a page simply reports its own EXIF when
   * it has it — the order in which a swiped-to page, the parent's effects and
   * the neighbours publish cannot matter (round 2 gated this on `isCurrent`
   * and re-published on becoming current; the parent's single-file RAW effect
   * then cleared it later in the same commit and the Info rows came up empty).
   */
  onExifInfo?: (fileId: string, info: RawExifInfo | null) => void;
  /** Task 1579 — the current page's image crossed 1x <-> zoomed (blocks paging). */
  onZoomChange?: (zoomed: boolean) => void;
  /** Task 1579 — a single tap on a zoomable page (chrome toggle); see ZoomableImage. */
  onSingleTap?: () => void;
  videoControlsBottomInset: number;
}) {
  const { colors: c } = useTheme();
  const { isUnlocked, getFileKeyBytes, getMasterKeyHandleId } = useCrypto();
  const isVideoEntry = !!entry.mime_type && entry.mime_type.startsWith('video/');
  // Task 1570 — RAW (CR2/CR3/ARW/NEF/RAF/DNG) joining the swipe pager (Codex
  // P2 follow-up, PR #126 review: `showPager` used to be `isImage || isVideo`
  // only, so opening a RAW file from a multi-item Photos `photoList` dropped
  // out of the pager into the single-file RAW branch, losing the ability to
  // swipe to adjacent photos). `entry.display_name` is already the decrypted
  // name (same fallback `currentFileName` uses below for the CURRENT entry).
  const entryFileName = entry.display_name ?? entry.name_encrypted;
  const isRawEntry = fileCategory(entry.mime_type ?? undefined, entryFileName) === 'raw';
  const [uri, setUri] = useState<string | null>(null);
  const [uriKind, setUriKind] = useState<ImagePreviewKind | null>(null);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<PhotoLoadStage | null>(null);
  const [progress, setProgress] = useState<PreviewProgressState>(() => emptyPreviewProgress('checking'));
  const [streamBufferPct, setStreamBufferPct] = useState<number | null>(null);
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
  // Task 1570 — this page's own decrypted RAW SOURCE temp file (distinct from
  // `RawRenderer`'s own extracted-preview temp file, which it cleans up
  // itself). Per-session temp file, not the persistent photo cache (see
  // `loadDecryptedRawSourceForViewer`'s doc comment) — cleaned up on unmount
  // below, mirroring `PreviewScreen`'s own `tempRawUriRef` for the single-file
  // case.
  const tempRawSourceUriRef = useRef<string | null>(null);
  // Task 1669 round 2 (ruling 3): true while this page's video is in Picture in Picture (set by
  // expo-video's VideoView `onPictureInPictureStart` / `Stop` via `PhotoPageVideo`). A player in
  // PiP must not be released just because its page stopped being current.
  const [pipActive, setPipActive] = useState(false);
  // Task 1669 round 3: up to 3 RAW pages (current +-1) run a `RawRenderer` at once. Each reports
  // its EXIF to the parent KEYED BY ITS OWN FILE ID (the Info sheet looks up the current file), so
  // there is no "who is current right now" gate and no re-publish effect to order against the
  // parent's. `RawRenderer`'s extraction effect captures its `onExifInfo` once (deps
  // [uri, cacheKey]), hence refs rather than closed-over props.
  const onExifInfoRef = useRef(onExifInfo);
  onExifInfoRef.current = onExifInfo;
  const entryIdRef = useRef(entry.id);
  entryIdRef.current = entry.id;
  const handleRawExif = useCallback((info: RawExifInfo | null) => {
    onExifInfoRef.current?.(entryIdRef.current, info);
  }, []);
  // Task 1669 round 2 (rulings 2 + 3): which resources this page wants loaded right now.
  //   - IMAGE / RAW: the full-resolution resource stays loaded for the current page +-1
  //     (`shouldLoadFull`, radius PHOTO_PAGE_LOAD_RADIUS = 1, at most 3 pages; matches the pager's
  //     windowSize=3) so a swipe back to a neighbour does not re-download/re-decrypt.
  //   - VIDEO: an AVPlayer (and the decrypted video file behind it) is bounded to the CURRENT page
  //     only (at most 1 live player).
  // `keepFull` additionally holds a video that is in Picture in Picture after its page stopped
  // being current; it is released when PiP ends.
  const loadFull = isVideoEntry ? shouldLoadFull && isCurrent : shouldLoadFull;
  const keepFull = loadFull || (isVideoEntry && pipActive);
  // Task 1669 Issue 1: NO `useVideoPlayer` here. expo-video builds a native
  // AVPlayer even for a null source, so calling it on every mounted page (image
  // pages included) held 10+ idle players. `PhotoPageVideo` owns the player and
  // is mounted only while a video page has a loaded `uri`.

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
    setStreamBufferPct(null);
    largePreviewAttemptRef.current = null;
    setPipActive(false);
    setOriginalUri(null);
    setOriginalActive(false);
    setOriginalCacheHit(false);
    setImageLoaded(false);
    sawOriginalProgressRef.current = false;
  }, [entry.id]);

  useEffect(() => {
    // Task 1539 (finding 1, P0): this effect used to run unconditionally for
    // EVERY page in the pager, including off-screen neighbors, and it seeds
    // `thumbnailUri` straight from `entry.thumbnail_uri` (handed over by
    // PhotosScreen) or a local cache — no `shouldLoadFull`/decrypt gate at
    // all. A locked neighbor's thumbnail would render the instant it entered
    // the pager's preload window, before the user even swiped to it.
    if (locked) return;
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
  }, [entry.id, locked]);

  useEffect(() => {
    if (!loadFull) return;
    // Task 1539 (finding 1, P0): the full-resolution/original decrypt path —
    // gates `loadDecryptedPhotoForViewer`, the same function the single-file
    // (non-swipe) effects above call directly.
    if (locked) return;
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

    // Task 1570 — RAW joining the pager: a RAW entry skips the thumbnail-
    // first/persistent-cache logic `loadDecryptedPhotoForViewer` uses for
    // images/video entirely (there is no thumbnail rung for `<Image>` to try
    // — it can't decode RAW sensor data) and goes straight to
    // `loadDecryptedRawSourceForViewer`'s plain decrypt-to-temp-file, same
    // shape (`{ uri, kind }`) so every `.then`/`.catch`/`.finally` handler
    // below stays shared between both branches.
    const loadPromise = isRawEntry
      ? loadDecryptedRawSourceForViewer(
          entry,
          getFileKeyBytes,
          getMasterKeyHandleId,
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
      : loadDecryptedPhotoForViewer(
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
            if (!cancelled) {
              applyNativeProgress(event, setProgress);
              const pct = streamBufferPctFromEvent(event);
              if (pct !== undefined) setStreamBufferPct(pct);
            }
          },
          controller.signal,
        );

    loadPromise
      .then((loaded) => {
        if (!cancelled) {
          recordRuntimeTrace('preview.photo_page.render_ready', {
            fileId: entry.id,
            isVideo: isVideoEntry,
            isRaw: isRawEntry,
            kind: loaded.kind,
          });
          if (isRawEntry) tempRawSourceUriRef.current = loaded.uri;
          setUri(loaded.uri);
          setUriKind(loaded.kind);
        }
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) {
          recordRuntimeTrace('preview.photo_page.load_failed', {
            fileId: entry.id,
            isVideo: isVideoEntry,
            isRaw: isRawEntry,
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
  }, [loadFull, uri, entry, isUnlocked, getFileKeyBytes, getMasterKeyHandleId, isVideoEntry, isRawEntry, previewProfile, locked]);

  // Task 1669 Issue 1 — release this page's fully-loaded resource (the
  // decrypted `uri`: a full-resolution decoded <Image>, a mounted
  // `PhotoPageVideo` and therefore its AVPlayer, or a RAW renderer) once the
  // page no longer wants it.
  //
  // Before this, `uri` was set once by the load effect above and NEVER
  // cleared when the page stopped being loaded. The page stays mounted
  // well past that point (the pager's `windowSize={3}`), so every page the
  // user had ever scrolled past kept its decoded image / live player: no
  // bound at all. Now (round 2 rulings): an image / RAW page holds its
  // resource while it is within current +-1 (at most 3 pages); a video page
  // holds its player only while it is the CURRENT page, or while that player
  // is in Picture in Picture (`keepFull`). In-flight loads need no handling
  // here: the load effect's cleanup aborts and `cancelled`-guards them when
  // `loadFull` flips.
  useEffect(() => {
    if (keepFull || uri === null) return;
    if (isVideoEntry) {
      void releasePreviewCopy(entry.id, extensionForMime(entry.mime_type ?? undefined, 'video')).catch(() => {});
    }
    if (isRawEntry) {
      void releasePreviewCopy(entry.id, extensionForRaw(entryFileName)).catch(() => {});
    }
    setUri(null);
    setUriKind(null);
    setOriginalUri(null);
    setOriginalActive(false);
    setOriginalCacheHit(false);
    setImageLoaded(false);
    sawOriginalProgressRef.current = false;
    // Per-load refs: a released page that is visited again must behave like a
    // fresh one. `largePreviewAttemptRef` records `${entry.id}:${uri}` of the
    // last large-preview upgrade attempt; left set, a revisit that reloads the
    // SAME thumbnail uri would be treated as "already attempted" and never
    // upgrade to the 'large' preview again.
    largePreviewAttemptRef.current = null;
    // A RAW page's decrypted SOURCE temp file is otherwise deleted only on
    // unmount; now that a page can reload after release, delete it here too or
    // each return to the page would orphan the previous one on disk.
    void cleanupTrackedTempFile(tempRawSourceUriRef, FileSystem.deleteAsync);
  }, [keepFull, uri, isVideoEntry, isRawEntry, entry.id, entry.mime_type, entryFileName]);

  // Release this page's own decrypted preview-cache leases on unmount — same
  // pattern as `PreviewScreen`'s single-file cleanup. `RawRenderer` owns
  // cleaning up its OWN separate extracted-preview temp file, not this source.
  useEffect(() => {
    return () => {
      if (isVideoEntry) {
        void releasePreviewCopy(entry.id, extensionForMime(entry.mime_type ?? undefined, 'video')).catch(() => {});
      }
      if (isRawEntry) {
        void releasePreviewCopy(entry.id, extensionForRaw(entryFileName)).catch(() => {});
      }
      void cleanupTrackedTempFile(tempRawSourceUriRef, FileSystem.deleteAsync);
    };
  }, [entry.id, entry.mime_type, entryFileName, isRawEntry, isVideoEntry]);

  useEffect(() => {
    if (!shouldLoadFull || !isCurrent) return;
    // Task 1539 (finding 1, P0): transitively protected too (`uri` only gets
    // set by the already-gated effect above), guarded explicitly for the
    // same defense-in-depth reasons as the single-file large-thumbnail
    // effect in the main component.
    if (locked) return;
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
  }, [entry, getFileKeyBytes, isCurrent, isUnlocked, isVideoEntry, previewProfile, shouldLoadFull, uri, uriKind, locked]);

  useEffect(() => {
    if (!originalRequestNonce || !isCurrent || isVideoEntry) return;
    // Task 1539 (finding 1, P0): defense-in-depth — the "View Original"
    // trigger this responds to only ever fires from within the already-
    // unlocked content UI, but gate it explicitly rather than rely on that.
    if (locked) return;
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
  }, [entry, getFileKeyBytes, getMasterKeyHandleId, isCurrent, isUnlocked, isVideoEntry, originalRequestNonce, previewProfile, uriKind, locked]);

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
  // Task 1570 — also skips RAW: `RawRenderer` manages its own internal
  // loading/ready/failed state (extraction, then its OWN `<Image>` load) and
  // never sets THIS component's `imageLoaded`, so without this exclusion the
  // watchdog would always fire for a RAW page and show "This image couldn't
  // be displayed" over a RawRenderer that is actually working fine.
  useEffect(() => {
    if (!uri || isVideoEntry || isRawEntry || imageLoaded || error) return;
    const t = setTimeout(() => {
      setError((prev) => prev ?? "This image couldn't be displayed.");
    }, IMAGE_RENDER_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [uri, isVideoEntry, isRawEntry, imageLoaded, error]);

  return (
    <View style={[styles.photoPage, { width }]}>
      {(() => {
        // Task 1687a — the page's tap decision per lock state (unit-tested
        // in preview-chrome.test.ts). Both locked branches wrap their
        // Pressable in a View that stops raw touch propagation, exactly the
        // pattern ZoomableImage uses: the pager FlatList's own
        // onTouchStart/onTouchEnd tap detector would otherwise ALSO see the
        // tap and call handleContentTap, toggling the chrome twice (net
        // no-op — the tap would read as dead again).
        const action = pagerTapAction({ fileLocked: locked, vaultLocked: !isUnlocked, contentOwned: false });
        if (action === 'unlock-file') {
          return (
            <View
              onTouchStart={stopPageTouchPropagation}
              onTouchEnd={stopPageTouchPropagation}
              onTouchCancel={stopPageTouchPropagation}
            >
              {/* Task 1539 (finding 1, P0): what a swipe onto a locked neighbor
                  shows now, instead of silently decrypting and displaying it. Every
                  effect that could populate `thumbnailUri`/`uri` is gated above,
                  so this is not just a visual cover-up over content that already
                  loaded — and (Codex P1 follow-up, PR #109 review) the render
                  branch below that WOULD show `uri`/`thumbnailUri`/`error` is now
                  also gated on `!locked`, so a value set by an in-flight load that
                  was already running before `locked` flipped true (e.g. the
                  startup window before `lockCheckReady`) can never surface
                  alongside or underneath this prompt either. */}
              <Pressable
                style={styles.photoPageStatus}
                onPress={() => onRequestUnlock(entry.id)}
                disabled={unlocking}
                accessibilityRole="button"
                accessibilityLabel="Locked file — tap to authenticate"
                testID="preview-locked-page"
              >
                <Ionicons name="lock-closed" size={32} color={colors.amber} />
                <Text style={styles.photoPageStatusTitle}>Locked</Text>
                <Text style={styles.photoPageStatusSub}>
                  {unlocking ? 'Authenticating...' : 'Tap to authenticate and view this file.'}
                </Text>
                {/* Task 1539 (finding 5, lead decision — PR #109 review): the lock
                    has no keychainAccessGroup, so it is not visible to the File
                    Provider extension — say so wherever there is room next to the
                    explainer, rather than let "Locked" imply full coverage. */}
                <Text style={styles.photoPageStatusSub}>{FILES_APP_LOCK_CAVEAT}</Text>
              </Pressable>
            </View>
          );
        }
        if (action === 'toggle-chrome' && !isUnlocked) {
          // Task 1687a — the VAULT-locked page (a different lock from the
          // per-file gate above; keep the two apart). This state previously
          // had NO dedicated render branch: the page fell through to the
          // content branch's plain status View, whose only tap path was the
          // pager's raw 10 pt / 500 ms detector — an imprecise or slow tap
          // landed nowhere, which is exactly the "sometimes doesn't respond
          // to touch, no menu top or bottom" report. A full-page Pressable
          // makes every tap register (chrome toggle via onSingleTap). The
          // card is informational only — NO auth step here; the vault
          // unlock flow is task 1684's, this lane is hit-testing only.
          return (
            <View
              onTouchStart={stopPageTouchPropagation}
              onTouchEnd={stopPageTouchPropagation}
              onTouchCancel={stopPageTouchPropagation}
            >
              <Pressable
                style={styles.photoPageStatus}
                onPress={onSingleTap}
                accessibilityRole="button"
                accessibilityLabel="Vault locked — tap to show or hide the menus"
                testID="preview-vault-locked-page"
              >
                <Ionicons name="lock-closed" size={32} color={colors.amber} />
                {/* 1346 — forced-dark text: every pager page sits on
                    mediaRoot's fixed near-black ground (see the mediaMaterial
                    comment in the main component), regardless of app scheme. */}
                <Text style={styles.photoPageStatusTitle}>Vault locked</Text>
                <Text style={styles.photoPageStatusSub}>
                  Unlock your vault to view this file.
                </Text>
                <Text style={styles.photoPageStatusSub}>Tap anywhere to show or hide the menus.</Text>
              </Pressable>
            </View>
          );
        }
        return (
          <>
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
                {isVideoEntry ? "Couldn't load video" : isRawEntry ? "Couldn't load RAW file" : "Couldn't load image"}
              </Text>
              <Text style={styles.photoPageStatusSub}>
                {error}
              </Text>
            </View>
          ) : uri && isVideoEntry ? (
            <View style={styles.mediaVideoStageWrap}>
              <PhotoPageVideo
                uri={uri}
                style={[styles.videoControlsSurface, { bottom: videoControlsBottomInset }]}
                onPictureInPictureStart={() => setPipActive(true)}
                onPictureInPictureStop={() => setPipActive(false)}
              />
              {isLoopbackStreamUri(uri) && streamBufferPct != null && streamBufferPct < 100 ? (
                <StreamingBufferBadge pct={streamBufferPct} />
              ) : null}
            </View>
          ) : uri && isRawEntry ? (
            // Task 1570 — RAW joining the pager. `RawRenderer` owns its own
            // loading/extraction/fallback states once handed this decrypted
            // SOURCE uri (mirrors the single-file `isRaw` branch exactly);
            // `error` above only ever covers the DECRYPT step failing.
            // Task 1579 — pinch/double-tap zoom; resets when paging away.
            <ZoomableImage
              style={StyleSheet.absoluteFill}
              resetSignal={isCurrent}
              onZoomChange={isCurrent ? onZoomChange : undefined}
              onSingleTap={onSingleTap}
              testID="preview-zoomable"
            >
              <RawRenderer
                uri={uri}
                fileName={entryFileName}
                formatLabel={rawFormatLabel(entryFileName, entry.mime_type)}
                cacheKey={entry.id}
                onExifInfo={handleRawExif}
              />
            </ZoomableImage>
          ) : uri ? (
            // Task 1579 — pinch/double-tap zoom; resets when paging away.
            <ZoomableImage
              style={StyleSheet.absoluteFill}
              resetSignal={isCurrent}
              onZoomChange={isCurrent ? onZoomChange : undefined}
              onSingleTap={onSingleTap}
              testID="preview-zoomable"
            >
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
            </ZoomableImage>
          ) : (
            <View style={styles.photoPageStatus}>
              {/* 1346 — textColor/trackColor forced dark: this pager page is
                  always inside mediaRoot's forced-dark ground (only reachable
                  from isMediaPreview), same argument as the mediaMaterial
                  comment above `if (isMediaPreview)` in the main component. */}
              {loading || loadFull ? (
                <PreviewProgressStatus
                  color={c.amber}
                  textColor={glassMaterial('dark').labelMuted}
                  trackColor="rgba(255,255,255,0.16)"
                  isUnlocked={isUnlocked}
                  isVideo={isVideoEntry}
                  progress={progress.stage ? progress : { ...progress, stage }}
                  profile={performanceProfile}
                  sizeBytes={entry.size_bytes}
                />
              ) : null}
            </View>
          )}
          </>
        );
      })()}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Top scrim (round 5 — "the clock stays legible when content scrolls
// beneath")
// ---------------------------------------------------------------------------

// TestFlight build 217 (iPhone, iOS 27): "the gradient at the top ... is not
// nice at all, it's blocky" — visible stepped grey bands behind the status
// bar over bright content (a white PDF/SVG page makes each band's edge a
// hard-contrast line). Root cause: 12 bands spread over up to 0.50 alpha is
// a ~0.05 jump per band in the steepest (0 → 0.55) segment — more than 6×
// `GlassSurface` Sheen's per-band delta (20 bands over ≤0.10 alpha, ~0.005)
// and over 2× `ScrollEdgeBlur`'s tint (14 bands over 0.30 alpha, ~0.021),
// both of which ship with no reported banding. 64 bands brings this scrim's
// worst-case per-band delta to ~0.012 — finer than `ScrollEdgeBlur`'s
// precedent and in the same imperceptible range as the Sheen. Plain `View`
// bands (no blur) is not a shortcut: the ground-truth canvas's `.topfade`
// (`design/preview-redesign-ios.html`) is itself a flat CSS
// `linear-gradient`, no `backdrop-filter` — the header's own glass pills
// (`GlassCapsule`/title pill), painted ON TOP of this scrim in the same
// wrapper, are what supplies the frosted-material texture; adding blur HERE
// would double it up and deviate from the canvas. So: same technique
// (`bandColors`, no new dependency, no dev-client rebuild), just enough
// resolution that the steps fall below the eye's threshold.
const PREVIEW_TOP_SCRIM_BANDS = 64;
// Dark/light scrim tracks the APP's resolved scheme, not the underlying
// document's colours — same reasoning `PREVIEW_CHROME_MATERIAL` already
// documents for the bars themselves: this backs the OS status bar (clock/
// battery/signal), which is itself always rendered in the app's own
// light/dark style, never adapting to page content.
const PREVIEW_TOP_SCRIM_STOPS_DARK: Stop[] = [
  { pos: 0, color: 'rgba(0,0,0,0.50)' },
  { pos: 0.55, color: 'rgba(0,0,0,0.18)' },
  { pos: 1, color: 'rgba(0,0,0,0)' },
];
const PREVIEW_TOP_SCRIM_STOPS_LIGHT: Stop[] = [
  { pos: 0, color: 'rgba(255,255,255,0.55)' },
  { pos: 0.55, color: 'rgba(255,255,255,0.20)' },
  { pos: 1, color: 'rgba(255,255,255,0)' },
];

/**
 * A plain top-to-bottom gradient needs none of `GlassSurface`'s Sheen
 * geometry (that machinery exists for an ANGLED sweep over an arbitrary
 * aspect ratio) — this is a vertical stack of `bandColors` bands, same
 * technique (no `expo-linear-gradient` — see `gradient.ts`'s own doc
 * comment), simpler case: no rotation, no measured width, just height.
 *
 * No `BlurView` either — see `PREVIEW_TOP_SCRIM_BANDS`'s doc comment: the
 * canvas's `.topfade` this backs is itself unblurred, and the header content
 * painted on top of this component already carries its own glass.
 */
function PreviewTopScrim({ height, dark }: { height: number; dark: boolean }) {
  const bands = useMemo(
    () => bandColors(dark ? PREVIEW_TOP_SCRIM_STOPS_DARK : PREVIEW_TOP_SCRIM_STOPS_LIGHT, PREVIEW_TOP_SCRIM_BANDS),
    [dark],
  );
  if (height <= 0) return null;
  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height }}
      pointerEvents="none"
      testID="preview-top-scrim"
    >
      {bands.map((color, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: color }} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PreviewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<PreviewRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { showToast } = useToast();
  const previewVideoControlsBottomInset = useMemo(
    () => Math.max(insets.bottom, 16) + PREVIEW_VIDEO_CONTROLS_BOTTOM_CLEARANCE,
    [insets.bottom],
  );
  const videoControlsBottomStyle = useMemo(
    () => ({ bottom: previewVideoControlsBottomInset }),
    [previewVideoControlsBottomInset],
  );
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
    startInEditMode,
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
  // Preview redesign item 3 — tap-to-hide on the swipe pager, WITHOUT a
  // wrapping `Pressable` ancestor. Verified on-device (bisected): a
  // `Pressable` wrapping this FlatList reliably swallowed every swipe (the
  // pager never advanced past page 1, confirmed with a fresh screenshot per
  // attempt) even though it never fires `onPress` on a real drag — RN's
  // responder negotiation did NOT let the paging ScrollView win the
  // horizontal pan here, for whatever Fabric/UIKit-version reason. Reverted
  // to a plain `View` wrapper and instrument the FlatList's own raw touch
  // events instead: `onTouchStart`/`onTouchEnd` fire on this view
  // regardless of who ends up owning the gesture, so a short, low-movement
  // touch (a tap) can be told apart from a real swipe without adding a
  // second responder to race the FlatList's own.
  const pagerTouchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const activePhotoPageIndexes = useMemo(
    () => activePhotoPageIndices(currentPhotoIndex, photoList.length, PHOTO_PAGE_LOAD_RADIUS),
    [currentPhotoIndex, photoList.length],
  );

  // Derive the current photo entry from the swipe index
  const currentEntry = photoList.length > 0 ? photoList[currentPhotoIndex] : null;
  const currentFileId = currentEntry?.id ?? fileId;
  const currentFileName = currentEntry?.display_name ?? currentEntry?.name_encrypted ?? fileName;
  const currentMimeType = currentEntry?.mime_type ?? mimeType;
  const currentSizeBytes = currentEntry?.size_bytes ?? sizeBytes;
  // Task 1592 item 5 — the size SHOWN (header pill, Info sheet, detail rows,
  // share sheet) follows an in-app save; `currentSizeBytes` (the decrypt
  // input) is left alone so a save never re-triggers the loaders.
  const [savedMeta, setSavedMeta] = useState<SavedFileMeta | null>(null);
  const shownSizeBytes = displayedSizeBytes(currentFileId, currentSizeBytes, savedMeta);
  const currentCreatedAt = currentEntry?.created_at ?? createdAt;
  const currentChunkCount = currentEntry?.chunk_count ?? chunkCount;
  const currentVersionNumber = currentEntry?.version_number ?? versionNumber;
  const currentStoragePoolId = currentEntry?.storage_pool_id ?? storagePoolId;

  // ---------------------------------------------------------------------
  // Task 1539 (finding 1, P0): "Lock file" enforcement.
  //
  // Before this, PreviewScreen never checked `isFileLocked` at all — the
  // ONLY gate anywhere in the app was FilesScreen's tap handler, so opening
  // a locked file via the Photos tab, or swiping to a locked neighbor in
  // THIS pager, decrypted and displayed it with no Face ID prompt. This is
  // the enforcement point the fix hint asks for: PreviewScreen owns the
  // check itself, on mount AND on every pager index change (re-evaluated
  // below via `isPagerPageGated(currentFileId, ...)`, which recomputes on
  // every render including a `currentPhotoIndex` change from a swipe).
  //
  // `lockedFileIds` is checked ONCE for the whole bounded id set this
  // screen instance can ever show (`fileId` + every id in `photoList` — the
  // same bounded swipe window PhotosScreen/FilesScreen already hand over),
  // not per-swipe, so paging doesn't re-hit SecureStore on every frame.
  // `authenticatedFileIds` tracks which of those the user has already
  // proven Face ID for THIS screen session, so re-visiting an unlocked
  // (this session) file by swiping back doesn't re-prompt every time —
  // each NEW locked id, e.g. a different locked neighbor, still gates
  // independently (verified directly by preview-lock-gate.test.ts's
  // "swiping to a DIFFERENT locked neighbor re-gates" case).
  const lockCandidateIds = useMemo(() => {
    const ids = photoList.length > 0 ? photoList.map((p) => p.id) : [fileId];
    return Array.from(new Set(ids));
  }, [photoList, fileId]);
  const [lockedFileIds, setLockedFileIds] = useState<Set<string>>(new Set());
  const [lockCheckReady, setLockCheckReady] = useState(false);
  const [authenticatedFileIds, setAuthenticatedFileIds] = useState<Set<string>>(new Set());
  const [unlockingFileId, setUnlockingFileId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLockCheckReady(false);
    checkLockedFileIds(lockCandidateIds)
      .then((locked) => {
        if (cancelled) return;
        setLockedFileIds(locked);
        setLockCheckReady(true);
      })
      .catch(() => {
        // Fail closed: an unreadable lock store must not be treated as
        // "nothing is locked". Every candidate id gates until the user
        // authenticates, same as file-locks.ts's own isFileLocked() would
        // report for a store it can't read.
        if (cancelled) return;
        setLockedFileIds(new Set(lockCandidateIds));
        setLockCheckReady(true);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lockCandidateIds is a bounded, mount-stable list (photoList/fileId don't change after route params are set).
  }, []);

  // Gates the CURRENT file — recomputed every render, so a pager swipe
  // (currentPhotoIndex -> currentFileId change) re-evaluates it fresh.
  // Before the initial SecureStore read resolves, fail closed rather than
  // let a decrypt start while lock status is still unknown (isPagerPageGated
  // — Codex P1 follow-up, PR #109 review — encodes this same "not ready yet
  // ⇒ gated" rule the swipe-pager's per-page gate below also needs).
  const contentLocked = isPagerPageGated(currentFileId, lockedFileIds, authenticatedFileIds, lockCheckReady);

  const handleUnlockCurrent = useCallback(async (targetFileId: string) => {
    setUnlockingFileId(targetFileId);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to open this file',
        disableDeviceFallback: true,
      });
      if (result.success) {
        setAuthenticatedFileIds((prev) => {
          const next = new Set(prev);
          next.add(targetFileId);
          return next;
        });
      }
    } finally {
      setUnlockingFileId(null);
    }
  }, []);
  // ---------------------------------------------------------------------

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
  // Task 1592 item 3 — "Try again" on a failed load bumps this; it is a
  // dependency of `fetchAndDecrypt` (so every loader effect built on it
  // re-runs) and of the image / PDF loaders, which do not use it.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Task 1563 — text/markdown/code EDIT mode state. `savedVersionNumber`/
  // `savedAt` override the route-provided version once a save succeeds (this
  // screen never re-fetches route params), and `fileMeta` carries the fields
  // a save needs that route.params never had (the file's CURRENT encrypted
  // name — reused byte-for-byte, never re-derived — and its parent folder,
  // needed only for "Keep both"). Fetched lazily on first entry into edit
  // mode, not on every keystroke or every save.
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedVersionNumber, setSavedVersionNumber] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [fileMeta, setFileMeta] = useState<{ nameEncrypted: string; parentId: string | null; versionNumber: number } | null>(null);
  const [fileMetaError, setFileMetaError] = useState<string | null>(null);
  const [loadingFileMeta, setLoadingFileMeta] = useState(false);
  const [conflict, setConflict] = useState<{ freshVersionNumber: number } | null>(null);

  // Video inline preview state — `videoUri` is the on-disk decrypted file
  // that the VideoView plays from; cleaned up on unmount / when changed.
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [streamBufferPct, setStreamBufferPct] = useState<number | null>(null);
  const tempVideoUriRef = useRef<string | null>(null);

  // Task 1568 — audio inline preview state, same shape as video's above:
  // `audioUri` is the on-disk decrypted file AudioRenderer plays from,
  // tracked in a ref so the unmount cleanup effect (below) always sees the
  // latest value without re-subscribing, and deleted on unmount / when the
  // previewed file changes.
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const tempAudioUriRef = useRef<string | null>(null);

  // Task 1569 — RAW inline preview state, same shape as video/audio's
  // above: `rawUri` is the on-disk DECRYPTED SOURCE raw file (RawRenderer
  // reads it and writes its OWN separate extracted-preview temp file,
  // which it cleans up itself — see RawRenderer.tsx). `rawExifInfo` is
  // bubbled up from RawRenderer's extraction for the Info sheet's extra
  // rows (Camera/Lens/ISO/Shutter/Aperture/Focal length).
  const [rawUri, setRawUri] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  // Task 1669 round 3: EXIF is stored KEYED BY FILE ID and the Info sheet reads the entry for the
  // CURRENT file. The round-2 single `rawExifInfo` slot was cleared by the single-file RAW effect
  // below in the same commit in which a preloaded neighbour re-published it, so the order of two
  // effects decided whether the Info sheet had any EXIF rows.
  const [rawExifById, setRawExifById] = useState<Record<string, RawExifInfo | null>>({});
  const publishRawExif = useCallback((forFileId: string, info: RawExifInfo | null) => {
    setRawExifById((prev) => (prev[forFileId] === info ? prev : { ...prev, [forFileId]: info }));
  }, []);
  const rawExifInfo = rawExifById[currentFileId] ?? null;
  const tempRawUriRef = useRef<string | null>(null);

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

  const { isUnlocked, getFileKeyBytes, getMasterKeyHandleId, getRequestContentKey, encryptChunk, encryptMetadata, decryptMetadata } = useCrypto();

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
  // Task 1569 — RAW (CR2/CR3/ARW/NEF/RAF/DNG) joins the MEDIA branch, same
  // full-bleed black stage as photos ("images/RAW on black" — see the
  // isImage render branch's own comment, which already anticipated this).
  // Unlike audio, a RAW file's content IS a photo once extracted, so it
  // belongs on the same visual frame as isImage, not the doc branch's
  // themed card.
  const isRaw = category === 'raw';
  const isSvg = category === 'svg';
  const isPdf = category === 'pdf';
  const isVideo = !!currentMimeType && currentMimeType.startsWith('video/');
  const isArchive = category === 'archive';
  const isPptx = category === 'pptx';
  // Task 1568 — audio gets its own doc-branch render (native player), not
  // the media (isImage||isVideo) branch: it has no visual frame of its own
  // to bleed edge-to-edge, so it belongs with the doc-root's themed
  // header/background, same class of decision as PDF/DOCX/etc.
  const isAudio = category === 'audio';
  const isMediaPreview = isImage || isVideo || isRaw;
  // "Canon RAW" / "Sony RAW" / … — the manufacturer-specific override for
  // CATEGORY_LABELS['raw'] wherever the title pill / Info sheet shows the
  // file's kind, same override pattern as isText's codeLanguageLabel.
  const rawFormatLabelValue = useMemo(
    () => rawFormatLabel(currentFileName, currentMimeType),
    [currentFileName, currentMimeType],
  );

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
  // Task 1570 — `isTextPreview` also accepts any mime_type that isn't
  // CONFIDENTLY something else (image/video/audio/pdf/zip/archive/office)
  // on a known text/code extension (py/go/rs/ts/tsx/js/jsx/java/kt/swift/c/
  // cpp/h/cs/rb/php/sh/sql/css/toml/ini/Dockerfile/…), not just a confident
  // text/json/xml mime_type — see that module's doc comment for why the
  // fallback lives here (preview time, not only the upload path) and for
  // the real `sample.sql` bug a narrower "only when mime is generic" gate
  // missed (a non-generic-but-still-not-text guess this app's own upstream
  // mime lookup can produce).
  const isText =
    !isDocx &&
    !isSpreadsheet &&
    !isSvg &&
    !isHtml &&
    !isZip &&
    !isArchive &&
    !isPptx &&
    isTextPreview(currentMimeType, currentFileName);
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

  // Task 1568 — the format chip AudioRenderer shows must match the REAL
  // extension the decrypted temp file was written with (`extensionForAudio`,
  // same function `fetchAndDecrypt` uses for the `ext` it hands
  // `decryptToTempFile` — see that call site), not just whatever extension
  // happens to be on the ORIGINAL filename (`fileFormat` above) — the two
  // only diverge in the rare case where the OS-reported mime disagrees with
  // the filename, but when they do, this is the one that's actually true of
  // the bytes being played.
  const audioFormatLabel = useMemo(
    () => extensionForAudio(currentMimeType, currentFileName).replace(/^\./, '').toUpperCase(),
    [currentMimeType, currentFileName],
  );

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
  const isMarkdown = isText && codeLanguage === 'markdown';

  // ---------------------------------------------------------------------
  // Preview redesign (task 1563 follow-up, `design/preview-redesign-ios.html`,
  // approved 2026-09-26 21:00 — "Love the redesign! Go with it. It feels
  // like notion, thats perfect"). Full-bleed content under glass bars that
  // tap to hide, an on-demand Info sheet instead of a permanent Details
  // bar, and a floating page counter. See `lib/preview-chrome.ts` for the
  // pure logic these read.
  // ---------------------------------------------------------------------
  const [barsVisible, setBarsVisible] = useState(true);
  // Task 1579 — true while the current image is pinch/double-tap zoomed:
  // the pager stops paging and the header's swipe-down-to-close is off, so
  // a drag pans the zoomed image instead. Reset on every page change.
  const [mediaZoomed, setMediaZoomed] = useState(false);
  useEffect(() => {
    setMediaZoomed(false);
  }, [currentPhotoIndex, currentFileId]);
  const [infoVisible, setInfoVisible] = useState(false);
  // Task 1583 — the bottom bar's "Versions" opens the sheet AT the Versions
  // section, "Info" at the top: one home for versions (the sheet's own
  // section), two doors into it.
  const [infoFocus, setInfoFocus] = useState<InfoSheetFocus>('info');
  const openInfo = useCallback((focus: InfoSheetFocus) => {
    setInfoFocus(focus);
    setInfoVisible(true);
  }, []);
  // A .md file's ⋯ menu can show the RAW source without entering Edit
  // (design section 02, "Show source" — Guus's 18:50 ruling put Edit in
  // this same menu; this is the sibling read-only view it also asked for).
  const [showSource, setShowSource] = useState(false);
  // Task 1591 bug 1 — the status bar's content style follows the surface it
  // sits on (media stage / code + editor surfaces are dark in BOTH themes),
  // not only the app theme the root <StatusBar> in App.tsx uses. See
  // src/lib/status-bar-style.ts.
  const surfaceIsDark = previewSurfaceIsDark({
    isMediaPreview,
    isText,
    editMode,
    textLoaded: textContent != null,
    isMarkdown,
    showSource,
    appScheme: resolved === 'dark' ? 'dark' : 'light',
  });
  const statusBarStyle = statusBarStyleFor(surfaceIsDark);
  const [pdfPageInfo, setPdfPageInfo] = useState<{ current: number; total: number } | null>(null);
  const barsOpacity = useRef(new Animated.Value(1)).current;

  // Round 5 (lead review of round 4's own screenshots): round 4 fixed the
  // "opaque dark band" bug by making `previewArea` a full-screen absolute
  // layer, but overcorrected — with NO inset, a document's first line now
  // sits UNDER the floating top bar (PDF title colliding with the clock,
  // DOCX's first two lines hidden behind the title pill). Required
  // behaviour (Photos/Files/Notion): at rest, content starts just BELOW the
  // floating bar; scrolling moves content UNDER the translucent bar. See
  // `computePreviewContentInset`'s own doc comment for the full reasoning.
  //
  // `docHeaderHeight`/`docBottomBarHeight` are the REAL, on-screen measured
  // heights of the doc branch's own floating chrome (via `onLayout` at each
  // JSX call site below) — not eyeballed constants, per this workspace's
  // "measured, not eyeballed" rule. `null` until the first layout pass
  // fires; `computePreviewContentInset` has a documented, derived fallback
  // for that one frame so content never flashes at y=0.
  const [docHeaderHeight, setDocHeaderHeight] = useState<number | null>(null);
  const [docBottomBarHeight, setDocBottomBarHeight] = useState<number | null>(null);
  // The ">2MB / lossy-decode" read-only notice (`readOnlyBanner` below) is
  // its OWN floating absolute overlay, above the code/markdown content, so
  // when it's showing, the SCROLLABLE content needs an extra top offset
  // equal to the banner's own real height too — otherwise the banner just
  // moves the collision from "under the header" to "under the banner".
  const [readOnlyBannerHeight, setReadOnlyBannerHeight] = useState<number | null>(null);
  const docContentInset = useMemo(
    () =>
      computePreviewContentInset({
        safeAreaTop: insets.top,
        safeAreaBottom: insets.bottom,
        headerHeight: docHeaderHeight,
        bottomBarHeight: docBottomBarHeight,
      }),
    [insets.top, insets.bottom, docHeaderHeight, docBottomBarHeight],
  );

  const handleContentTap = useCallback(() => {
    setBarsVisible((prev) => nextBarsVisible(prev, { editMode, infoVisible, optionsVisible }));
  }, [editMode, infoVisible, optionsVisible]);

  // Bars are always fully visible while editing (there's no bottom bar to
  // hide, and the top bar becomes the Done/Save row — item 7) regardless of
  // the last `barsVisible` value from before Edit was entered.
  const chromeVisible = editMode || barsVisible;
  useEffect(() => {
    Animated.timing(barsOpacity, {
      toValue: chromeVisible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [chromeVisible, barsOpacity]);

  // One floating "N / total" pill, reused for a multi-page PDF and for the
  // photo swipe-pager's position — see `formatPdfPageCounter`'s doc comment.
  const pageCounterLabel = isPdf
    ? (pdfPageInfo ? formatPdfPageCounter(pdfPageInfo.current, pdfPageInfo.total) : null)
    // Task 1570 — isRaw added: RAW now joins the swipe pager (see
    // `showPager` below), so the "N / total" pill must show for a RAW page
    // too, not just vanish for the one category that just gained paging.
    : (hasSwipe && (isImage || isVideo || isRaw) ? formatPdfPageCounter(currentPhotoIndex + 1, photoList.length) : null);

  // ---------------------------------------------------------------------
  // Task 1563 — markdown preview + native text/code editor.
  // ---------------------------------------------------------------------

  const effectiveVersionNumber = savedVersionNumber ?? currentVersionNumber ?? 1;

  const editGate = useMemo(
    () => evaluateTextEditGate({
      sizeBytes: currentSizeBytes,
      decodedText: textContent,
      decodeFailed: !!textError,
    }),
    [currentSizeBytes, textContent, textError],
  );
  const canEditText = isText && editGate.editable;

  const isDirty = editMode && editText != null && editText !== (textContent ?? '');

  const statusLine = useMemo(() => {
    if (!savedAt) return null;
    const hh = savedAt.getHours().toString().padStart(2, '0');
    const mm = savedAt.getMinutes().toString().padStart(2, '0');
    return `Encrypted · version ${effectiveVersionNumber} · ${hh}:${mm}`;
  }, [savedAt, effectiveVersionNumber]);

  // Lazily fetch the fields a save needs that route.params never carried
  // (the file's CURRENT encrypted name — reused byte-for-byte — and its
  // parent id, needed only for "Keep both"). Runs once per preview open,
  // the first time the user actually enters edit mode; re-run after a
  // conflict is resolved so the next attempt starts from the true current
  // state.
  const loadFileMeta = useCallback(async (): Promise<{ nameEncrypted: string; parentId: string | null; versionNumber: number } | null> => {
    setLoadingFileMeta(true);
    setFileMetaError(null);
    try {
      // Task 1563 (found while verifying the conflict flow, evidence pasted
      // in the task Notes): `GET /api/v1/files/:id` never selects
      // `version_number` server-side, so `fresh.version_number` is always
      // `undefined` — using it (with a stale-state fallback) silently fed a
      // WRONG "current version" into a real conflict retry. `/versions`'s
      // `current_version` is the reliable source (see `getFileCurrentVersion`'s
      // doc comment) — an existing endpoint, not a new one.
      const [fresh, currentVersion] = await Promise.all([
        getFile(currentFileId),
        getFileCurrentVersion(currentFileId),
      ]);
      const meta = {
        nameEncrypted: fresh.name_encrypted,
        parentId: fresh.parent_id ?? null,
        versionNumber: currentVersion,
      };
      setFileMeta(meta);
      return meta;
    } catch (err) {
      setFileMetaError(friendlyError(err));
      return null;
    } finally {
      setLoadingFileMeta(false);
    }
  }, [currentFileId]);

  const handleEnterEditMode = useCallback(() => {
    if (!canEditText || textContent == null) return;
    setEditText(textContent);
    setEditMode(true);
    setOptionsVisible(false);
    if (!fileMeta) void loadFileMeta();
  }, [canEditText, textContent, fileMeta, loadFileMeta]);

  // Task 1587 — a file just created from the Files "+" menu opens straight in
  // the editor. Fires once, after the (empty) text has loaded and the normal
  // edit gate agrees; never re-enters after the user leaves edit mode.
  const autoEditConsumedRef = useRef(false);
  useEffect(() => {
    if (!startInEditMode || autoEditConsumedRef.current) return;
    if (!canEditText || textContent == null) return;
    autoEditConsumedRef.current = true;
    handleEnterEditMode();
  }, [startInEditMode, canEditText, textContent, handleEnterEditMode]);

  const handleExitEditMode = useCallback(() => {
    if (isDirty) {
      Alert.alert(
        'Discard unsaved changes?',
        'Your edits since the last save will be lost.',
        [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              setEditMode(false);
              setEditText(null);
              setOptionsVisible(false);
            },
          },
        ],
      );
      return;
    }
    setEditMode(false);
    setOptionsVisible(false);
  }, [isDirty]);

  // Task 1563 — the post-success state update shared by every save path.
  const applySavedVersion = useCallback(async (opts: {
    text: string;
    targetFileId: string;
    nameEncrypted: string;
    parentId: string | null;
    versionNumber: number;
  }) => {
    // Task 1563 — `decryptToTempFile`'s preview cache is keyed by fileId +
    // extension only, with no version awareness (every caller before this
    // one only ever produced a NEW plaintext for a fileId the cache had
    // never seen). A version-replace writes NEW bytes behind an
    // ALREADY-cached fileId, so without this, reopening the file in the
    // same session served the stale pre-edit content — confirmed
    // on-device (bb-ios27): server size_bytes updated, cached preview
    // did not. `extensionForMime(..., 'doc')` matches exactly what the
    // isText read-view's own `fetchAndDecrypt` call caches under.
    await invalidatePreviewCache(opts.targetFileId, extensionForMime(currentMimeType, category).replace(/^\./, ''));
    setSavedVersionNumber(opts.versionNumber);
    setSavedAt(new Date());
    setTextContent(opts.text);
    setEditText(opts.text);
    setFileMeta({ nameEncrypted: opts.nameEncrypted, parentId: opts.parentId, versionNumber: opts.versionNumber });
    // Task 1592 item 5 — refresh the saved file's size (best effort; the
    // saved text's byte length when the read fails).
    const fresh = await getFile(opts.targetFileId).catch(() => null);
    setSavedMeta(savedFileMetaFrom(opts.targetFileId, opts.text, fresh));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [currentMimeType, category]);

  const showSaveFailed = useCallback((message: string) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    Alert.alert('Save failed', message);
  }, []);

  // Task 1578 — one synchronous gate for every save path. React's `saving`
  // is read from a render closure, so two taps before the re-render both
  // passed the old `if (saving) return` guard and raced two uploads of the
  // same file; the loser got "upload already in progress" (a 409), which
  // was shown as "a newer version was saved on another device".
  const saveGateRef = useRef(createSingleFlight());

  /**
   * Task 1578 — the file is marked as uploading ("upload is already in
   * progress"). The server cannot say whose upload that is — an orphan from
   * an interrupted save looks exactly like another device's live save — so
   * it is never cleared silently: only the user knows whether they are
   * saving it somewhere else. Resolves false on Cancel or when the alert is dismissed.
   */
  const confirmClearInFlightUpload = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        Alert.alert(
          'This file is still marked as uploading',
          'An earlier save did not finish, or another device is saving this file right now. If you are not saving it somewhere else, you can clear it and save.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Clear and save', style: 'destructive', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      }),
    [],
  );

  /**
   * Task 1578 — save `text` as a new version of THIS file via `runTextSave`
   * (see `text-save-flow.ts`): a file still marked as uploading asks the user
   * before clearing it (never reported as another device's change); a REAL stale-version conflict opens the
   * conflict dialog, as before.
   */
  const saveAsNewVersion = useCallback(async (opts: {
    text: string;
    meta: { nameEncrypted: string; parentId: string | null; versionNumber: number };
  }): Promise<void> => {
    const { text, meta } = opts;
    const result = await runTextSaveConfirmingClear(
      {
        save: async (baseVersionNumber) => {
          const updated = await saveTextFileVersion({
            fileId: currentFileId,
            nameEncrypted: meta.nameEncrypted,
            parentId: meta.parentId ?? undefined,
            text,
            encryptChunkFn: encryptChunk,
            versionReplace: { baseVersionNumber },
          });
          return updated.version_number ?? baseVersionNumber + 1;
        },
        uploadStarted: saveFailedAfterUploadStarted,
        abandon: () => abandonTextFileUpload(currentFileId),
        // Codex P2 (PR #134): after a real conflict, refresh name + parent +
        // version (loadFileMeta sets fileMeta), so a later Save cannot revert
        // a rename or move made by the conflicting save.
        readCurrentVersion: () => refreshMetaForConflict(loadFileMeta),
      },
      { baseVersionNumber: meta.versionNumber },
      confirmClearInFlightUpload,
    );
    switch (result.kind) {
      case 'saved':
        await applySavedVersion({
          text,
          targetFileId: currentFileId,
          nameEncrypted: meta.nameEncrypted,
          parentId: meta.parentId,
          versionNumber: result.versionNumber,
        });
        return;
      case 'conflict':
        // fileMeta was already replaced by the fresh copy in readCurrentVersion.
        setConflict({ freshVersionNumber: result.freshVersionNumber });
        return;
      case 'cancelled':
      case 'needs-confirmation':
        // The user chose not to clear the in-flight upload. Their edit stays
        // in the editor; nothing was abandoned.
        return;
      case 'busy':
        showSaveFailed('An earlier save of this file is still finishing. Try again in a moment.');
        return;
      case 'error':
        showSaveFailed(friendlyError(result.error));
        return;
    }
  }, [currentFileId, encryptChunk, applySavedVersion, showSaveFailed, confirmClearInFlightUpload, loadFileMeta]);

  const handleSaveEdit = useCallback(async () => {
    if (editText == null) return;
    const text = editText;
    await saveGateRef.current.run(async () => {
      setSaving(true);
      try {
        let meta = fileMeta;
        if (!meta) meta = await loadFileMeta();
        if (!meta) {
          showSaveFailed(fileMetaError ?? 'Could not read the file before saving.');
          return;
        }
        await saveAsNewVersion({ text, meta });
      } finally {
        setSaving(false);
      }
    });
  }, [editText, fileMeta, loadFileMeta, fileMetaError, saveAsNewVersion, showSaveFailed]);

  const handleConflictChoice = useCallback(async (choice: 'keep-both' | 'new-version' | 'discard' | 'cancel') => {
    setConflict(null);
    if (choice === 'cancel' || editText == null) return;
    if (choice === 'discard') {
      setEditMode(false);
      setEditText(null);
      return;
    }
    const text = editText;
    await saveGateRef.current.run(async () => {
      setSaving(true);
      try {
        const refreshed = await loadFileMeta();
        if (!refreshed) {
          showSaveFailed(fileMetaError ?? 'Could not read the file before saving.');
          return;
        }
        if (choice === 'new-version') {
          await saveAsNewVersion({ text, meta: refreshed });
          return;
        }
        // Keep both — a brand-new file, same folder, suffixed name. Never
        // touches the OTHER device's version at all.
        const newFileId = await generateFileId();
        const keptName = buildKeepBothName(previewFileName, 'iPhone');
        const metadataPlain = fileMetadataPlaintext(keptName, currentMimeType ?? null, null);
        const encName = await encryptMetadata(newFileId, metadataPlain);
        const nameEncrypted = encryptedMetadataToJson(encName);
        try {
          await saveTextFileVersion({
            fileId: newFileId,
            nameEncrypted,
            parentId: refreshed.parentId ?? undefined,
            text,
            encryptChunkFn: encryptChunk,
          });
          // The edited text now lives in the NEW file and THIS file is
          // unchanged, so leave the editor showing this file as it is.
          setEditMode(false);
          setEditText(null);
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          showToast({ type: 'success', message: `Saved as "${keptName}"` });
        } catch (err) {
          showSaveFailed(friendlyError(err));
        }
      } finally {
        setSaving(false);
      }
    });
  }, [editText, loadFileMeta, fileMetaError, saveAsNewVersion, previewFileName, currentMimeType, encryptMetadata, encryptChunk, showToast, showSaveFailed]);

  const showConflictDialog = useCallback(() => {
    if (!conflict) return;
    Alert.alert(
      'A newer version was saved on another device',
      `Version ${conflict.freshVersionNumber} exists on the server. Your changes are still here — choose what happens next.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => { void handleConflictChoice('cancel'); } },
        { text: 'Discard my changes', style: 'destructive', onPress: () => { void handleConflictChoice('discard'); } },
        { text: 'Keep both', onPress: () => { void handleConflictChoice('keep-both'); } },
        { text: 'Save as new version', onPress: () => { void handleConflictChoice('new-version'); } },
      ],
    );
  }, [conflict, handleConflictChoice]);

  useEffect(() => {
    if (conflict) showConflictDialog();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per conflict object identity, not per render of showConflictDialog.
  }, [conflict]);

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
      { label: 'Kind', value: category === 'raw' ? rawFormatLabelValue : (CATEGORY_LABELS[category] ?? 'File') },
    ];
    if (fileFormat) rows.push({ label: 'Format', value: fileFormat });
    if (currentMimeType) rows.push({ label: 'Type', value: currentMimeType });
    if (shownSizeBytes != null) rows.push({ label: 'Size', value: formatSize(shownSizeBytes) });
    if (currentCreatedAt) rows.push({ label: 'Created', value: formatDate(currentCreatedAt) });
    if (currentVersionNumber != null) rows.push({ label: 'Version', value: `v${currentVersionNumber}` });
    if (currentChunkCount != null) rows.push({ label: 'Chunks', value: String(currentChunkCount) });
    // Task 1569 — EXIF summary, only when RawRenderer's extraction actually
    // found something ("where the EXIF has them" — the task's own phrasing;
    // CR3 in particular has no path to real EXIF here, see raw-preview.ts's
    // doc comment, so this section is simply omitted for it rather than
    // showing six blank rows).
    if (category === 'raw' && rawExifInfo) {
      if (rawExifInfo.cameraModel) rows.push({ label: 'Camera', value: rawExifInfo.cameraModel });
      if (rawExifInfo.lensModel) rows.push({ label: 'Lens', value: rawExifInfo.lensModel });
      if (rawExifInfo.iso) rows.push({ label: 'ISO', value: rawExifInfo.iso });
      if (rawExifInfo.shutterSpeed) rows.push({ label: 'Shutter', value: rawExifInfo.shutterSpeed });
      if (rawExifInfo.aperture) rows.push({ label: 'Aperture', value: rawExifInfo.aperture });
      if (rawExifInfo.focalLength) rows.push({ label: 'Focal length', value: rawExifInfo.focalLength });
    }
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
    shownSizeBytes,
    currentStoragePoolId,
    currentVersionNumber,
    rawExifInfo,
    rawFormatLabelValue,
  ]);

  // Task 1360 — `goBack()` is NOT idempotent: the modal's dismiss transition
  // (`presentation: 'modal', animation: 'slide_from_bottom'`, App.tsx) is a native
  // animation, so this screen can still be mounted and hit-testable for the ~300-500ms it
  // takes to slide away after the first call. A second real tap landing in that window
  // (e.g. a genuine rapid double-tap, or a test-harness retry compensating for a stale
  // Maestro driver — see CLAUDE.md) would call `goBack()` again against a navigator that has
  // already advanced past this screen, popping an EXTRA one. `closedRef` makes this call
  // idempotent regardless of how many times it fires — a fresh `false` per mount, since
  // Preview is a routed screen that fully unmounts/remounts on each open.
  const closedRef = useRef(false);
  const handleClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    navigation.goBack();
  }, [navigation]);

  // Preview redesign item 1 — the screen is now presented as a genuine
  // `fullScreenModal` (App.tsx), which on iOS maps to
  // `UIModalPresentationFullScreen`. Unlike `modal`/`pageSheet`, that
  // presentation style has NO built-in interactive dismiss gesture, so the
  // swipe-down-to-close the old `modal` sheet gave for free has to be
  // rebuilt in JS. Scoped to the glass header row only (not the whole
  // screen): the doc/media content below is a mix of vertical ScrollViews
  // (markdown/code/HTML source), a horizontal FlatList (photo pager) and a
  // native PdfRenderer — a PanGestureHandler wrapping ALL of that would
  // race each of their own pan recognizers for every scroll-up gesture, not
  // just a dismiss swipe (there is no cheap way to ask an arbitrary nested
  // scrollable "are you at the top?" across that many renderer types). The
  // header has no competing gesture of its own, so grabbing it and dragging
  // down is unambiguous — same idiom as BBActionSheet's own grabber drag.
  // `handleClose` (above) already routes through the `beforeRemove`
  // unsaved-changes guard via `navigation.goBack()`, so a swipe-dismiss
  // while editing gets the same discard confirmation as every other close
  // path — nothing extra to wire here.
  const closeTranslateY = useRef(new Animated.Value(0)).current;
  const onCloseGestureEvent = useMemo(
    () => Animated.event(
      [{ nativeEvent: { translationY: closeTranslateY } }],
      { useNativeDriver: true },
    ),
    [closeTranslateY],
  );
  const onCloseHandlerStateChange = useCallback((event: PanGestureHandlerStateChangeEvent) => {
    if (event.nativeEvent.oldState !== State.ACTIVE) return;
    const { translationY, velocityY } = event.nativeEvent;
    if (translationY > 120 || velocityY > 800) {
      handleClose();
      return;
    }
    Animated.spring(closeTranslateY, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 4,
    }).start();
  }, [closeTranslateY, handleClose]);
  const closeTranslateYClamped = useMemo(
    () => closeTranslateY.interpolate({
      inputRange: [-1, 0, 4000],
      outputRange: [0, 0, 4000],
      extrapolate: 'clamp',
    }),
    [closeTranslateY],
  );

  // Task 1563 (item 7 — unsaved-changes guard). `beforeRemove` fires for
  // EVERY way this screen can leave — the close button above, the modal's
  // own swipe-to-dismiss gesture, and Android hardware back — not just one
  // button handler, so this is the one place that actually covers "leaving
  // the screen" rather than just "tapping this specific control".
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (!isDirty) return;
      e.preventDefault();
      Alert.alert(
        'Discard unsaved changes?',
        'Your edits since the last save will be lost.',
        [
          {
            text: 'Keep editing',
            style: 'cancel',
            // `handleClose` above latches `closedRef` before this listener
            // ever runs (it calls `goBack()` unconditionally); un-latch it
            // here so a cancelled leave doesn't permanently disable the
            // close button for the rest of this screen's lifetime.
            onPress: () => { closedRef.current = false; },
          },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      );
    });
    return unsubscribe;
  }, [navigation, isDirty]);

  /**
   * Download the encrypted file to cache and decrypt it (when the vault is
   * unlocked). Returns a local URI suitable for an <Image> source or sharing.
   * Falls back to the encrypted URI if crypto is unavailable.
   */
  const fetchAndDecrypt = useCallback(async (options: {
    signal?: AbortSignal;
    onStreamProgress?: (pct: number) => void;
  } = {}): Promise<string> => {
    throwIfPreviewAborted(options.signal);
    // Task 1539 (finding 1, P0): every single-file decrypt path funnels
    // through this function — see PreviewLockedError's doc comment. Checked
    // AFTER the abort check (an already-cancelled load shouldn't masquerade
    // as a lock error) and BEFORE any network/decrypt work starts.
    if (contentLocked) {
      recordRuntimeTrace('preview.original.blocked_locked', { fileId: currentFileId });
      throw new PreviewLockedError();
    }
    const startedAt = Date.now();
    recordRuntimeTrace('preview.original.fetch_start', {
      fileId: currentFileId,
      category,
      mimeType: currentMimeType ?? null,
      sizeBytes: currentSizeBytes ?? null,
      chunkCount: currentChunkCount ?? null,
      isUnlocked,
      hasMasterKeyHandle: getMasterKeyHandleId() != null,
      attempt: reloadNonce,
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
    // caches-registry: example=00000000-0000-0000-0000-000000000000_x.jpg (legacy <fileId>_<name>)
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
      // Task 1593 — the shared preview cache key ("Prove it" uses the same).
      const decryptExt = previewDecryptExtension(currentMimeType, currentFileName);
      let decryptedUri: string;
      try {
        recordRuntimeTrace('preview.original.decrypt_request', {
          fileId: currentFileId,
          category,
          extension: decryptExt,
        });
        {
          const { keyProvider, handleId } = resolveDecryptKey(currentFileId);
          decryptedUri = await decryptToTempFile(
            currentFileId,
            keyProvider,
            decryptExt,
            currentSizeBytes,
            currentChunkCount,
            handleId,
            {
              onProgress: (event) => {
                applyNativeProgress(event, setLoadProgress);
                const pct = streamBufferPctFromEvent(event);
                if (pct !== undefined) {
                  setStreamBufferPct(pct);
                  if (pct !== null) options.onStreamProgress?.(pct);
                }
              },
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
    contentLocked,
    currentChunkCount,
    currentFileId,
    currentFileName,
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
    reloadNonce,
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
    // Task 1539 (finding 1, P0): the single-file image path calls
    // `loadDecryptedPhotoForViewer` DIRECTLY — it never went through
    // `fetchAndDecrypt`, so guarding that function alone would have missed
    // this, the most common preview path (images/videos are the bulk of
    // what Photos opens). This is the same function PhotoPage's own
    // `shouldLoadFull` effect calls for the swipe pager, gated there via its
    // `locked` prop.
    if (contentLocked) return;
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
          setImageError(previewLoadErrorMessage(err));
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
    contentLocked,
    currentFileId,
    currentPhotoPageEntry,
    getFileKeyBytes,
    getMasterKeyHandleId,
    hasSwipe,
    isImage,
    isUnlocked,
    performanceStorageProfile,
    reloadNonce,
  ]);

  useEffect(() => {
    if (!isImage || hasSwipe) return;
    // Task 1539 (finding 1, P0): same direct-call bypass as the effect
    // above — belt-and-suspenders here since `imageUri` (required below)
    // only gets set by that already-gated effect in the first place.
    if (contentLocked) return;
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
    contentLocked,
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
    // Task 1539 (finding 1, P0): PDFs call `decryptToTempFile` DIRECTLY —
    // another `fetchAndDecrypt` bypass, and unlike the image effects above
    // this one isn't even implicitly protected by a downstream `!imageUri`
    // check, so it needed its own explicit guard.
    if (contentLocked) return;
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
        if (!cancelled && !isAbortError(err)) setPdfError(previewLoadErrorMessage(err));
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
  }, [contentLocked, isPdf, isUnlocked, currentFileId, getFileKeyBytes, getMasterKeyHandleId, resolveDecryptKey, currentSizeBytes, currentChunkCount, reloadNonce]);

  // Auto-load text/code/JSON inline on mount — read decrypted file as UTF-8.
  //
  // Task 1563 (App Review blocker, build 214): gated on `lockCheckReady`, not
  // just `isText`. `contentLocked` (isPagerPageGated) fails CLOSED for every
  // file — including ones that are not actually locked — until the async
  // `checkLockedFileIds` lookup resolves (see task 1539). Before this fix,
  // this effect fired the moment `isText` became true, regardless of
  // `lockCheckReady`: on an unlocked file it would (a) call fetchAndDecrypt()
  // while contentLocked was still provisionally true, drawing a thrown
  // PreviewLockedError and a wasted `setTextError('This file is locked.')`,
  // then (b) re-fire microseconds later once lockCheckReady flipped and
  // contentLocked resolved to false, immediately clearing that error and
  // re-decrypting. Both the wasted first attempt and the effect re-mount it
  // forces are pure overhead — the outcome (this file is not locked) was
  // never in doubt, we just hadn't been told yet. Waiting the extra tens of
  // milliseconds for `lockCheckReady` removes the double-fire entirely: the
  // effect now runs exactly once, after the lock status is actually known,
  // for every file — matching how `contentLocked` itself is already
  // documented to behave ("fails closed until ready").
  useEffect(() => {
    if (!isText) return;
    if (!lockCheckReady) return;
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
        // A PreviewLockedError here means `contentLocked` flipped true again
        // between this effect starting and fetchAndDecrypt's own check —
        // e.g. the user tapped "Lock file" while the decrypt was in flight.
        // The locked-doc render branch (gated on `contentLocked` itself, not
        // on `textError`) already owns showing that state, so surfacing it
        // as a text-pane error too would just be a second, redundant UI for
        // the same fact.
        if (!cancelled && !isAbortError(err) && !isPreviewLockedError(err)) {
          setTextError(previewLoadErrorMessage(err));
        }
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
  }, [isText, lockCheckReady, fetchAndDecrypt]);

  // Auto-load video on mount; track the on-disk URI so we can delete it on unmount
  useEffect(() => {
    if (!isVideo) return;
    if (hasSwipe) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setVideoLoading(true);
    setVideoError(null);
    setStreamBufferPct(null);
    fetchAndDecrypt({ signal: controller.signal, onStreamProgress: setStreamBufferPct })
      .then((uri) => {
        if (cancelled || controller.signal.aborted) {
          // Screen already unmounted by the time the download completed —
          // delete the file directly since the cleanup branch never sees it.
          if (!isLoopbackStreamUri(uri)) {
            FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          }
          void releasePreviewCopy(fileId, previewDecryptExtension(mimeType, fileName)).catch(() => {});
          return;
        }
        tempVideoUriRef.current = uri;
        setVideoUri(uri);
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) setVideoError(previewLoadErrorMessage(err));
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
  }, [hasSwipe, isVideo, fetchAndDecrypt, fileId, mimeType, fileName]);

  // Delete the temp video file when the screen unmounts.
  useEffect(() => {
    return () => {
      const uri = tempVideoUriRef.current;
      if (!uri) return;
      tempVideoUriRef.current = null;
      if (isLoopbackStreamUri(uri)) {
        void releasePreviewCopy(fileId, previewDecryptExtension(mimeType, fileName)).catch(() => {});
        return;
      }
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    };
  }, []);

  // expo-video player — must be called unconditionally, but a null source
  // keeps it idle until `videoUri` resolves.
  const player = useVideoPlayer(videoUri, (p) => {
    p.loop = false;
  });

  // Task 1568 — auto-load audio on mount; same shape as video's loader
  // above (fetchAndDecrypt → track the on-disk temp URI → delete it once the
  // screen unmounts or the load is aborted before it lands).
  useEffect(() => {
    if (!isAudio) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setAudioLoading(true);
    setAudioError(null);
    fetchAndDecrypt({ signal: controller.signal })
      .then((uri) => {
        if (cancelled || controller.signal.aborted) {
          // Screen already unmounted by the time the decrypt completed —
          // delete the file directly since the cleanup effect below never
          // sees a uri it was never handed.
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          return;
        }
        tempAudioUriRef.current = uri;
        setAudioUri(uri);
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) setAudioError(previewLoadErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) {
          setAudioLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isAudio, fetchAndDecrypt]);

  // Delete the temp audio file when the screen unmounts (i.e. on close —
  // `handleClose` calls `navigation.goBack()`, which unmounts this screen;
  // see that function's own comment). Routed through the extracted
  // `cleanupTrackedTempFile` helper (`lib/preview-temp-file.ts`) rather than
  // inlined like video's equivalent effect above, specifically so this
  // exact "temp file is deleted" behaviour has a real, mutation-proven unit
  // test — PreviewScreen.tsx itself cannot be unit-tested (no React
  // reconciler in this project's test runner; see
  // PreviewScreen.webview-parent.test.ts's doc comment).
  useEffect(() => {
    return () => {
      void cleanupTrackedTempFile(tempAudioUriRef, FileSystem.deleteAsync);
    };
  }, []);

  // Task 1569 — auto-load the RAW source file on mount; same shape as
  // audio's loader above. RawRenderer reads this decrypted SOURCE file and
  // writes its OWN separate extracted-preview temp file (cleaned up by
  // RawRenderer itself, not here — see that component's doc comment).
  useEffect(() => {
    if (!isRaw) return;
    // In pager mode each `PhotoPage` decrypts and renders its own RAW source; this single-file
    // loader would decrypt the current file a second time into a temp file nothing shows (image and
    // video already skip it the same way).
    if (hasSwipe) return;
    if (Platform.OS === 'web') return;
    const controller = new AbortController();
    let cancelled = false;
    setRawLoading(true);
    setRawError(null);
    fetchAndDecrypt({ signal: controller.signal })
      .then((uri) => {
        if (cancelled || controller.signal.aborted) {
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          return;
        }
        tempRawUriRef.current = uri;
        setRawUri(uri);
      })
      .catch((err) => {
        if (!cancelled && !isAbortError(err)) setRawError(previewLoadErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) {
          setRawLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasSwipe, isRaw, fetchAndDecrypt]);

  // Delete the temp SOURCE raw file when the screen unmounts — same
  // extracted-helper pattern as audio's equivalent effect above.
  useEffect(() => {
    return () => {
      void cleanupTrackedTempFile(tempRawUriRef, FileSystem.deleteAsync);
    };
  }, []);

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
        if (!cancelled && !isAbortError(err)) setDocxError(previewLoadErrorMessage(err));
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
        if (!cancelled && !isAbortError(err)) setSheetError(previewLoadErrorMessage(err));
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
        if (!cancelled && !isAbortError(err)) setSvgError(previewLoadErrorMessage(err));
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
        if (!cancelled && !isAbortError(err)) setHtmlError(previewLoadErrorMessage(err));
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
        if (!cancelled && !isAbortError(err)) setZipError(previewLoadErrorMessage(err));
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
        if (!cancelled && !isAbortError(err)) setArchiveError(previewLoadErrorMessage(err));
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
        if (!cancelled && !isAbortError(err)) setPptxError(previewLoadErrorMessage(err));
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
          // Task 1593 round 2 (P2-F) — release, never delete, the shared preview copy.
          await releasePreviewCopy(currentFileId, previewDecryptExtension(currentMimeType, currentFileName));
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
        setImageError(previewLoadErrorMessage(err));
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
    navigation.navigate('ShareSheet', { fileId: currentFileId, fileName: previewFileName, mimeType: currentMimeType, sizeBytes: shownSizeBytes ?? undefined });
  }, [navigation, currentFileId, previewFileName, currentMimeType, shownSizeBytes]);

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

  // Preview redesign item 4 — "Move to…" (design section 02's ⋯ menu).
  // FilesScreen already ships a "Move" flow for possibly-FOLDER items
  // (`FolderPickerModal` + `buildPickerFolders` + `moveFile`) — reused here
  // verbatim (the SAME component + the SAME `moveFile` endpoint). What's
  // rebuilt is only the folder-tree FETCH: FilesScreen's version prefers a
  // cached `sync.allNodes()` tree that this screen has no access to (no
  // sync engine is wired into Preview), and its OWN fallback for when that
  // cache isn't ready is a flat ROOT-ONLY `listAllFiles()` — not good
  // enough as Preview's ONLY path, since a picker that can't be drilled
  // into past the root would be a materially worse "Move to…" than the one
  // FilesScreen already ships. `collectAllFolders` (lib/move-picker-folders,
  // unit-tested + mutation-proven) walks the WHOLE tree instead. The
  // descendant-exclusion step FilesScreen's version needs (so a folder
  // can't move into its own subtree) does not apply here — Preview only
  // ever moves a single FILE, which has no descendants.
  const [movePicker, setMovePicker] = useState<{ folders: PickerFolder[]; currentParentId: string | null } | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);

  const handleOpenMovePicker = useCallback(async () => {
    setOptionsVisible(false);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const [fresh, folderNodes] = await Promise.all([
        getFile(currentFileId),
        collectAllFolders((parentId) => listAllFiles(parentId ?? undefined)),
      ]);
      const folders: PickerFolder[] = await Promise.all(
        folderNodes.map(async (node: MovePickerFolderNode) => {
          let name = movePickerFolderFallbackName(node);
          try {
            const payload = encryptedMetadataPayloadToBytes(node.name_encrypted);
            if (payload) {
              const plaintext = await decryptMetadata(node.id, payload.nonce, payload.ciphertext);
              const parsed = JSON.parse(plaintext) as { name?: unknown };
              if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
                name = parsed.name.trim();
              }
            }
          } catch {
            // Keep the fallback name — a folder failing to decrypt is not a
            // reason to block the whole picker from opening.
          }
          return { id: node.id, name, parentId: node.parent_id };
        }),
      );
      setMovePicker({ folders, currentParentId: fresh.parent_id ?? null });
    } catch (err) {
      Alert.alert('Error', friendlyError(err));
    }
  }, [currentFileId, decryptMetadata]);

  const handleConfirmMove = useCallback(async (targetId: string | null) => {
    if (moveBusy) return;
    setMoveBusy(true);
    try {
      await moveFile(currentFileId, targetId);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const destName = targetId === null
        ? 'Drive'
        : movePicker?.folders.find((f) => f.id === targetId)?.name ?? 'folder';
      showToast({ type: 'success', message: `Moved to ${destName}` });
      setMovePicker(null);
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Move failed', friendlyError(err));
    } finally {
      setMoveBusy(false);
    }
  }, [currentFileId, moveBusy, movePicker, showToast]);

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

  // Task 1563 — Guus's ruling (2026-09-26 18:50) overrides the mockup's
  // Edit/Preview segmented control: Edit is reached from THIS existing ⋯
  // menu, not a new control. While editing, the same slot flips to
  // "Preview" (markdown — go back to the formatted view) or "Done"
  // (plain text/code — go back to the highlighted read view). No item at
  // all when the file fails the edit gate (no Edit button, per the size/
  // UTF-8 limit) and the file hasn't been opened for editing.
  const editMenuAction = useMemo<PreviewOptionAction | null>(() => {
    if (!isText) return null;
    if (editMode) {
      return {
        label: isMarkdown ? 'Preview' : 'Done',
        icon: isMarkdown ? 'eye-outline' : 'checkmark-outline',
        run: handleExitEditMode,
      };
    }
    if (!canEditText) return null;
    return { label: 'Edit', icon: 'pencil-outline', run: handleEnterEditMode };
  }, [isText, editMode, isMarkdown, canEditText, handleExitEditMode, handleEnterEditMode]);

  const previewActions = useMemo<PreviewOptionAction[]>(() => [
    ...(isImage ? [{ label: 'View Original', icon: 'image-outline' as const, run: handleViewOriginal }] : []),
    ...(editMenuAction ? [editMenuAction] : []),
    // Preview redesign, design section 02 — a markdown file's ⋯ menu also
    // offers the raw source without entering Edit (item 3: "⋯ keeps ...
    // Show source (markdown)"). Not shown while editing (the editor IS the
    // raw source) or once the file has fallen back to error/loading states.
    ...(isMarkdown && !editMode && textContent != null
      ? [{
          label: showSource ? 'Show Preview' : 'Show Source',
          icon: 'eye-outline' as const,
          run: () => setShowSource((prev) => !prev),
        }]
      : []),
    { label: 'Share Beebeeb Link', icon: 'link-outline', run: handleShare },
    { label: 'Save Original…', icon: 'share-outline', run: handleDownload },
    { label: 'Copy File Name', icon: 'copy-outline', run: handleCopyName },
    { label: 'Duplicate', icon: 'duplicate-outline', run: handleDuplicate },
    // Preview redesign item 4 — design section 02's ⋯ mock order is
    // Edit / Show source / Copy share link / Move to… / Version history /
    // Move to Trash; "Move to…" was the one entry with no reuse path in an
    // earlier pass (see DEVIATIONS.md history) until this pass found and
    // wired FilesScreen's existing FolderPickerModal + moveFile flow.
    { label: 'Move to…', icon: 'folder-outline', run: () => { void handleOpenMovePicker(); } },
    { label: 'Move to Trash', icon: 'trash-outline', destructive: true, run: handleMoveToTrash },
  ], [handleCopyName, handleDownload, handleDuplicate, handleMoveToTrash, handleOpenMovePicker, handleShare, handleViewOriginal, isImage, editMenuAction, isMarkdown, editMode, textContent, showSource]);

  const handlePreviewOptions = useCallback(() => {
    // Task 1583 — ⋯ while the Info sheet is open swaps the sheet for the
    // menu instead of stacking the menu on the sheet.
    setInfoVisible(false);
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
        // Task 1539 (Codex P1 follow-up, PR #109 review): was bare
        // `isPreviewGated`, which reports every page "unlocked" during the
        // startup window before `checkLockedFileIds` resolves (`lockedFileIds`
        // starts empty) — a locked neighbor could start a thumbnail/decrypt
        // before we even knew it was locked. `isPagerPageGated` fails closed
        // until `lockCheckReady`.
        locked={isPagerPageGated(item.id, lockedFileIds, authenticatedFileIds, lockCheckReady)}
        unlocking={unlockingFileId === item.id}
        onRequestUnlock={handleUnlockCurrent}
        // Task 1570 — RAW joining the pager: every page reports its own EXIF,
        // keyed by file id (round 3) — see `PhotoPage`'s own `onExifInfo` prop
        // doc comment.
        onExifInfo={publishRawExif}
        onZoomChange={setMediaZoomed}
        onSingleTap={handleContentTap}
        videoControlsBottomInset={previewVideoControlsBottomInset}
      />
    ),
    [
      activePhotoPageIndexes,
      authenticatedFileIds,
      currentPhotoIndex,
      handleContentTap,
      handleUnlockCurrent,
      lockCheckReady,
      lockedFileIds,
      originalPhotoRequest,
      performanceStorageProfile,
      previewVideoControlsBottomInset,
      publishRawExif,
      unlockingFileId,
    ],
  );

  // 1346 — this loading-state status is shared by BOTH the media branch
  // (always forced dark — mediaMaterial comment above `if (isMediaPreview)`)
  // and the doc branch's renderer Suspense fallbacks (now scheme={resolved}
  // per 1344). It has no branch of its own to carry a comment at each call
  // site (20 call sites), so the decision lives here, once: pass the same
  // forced-dark tokens the media header uses when isMediaPreview, otherwise
  // the doc branch's own c.ink3/c.line — the identical decision already
  // made for the error-state text below, just for the "still loading" text
  // instead of the "failed to load" text. Leaving this un-themed would have
  // shipped exactly the dark-on-light regression 1344 warned about: the doc
  // root now follows scheme, so its "still loading" text has to as well.
  // Task 1592 item 3 — one failed-load view for every renderer: an honest
  // message (previewLoadErrorMessage — never a raw native exception) and a
  // way to try again (a file still uploading finishes in a moment).
  // `tone: 'media'` keeps the forced-white text of the always-dark media
  // stage (see the 1346 notes at those call sites).
  const retryLoad = () => {
    setImageError(null);
    setPdfError(null);
    setTextError(null);
    setVideoError(null);
    setAudioError(null);
    setRawError(null);
    setDocxError(null);
    setSheetError(null);
    setSvgError(null);
    setHtmlError(null);
    setZipError(null);
    setArchiveError(null);
    setPptxError(null);
    setReloadNonce((n) => n + 1);
  };
  const renderLoadError = (title: string, message: string, tone: 'doc' | 'media' = 'doc') => {
    const stillUploading = message === STILL_UPLOADING_MESSAGE;
    // Task 1687d — an honest card for the partial-file case ("halve file"):
    // the message names what happened ("This file didn't fully decrypt."),
    // the title names what the user is looking at, and Try again fetches a
    // fresh copy (the truncated cache entry was already scrubbed at
    // reject time). Never a promise that the retry "should work".
    const partial = message === PARTIAL_DECRYPT_MESSAGE;
    const resolvedTitle = partial ? 'Incomplete file' : stillUploading ? 'Still uploading' : title;
    const ink = tone === 'media' ? colors.white : c.ink;
    return (
      <View style={styles.imageStatus} testID="preview-load-error">
        <Text style={[styles.imageStatusTitle, { color: ink }]}>
          {resolvedTitle}
        </Text>
        <Text style={[styles.imageStatusSub, tone === 'doc' && { color: c.ink3 }]}>{message}</Text>
        <TouchableOpacity
          onPress={retryLoad}
          style={[
            styles.loadRetryButton,
            { borderColor: tone === 'media' ? 'rgba(255,255,255,0.35)' : c.line },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          testID="preview-load-retry"
        >
          <Text style={[styles.loadRetryText, { color: ink }]}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderSharedProgress = (isVideoProgress = false) => (
    <PreviewProgressStatus
      color={c.amber}
      textColor={isMediaPreview ? glassMaterial('dark').labelMuted : c.ink3}
      trackColor={isMediaPreview ? 'rgba(255,255,255,0.16)' : c.line}
      isUnlocked={isUnlocked}
      isVideo={isVideoProgress}
      progress={loadProgress.stage ? loadProgress : emptyPreviewProgress('downloading')}
      profile={performanceProfile}
      sizeBytes={currentSizeBytes}
    />
  );

  if (isMediaPreview) {
    // When a photo list is provided, show a horizontal swipeable pager
    // Task 1570 (Codex P2 follow-up, PR #126 review): isRaw added. This was
    // `isImage || isVideo` only, so opening a RAW file from a multi-item
    // Photos `photoList` (DNG shows up in Photos as `image/x-adobe-dng`, and
    // other RAW extensions are media candidates too) fell out of the pager
    // into the single-file RAW branch below (`isRaw` render branch further
    // down, ~line 4390) instead — swiping to adjacent photos was lost
    // entirely. `PhotoPage` now handles a RAW entry itself (its own
    // `isRawEntry` branch: decrypt the source file, hand it to
    // `RawRenderer`), so RAW can safely join the pager the same way
    // image/video already do.
    const showPager = hasSwipe && (isImage || isVideo || isRaw);
    // 1346 — every scheme="dark" below (ScrollEdgeBlur, both GlassCircles,
    // the title/subtitle GlassCapsule, the e2e badge GlassCapsule) and every
    // colors.white/rgba(255,255,255,…) literal in this media branch is
    // ARGUED, not compared to a canvas: light mode has no artboard for this
    // screen at all, so there is no light-mode sample to lift or even
    // compare against. The argument is the ground itself — mediaRoot's
    // backgroundColor is the fixed near-black '#020203' no matter the app
    // scheme, because it sits under ARBITRARY decrypted photo/video pixels
    // (unlike every other screen's root, which sits under known, themed
    // content). Chrome floating over an unknown, uncontrolled background
    // needs one predictable contrast, not two — that's the same honesty
    // class as `SCROLL_EDGE.lightTint` and `MODAL_SCRIM.light` in
    // glass-recipe.ts: both are DERIVED values invented because the canvas
    // never sampled a light equivalent, not lifted from one. See
    // DEVIATIONS.md "Phase 4 — Preview light-mode rationale (1346)".
    //
    // Round 4 (lead review, see `PREVIEW_CHROME_MATERIAL`'s own doc comment):
    // `glassMaterial('dark')` alone is not enough even here — a bright/white
    // photo washes out its 0.46-alpha fill exactly like the doc header's did
    // over a white PDF page. `PREVIEW_CHROME_MATERIAL` is the fix for BOTH
    // branches, not a doc-only patch.
    const mediaMaterial = PREVIEW_CHROME_MATERIAL;

    return (
      <Animated.View style={[styles.mediaRoot, { transform: [{ translateY: closeTranslateYClamped }] }]}>
        {/* 1314 — the canvas floats Preview's chrome as glass over the media
            instead of a flat black bar. The scrim becomes a progressive blur
            so the title stays legible over bright images, and the controls
            become glass circles.
            1346 — scheme="dark" forced: mediaMaterial comment above (media
            ground is always near-black, not a light/dark toggle). */}
        <StatusBar style={statusBarStyle} hidden={!chromeVisible} animated />

        {/* Preview redesign item 3 — the "e2e" pill (design's "00 TODAY"
            complaint: "it covers the content, and 'e2e' is jargon") is
            retired. The encryption state now lives in the header subtitle
            ("Encrypted · Type · size", item 2) instead of a second floating
            badge; see DEVIATIONS.md for the removal note. */}

        {/* Task 1687b — swipe-down on preview CONTENT closes the preview,
            same gesture + thresholds as the header rows (closeTranslateY
            comment above): the pan wraps ALL media content branches (pager,
            locked single-file stage, normal stage). Configuration copied
            from the header's own PanGestureHandler: activeOffsetY
            [-1000, 8] activates on a ≥8 pt downward move, failOffsetX ±20
            hands horizontal moves to the pager's FlatList so page swipes
            are untouched. This is an RNGH NATIVE pan, not a JS responder —
            the bisected trap the pager comment below documents (a Pressable
            ancestor ate every swipe) does not apply. `enabled={!mediaZoomed}`
            matches the pager's own scrollEnabled gate (1579): while a
            ZoomableImage is zoomed its ScrollView owns the vertical pan, so
            the dismiss gesture stands down. The doc branch is deliberately
            NOT wrapped: its content (PDF/WebView/text) scrolls vertically —
            a content pan there would fight scrolling; the doc header
            already carries the same swipe (see its PanGestureHandler).
            Taps still reach the content: the header proves the tap/pan
            coexistence (its TouchableOpacities work inside the same pan). */}
        <PanGestureHandler
          onGestureEvent={onCloseGestureEvent}
          onHandlerStateChange={onCloseHandlerStateChange}
          activeOffsetY={[-1000, 8]}
          failOffsetX={[-20, 20]}
          enabled={!mediaZoomed}
        >
        {showPager ? (
          // Preview redesign item 3 — tap-to-hide on the swipe pager too.
          // See the `pagerTouchStartRef` comment above (by `pagerRef`) for
          // why this is raw `onTouchStart`/`onTouchEnd` on the FlatList
          // itself, not a wrapping `Pressable` — bisected on-device: a
          // `Pressable` ancestor reliably ate every swipe (screenshot proof:
          // the page counter stayed "1 / 13" after a real swipe gesture,
          // both with Maestro's coordinate-swipe and its direction-swipe);
          // removing it and using the plain `View` below restored paging
          // immediately (counter advanced to "2 / 13" on the same gesture).
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
              // Task 1579 — no paging while the current image is zoomed.
              scrollEnabled={!mediaZoomed}
              onTouchStart={(e) => {
                const { pageX, pageY } = e.nativeEvent;
                pagerTouchStartRef.current = { x: pageX, y: pageY, t: Date.now() };
              }}
              onTouchEnd={(e) => {
                const start = pagerTouchStartRef.current;
                pagerTouchStartRef.current = null;
                if (!start) return;
                const { pageX, pageY } = e.nativeEvent;
                const dx = Math.abs(pageX - start.x);
                const dy = Math.abs(pageY - start.y);
                const dt = Date.now() - start.t;
                // A real swipe (paging) travels most of the screen width in
                // this same gesture; a tap moves only a few points. 500ms
                // covers a normal tap without also matching a slow drag.
                if (dx < 10 && dy < 10 && dt < 500) {
                  handleContentTap();
                }
              }}
              testID="preview-content-tap"
              windowSize={3}
              maxToRenderPerBatch={3}
              removeClippedSubviews
              style={{ flex: 1 }}
            />
          </View>
        ) : contentLocked ? (
          // Task 1539 (finding 1, P0): the single-file (non-swipe) content
          // area, gated the same way as every pager page. Every effect that
          // could populate imageUri/videoUri for THIS file is gated above
          // (`contentLocked` in their dependency arrays), so this replaces
          // what would otherwise be an indefinite loading spinner — not an
          // overlay hiding content that already started loading underneath.
          <Pressable
            style={[
              styles.mediaStage,
              {
                paddingTop: insets.top + 64,
                paddingBottom: 24 + Math.max(insets.bottom, 16),
                alignItems: 'center',
                justifyContent: 'center',
              },
            ]}
            onPress={() => { void handleUnlockCurrent(currentFileId); }}
            disabled={unlockingFileId === currentFileId}
            accessibilityRole="button"
            accessibilityLabel="Locked file — tap to authenticate"
            testID="preview-locked-single"
          >
            <View style={styles.imageStatus}>
              <Ionicons name="lock-closed" size={40} color={colors.amber} />
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>Locked</Text>
              <Text style={styles.imageStatusSub}>
                {unlockingFileId === currentFileId ? 'Authenticating...' : 'Tap to authenticate and view this file.'}
              </Text>
              {/* Task 1539 (finding 5, lead decision — PR #109 review): see
                  lock-copy.ts — the lock is not visible to the File
                  Provider extension, so say so wherever there is room. */}
              <Text style={styles.imageStatusSub}>{FILES_APP_LOCK_CAVEAT}</Text>
            </View>
          </Pressable>
        ) : (
          <Pressable
            style={[
              styles.mediaStage,
              {
                paddingTop: insets.top + 64,
                paddingBottom: 24 + Math.max(insets.bottom, 16),
              },
            ]}
            onPress={handleContentTap}
            // Task 1579 — a mounted ZoomableImage owns taps (single tap →
            // handleContentTap, double-tap → zoom); a live Pressable
            // responder here would also block its native pinch.
            disabled={(isImage && !!imageUri && !imageError) || (isRaw && !!rawUri && !rawError)}
            testID="preview-content-tap"
          >
            {isImage ? (
              imageError ? (
                // 1346 — colors.white forced: this status sits on mediaStage,
                // itself painted over mediaRoot's forced-dark ground (see
                // mediaMaterial comment above `if (isMediaPreview)`). Left as
                // the plain literal rather than switched to
                // mediaMaterial.label — it's status content, not chrome, but
                // the same forced-ground argument applies unchanged.
                renderLoadError("Couldn't load image", imageError, 'media')
              ) : imageUri ? (
                // Task 1579 — pinch/double-tap zoom (single-file image).
                <ZoomableImage
                  resetSignal={currentFileId}
                  onZoomChange={setMediaZoomed}
                  onSingleTap={handleContentTap}
                  testID="preview-zoomable"
                >
                  {originalImageActive ? (
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
                  )}
                </ZoomableImage>
              ) : (
                <View style={styles.imageStatus}>
                  {renderSharedProgress(false)}
                </View>
              )
            ) : isRaw ? (
              // Task 1569 — RAW (CR2/CR3/ARW/NEF/RAF/DNG). RawRenderer owns
              // its own loading/fallback states internally once handed a
              // decrypted source uri; rawError only covers the DECRYPT step
              // failing outright (mirrors audio/video's own error branch).
              rawError ? (
                renderLoadError("Couldn't load RAW file", rawError, 'media')
              ) : rawUri ? (
                // Task 1579 — pinch/double-tap zoom (single-file RAW preview).
                <ZoomableImage
                  resetSignal={currentFileId}
                  onZoomChange={setMediaZoomed}
                  onSingleTap={handleContentTap}
                  testID="preview-zoomable"
                >
                  <RawRenderer
                    uri={rawUri}
                    fileName={previewFileName}
                    formatLabel={rawFormatLabelValue}
                    cacheKey={currentFileId}
                    onExifInfo={(info) => publishRawExif(currentFileId, info)}
                  />
                </ZoomableImage>
              ) : (
                <View style={styles.imageStatus}>
                  {renderSharedProgress(false)}
                </View>
              )
            ) : videoUri ? (
              <View style={styles.mediaVideoStageWrap}>
                <VideoView
                  player={player}
                  style={[styles.videoControlsSurface, videoControlsBottomStyle]}
                  contentFit="contain"
                  nativeControls
                  fullscreenOptions={{ enable: true }}
                  allowsPictureInPicture
                />
                {isLoopbackStreamUri(videoUri) && streamBufferPct != null && streamBufferPct < 100 ? (
                  <StreamingBufferBadge pct={streamBufferPct} />
                ) : null}
              </View>
            ) : videoError ? (
              // 1346 — colors.white forced: same mediaStage/mediaRoot ground
              // argument as the image error above.
              renderLoadError("Couldn't load video", videoError, 'media')
            ) : (
              <View style={styles.imageStatus}>
                {renderSharedProgress(true)}
              </View>
            )}
          </Pressable>
        )}
        </PanGestureHandler>

        {/* Task 1583 — the chrome layer is rendered AFTER the content stage,
            not before it. zIndex (chromeLayer: 20) already puts it on top,
            but a later sibling also wins paint and hit-test order with no
            zIndex at all, so the header can never again end up under the
            stage the way #123 left it (builds 216–218: the stage Pressable
            took the close/⋯ taps and only toggled the chrome). Guarded by
            PreviewScreen.chrome-layer.test.ts. */}
        {/* Fix: dead close/⋯ in the single-file media preview. Since #123
            (1563) wrapped the header in this opacity fade, the floating
            positioning + zIndex sat on `mediaHeader` INSIDE the wrapper, and
            this wrapper was a zero-height, un-z-indexed normal-flow sibling
            that comes BEFORE the content stage. zIndex only orders siblings,
            so the single-file stage (a `Pressable` — never flattened away by
            Fabric, unlike the pager's plain layout `View`) sat on top of the
            header and took every tap, and the zero-frame chain dropped the
            controls from the accessibility tree. Same two bugs, same fix, as
            the doc branch's header (see `header`'s style comment):
            `chromeLayer` (absolute + zIndex) on the wrapper, `mediaHeader`
            a plain in-flow row. Guarded by
            PreviewScreen.chrome-layer.test.ts. */}
        <Animated.View
          style={[styles.chromeLayer, { opacity: barsOpacity }]}
          pointerEvents={chromeVisible ? 'auto' : 'none'}
        >
        <ScrollEdgeBlur scheme="dark" height={SCROLL_EDGE.chromeFallback} />
        {/* Preview redesign item 1 — swipe-down-to-close (see the
            `closeTranslateY` comment by `handleClose`): the header row is
            the gesture's hit area. */}
        <PanGestureHandler
          onGestureEvent={onCloseGestureEvent}
          onHandlerStateChange={onCloseHandlerStateChange}
          activeOffsetY={[-1000, 8]}
          failOffsetX={[-20, 20]}
          // Task 1579 — swipe-down-to-close only at 1x.
          enabled={!mediaZoomed}
        >
        <View style={[styles.mediaHeader, { paddingTop: insets.top + 8 }]}>
          {/* 1343 — outer TouchableOpacity wraps the fixed-size GlassCircle so
              hitSlop is not clipped to the disc (RN clips hitSlop to the
              parent's bounds — the lesson FilesScreen's back-button needed a
              follow-up commit to learn, task 1341 / PR #51). Size is now
              GLASS_CIRCLE_SIZES.action (42, canvas verbatim) — 1314 had kept
              this screen's pre-glass literal 38 without ever routing it
              through the recipe's own default (DEVIATIONS.md).
              1346 — scheme="dark" forced: mediaMaterial comment above. */}
          <TouchableOpacity
            onPress={handleClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            testID="preview-close"
            accessibilityLabel="Close preview"
          >
            <GlassCircle scheme="dark" materialOverride={mediaMaterial} size={GLASS_CIRCLE_SIZES.action}>
              <Ionicons name="chevron-down" size={22} color={mediaMaterial.label} />
            </GlassCircle>
          </TouchableOpacity>

          {/* 1343 — Preview.dc.html wraps the title/subtitle in its own glass
              capsule (radius 999, padding 7px 18px — both lifted verbatim);
              the shipped header had left this block bare on the scrim since
              1314 (DEVIATIONS.md). maxWidth: '100%' on the capsule lets it
              hug short filenames and still cap at the row's available width
              for long ones, so the existing numberOfLines={1} truncation on
              both lines keeps working unchanged.
              1346 — scheme="dark" forced: mediaMaterial comment above.
              Preview redesign item 2 — the subtitle's "N of total" pager
              text moves to the floating `pageCounterLabel` pill (design item
              6, generalized to the photo pager — see that state's own
              comment), freeing this line for "Encrypted · Type · size" on
              every file, paged or not. */}
          <View style={styles.mediaHeaderText}>
            <GlassCapsule
              scheme="dark"
              materialOverride={mediaMaterial}
              style={styles.mediaHeaderCapsule}
              contentStyle={styles.mediaHeaderCapsuleBody}
            >
              <Text
                style={[styles.mediaHeaderTitle, { color: mediaMaterial.label }]}
                numberOfLines={1}
              >
                {previewFileName}
              </Text>
              <View style={styles.encSubRow}>
                <Ionicons name="lock-closed" size={10} color={colors.amber} />
                <Text style={[styles.mediaHeaderSubtitle, styles.mono, { color: mediaMaterial.labelMuted }]} numberOfLines={1}>
                  {`Encrypted · ${category === 'raw' ? rawFormatLabelValue : CATEGORY_LABELS[category]}${shownSizeBytes != null ? ` · ${formatSize(shownSizeBytes)}` : ''}`}
                </Text>
              </View>
            </GlassCapsule>
          </View>

          {/* 1346 — scheme="dark" forced: mediaMaterial comment above (mirrors
              the close button; same GlassCircle, same forced ground). */}
          <TouchableOpacity
            onPress={handlePreviewOptions}
            disabled={downloading || trashing}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Open file options"
          >
            <GlassCircle
              scheme="dark"
              materialOverride={mediaMaterial}
              size={GLASS_CIRCLE_SIZES.action}
              style={(downloading || trashing) ? styles.disabledIconButton : undefined}
            >
              <Ionicons name="ellipsis-horizontal" size={21} color={mediaMaterial.label} />
            </GlassCircle>
          </TouchableOpacity>
        </View>
        </PanGestureHandler>

        {/* Preview redesign item 6 — floating page counter, shown/hidden
            with the rest of the chrome (design's "Tap to hide" mock omits
            the pill along with the bars). Reused verbatim for the photo
            swipe-pager via `formatPdfPageCounter` (see that function's doc
            comment) — same "N / total" shape, same position.
            Bug found verifying this pass: `top: insets.top + 8` put this
            pill at the EXACT same top offset as `mediaHeader` itself (which
            also uses `paddingTop: insets.top + 8`), so it rendered directly
            on top of the ⋯ circle instead of below the bar the comment
            above already claimed. `insets.top + 62` matches the offset this
            same header already uses for its own options popover
            (`PreviewOptionsPopover`'s `top` prop below) — i.e., the header's
            own already-established "just under the bar" anchor, not a new
            magic number. */}
        {pageCounterLabel && (
          <View style={[styles.pageCounterWrap, { top: insets.top + 62 }]} pointerEvents="none">
            <GlassCapsule scheme="dark" materialOverride={mediaMaterial} contentStyle={styles.pageCounterBody}>
              <Text style={[styles.pageCounterText, styles.mono, { color: mediaMaterial.label }]}>{pageCounterLabel}</Text>
            </GlassCapsule>
          </View>
        )}
        </Animated.View>

        {/* Preview redesign item 3/5 — DetailsSheet's permanent collapsed
            peek is retired; Info is now on-demand (bottom bar "Info", or a
            swipe up on the content — item 4). Same fields it showed today,
            carried over via `extraRows` below — see InfoSheet's own doc
            comment for why it's the opaque-content-surface pattern, not a
            second glass sheet. */}
        {!editMode && (
          <Animated.View
            style={[styles.bottomBarWrap, { opacity: barsOpacity, bottom: Math.max(insets.bottom, 16) + 8 }]}
            pointerEvents={chromeVisible ? 'auto' : 'none'}
          >
            <PreviewBottomBar
              scheme="dark"
              actions={[
                { key: 'share', label: 'Share', icon: 'share-outline', onPress: handleShare, testID: 'preview-bar-share' },
                { key: 'save', label: 'Save', icon: 'download-outline', disabled: downloading, onPress: handleDownload, testID: 'preview-bar-save' },
                { key: 'versions', label: 'Versions', icon: 'time-outline', onPress: () => openInfo('versions'), testID: 'preview-bar-versions' },
                { key: 'info', label: 'Info', icon: 'information-circle-outline', onPress: () => openInfo('info'), testID: 'preview-bar-info' },
              ]}
            />
          </Animated.View>
        )}
        <InfoSheet
          visible={infoVisible}
          onClose={() => setInfoVisible(false)}
          fileId={currentFileId}
          filename={previewFileName}
          kindLabel={category === 'raw' ? rawFormatLabelValue : (CATEGORY_LABELS[category] ?? 'File')}
          sizeBytes={shownSizeBytes ?? null}
          extraRows={buildInfoSheetRows(mediaDetailsRows)}
          focus={infoFocus}
        />
        <PreviewOptionsPopover
          visible={optionsVisible}
          filename={previewFileName}
          actions={previewActions}
          onClose={() => setOptionsVisible(false)}
          top={insets.top + 62}
        />
        {/* Preview redesign item 4 — "Move to…", reusing FilesScreen's own
            FolderPickerModal (see the `handleOpenMovePicker` comment). */}
        <FolderPickerModal
          visible={movePicker !== null}
          title="Move"
          folders={movePicker?.folders ?? []}
          currentParentId={movePicker?.currentParentId ?? null}
          busy={moveBusy}
          onCancel={() => setMovePicker(null)}
          onConfirm={(targetId) => { void handleConfirmMove(targetId); }}
        />
      </Animated.View>
    );
  }

  // 1344 — unlike the media header (forced scheme="dark": the ground is
  // always the near-black mediaRoot behind arbitrary photo/video content),
  // this doc/PDF header follows the app's own resolved theme. The doc
  // content area already does — DocxRenderer/XlsxRenderer/ZipRenderer/
  // ArchiveRenderer/PptxRenderer all read `colors={c}` and the HTML toggle
  // bar/WebView read `c.paper`/`c.line`/`c.ink` — only the chrome (this
  // header) had been left as plain always-dark views. A document page is
  // usually a white sheet, not a theater-dark stage, so forcing dark glass
  // here would float a mismatched dark bar over an otherwise light screen in
  // light mode.
  //
  // 1346 — the two things 1344 explicitly handed off (DEVIATIONS.md "Phase 3
  // — Preview doc header (1344)"): `styles.root`'s own background, and the
  // renderers' error-state text. The argument that holds for the header
  // holds here too, harder: unlike the media header (which has no light-mode
  // artboard to argue from at all), this root sits under content that is
  // ALREADY scheme-aware on both sides of it — the header above follows
  // `resolved`, DocxRenderer/XlsxRenderer/ZipRenderer/ArchiveRenderer/
  // PptxRenderer/the HTML WebView all already paint `c.paper`. A forced-dark
  // root between two already-themed layers isn't "one predictable contrast
  // over unknown media" (the media-root argument) — it's a dark stripe left
  // over from before the doc header existed, that would show through at
  // insets.top (root's own paddingTop, before anything else paints) and
  // around any renderer that doesn't fully cover previewArea. Switched to
  // `c.paper`, the same root-background token every other screen in this
  // app uses (SettingsScreen, FilesScreen, LoginScreen, …). See
  // DEVIATIONS.md "Phase 4 — Preview light-mode rationale (1346)".
  //
  // CORRECTION, round 4 (lead review of round 3's own PDF screenshot,
  // `evidence-1563-redesign-r3/23-pdf-counter-1of4-FIXED.png`): the
  // paragraph above is right about `styles.root`'s OWN background
  // (`c.paper`, untouched below) but WRONG about the header/bottom-bar
  // CHROME following `resolved`. A PDF's own bytes render a literal white
  // page independent of the app's theme — unlike DocxRenderer/XlsxRenderer,
  // it never paints `c.paper`. On a device in dark mode, `resolved` picked
  // `glassMaterial('dark')`, whose 0.46-alpha fill washed out to a ~3.7:1
  // grey-on-grey bar over that white page — the exact screenshot the lead
  // flagged. Left here rather than deleted, per this workspace's "leave the
  // wrong claim visible, correct beneath it" convention. Chrome now always
  // renders through `PREVIEW_CHROME_MATERIAL` (see its own doc comment in
  // `glass-recipe.ts`) — measured safe over white/black/mid-grey, not just
  // argued from the (correct, for CONTENT) theme-tracking logic above.
  const docMaterial = PREVIEW_CHROME_MATERIAL;

  return (
    <Animated.View style={[styles.root, { backgroundColor: c.paper }, { transform: [{ translateY: closeTranslateYClamped }] }]}>
      <StatusBar style={statusBarStyle} hidden={!chromeVisible} animated />
      {/* Round 4 fix — see `header`'s own style comment for the two bugs
          this exact shape fixes (a stacking bug, then an accessibility-tree
          bug from the first attempt at fixing it). This wrapper floats over
          `previewArea` (now full-bleed); `header` inside it stays a plain,
          normally-sized row. */}
      <Animated.View
        style={[styles.chromeLayer, { opacity: barsOpacity }]}
        pointerEvents={chromeVisible ? 'auto' : 'none'}
        onLayout={(e) => {
          // Round 5 — the REAL rendered height of this wrapper (from y=0,
          // since it's `position:'absolute', top:0`) already bakes in
          // `insets.top` via the header's own inline `paddingTop`. Feeds
          // `computePreviewContentInset` above; see that function's doc
          // comment for why a measured height beats a guessed constant.
          const h = e.nativeEvent.layout.height;
          setDocHeaderHeight((prev) => (prev === h ? prev : h));
        }}
      >
      {/* Round 5 — a subtle top gradient scrim behind the status bar + this
          header (design requirement: "the clock stays legible when content
          scrolls beneath"). The header's own glass pills already clear WCAG
          AA via `PREVIEW_CHROME_MATERIAL` (round 4), but the strip ABOVE
          them — the real system status bar, y=0 to insets.top — has no
          background of its own: it's fully transparent, so once content
          scrolls, arbitrary document pixels can land directly behind the
          system clock/battery icons with no legibility guarantee at all.
          Banded Views (no `expo-linear-gradient` — see `gradient.ts`'s own
          doc comment for why this app never added that native module), one
          flat colour per scheme (dark scrim in dark mode, light in light —
          this backs the OS clock, which follows the app's OWN appearance,
          not the underlying document's colours, same reasoning as
          `PREVIEW_CHROME_MATERIAL` already applies to the bars themselves).
          Sized to the header's own measured height so it fades out exactly
          where the header's content ends, not into the page below it. */}
      <PreviewTopScrim height={docHeaderHeight ?? insets.top + 58} dark={surfaceIsDark} />
      {/* ---- Header ----
          Preview redesign item 7 — while editing a text file, this row
          becomes Done (left, the SAME dirty-guard exit as the ⋯ menu's
          "Done"/"Preview" item, `handleExitEditMode`) / status (center) /
          Save (right, amber, `handleSaveEdit`) instead of close/title/⋯ —
          and stays fully opaque regardless of `barsVisible` (item 7: "no
          bottom bar while editing"; `chromeVisible` above is forced true by
          `editMode`). Preview redesign item 1 — swipe-down-to-close on the
          header row (see the `closeTranslateY` comment by `handleClose`);
          covers both header variants below since PanGestureHandler forwards
          the ternary's single resolved child either way. */}
      <PanGestureHandler
        onGestureEvent={onCloseGestureEvent}
        onHandlerStateChange={onCloseHandlerStateChange}
        activeOffsetY={[-1000, 8]}
        failOffsetX={[-20, 20]}
      >
      {editMode ? (
        <View style={[styles.header, { paddingTop: insets.top + 8 }]} testID="preview-edit-topbar">
          <TouchableOpacity
            onPress={handleExitEditMode}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            testID="preview-edit-done"
            accessibilityLabel="Stop editing"
          >
            <GlassCapsule scheme="dark" materialOverride={docMaterial} contentStyle={styles.editTopBarPillBody}>
              <Text style={[styles.editTopBarPillText, { color: docMaterial.label }]}>Done</Text>
            </GlassCapsule>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <GlassCapsule
              scheme="dark"
              materialOverride={docMaterial}
              style={styles.docHeaderCapsule}
              contentStyle={styles.docHeaderCapsuleBody}
            >
              <Text style={[styles.docHeaderTitle, { color: docMaterial.label }]} numberOfLines={1}>
                {previewFileName}
              </Text>
              <View style={styles.headerSubRow}>
                <View style={[styles.editDirtyDot, { backgroundColor: docMaterial.label }]} />
                <Text style={[styles.docHeaderSubtitle, styles.mono, { color: docMaterial.labelMuted }]} numberOfLines={1}>
                  {isDirty ? 'Edited · not saved' : (statusLine ?? 'Editing')}
                </Text>
              </View>
            </GlassCapsule>
          </View>

          <TouchableOpacity
            onPress={() => { void handleSaveEdit(); }}
            disabled={!isDirty || saving}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            testID="preview-edit-save"
            accessibilityLabel="Save"
          >
            <View style={[styles.editSavePill, (!isDirty || saving) && styles.editSavePillDisabled]}>
              {saving ? (
                <ActivityIndicator size="small" color="#1A1405" />
              ) : (
                <Text style={styles.editSavePillText}>Save</Text>
              )}
            </View>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          {/* 1344 — outer TouchableOpacity wraps the fixed-size GlassCircle so
              hitSlop is not clipped to the disc (the hitSlop-clip bug 1343 just
              fixed on this screen's own media header, and 1341/1342 fixed on
              FilesScreen/TrashScreen — RN clips hitSlop to the parent's bounds
              when the touchable is nested INSIDE a fixed-size view, not
              wrapping it). Icon matches the media header's chevron-down
              exactly: Preview.dc.html only samples the media/video preview, so
              this doc header has no artboard of its own — extending the media
              header's icon choice by analogy is the same DERIVED class as
              1341/1342's non-canvas circles (DEVIATIONS.md). testID unchanged
              from 1336 — same value as the media header's close control, so a
              test can assert the preview is open without knowing which of the
              two headers rendered. */}
          <TouchableOpacity
            onPress={handleClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            testID="preview-close"
            accessibilityLabel="Close preview"
          >
            <GlassCircle scheme="dark" materialOverride={docMaterial} size={GLASS_CIRCLE_SIZES.action}>
              <Ionicons name="chevron-down" size={22} color={docMaterial.label} />
            </GlassCircle>
          </TouchableOpacity>

          {/* 1344 — same GlassCapsule shape/padding (7px 18px, radius 999) as
              the media header. Round 4 CORRECTION: this used to pass
              scheme=resolved instead of forced "dark" — see the CORRECTION
              note above `docMaterial`'s declaration for why that no longer
              holds for the CHROME (the `c.paper` content-background argument
              a few paragraphs up is still correct and unrelated). Subtitle
              colour reads `docMaterial.labelMuted` (now `PREVIEW_CHROME_MATERIAL`'s
              token, not `glassMaterial(resolved)`'s).
              Preview redesign item 2 — subtitle gets a lock icon + "Encrypted"
              prefix (design: amber lock icon, "Encrypted · Type · size"). */}
          <View style={styles.headerCenter}>
            <GlassCapsule
              scheme="dark"
              materialOverride={docMaterial}
              style={styles.docHeaderCapsule}
              contentStyle={styles.docHeaderCapsuleBody}
            >
              <Text
                style={[styles.docHeaderTitle, { color: docMaterial.label }]}
                numberOfLines={1}
              >
                {previewFileName}
              </Text>
              <View style={styles.headerSubRow}>
                <Ionicons name="lock-closed" size={10} color={colors.amber} />
                <Text
                  style={[styles.docHeaderSubtitle, styles.mono, { color: docMaterial.labelMuted }]}
                  numberOfLines={1}
                >
                  {/* Preview redesign item 2 — the separate "MARKDOWN"-style
                      lang badge (removed below) truncated the size on the
                      same row. A text file's type now reads from
                      `codeLanguageLabel` ("Markdown", "TypeScript", "Plain
                      text", …) INSTEAD OF the generic `CATEGORY_LABELS['doc']`
                      ("Document") it fell into before — one accurate word in
                      the subline, matching design section 02's "Encrypted ·
                      Markdown · 184 B", rather than a second chip. */}
                  {`Encrypted · ${isText ? codeLanguageLabel : (CATEGORY_LABELS[category] ?? 'File')}${shownSizeBytes != null ? ` · ${formatSize(shownSizeBytes)}` : ''}`}
                </Text>
              </View>
            </GlassCapsule>
          </View>

          <TouchableOpacity
            onPress={handlePreviewOptions}
            disabled={downloading || trashing}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Open file options"
          >
            <GlassCircle
              scheme="dark"
              materialOverride={docMaterial}
              size={GLASS_CIRCLE_SIZES.action}
              style={(downloading || trashing) ? styles.disabledIconButton : undefined}
            >
              <Ionicons name="ellipsis-horizontal" size={21} color={docMaterial.label} />
            </GlassCircle>
          </TouchableOpacity>
        </View>
      )}
      </PanGestureHandler>

      {/* Preview redesign item 6 — floating page counter (PDF), same
          fade-with-chrome behaviour as the media branch's pill.
          Same fix as the media branch's matching pill above: `insets.top + 58`
          matches THIS header's own `PreviewOptionsPopover` anchor below —
          "just under the bar," not `insets.top + 8` (the header's own top,
          which visually collided with the ⋯ circle). */}
      </Animated.View>

      {/* Preview redesign item 3 — the "e2e" pill is retired (see the media
          branch's matching removal note); the lock now lives in the header
          subtitle above. */}

      <PreviewOptionsPopover
        visible={optionsVisible}
        filename={previewFileName}
        actions={previewActions}
        onClose={() => setOptionsVisible(false)}
        top={insets.top + 58}
      />
      {/* Preview redesign item 4 — "Move to…", reusing FilesScreen's own
          FolderPickerModal (see the `handleOpenMovePicker` comment). */}
      <FolderPickerModal
        visible={movePicker !== null}
        title="Move"
        folders={movePicker?.folders ?? []}
        currentParentId={movePicker?.currentParentId ?? null}
        busy={moveBusy}
        onCancel={() => setMovePicker(null)}
        onConfirm={(targetId) => { void handleConfirmMove(targetId); }}
      />

      {/* ---- Preview area ----
          1346 — the nine reachable error-state Texts below (isSvg through
          isPptx) switch from the forced `colors.white` (1344's flagged
          hand-off, DEVIATIONS.md "Phase 3 — Preview doc header (1344)") to
          `c.ink`/`c.ink3`: with `styles.root` now `c.paper` (see the
          docMaterial comment above `return (`), the old white-on-forced-
          dark text would have gone invisible white-on-paper in light mode —
          exactly the regression 1344 warned a half-fix would create. The
          paired imageStatusSub subtext gets the same c.ink3 treatment
          inline per site, since its base style (see imageStatusSub's own
          comment) has no scheme of its own to read.

          NOT touched: the isImage and isVideo branches immediately below
          are DEAD CODE in this doc branch — isMediaPreview
          (`= isImage || isVideo`) already returned early above, in the
          `if (isMediaPreview)` block, so isImage/isVideo are always false
          by the time this switch runs. Left as colors.white rather than
          silently "fixed": they never render, so there is nothing to
          regress, and touching unreachable code isn't part of this
          decision. */}
      <View style={styles.previewArea}>
        {contentLocked ? (
          // Task 1539 (finding 1, P0): the doc branch (pdf/docx/spreadsheet/
          // html/zip/archive/text/pptx/svg) — every content-loading effect
          // for these categories is gated the same way as the media branch
          // above, via `contentLocked` in their dependency arrays.
          <Pressable
            style={styles.imageStatus}
            onPress={() => { void handleUnlockCurrent(currentFileId); }}
            disabled={unlockingFileId === currentFileId}
            accessibilityRole="button"
            accessibilityLabel="Locked file — tap to authenticate"
            testID="preview-locked-doc"
          >
            <Ionicons name="lock-closed" size={40} color={c.amber} />
            <Text style={[styles.imageStatusTitle, { color: c.ink }]}>Locked</Text>
            <Text style={[styles.imageStatusSub, { color: c.ink3 }]}>
              {unlockingFileId === currentFileId ? 'Authenticating...' : 'Tap to authenticate and view this file.'}
            </Text>
            {/* Task 1539 (finding 5, lead decision — PR #109 review): see
                lock-copy.ts — the lock is not visible to the File Provider
                extension, so say so wherever there is room. */}
            <Text style={[styles.imageStatusSub, { color: c.ink3 }]}>{FILES_APP_LOCK_CAVEAT}</Text>
          </Pressable>
        ) : isImage ? (
          imageError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load image
              </Text>
              <Text style={styles.imageStatusSub}>{imageError}</Text>
            </View>
          ) : imageUri ? (
            // Preview redesign item 1 ("images/RAW on black") — `#000`
            // lifted verbatim from `design/preview-redesign-ios.html`'s
            // `.photo{background:#000}`; see the `fullBleedFill` style
            // comment for why this escapes `previewArea`'s centering
            // instead of changing it.
            <View style={[styles.fullBleedFill, styles.imageBleedBg]}>
              {originalImageActive ? (
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
              )}
            </View>
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isSvg ? (
          wrappedSvgHtml ? (
            // Task 1564 — root cause: `previewArea` (this branch's direct
            // parent) sets justifyContent:'center'/alignItems:'center'.
            // Confirmed by isolated repro (7 build/device iterations on iOS
            // 27, bb-1564 sim) that react-native-webview's Fabric-mounted
            // WKWebView never paints — not even its own background — when
            // its DIRECT parent centers it, regardless of the WebView's own
            // sizing (flex:1, percentage, or percentage+alignSelf:'stretch'
            // all failed identically; the SAME child style renders correctly
            // once the direct parent drops centering). This plain flex:1
            // wrapper (default align:'stretch') is the fix — give the
            // WebView a non-centered direct parent instead of touching
            // react-native-webview itself.
            //
            // Preview redesign item 3 — 1564 is merged, so this branch now
            // also gets the same full-bleed + tap-to-hide frame as every
            // other type. `Pressable` sits ABOVE `svgWebViewWrap`, which
            // stays the WebView's unchanged DIRECT parent (still plain
            // flex:1, still not centering) — the fix above is untouched.
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              <View style={styles.svgWebViewWrap}>
                <WebView
                  originWhitelist={['*']}
                  source={{ html: wrappedSvgHtml }}
                  style={styles.svgWebView}
                  scalesPageToFit
                  showsHorizontalScrollIndicator={false}
                  showsVerticalScrollIndicator={false}
                />
              </View>
            </Pressable>
          ) : svgError ? (
            renderLoadError("Couldn't load SVG", svgError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isPdf ? (
          pdfUri ? (
            // Preview redesign item 1 ("PDF pages full width") + item 6
            // (floating page counter, wired via `onPageInfo` — see the
            // `pageCounterLabel`/`pdfPageInfo` state above and the pill
            // rendered in the header block). `#2A2A28` lifted verbatim from
            // the design's `.pdf{background:#2A2A28}` page-gutter colour.
            <Pressable
              style={[styles.fullBleedFill, styles.pdfBleedBg]}
              onPress={handleContentTap}
              testID="preview-content-tap"
            >
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <PdfRenderer
                  filePath={pdfUri}
                  onPageInfo={setPdfPageInfo}
                  topInset={docContentInset.top}
                  bottomInset={docContentInset.bottom}
                />
              </Suspense>
            </Pressable>
          ) : pdfError ? (
            renderLoadError("Couldn't load PDF", pdfError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isVideo ? (
          videoUri ? (
            // Preview redesign item 1 ("video" full-bleed) — same black
            // ground as the image branch above (design's `.photo{background:
            // #000}`; there is no separate video mock, so this is DERIVED by
            // analogy to the photo one, same class as PdfRenderer's onPageInfo
            // extension).
            <View style={[styles.fullBleedFill, styles.imageBleedBg]}>
              <VideoView
                player={player}
                style={[styles.videoControlsSurface, videoControlsBottomStyle]}
                contentFit="contain"
                nativeControls
                fullscreenOptions={{ enable: true }}
                allowsPictureInPicture
              />
            </View>
          ) : videoError ? (
            renderLoadError("Couldn't load video", videoError, 'media')
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(true)}
            </View>
          )
        ) : isAudio ? (
          // Task 1568 — native audio player. `Pressable` gives the same
          // tap-to-hide-chrome gesture every other doc-branch renderer has;
          // AudioRenderer itself has no WebView (task 1564's centered-parent
          // trap doesn't apply here) and honours `docContentInset` as
          // container padding, same convention as every other renderer's
          // topInset/bottomInset props.
          audioUri ? (
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <AudioRenderer
                  uri={audioUri}
                  fileName={previewFileName}
                  formatLabel={audioFormatLabel}
                  colors={c}
                  topInset={docContentInset.top}
                  bottomInset={docContentInset.bottom}
                />
              </Suspense>
            </Pressable>
          ) : audioError ? (
            renderLoadError("Couldn't load audio", audioError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isText ? (
          editMode ? (
            // Task 1563 — `previewArea`'s `alignItems:'center'`/`justifyContent:'center'`
            // (tuned for centering a small spinner/error message) shrinks any
            // ordinary `flex:1` child to its CONTENT width, not the screen's —
            // confirmed on-device (bb-ios27): the editor rendered as a narrow
            // floating column instead of full-bleed. `fullBleedFill` escapes
            // that via absolute positioning, the same technique CodeRenderer's
            // own `root` style already uses for exactly this reason.
            <View style={styles.fullBleedFill}>
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <TextEditorView
                  initialText={editText ?? textContent ?? ''}
                  language={codeLanguage}
                  onChangeText={setEditText}
                  bottomInset={Math.max(insets.bottom, 16)}
                  // Build 217 bug fix — reuses the SAME measured header
                  // height CodeRenderer's read-only sibling already gets via
                  // its own `topInset` prop a few branches up (`docHeaderHeight`
                  // is measured off the SAME wrapper for both the normal and
                  // edit-mode header — see that `onLayout`'s own comment).
                  // Edit mode's header row is a plain (non-scrolling) header
                  // like the normal one, just with different content, so the
                  // exact same inset applies.
                  topInset={docContentInset.top}
                />
              </Suspense>
            </View>
          ) : textContent != null ? (
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              {/* Task 1563 limit (item 6): an honest notice, no Edit button,
                  when the file loaded fine for READING but fails the edit
                  gate (over 2 MB, or content that looks like a lossy UTF-8
                  decode) — never a silently-disabled control with no reason. */}
              {editGate.reason && (
                // Round 5 — this banner is its OWN floating overlay above the
                // scrollable content below, so it needs the same top inset
                // the header itself does (`top: 0` used to sit it directly
                // under the header, i.e. exactly the collision this task
                // fixes, just moved one layer down). Its onLayout feeds the
                // content's OWN extra offset just below, so content starts
                // below the banner, not under it.
                <View
                  style={[styles.readOnlyBanner, { top: docContentInset.top, backgroundColor: c.paper2, borderColor: c.line }]}
                  testID="text-readonly-notice"
                  onLayout={(e) => {
                    const h = e.nativeEvent.layout.height;
                    setReadOnlyBannerHeight((prev) => (prev === h ? prev : h));
                  }}
                >
                  <Ionicons name="information-circle-outline" size={16} color={c.ink3} />
                  <Text style={[styles.readOnlyBannerText, { color: c.ink2 }]}>{editGate.reason}</Text>
                </View>
              )}
              {/* Preview redesign / DEVIATIONS.md — the ⋯ menu's "Show
                  source" (design section 02) shows a markdown file's raw
                  text via the SAME CodeRenderer the plain-text/code path
                  already uses, without leaving the rendered-preview screen. */}
              {isMarkdown && !showSource ? (
                <ScrollView
                  style={styles.markdownScroll}
                  showsVerticalScrollIndicator
                  // Round 5 — on `contentContainerStyle` (not a prop into
                  // MarkdownRenderer itself), same reasoning as
                  // CodeRenderer's own ScrollView: the viewport stays full-
                  // bleed, only the CONTENT gets the extra padding, so
                  // scrolling moves the rendered markdown UNDER the
                  // translucent bars instead of clipping at a shrunk edge.
                  contentContainerStyle={{
                    paddingTop: docContentInset.top + (editGate.reason ? (readOnlyBannerHeight ?? 44) : 0),
                    paddingBottom: docContentInset.bottom,
                  }}
                >
                  <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                    <MarkdownRenderer markdown={textContent} colors={c} />
                  </Suspense>
                </ScrollView>
              ) : (
                <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                  <CodeRenderer
                    code={textContent}
                    language={codeLanguage}
                    topInset={docContentInset.top + (editGate.reason ? (readOnlyBannerHeight ?? 44) : 0)}
                    bottomInset={docContentInset.bottom}
                  />
                </Suspense>
              )}
            </Pressable>
          ) : textError ? (
            renderLoadError("Couldn't load file", textError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isDocx ? (
          docxData ? (
            // Preview redesign item 3 — full-bleed + tap-to-hide, same frame
            // as every other type. `Pressable` is an ANCESTOR of
            // `DocxRenderer`, not its direct parent — its own internal
            // WebView already has its own non-centering flex:1 wrapper
            // (task 1564), untouched by this.
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <DocxRenderer
                  data={docxData}
                  colors={c}
                  isDark={resolved === 'dark'}
                  topInset={docContentInset.top}
                  bottomInset={docContentInset.bottom}
                />
              </Suspense>
            </Pressable>
          ) : docxError ? (
            renderLoadError("Couldn't open document", docxError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isSpreadsheet ? (
          sheetData ? (
            // Preview redesign item 3 — full-bleed + tap-to-hide (no WebView
            // in this renderer, so no direct-parent-centering concern).
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <XlsxRenderer
                  data={sheetData}
                  colors={c}
                  topInset={docContentInset.top}
                  bottomInset={docContentInset.bottom}
                />
              </Suspense>
            </Pressable>
          ) : sheetError ? (
            renderLoadError("Couldn't open spreadsheet", sheetError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isHtml ? (
          htmlContent != null ? (
            // Preview redesign item 3 — full-bleed + tap-to-hide.
            // `htmlContainer` (flex:1, unchanged) stays the WebView's DIRECT
            // parent in the "Rendered" toggle state — it never centered its
            // children, so task 1564's fix was never needed here; `Pressable`
            // is only an ancestor of that, same as every other branch above.
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
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
                // 1346 — was `backgroundColor: colors.darkBg` (forced): the
                // code line numbers/text right below already read
                // `c.ink3`/`c.ink` (scheme-aware, unchanged by this task),
                // so in light mode this was DARK TEXT ON A FORCED-DARK
                // BACKGROUND read against a forced-dark scroll surface —
                // i.e. it was already correct only by accident, because
                // `styles.root` behind it was ALSO forced dark before this
                // task. Once root moved to `c.paper` (docMaterial comment
                // above `return (`) this would have flipped to dark-on-dark
                // and gone illegible — the argument for forcing dark never
                // held here (this is the code view's own opaque background,
                // not chrome over arbitrary media), so it now matches the
                // sibling WebView branch's own `c.paper` a few lines below.
                <ScrollView
                  style={[styles.codeScroll, { backgroundColor: c.paper, borderRadius: 0 }]}
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
            </Pressable>
          ) : htmlError ? (
            renderLoadError("Couldn't load page", htmlError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isZip ? (
          zipData ? (
            // Preview redesign item 3 — full-bleed + tap-to-hide (no WebView
            // in this renderer).
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <ZipRenderer
                  data={zipData}
                  colors={c}
                  topInset={docContentInset.top}
                  bottomInset={docContentInset.bottom}
                />
              </Suspense>
            </Pressable>
          ) : zipError ? (
            renderLoadError("Couldn't open archive", zipError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isArchive ? (
          archiveData ? (
            // Preview redesign item 3 — full-bleed + tap-to-hide (no WebView
            // in this renderer).
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <ArchiveRenderer
                  data={archiveData}
                  extension={(currentFileName ?? '').toLowerCase().split('.').pop() ?? 'tar'}
                  colors={c}
                  topInset={docContentInset.top}
                  bottomInset={docContentInset.bottom}
                />
              </Suspense>
            </Pressable>
          ) : archiveError ? (
            renderLoadError("Couldn't open archive", archiveError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : isPptx ? (
          pptxData ? (
            // Preview redesign item 3 — full-bleed + tap-to-hide (no WebView
            // in this renderer).
            <Pressable style={styles.fullBleedFill} onPress={handleContentTap} testID="preview-content-tap">
              <Suspense fallback={<View style={styles.imageStatus}>{renderSharedProgress(false)}</View>}>
                <PptxRenderer
                  data={pptxData}
                  colors={c}
                  topInset={docContentInset.top}
                  bottomInset={docContentInset.bottom}
                />
              </Suspense>
            </Pressable>
          ) : pptxError ? (
            renderLoadError("Couldn't open presentation", pptxError)
          ) : (
            <View style={styles.imageStatus}>
              {renderSharedProgress(false)}
            </View>
          )
        ) : (
          // Preview redesign item 3 — tap-to-hide only (no full-bleed):
          // per DEVIATIONS.md, the fallback card is a centered card by
          // design (section 03's own "good" list separates full-bleed
          // content from the card pattern — there is no mock of this card
          // running edge to edge), so `previewArea`'s centering stays;
          // `Pressable` just adds the same tap gesture every other type
          // now has, without changing the card's own layout.
          <Pressable onPress={handleContentTap} testID="preview-content-tap">
          <View style={styles.genericPlaceholder}>
            {/* 1346 — genericIconText stays colors.white: this badge's
                background (categoryAccent, just above) is ALREADY
                theme-aware (c.amber/c.red/c.green/c.ink2/c.ink3 per
                category — "Theme-aware accent for non-image category
                badge" comment above categoryAccent's definition), and
                predates this task. A solid coloured tile with a fixed
                light glyph is an established, self-contained badge
                pattern (matches the FAB and other coloured icon tiles
                elsewhere in the app) — independent of styles.root, so
                unaffected by this task's root-background decision. Not
                touched. */}
            <View style={[styles.genericIcon, { backgroundColor: categoryAccent }]}>
              <Text style={styles.genericIconText}>
                {CATEGORY_BADGE[category] ?? 'FILE'}
              </Text>
            </View>
            {/* 1346 — title/sub WERE colors.white/rgba(255,255,255,0.5): sit
                directly on styles.root (now c.paper, docMaterial comment
                above `return (`), same regression class as the
                error-state text above. Switched to c.ink/c.ink3. */}
            <Text style={[styles.genericTitle, { color: c.ink }]}>{CATEGORY_LABELS[category] ?? 'File'}</Text>
            <Text style={[styles.genericSub, { color: c.ink3 }]}>
              {isUnlocked
                ? 'Download to decrypt and open this file.'
                : 'Unlock your vault to decrypt this file.'}
            </Text>
          </View>
          </Pressable>
        )}
      </View>

      {/* Preview redesign item 6 — floating page counter (PDF). Bug found
          verifying rung (g) on-device with a real multi-page PDF: this used
          to render INSIDE the header's own chrome wrapper, BEFORE
          `previewArea` in the tree — confirmed via instrumented
          `onLoadComplete`/`onPageChanged` logs that `pdfPageInfo` (and so
          `pageCounterLabel`) was correctly populated ("1 / 4"), yet the pill
          was never visible on screen. `react-native-pdf`'s native view
          consistently painted over it regardless of the pill's own
          `zIndex: 14` — a zIndex only reorders siblings sharing the SAME
          parent, and the real competing siblings here are the whole chrome
          wrapper vs. `previewArea`, neither of which had one set. Moved to
          a genuine sibling AFTER `previewArea` closes instead — the exact
          position the bottom bar below already uses successfully (proven
          visible over the very same PDF in every screenshot this pass). */}
      {!editMode && pageCounterLabel && (
        <View style={[styles.pageCounterWrap, { top: insets.top + 58 }]} pointerEvents="none">
          <GlassCapsule scheme="dark" materialOverride={docMaterial} contentStyle={styles.pageCounterBody}>
            <Text style={[styles.pageCounterText, styles.mono, { color: docMaterial.label }]}>{pageCounterLabel}</Text>
          </GlassCapsule>
        </View>
      )}

      {/* ---- Details sheet (handle-only, pull up to expand) ---- */}
      {/* ---- Bottom bar + Info sheet (item 3/5) ----
          Same removal as the media branch: DetailsSheet's permanent
          collapsed peek is retired in favour of an on-demand Info sheet,
          reached from here or the ⋯ menu's "Version history". No bottom
          bar while editing (item 7). */}
      {!editMode && (
        <Animated.View
          style={[styles.bottomBarWrap, { opacity: barsOpacity, bottom: Math.max(insets.bottom, 16) + 8 }]}
          pointerEvents={chromeVisible ? 'auto' : 'none'}
          onLayout={(e) => {
            // Round 5 — the bar's OWN height (not its offset from the safe
            // area, which `computePreviewContentInset` adds separately).
            const h = e.nativeEvent.layout.height;
            setDocBottomBarHeight((prev) => (prev === h ? prev : h));
          }}
        >
          <PreviewBottomBar
            scheme="dark"
            actions={[
              { key: 'share', label: 'Share', icon: 'share-outline', onPress: handleShare, testID: 'preview-bar-share' },
              { key: 'save', label: 'Save', icon: 'download-outline', disabled: downloading, onPress: handleDownload, testID: 'preview-bar-save' },
              { key: 'versions', label: 'Versions', icon: 'time-outline', onPress: () => openInfo('versions'), testID: 'preview-bar-versions' },
              { key: 'info', label: 'Info', icon: 'information-circle-outline', onPress: () => openInfo('info'), testID: 'preview-bar-info' },
            ]}
          />
        </Animated.View>
      )}
      <InfoSheet
        visible={infoVisible}
        onClose={() => setInfoVisible(false)}
        fileId={currentFileId}
        filename={previewFileName}
        kindLabel={CATEGORY_LABELS[category] ?? 'File'}
        sizeBytes={shownSizeBytes ?? null}
        pageCount={pdfPageInfo?.total ?? null}
        extraRows={buildInfoSheetRows([
          ...(currentCreatedAt ? [{ label: 'Created', value: formatDate(currentCreatedAt) }] : []),
          ...(fileFormat ? [{ label: 'Format', value: fileFormat }] : []),
          ...(currentMimeType ? [{ label: 'Type', value: currentMimeType }] : []),
        ])}
        focus={infoFocus}
      />
    </Animated.View>
  );
}

// 1346 — reviewed, NOT touched: this popover (rendered from both the media
// branch, line ~3070ish, and the doc branch, ~line 3235ish) is entirely
// unschemed — a self-contained dark panel (rgba(37,35,31,0.94) fill, white-
// ish text, styles below) with no useTheme() of its own. It floats above
// both branches and doesn't depend on `styles.root`, so this task's root-
// background change doesn't newly break it — it was already forced dark
// before and after. 1344's hand-off named exactly two elements (`styles.
// root`'s background and the renderers' error-state text); this popover
// wasn't one of them, and re-theming a whole separate floating-menu
// component is a bigger decision than "attribute or flip a colour" —
// flagging as a candidate for its own follow-up task rather than folding it
// in here unannounced. Same class of gap: `src/components/preview/
// DetailsSheet.tsx` (a SEPARATE FILE, out of this dispatch's scope
// entirely) is also entirely unschemed and used by both branches.
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
  // Preview redesign (task 1563 follow-up, design item 1 — "every preview
  // type runs edge to edge"): `previewArea` below centers its children
  // (tuned for a small spinner/error message) and shrinks any ordinary
  // `flex:1` child to its CONTENT width rather than the screen's — confirmed
  // on-device for the text editor (comment at that call site). Absolute
  // positioning escapes it without touching `previewArea` itself, so the
  // generic/fallback/error states (which DO want centering — a "card" is
  // supposed to be a card) are untouched, and so is the isSvg/isHtml WebView
  // branch below (task 1564, in flight in a sibling worktree, touches those
  // exact lines — see DEVIATIONS.md). Used by the editor, and now also by
  // the image/PDF/video branches for the same full-bleed requirement.
  fullBleedFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  imageBleedBg: { backgroundColor: '#000000' },
  pdfBleedBg: { backgroundColor: '#2A2A28' },
  markdownScroll: {
    flex: 1,
  },
  // Rung (f) bug found verifying this pass: this banner used to be a plain
  // NORMAL-FLOW sibling before CodeRenderer in the JSX, expecting to sit
  // above it and push it down. But `CodeRenderer`'s own root is
  // `position:'absolute', top:0,...` with an OPAQUE background (its own
  // fullBleedFill escape from `previewArea`'s centering, same class of fix
  // as this screen's) — a later-JSX absolutely-positioned opaque sibling
  // paints OVER an earlier normal-flow one at the same top edge, so the
  // read-only notice rendered (proven: `editGate.reason` was correctly
  // truthy, `canEditText` correctly hid the ⋯ menu's Edit item) but was
  // never actually VISIBLE — confirmed on-device with a real >2 MB file
  // (screenshot showed only CodeRenderer's own unrelated 300k-char
  // truncation notice). Fixed by pulling this banner OUT of flow too, with
  // an explicit `zIndex` above CodeRenderer's implicit 0, so it floats on
  // top instead of losing a z-order fight it can't win by JSX order alone.
  readOnlyBanner: {
    position: 'absolute',
    // `top: 0` here is only the pre-round-5 default; every real call site
    // overrides it inline with `docContentInset.top` (see the JSX call
    // site's own comment) so the banner sits below the floating header
    // instead of under it.
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  readOnlyBannerText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 17,
  },
  // The floating top-chrome layer, shared by the media and doc branches:
  // it must be the view carrying position + zIndex, because it is the one
  // that is a SIBLING of the full-screen content (zIndex only orders
  // siblings). See the comment at the media branch's wrapper and `header`'s
  // style comment for the on-device bugs this shape fixes.
  chromeLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  // A plain in-flow row inside `chromeLayer` — NOT absolute: an absolute row
  // here collapses its ancestors to a zero frame, which hides the close/⋯
  // controls from the accessibility tree (and, pre-fix, from touches).
  // It still needs its OWN zIndex: its sibling `ScrollEdgeBlur` is absolute
  // with zIndex 5, and without this the blur paints over the glass controls
  // (seen on bb-qa-2 while verifying this fix: a frosted, unreadable header).
  mediaHeader: {
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 12,
  },
  disabledIconButton: {
    opacity: 0.48,
  },
  mediaHeaderText: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  // 1343 — maxWidth: '100%' (not width/flex) so the capsule hugs a short
  // filename instead of always stretching to the row's full available
  // width, while still capping at that width for a long one (percentage
  // resolves against mediaHeaderText's flex-resolved px width, so the
  // Title/Subtitle Texts' own numberOfLines={1} keeps truncating correctly).
  mediaHeaderCapsule: {
    maxWidth: '100%',
  },
  // Canvas Preview.dc.html: `border-radius: 999px; padding: 7px 18px` —
  // lifted verbatim (GlassCapsule already defaults radius to GLASS_RADII.capsule).
  mediaHeaderCapsuleBody: {
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 7,
  },
  mediaHeaderTitle: {
    maxWidth: '100%',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
  },
  // 1343 — mono (canvas: class="mono"), fontSize 10, and the 0.40-alpha
  // colour are all lifted verbatim from Preview.dc.html's own subtitle span.
  // That 0.40 is a one-off artboard value, not the shared glassMaterial()
  // labelMuted token (0.62 elsewhere in this canvas) — see DEVIATIONS.md.
  mediaHeaderSubtitle: {
    maxWidth: '100%',
    marginTop: 2,
    color: 'rgba(240,238,233,0.40)',
    fontSize: 10,
    lineHeight: 13,
  },
  // e2eBadgeWrap/e2eBadgeBody/e2eBadgeText: removed (preview redesign item
  // 3 — the "e2e" pill is retired; see the JSX removal notes in both
  // branches and DEVIATIONS.md).
  // Preview redesign item 2 — the header subtitle's lock icon + "Encrypted"
  // row (design: `<svg class="lk">` + `<span class="enc">Encrypted</span>`).
  encSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  // Preview redesign item 6 — the floating page-counter pill. Position
  // DERIVED (top-right, under the bar) from the design's `.pgind` (right:
  // 4cqw, top: 27cqw on a 300pt-wide phone artboard ≈ just under the header);
  // this app has a real safe-area inset instead of a fixed cqw offset.
  pageCounterWrap: {
    position: 'absolute',
    right: 16,
    zIndex: 14,
  },
  pageCounterBody: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pageCounterText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ECE8DF',
  },
  // Preview redesign item 3 — the glass bottom bar's positioning wrapper
  // (the bar itself, `PreviewBottomBar`, is unschemed/reusable; only its
  // screen position is this screen's concern).
  bottomBarWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 15,
  },
  mono: {
    fontFamily: fonts.mono,
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
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
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
  // 1346 — colors.white/rgba(255,255,255,…) forced: only ever rendered
  // inside the swipeable photo pager, which is only reachable from
  // isMediaPreview — same forced-dark-ground argument as mediaMaterial
  // above `if (isMediaPreview)` in the main component.
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
  videoControlsSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  mediaVideoStageWrap: {
    position: 'relative',
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
  },
  streamBadgeLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  streamBadge: {
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  streamBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  optionsLayer: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
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

  // 1346 — backgroundColor moved to an inline `c.paper` at the JSX call
  // site (was baked-in colors.darkBg, forced regardless of scheme — see the
  // docMaterial comment above `return (`).
  root: {
    flex: 1,
  },

  // ---- Header ----
  // Round 4 (lead review): this used to be a plain in-flow row, sized by
  // `root`'s own `paddingTop: insets.top` above it — which meant
  // `previewArea` below (a normal-flow sibling) started BELOW both the
  // inset AND this row's own height, painting `root`'s opaque
  // `backgroundColor` behind that whole span. That's the "header sits on an
  // opaque dark band, content starts at y≈310/2000" bug — the design says
  // content runs UNDER the translucent bars, not after them. `root` no
  // longer sets `paddingTop` at all, and `previewArea` below is now a
  // full-screen absolute layer, so content reaches y=0.
  //
  // The float-above-content positioning (`position:'absolute', top/left/
  // right:0, zIndex:20`) lives on the WRAPPING `<Animated.View>` at the JSX
  // call site, not here on `header` itself — two on-device bugs, in order:
  // (1) first attempt put it here on `header`. `previewArea` is a sibling of
  // that OUTER wrapper, not of `header` (`header` is nested one more level
  // in, inside `PanGestureHandler`) — zIndex only resolves stacking among
  // siblings sharing one parent, so `header`'s zIndex never even entered the
  // comparison against `previewArea`'s; the header vanished completely
  // behind the (correctly full-bleed) PDF page, confirmed on-device
  // (`evidence-1563-redesign-r4/01-pdf-fixed.png`).
  // (2) moving position:absolute here (to `header`) instead of the wrapper
  // fixed the visual stacking (the wrapper itself got the zIndex) but then
  // made THIS view the one with zero contributed size — its own parent
  // chain (wrapper > PanGestureHandler > header) collapsed to a zero
  // accessibility frame, and Maestro/XCUITest could no longer find ANY
  // element inside it (`maestro hierarchy` showed the close/⋯ circles
  // rendering on screen but absent from the accessibility tree entirely —
  // confirmed by dumping the hierarchy and finding nothing in the header's
  // screen region). Fixed by keeping `header` a plain, normally-sized
  // in-flow row and putting the absolute positioning + zIndex on the
  // wrapper instead — the wrapper's frame now comes from `header`'s real
  // (non-zero) content size, same as any ordinary floating-header pattern.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  // 1344 — closeButton/closeIcon/headerIconButton (plain circles, no glass)
  // retired: the close/options controls are now GlassCircle (see the JSX),
  // matching 1343's media header. disabledIconButton (below) stays — it's
  // shared with the media header's GlassCircle disabled state too.
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    // Matches 1343's mediaHeaderText: minWidth: 0 lets this flex:1 child
    // shrink below its content size in the row, which is what makes the
    // capsule's own numberOfLines={1} truncation actually engage for a long
    // filename instead of the row just overflowing.
    minWidth: 0,
  },
  // 1344 — the title/subtitle capsule's own shape: maxWidth: '100%' (not
  // width/flex) so it hugs a short filename and only stretches to the row's
  // full available width for a long one, same reasoning as 1343's
  // mediaHeaderCapsule. Padding 7px 18px is the same canvas value 1343 lifted
  // for the media header (Preview.dc.html:49) — there is no separate doc
  // artboard, so this is DERIVED-by-extension, not a fresh sample.
  docHeaderCapsule: {
    maxWidth: '100%',
  },
  docHeaderCapsuleBody: {
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 7,
  },
  docHeaderTitle: {
    maxWidth: '100%',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
  },
  // No baked-in colour (unlike 1343's mediaHeaderSubtitle, which bakes the
  // media header's forced-dark one-off 0.40 literal): this header follows
  // the app's resolved scheme, so the colour must flip with it and is set
  // inline from `docMaterial.labelMuted` at the call site instead.
  // flexShrink: 1 + minWidth: 0 (review finding, 1344): without them this
  // Text refuses to shrink below its own content width inside headerSubRow's
  // row, so on a narrow screen or with enlarged text the langBadge sitting
  // beside it (fixed intrinsic width, no flexShrink) gets pushed past the
  // capsule's clipped bounds and silently disappears instead of the subtitle
  // truncating first. numberOfLines={1} already ellipsizes; these two just
  // let that truncation actually engage before the badge is squeezed out.
  docHeaderSubtitle: {
    maxWidth: '100%',
    marginTop: 2,
    fontSize: 10,
    lineHeight: 13,
    flexShrink: 1,
    minWidth: 0,
  },
  // width: '100%' (review finding, 1344): bounds this row to the capsule's
  // own available content width so the subtitle Text above has something
  // concrete to shrink against — without it the row is free to size itself
  // to its children's natural (unshrunk) width, which is the other half of
  // the same clipped-badge bug docHeaderSubtitle's flexShrink fixes.
  headerSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
    width: '100%',
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

  // ---- Edit-mode top bar (preview redesign item 7) ----
  editTopBarPillBody: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  editTopBarPillText: {
    fontSize: 14,
    fontWeight: '600',
  },
  editDirtyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  // Amber, matching the design's "Save" pill exactly (`background:var(--amber)`)
  // — the app's ONE accent colour, used here for its brand-canonical purpose
  // (a primary action), per the workspace's own "one accent colour" rule.
  editSavePill: {
    backgroundColor: colors.amber,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minWidth: 58,
    alignItems: 'center',
  },
  editSavePillDisabled: {
    opacity: 0.4,
  },
  editSavePillText: {
    color: '#1A1405',
    fontSize: 14,
    fontWeight: '700',
  },

  // ---- Preview area ----
  // Round 4 (lead review) — `flex: 1` sized this to whatever space was left
  // BELOW `header` in normal flow (the actual dead-band bug; see `header`'s
  // own comment). Absolute + inset 0 makes this span the WHOLE root
  // regardless of the header floating above it, so every `fullBleedFill`
  // child inside it (already proven to escape `justifyContent`/`alignItems`/
  // `paddingHorizontal` here — see the `fullBleedFill` style comment) now
  // reaches all four edges of the SCREEN, not just of the old, header-
  // shrunk remainder. The non-full-bleed states (locked/error/fallback
  // cards) still center within this box — now centered on the whole screen,
  // which is the same "content runs under the bars" behaviour, just applied
  // to a small card instead of a full-bleed page.
  previewArea: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },

  image: { width: '100%', height: '100%' },
  video: { width: '100%', height: '100%' },
  // 1346 — reviewed, not touched: forced WHITE (not dark), pre-existing and
  // unrelated to this task. Most SVGs assume a light/transparent canvas
  // (that's the format's own convention, same reason browsers letterbox
  // transparent SVGs onto white), independent of the app's own scheme —
  // the opposite of the forced-dark question this task answers.
  svgWebView: { width: '100%', height: '100%', backgroundColor: '#ffffff', borderRadius: radii.md },
  // Task 1564 — plain flex:1 (default align:'stretch'), deliberately NOT
  // centered like `previewArea` above it. See the JSX comment at the SVG
  // WebView call site for why this wrapper exists.
  svgWebViewWrap: { flex: 1, width: '100%' },

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
  // Task 1592 — secondary action (brand rule: amber is for primary actions
  // and encryption state only), so an outline, not a filled amber button.
  loadRetryButton: {
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  loadRetryText: { fontSize: 14, fontWeight: '600' },
  // 1346 — neither imageStatusTitle nor this base imageStatusSub bakes a
  // scheme-aware colour: this pair is shared verbatim by the always-dark
  // media branch (mediaStage error text) AND the doc branch (renderer error
  // text, now scheme={resolved} per 1344). The media branch's two call
  // sites rely on this base rgba(255,255,255,0.6) unmodified (still correct
  // — the media ground never changes); the doc branch's nine reachable
  // call sites override colour inline per-Text with c.ink/c.ink3 instead
  // (see the "Preview area" switch below) rather than this style flipping
  // for everyone, since it has no scheme of its own to read.
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
  // 1346 — backgroundColor moved to an inline `trackColor` at the two call
  // sites: this track is shared by the always-dark media pager/stage and
  // the scheme-following doc branch, and the old baked
  // 'rgba(255,255,255,0.16)' would have washed out to near-invisible over
  // the doc root's light-mode c.paper (see PreviewProgressStatus).
  previewProgressTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  previewProgressFill: {
    height: '100%',
    minWidth: 8,
    borderRadius: 2,
  },
  // Task 0799 — slim "bytes arriving" bar pinned to the top of the frame during
  // the View-Original download phase.
  // 1346 — rgba(255,255,255,0.14) forced: ProgressiveOriginalImage's only
  // reachable caller is the media branch (the doc branch's own isImage tree
  // is dead code — isMediaPreview = isImage || isVideo already returns
  // early above it, see the "Preview area" switch's own note). Chrome over
  // arbitrary media, same forced-ground argument as mediaMaterial.
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
  // 1346 — colors.white kept: see the comment at this style's JSX call
  // site (independent, already-theme-aware badge, predates this task).
  genericIconText: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.white,
    letterSpacing: 0.5,
  },
  // 1346 — colour moved to an inline c.ink/c.ink3 at the JSX call site (was
  // baked-in colors.white/rgba(255,255,255,0.5) — see the comment there).
  genericTitle: { fontSize: 18, fontWeight: '600' },
  genericSub: {
    fontSize: 13,
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
