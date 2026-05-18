import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
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
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { WebView } from 'react-native-webview';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import JSZip from 'jszip';
import type { RootStackParamList } from '../App';
import { colors, radii, shadows } from '../theme';
import type { Colors } from '../theme';
import { useTheme } from '../lib/theme-context';
import { ApiError, getToken, getDownloadUrl, friendlyError, trustLocation } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import {
  decryptEncryptedBytes,
  inferChunkCountFromEncryptedSize,
} from '../lib/encrypted-download';
import { decryptToTempFile } from '../lib/native-decrypt';
import { getCachedPhoto, cachePhoto } from '../lib/photo-cache';
import { PdfRenderer } from '../components/preview/PdfRenderer';
import { DetailsSheet } from '../components/preview/DetailsSheet';
import { ArchiveRenderer } from '../components/preview/ArchiveRenderer';
import { PptxRenderer } from '../components/preview/PptxRenderer';

// Office libs — loaded eagerly so Metro bundles them. Mammoth's `browser`
// entry is a UMD bundle that avoids Node-only deps (fs, path) and works in RN.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mammoth/mammoth.browser ships no .d.ts.
import mammoth from 'mammoth/mammoth.browser';
import * as XLSX from 'xlsx';

// Syntax highlighting — modular import + register only the languages we ship,
// so the bundle stays small (~50 KB instead of ~700 KB for all 197 languages).
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsMarkdown from 'highlight.js/lib/languages/markdown';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', hljsBash);
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('javascript', hljsJavascript);
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('markdown', hljsMarkdown);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('swift', hljsSwift);
hljs.registerLanguage('typescript', hljsTypescript);
hljs.registerLanguage('xml', hljsXml);
hljs.registerLanguage('yaml', hljsYaml);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PreviewRoute = RouteProp<RootStackParamList, 'Preview'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
}

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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function responseHeaderInt(headers: Headers, key: string): number | null {
  const value = headers.get(key);
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function errorMessageFromResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText || `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // Plain text error body.
  }
  return text;
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
// DOCX helpers
// ---------------------------------------------------------------------------

/**
 * Wrap mammoth's HTML output with a Beebeeb-styled stylesheet so the WebView
 * preview matches the app's brand (Inter sans, JetBrains Mono for code, warm
 * paper background, amber accent for links).
 */
function buildDocxHtml(bodyHtml: string, c: Colors, isDark: boolean): string {
  const bg = c.paper;
  const ink = c.ink;
  const ink3 = c.ink3;
  const line = c.line;
  const amber = c.amber;
  const codeBg = c.paper2;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=4" />
  <style>
    :root { color-scheme: ${isDark ? 'dark' : 'light'}; }
    html, body { background: ${bg}; color: ${ink}; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      padding: 24px 20px 96px;
      -webkit-text-size-adjust: 100%;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    h1, h2, h3, h4, h5, h6 {
      font-weight: 700;
      line-height: 1.25;
      color: ${ink};
      margin: 1.4em 0 0.6em;
    }
    h1 { font-size: 1.7em; }
    h2 { font-size: 1.4em; }
    h3 { font-size: 1.2em; }
    h4, h5, h6 { font-size: 1em; }
    p { margin: 0 0 1em; }
    a { color: ${amber}; text-decoration: none; border-bottom: 1px solid ${amber}; }
    ul, ol { padding-left: 1.4em; margin: 0 0 1em; }
    li { margin: 0.25em 0; }
    blockquote {
      margin: 1em 0;
      padding: 0.5em 1em;
      border-left: 3px solid ${amber};
      color: ${ink3};
      background: ${codeBg};
    }
    code, pre, tt {
      font-family: 'JetBrainsMono-Regular', 'JetBrains Mono', ui-monospace,
                   SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
    }
    code { background: ${codeBg}; padding: 0.1em 0.35em; border-radius: 3px; }
    pre {
      background: ${codeBg};
      padding: 12px 14px;
      border-radius: 8px;
      overflow-x: auto;
    }
    pre code { background: transparent; padding: 0; }
    table {
      border-collapse: collapse;
      margin: 1em 0;
      width: 100%;
      font-size: 0.92em;
    }
    th, td {
      border: 1px solid ${line};
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th { background: ${codeBg}; font-weight: 600; }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 0.5em 0;
    }
    hr {
      border: 0;
      border-top: 1px solid ${line};
      margin: 1.5em 0;
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
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
// Spreadsheet helpers
// ---------------------------------------------------------------------------

interface SpreadsheetData {
  sheetName: string;
  sheetNames: string[];
  rows: string[][]; // includes header at index 0
  columnCount: number;
}

/**
 * Parse the first sheet of an XLSX/CSV/etc. file. Returns rows as 2D string
 * array with the header in row 0.
 */
function parseSpreadsheet(arrayBuffer: ArrayBuffer): SpreadsheetData {
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const sheetNames = workbook.SheetNames;
  const sheetName = sheetNames[0] ?? '';
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;

  if (!sheet) {
    return { sheetName, sheetNames, rows: [], columnCount: 0 };
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  const rows = aoa.map((r) => r.map((cell) => (cell == null ? '' : String(cell))));
  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  // Pad rows so every row has the same width (FlatList rendering is simpler).
  const padded = rows.map((r) =>
    r.length === columnCount ? r : [...r, ...Array(columnCount - r.length).fill('')],
  );

  return { sheetName, sheetNames, rows: padded, columnCount };
}

// ---------------------------------------------------------------------------
// ZIP helpers
// ---------------------------------------------------------------------------

interface ZipEntry {
  /** Path inside the archive (e.g. "src/foo.ts") */
  path: string;
  /** Display name (last segment of path) */
  name: string;
  /** True for directories (JSZip flags these explicitly) */
  isFolder: boolean;
  /** Uncompressed size in bytes (best-effort — JSZip exposes this on `_data`) */
  uncompressedSize: number;
  /** Modified date if present in the archive */
  modifiedAt: Date | null;
  /** Lowercase extension, used for icon mapping */
  ext: string;
}

interface ZipSummary {
  entries: ZipEntry[];
  fileCount: number;
  folderCount: number;
  totalUncompressed: number;
}

/**
 * Read a ZIP archive into a flat list of entries plus summary stats.
 * Sorted: folders first (alphabetical), then files (alphabetical) — easiest
 * for users to scan a tree at a glance.
 */
async function parseZip(arrayBuffer: ArrayBuffer): Promise<ZipSummary> {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entries: ZipEntry[] = [];
  let fileCount = 0;
  let folderCount = 0;
  let totalUncompressed = 0;

  Object.keys(zip.files).forEach((path) => {
    const f = zip.files[path];
    // Strip trailing slash for directory display
    const cleanPath = f.dir ? path.replace(/\/$/, '') : path;
    const segments = cleanPath.split('/');
    const name = segments[segments.length - 1] || cleanPath;
    const ext = f.dir ? '' : (name.toLowerCase().split('.').pop() ?? '');

    // JSZip exposes uncompressed size on `_data.uncompressedSize` for files
    // we haven't decompressed yet. Fall back to 0 if missing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalData = (f as any)._data as
      | { uncompressedSize?: number }
      | undefined;
    const uncompressedSize = f.dir ? 0 : internalData?.uncompressedSize ?? 0;

    if (f.dir) {
      folderCount += 1;
    } else {
      fileCount += 1;
      totalUncompressed += uncompressedSize;
    }

    entries.push({
      path: cleanPath,
      name,
      isFolder: !!f.dir,
      uncompressedSize,
      modifiedAt: f.date ?? null,
      ext,
    });
  });

  // Folders first, then alphabetical within each group
  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return { entries, fileCount, folderCount, totalUncompressed };
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/** Map a file extension to a sensible Ionicons name. Mirrors FilesScreen. */
function zipEntryIcon(entry: ZipEntry): IoniconName {
  if (entry.isFolder) return 'folder';
  const ext = entry.ext;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp', 'tiff'].includes(ext)) {
    return 'image';
  }
  if (ext === 'pdf') return 'document-text';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return 'musical-notes';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'videocam';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'document';
  if (['xls', 'xlsx', 'csv', 'ods', 'tsv'].includes(ext)) return 'grid';
  if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext)) return 'file-tray-stacked';
  if (
    [
      'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'kt', 'swift',
      'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'json',
      'xml', 'html', 'htm', 'css', 'scss', 'yaml', 'yml', 'toml', 'md',
    ].includes(ext)
  ) {
    return 'code-slash';
  }
  return 'document-outline';
}

// ---------------------------------------------------------------------------
// Code highlighting helpers
// ---------------------------------------------------------------------------

// Atom One Dark theme — matches our dark preview chrome and is the same
// scheme VS Code's "One Dark Pro" / Atom's default editor uses. Inlined so
// the WebView can render without external network requests.
const ATOM_ONE_DARK_CSS = 'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#abb2bf;background:#282c34}.hljs-comment,.hljs-quote{color:#5c6370;font-style:italic}.hljs-doctag,.hljs-formula,.hljs-keyword{color:#c678dd}.hljs-deletion,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-subst{color:#e06c75}.hljs-literal{color:#56b6c2}.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#98c379}.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable{color:#d19a66}.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-symbol,.hljs-title{color:#61aeee}.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#e6c07b}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}.hljs-link{text-decoration:underline}';

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

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wrap each line of `highlight.js` output in a `<div class="line">` so the
 * WebView can show line numbers via flexbox. Tokens that span multiple lines
 * (multi-line strings, JSDoc, etc.) emit `<span>` tags that cross `\n`; we
 * close them at the end of each line and reopen them on the next so the
 * per-line wrapper produces well-formed HTML.
 */
function wrapHighlightedLines(highlighted: string, totalDigits: number): string {
  const open: string[] = [];
  let buf = '';
  const lines: string[] = [];
  let i = 0;
  while (i < highlighted.length) {
    const ch = highlighted[i];
    if (ch === '<') {
      const end = highlighted.indexOf('>', i);
      if (end === -1) {
        buf += highlighted.slice(i);
        break;
      }
      const tag = highlighted.slice(i, end + 1);
      buf += tag;
      if (tag.startsWith('</')) {
        if (open.length > 0) open.pop();
      } else if (!tag.endsWith('/>')) {
        open.push(tag);
      }
      i = end + 1;
    } else if (ch === '\n') {
      const closing = open.map(() => '</span>').join('');
      lines.push(buf + closing);
      buf = open.join('');
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  lines.push(buf);

  return lines
    .map((line, idx) => {
      const lineNum = String(idx + 1).padStart(totalDigits, ' ');
      const content = line.length === 0 ? ' ' : line;
      return `<div class="line"><span class="lineno">${lineNum}</span><span class="lc">${content}</span></div>`;
    })
    .join('');
}

function buildCodeHtml(code: string, language: string): string {
  let highlighted: string;
  try {
    if (language !== 'plaintext' && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } else {
      highlighted = escapeHtmlText(code);
    }
  } catch {
    highlighted = escapeHtmlText(code);
  }

  const lineCount = code.split('\n').length;
  const totalDigits = Math.max(2, String(lineCount).length);
  const wrapped = wrapHighlightedLines(highlighted, totalDigits);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=4" />
  <style>
    ${ATOM_ONE_DARK_CSS}
    html, body { margin: 0; padding: 0; background: #282c34; color: #abb2bf; }
    body {
      font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      -webkit-text-size-adjust: 100%;
    }
    .code { padding: 12px 0 32px; }
    .line { display: flex; align-items: flex-start; padding: 0 16px; min-height: 19.2px; }
    .lineno {
      color: #4b5263;
      min-width: ${totalDigits + 1}ch;
      text-align: right;
      padding-right: 16px;
      user-select: none;
      flex-shrink: 0;
    }
    .lc {
      white-space: pre;
      flex: 1 1 auto;
    }
    ::selection { background: rgba(82, 139, 255, 0.35); }
  </style>
</head>
<body>
  <div class="code hljs">${wrapped}</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Photo swipe page — renders a single photo inside the horizontal pager
// ---------------------------------------------------------------------------

const SCREEN_WIDTH = Dimensions.get('window').width;

interface PhotoPageEntry {
  id: string;
  name_encrypted: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: string;
  chunk_count: number;
  version_number?: number;
  storage_pool_id?: string | null;
}

const PhotoPage = React.memo(function PhotoPage({
  entry,
  isActive,
  width,
}: {
  entry: PhotoPageEntry;
  isActive: boolean;
  width: number;
}) {
  const { colors: c } = useTheme();
  const { isUnlocked, getFileKeyBytes } = useCrypto();
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive) return;
    if (uri) return; // Already loaded
    if (Platform.OS === 'web') return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error('Not signed in');

        const ext = extensionForMime(entry.mime_type ?? undefined, 'image');
        const cacheUri = `${FileSystem.cacheDirectory}dec_${entry.id}_photo${ext}`;

        try {
          await FileSystem.deleteAsync(cacheUri, { idempotent: true });
        } catch { /* ignore */ }

        const res = await fetch(getDownloadUrl(entry.id), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new ApiError(res.status, await errorMessageFromResponse(res));
        const encBytes = new Uint8Array(await res.arrayBuffer());

        if (isUnlocked && BeebeebCrypto.isNativeAvailable) {
          const headerOriginalSize = responseHeaderInt(res.headers, 'X-Original-Size');
          const effectiveSize = headerOriginalSize ?? entry.size_bytes ?? encBytes.length - 28;
          if (effectiveSize <= 0) throw new Error('Could not determine plaintext size.');

          const headerChunkCount = responseHeaderInt(res.headers, 'X-Chunk-Count');
          const headerChunkSize = responseHeaderInt(res.headers, 'X-Chunk-Size');
          const inferred = inferChunkCountFromEncryptedSize(encBytes.length, effectiveSize);
          const effectiveChunkCount = headerChunkCount ?? entry.chunk_count ?? inferred ?? 1;
          const effectiveChunkSize = headerChunkSize && headerChunkSize > 0 ? headerChunkSize : undefined;

          const fileKey = await getFileKeyBytes(entry.id);
          const decrypted = await decryptEncryptedBytes(fileKey, encBytes, effectiveChunkCount, effectiveSize, effectiveChunkSize);

          await FileSystem.writeAsStringAsync(cacheUri, uint8ArrayToBase64(decrypted), {
            encoding: FileSystem.EncodingType.Base64,
          });
          if (!cancelled) setUri(cacheUri);
        } else {
          const encCacheUri = `${FileSystem.cacheDirectory}${entry.id}_photo${ext}`;
          await FileSystem.writeAsStringAsync(encCacheUri, uint8ArrayToBase64(encBytes), {
            encoding: FileSystem.EncodingType.Base64,
          });
          if (!cancelled) setUri(encCacheUri);
        }
      } catch (err) {
        if (!cancelled) setError(friendlyError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isActive, uri, entry, isUnlocked, getFileKeyBytes]);

  return (
    <View style={{ width, flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="contain"
        />
      ) : error ? (
        <View style={{ alignItems: 'center', gap: 12 }}>
          <Text style={{ color: colors.white, fontSize: 16, fontWeight: '600' }}>
            Couldn't load image
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'center' }}>
            {error}
          </Text>
        </View>
      ) : (
        <View style={{ alignItems: 'center', gap: 12 }}>
          <ActivityIndicator color={c.amber} size="large" />
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
            {loading
              ? isUnlocked
                ? 'Downloading and decrypting...'
                : 'Unlock your vault to view this image.'
              : ''}
          </Text>
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
  } = route.params;

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
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(initialPhotoIndex ?? 0);
  const pagerRef = useRef<FlatList<PhotoPageEntry>>(null);

  // Derive the current photo entry from the swipe index
  const currentEntry = hasSwipe ? photoList[currentPhotoIndex] : null;
  const currentFileId = currentEntry?.id ?? fileId;
  const currentFileName = currentEntry?.name_encrypted ?? fileName;
  const currentMimeType = currentEntry?.mime_type ?? mimeType;
  const currentSizeBytes = currentEntry?.size_bytes ?? sizeBytes;
  const currentCreatedAt = currentEntry?.created_at ?? createdAt;
  const currentChunkCount = currentEntry?.chunk_count ?? chunkCount;
  const currentVersionNumber = currentEntry?.version_number ?? versionNumber;
  const currentStoragePoolId = currentEntry?.storage_pool_id ?? storagePoolId;

  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Image inline preview state
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

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

  // DOCX inline preview state
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState<string | null>(null);

  // Spreadsheet inline preview state
  const [sheetData, setSheetData] = useState<SpreadsheetData | null>(null);
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

  // ZIP archive listing state
  const [zipSummary, setZipSummary] = useState<ZipSummary | null>(null);
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

  const { isUnlocked, getFileKeyBytes } = useCrypto();

  // Use current* values so derived state updates when swiping between photos
  const category = fileCategory(currentMimeType, currentFileName);
  const isImage = category === 'image';
  const isSvg = category === 'svg';
  const isPdf = category === 'pdf';
  const isVideo = !!currentMimeType && currentMimeType.startsWith('video/');
  const isArchive = category === 'archive';
  const isPptx = category === 'pptx';
  const isMediaPreview = isImage || isVideo;
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
  const codeHtml = useMemo(() => {
    if (!isText || textContent == null) return null;
    return buildCodeHtml(textContent, codeLanguage);
  }, [isText, textContent, codeLanguage]);

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
  const fetchAndDecrypt = useCallback(async (): Promise<string> => {
    const token = await getToken();
    if (!token) throw new Error('Not signed in');

    // Keep the original extension on the cache filename — RN's <Image>,
    // expo-video, and the WebView pick the decoder from the URI suffix.
    const cacheUri = `${FileSystem.cacheDirectory}${currentFileId}_${cacheFileName}`;

    // Remove any stale copy so a previous failed download (e.g. a JSON error
    // body that 401'd) can't masquerade as a valid file.
    try {
      await FileSystem.deleteAsync(cacheUri, { idempotent: true });
    } catch {
      // Best-effort — proceed even if the path can't be cleared.
    }

    const res = await fetch(getDownloadUrl(currentFileId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new ApiError(res.status, await errorMessageFromResponse(res));
    }
    const encBytes = new Uint8Array(await res.arrayBuffer());
    await FileSystem.writeAsStringAsync(cacheUri, uint8ArrayToBase64(encBytes), {
      encoding: FileSystem.EncodingType.Base64,
    });
    setDownloadProgress(1);

    if (isUnlocked) {
      if (!BeebeebCrypto.isNativeAvailable) {
        throw new Error('Preview requires a dev client build with native crypto.');
      }

      // Resolve plaintext size: prefer the X-Original-Size header (the server
      // stores the canonical value), then the route-param `currentSizeBytes`, then
      // fall back to the encrypted length minus a single-chunk overhead.
      const headerOriginalSize = responseHeaderInt(res.headers, 'X-Original-Size');
      const effectiveSize = headerOriginalSize ?? currentSizeBytes ?? encBytes.length - 28;
      if (effectiveSize <= 0) {
        throw new Error('Could not determine plaintext size for decryption.');
      }

      // Resolve chunk count: header → route param → byte-math inference.
      const headerChunkCount = responseHeaderInt(res.headers, 'X-Chunk-Count');
      const headerChunkSize = responseHeaderInt(res.headers, 'X-Chunk-Size');
      const inferred = inferChunkCountFromEncryptedSize(encBytes.length, effectiveSize);
      const effectiveChunkCount = headerChunkCount ?? currentChunkCount ?? inferred ?? 1;
      const effectiveChunkSize = headerChunkSize && headerChunkSize > 0
        ? headerChunkSize
        : undefined;

      // Derive the per-file key once and reuse it across chunks.
      const fileKey = await getFileKeyBytes(currentFileId);
      const decrypted = await decryptEncryptedBytes(
        fileKey,
        encBytes,
        effectiveChunkCount,
        effectiveSize,
        effectiveChunkSize,
      );

      const decUri = `${FileSystem.cacheDirectory}dec_${currentFileId}_${cacheFileName}`;
      await FileSystem.writeAsStringAsync(decUri, uint8ArrayToBase64(decrypted), {
        encoding: FileSystem.EncodingType.Base64,
      });
      return decUri;
    }
    return cacheUri;
  }, [cacheFileName, currentFileId, isUnlocked, getFileKeyBytes, currentChunkCount, currentSizeBytes]);

  const getExportUri = useCallback(async (): Promise<{ uri: string; reusedPreview: boolean }> => {
    if (isImage && imageUri) return { uri: imageUri, reusedPreview: true };
    if (isVideo && videoUri) return { uri: videoUri, reusedPreview: true };
    if (isPdf && pdfUri) return { uri: pdfUri, reusedPreview: true };
    return { uri: await fetchAndDecrypt(), reusedPreview: false };
  }, [fetchAndDecrypt, imageUri, isImage, isPdf, isVideo, pdfUri, videoUri]);

  // Auto-load images inline on mount — checks photo cache first to avoid
  // re-downloading and re-decrypting when navigating back to a photo.
  useEffect(() => {
    if (!isImage) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setImageLoading(true);
    setImageError(null);

    (async () => {
      // Fast path: check if this photo is already cached (memory or disk)
      const cached = await getCachedPhoto(currentFileId);
      if (cached) {
        if (!cancelled) {
          setImageUri(cached);
          setImageLoading(false);
        }
        return;
      }

      // Slow path: download + decrypt, then cache the result
      const decryptedUri = await fetchAndDecrypt();
      if (cancelled) return;

      // Store in photo cache for future navigations
      try {
        const cachedUri = await cachePhoto(currentFileId, decryptedUri);
        if (!cancelled) setImageUri(cachedUri);
      } catch {
        // Caching failed — use the decrypted URI directly
        if (!cancelled) setImageUri(decryptedUri);
      }
    })()
      .catch((err) => {
        if (!cancelled) setImageError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setImageLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isImage, currentFileId, fetchAndDecrypt]);

  // Auto-load PDFs inline on mount — uses native decrypt + PdfRenderer.
  useEffect(() => {
    if (!isPdf) return;
    if (Platform.OS === 'web') return;
    if (!isUnlocked) return;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);
    setPdfUri(null);

    (async () => {
      try {
        const fileKey = await getFileKeyBytes(fileId);
        const tempPath = await decryptToTempFile(fileId, fileKey, 'pdf', sizeBytes, chunkCount);
        if (!cancelled) {
          setPdfUri(tempPath);
        }
      } catch (err) {
        if (!cancelled) setPdfError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setPdfLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isPdf, isUnlocked, fileId, getFileKeyBytes, sizeBytes, chunkCount]);

  // Auto-load text/code/JSON inline on mount — read decrypted file as UTF-8
  useEffect(() => {
    if (!isText) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setTextLoading(true);
    setTextError(null);
    fetchAndDecrypt()
      .then(async (uri) => {
        const content = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        if (!cancelled) setTextContent(content);
      })
      .catch((err) => {
        if (!cancelled) setTextError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setTextLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isText, fetchAndDecrypt]);

  // Auto-load video on mount; track the on-disk URI so we can delete it on unmount
  useEffect(() => {
    if (!isVideo) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setVideoLoading(true);
    setVideoError(null);
    fetchAndDecrypt()
      .then((uri) => {
        if (cancelled) {
          // Screen already unmounted by the time the download completed —
          // delete the file directly since the cleanup branch never sees it.
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          return;
        }
        tempVideoUriRef.current = uri;
        setVideoUri(uri);
      })
      .catch((err) => {
        if (!cancelled) setVideoError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setVideoLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isVideo, fetchAndDecrypt]);

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

  // Auto-load DOCX inline — convert with mammoth, render styled HTML in WebView
  useEffect(() => {
    if (!isDocx) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setDocxLoading(true);
    setDocxError(null);
    setDocxHtml(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt();
        if (cancelled) return;
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (cancelled) return;
        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (cancelled) return;
        const body = (result?.value as string) ?? '';
        setDocxHtml(body || '<p><em>This document is empty.</em></p>');
      } catch (err) {
        if (!cancelled) setDocxError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setDocxLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isDocx, fetchAndDecrypt]);

  // Auto-load spreadsheets inline — parse with SheetJS, render as a table
  useEffect(() => {
    if (!isSpreadsheet) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setSheetLoading(true);
    setSheetError(null);
    setSheetData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt();
        if (cancelled) return;
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (cancelled) return;
        const data = parseSpreadsheet(arrayBuffer);
        if (!cancelled) setSheetData(data);
      } catch (err) {
        if (!cancelled) setSheetError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setSheetLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSpreadsheet, fetchAndDecrypt]);

  // Wrap the mammoth HTML in our brand stylesheet whenever theme/content changes
  const styledDocxHtml = useMemo(() => {
    if (!docxHtml) return null;
    return buildDocxHtml(docxHtml, c, resolved === 'dark');
  }, [docxHtml, c, resolved]);

  // Auto-load SVGs inline — read as UTF-8, wrap in an HTML doc, show in WebView
  useEffect(() => {
    if (!isSvg) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setSvgLoading(true);
    setSvgError(null);
    setSvgContent(null);

    fetchAndDecrypt()
      .then(async (uri) => {
        const content = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        if (!cancelled) setSvgContent(content);
      })
      .catch((err) => {
        if (!cancelled) setSvgError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setSvgLoading(false);
          setDownloadProgress(0);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isSvg, fetchAndDecrypt]);

  // Auto-load HTML files — read as UTF-8 string, render or show source on toggle
  useEffect(() => {
    if (!isHtml) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setHtmlLoading(true);
    setHtmlError(null);
    setHtmlContent(null);
    // Always start in rendered mode for a fresh file
    setHtmlShowSource(false);

    fetchAndDecrypt()
      .then(async (uri) => {
        const content = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        if (!cancelled) setHtmlContent(content);
      })
      .catch((err) => {
        if (!cancelled) setHtmlError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setHtmlLoading(false);
          setDownloadProgress(0);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isHtml, fetchAndDecrypt]);

  // Wrap the SVG content in a minimal HTML doc whenever the SVG changes
  const wrappedSvgHtml = useMemo(() => {
    if (!svgContent) return null;
    return buildSvgHtml(svgContent);
  }, [svgContent]);

  // Auto-load ZIP archives — read as bytes, parse contents with JSZip, render as a list
  useEffect(() => {
    if (!isZip) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setZipLoading(true);
    setZipError(null);
    setZipSummary(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt();
        if (cancelled) return;
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (cancelled) return;
        const summary = await parseZip(arrayBuffer);
        if (!cancelled) setZipSummary(summary);
      } catch (err) {
        if (!cancelled) setZipError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setZipLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isZip, fetchAndDecrypt]);

  // Auto-load TAR/GZ/TGZ archives — decrypt and read as bytes for ArchiveRenderer
  useEffect(() => {
    if (!isArchive) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setArchiveLoading(true);
    setArchiveError(null);
    setArchiveData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt();
        if (cancelled) return;
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (!cancelled) setArchiveData(arrayBuffer);
      } catch (err) {
        if (!cancelled) setArchiveError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setArchiveLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isArchive, fetchAndDecrypt]);

  // Auto-load PPTX — decrypt and read as bytes for PptxRenderer
  useEffect(() => {
    if (!isPptx) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setPptxLoading(true);
    setPptxError(null);
    setPptxData(null);

    (async () => {
      try {
        const uri = await fetchAndDecrypt();
        if (cancelled) return;
        const arrayBuffer = await readFileAsArrayBuffer(uri);
        if (!cancelled) setPptxData(arrayBuffer);
      } catch (err) {
        if (!cancelled) setPptxError(friendlyError(err));
      } finally {
        if (!cancelled) {
          setPptxLoading(false);
          setDownloadProgress(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isPptx, fetchAndDecrypt]);

  const handleDownload = useCallback(async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Not available', 'File download is only available on iOS and Android.');
      return;
    }

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
  }, [previewFileName, currentMimeType, getExportUri]);

  const handleShare = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigation.navigate('ShareSheet', { fileId: currentFileId, fileName: previewFileName, mimeType: currentMimeType, sizeBytes: currentSizeBytes });
  }, [navigation, currentFileId, previewFileName, currentMimeType, currentSizeBytes]);

  if (isMediaPreview) {
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
              {CATEGORY_LABELS[category]}{sizeBytes != null ? ` · ${formatSize(sizeBytes)}` : ''}
            </Text>
          </View>

          <TouchableOpacity
            onPress={handleShare}
            style={styles.mediaIconButton}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Share Beebeeb link"
          >
            <Ionicons name="link-outline" size={19} color={colors.white} />
          </TouchableOpacity>
        </View>

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
            imageUri ? (
              <Image
                source={{ uri: imageUri }}
                style={styles.mediaImage}
                resizeMode="contain"
                accessibilityLabel={previewFileName}
              />
            ) : imageError ? (
              <View style={styles.imageStatus}>
                <Text style={[styles.imageStatusTitle, { color: colors.white }]}>Couldn't load image</Text>
                <Text style={styles.imageStatusSub}>{imageError}</Text>
              </View>
            ) : (
              <View style={styles.imageStatus}>
                <ActivityIndicator color={c.amber} size="large" />
                <Text style={styles.imageStatusSub}>
                  {imageLoading && downloadProgress > 0
                    ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                    : isUnlocked
                    ? 'Downloading and decrypting...'
                    : 'Unlock your vault to view this image.'}
                </Text>
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
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {videoLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to play this video.'}
              </Text>
            </View>
          )}
        </Pressable>

        <DetailsSheet
          filename={previewFileName}
          kind={CATEGORY_LABELS[category] ?? 'File'}
          size={sizeBytes != null ? formatSize(sizeBytes) : 'Unknown'}
          created={createdAt ? formatDate(createdAt) : undefined}
          extraInfo={mediaDetailsRows
            .filter((r) => !['Name', 'Kind', 'Size', 'Created'].includes(r.label))
            .map((r) => ({ label: r.label, value: r.value }))}
          storageLocation={(() => {
            const storage = trustLocation(storagePoolId);
            return `${storage.region} · ${storage.city}`;
          })()}
          onShare={handleShare}
          onDownload={handleDownload}
          downloading={downloading}
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
              {sizeBytes != null ? `  ·  ${formatSize(sizeBytes)}` : ''}
            </Text>
            {isText && codeLanguage !== 'plaintext' && (
              <View style={styles.langBadge}>
                <Text style={styles.langBadgeText}>{codeLanguageLabel}</Text>
              </View>
            )}
          </View>
        </View>

        <TouchableOpacity
          onPress={handleShare}
          style={styles.headerAction}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.headerActionText}>Share</Text>
        </TouchableOpacity>
      </View>

      {/* ---- Preview area ---- */}
      <View style={styles.previewArea}>
        {isImage ? (
          imageUri ? (
            <Image
              source={{ uri: imageUri }}
              style={styles.image}
              resizeMode="contain"
              accessibilityLabel={previewFileName}
            />
          ) : imageError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load image
              </Text>
              <Text style={styles.imageStatusSub}>{imageError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {imageLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to view this image.'}
              </Text>
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
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {svgLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to view this SVG.'}
              </Text>
            </View>
          )
        ) : isPdf ? (
          pdfUri ? (
            <PdfRenderer filePath={pdfUri} />
          ) : pdfError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load PDF
              </Text>
              <Text style={styles.imageStatusSub}>{pdfError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {pdfLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to view this PDF.'}
              </Text>
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
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {videoLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to play this video.'}
              </Text>
            </View>
          )
        ) : isText ? (
          codeHtml ? (
            <WebView
              source={{ html: codeHtml }}
              style={[styles.codeWebView, { backgroundColor: '#282c34' }]}
              originWhitelist={['*']}
              showsHorizontalScrollIndicator
              showsVerticalScrollIndicator
            />
          ) : textError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load file
              </Text>
              <Text style={styles.imageStatusSub}>{textError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {textLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to view this file.'}
              </Text>
            </View>
          )
        ) : isDocx ? (
          styledDocxHtml ? (
            <WebView
              originWhitelist={['*']}
              source={{ html: styledDocxHtml }}
              style={[styles.docxWebView, { backgroundColor: c.paper }]}
              showsVerticalScrollIndicator
            />
          ) : docxError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open document
              </Text>
              <Text style={styles.imageStatusSub}>{docxError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {docxLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and converting document...'
                  : 'Unlock your vault to view this document.'}
              </Text>
            </View>
          )
        ) : isSpreadsheet ? (
          sheetData ? (
            <SpreadsheetTable data={sheetData} c={c} />
          ) : sheetError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open spreadsheet
              </Text>
              <Text style={styles.imageStatusSub}>{sheetError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {sheetLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and parsing spreadsheet...'
                  : 'Unlock your vault to view this spreadsheet.'}
              </Text>
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
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {htmlLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to view this page.'}
              </Text>
            </View>
          )
        ) : isZip ? (
          zipSummary ? (
            <ZipContents summary={zipSummary} c={c} />
          ) : zipError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open archive
              </Text>
              <Text style={styles.imageStatusSub}>{zipError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {zipLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and reading archive...'
                  : 'Unlock your vault to inspect this archive.'}
              </Text>
            </View>
          )
        ) : isArchive ? (
          archiveData ? (
            <ArchiveRenderer
              data={archiveData}
              extension={(fileName ?? '').toLowerCase().split('.').pop() ?? 'tar'}
              colors={c}
            />
          ) : archiveError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open archive
              </Text>
              <Text style={styles.imageStatusSub}>{archiveError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {archiveLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and reading archive...'
                  : 'Unlock your vault to inspect this archive.'}
              </Text>
            </View>
          )
        ) : isPptx ? (
          pptxData ? (
            <PptxRenderer data={pptxData} colors={c} />
          ) : pptxError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't open presentation
              </Text>
              <Text style={styles.imageStatusSub}>{pptxError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {pptxLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and extracting slides...'
                  : 'Unlock your vault to view this presentation.'}
              </Text>
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
        size={sizeBytes != null ? formatSize(sizeBytes) : 'Unknown'}
        created={createdAt ? formatDate(createdAt) : undefined}
        extraInfo={[
          ...(fileFormat ? [{ label: 'Format', value: fileFormat }] : []),
          ...(mimeType ? [{ label: 'Type', value: mimeType }] : []),
        ]}
        storageLocation={(() => {
          const storage = trustLocation(storagePoolId);
          return `${storage.region} · ${storage.city}`;
        })()}
        onShare={handleShare}
        onDownload={handleDownload}
        downloading={downloading}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Spreadsheet table component
// ---------------------------------------------------------------------------

const COL_WIDTH = 140;
const ROW_HEIGHT = 36;
const MAX_PREVIEW_ROWS = 1000;

interface SpreadsheetTableProps {
  data: SpreadsheetData;
  c: Colors;
}

function SpreadsheetTable({ data, c }: SpreadsheetTableProps) {
  const { rows, columnCount, sheetName, sheetNames } = data;

  const headerRow = rows[0] ?? [];
  const bodyRows = rows.slice(1, MAX_PREVIEW_ROWS + 1);
  const truncated = rows.length - 1 > MAX_PREVIEW_ROWS;

  if (rows.length === 0) {
    return (
      <View style={styles.imageStatus}>
        <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
          Empty spreadsheet
        </Text>
        <Text style={styles.imageStatusSub}>
          {sheetName ? `Sheet "${sheetName}" has no data.` : 'This file has no data.'}
        </Text>
      </View>
    );
  }

  const totalWidth = Math.max(COL_WIDTH * columnCount, 1);

  const renderRow = ({ item, index }: { item: string[]; index: number }) => {
    const stripe = index % 2 === 0;
    return (
      <View
        style={[
          styles.sheetRow,
          {
            backgroundColor: stripe ? c.paper : c.paper2,
            width: totalWidth,
            borderBottomColor: c.line,
          },
        ]}
      >
        {Array.from({ length: columnCount }).map((_, ci) => (
          <View
            key={ci}
            style={[styles.sheetCell, { width: COL_WIDTH, borderRightColor: c.line }]}
          >
            <Text
              style={[styles.sheetCellText, { color: c.ink }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {item[ci] ?? ''}
            </Text>
          </View>
        ))}
      </View>
    );
  };

  return (
    <View style={[styles.sheetContainer, { backgroundColor: c.paper }]}>
      {sheetNames.length > 1 ? (
        <View style={[styles.sheetTabs, { borderBottomColor: c.line }]}>
          <Text style={[styles.sheetTabsText, { color: c.ink3 }]} numberOfLines={1}>
            Showing: {sheetName}  ·  {sheetNames.length} sheets in file
          </Text>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={{ flexGrow: 1 }}
      >
        <View>
          {/* Header row */}
          <View
            style={[
              styles.sheetRow,
              styles.sheetHeaderRow,
              {
                backgroundColor: c.paper2,
                borderBottomColor: c.line,
                width: totalWidth,
              },
            ]}
          >
            {Array.from({ length: columnCount }).map((_, ci) => (
              <View
                key={ci}
                style={[styles.sheetCell, { width: COL_WIDTH, borderRightColor: c.line }]}
              >
                <Text
                  style={[styles.sheetHeaderText, { color: c.ink }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {headerRow[ci] ?? ''}
                </Text>
              </View>
            ))}
          </View>

          {/* Body rows */}
          <FlatList
            data={bodyRows}
            keyExtractor={(_, i) => `row-${i}`}
            renderItem={renderRow}
            getItemLayout={(_, index) => ({
              length: ROW_HEIGHT,
              offset: ROW_HEIGHT * index,
              index,
            })}
            initialNumToRender={30}
            windowSize={11}
            removeClippedSubviews
          />
        </View>
      </ScrollView>

      {truncated ? (
        <View style={[styles.sheetFooter, { borderTopColor: c.line }]}>
          <Text style={[styles.sheetFooterText, { color: c.ink3 }]}>
            Showing first {MAX_PREVIEW_ROWS} rows of {rows.length - 1}. Download to see the full file.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ZIP archive contents component
// ---------------------------------------------------------------------------

interface ZipContentsProps {
  summary: ZipSummary;
  c: Colors;
}

function formatZipSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function formatZipDate(d: Date | null): string | null {
  if (!d || isNaN(d.getTime())) return null;
  const month = d.toLocaleString('en', { month: 'short' });
  const day = d.getDate();
  const year = d.getFullYear();
  return `${month} ${day}, ${year}`;
}

function ZipContents({ summary, c }: ZipContentsProps) {
  const { entries, fileCount, folderCount, totalUncompressed } = summary;

  const renderRow = ({ item }: { item: ZipEntry }) => {
    const iconBg = item.isFolder ? c.amberDeep : c.ink3;
    const iconName = zipEntryIcon(item);
    const dateLabel = formatZipDate(item.modifiedAt);

    return (
      <View style={[styles.zipRow, { borderBottomColor: c.line }]}>
        <View style={[styles.zipIcon, { backgroundColor: iconBg }]}>
          <Ionicons name={iconName} size={16} color="#FFFFFF" />
        </View>
        <View style={styles.zipRowText}>
          <Text style={[styles.zipRowName, { color: c.ink }]} numberOfLines={1}>
            {item.path || item.name}
          </Text>
          <Text style={[styles.zipRowMeta, { color: c.ink3 }]} numberOfLines={1}>
            {item.isFolder
              ? 'Folder'
              : `${formatZipSize(item.uncompressedSize)}${dateLabel ? `  ·  ${dateLabel}` : ''}`}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.zipContainer, { backgroundColor: c.paper }]}>
      <View style={[styles.zipHeader, { borderBottomColor: c.line }]}>
        <View style={styles.zipHeaderRow}>
          <Text style={[styles.zipHeaderTitle, { color: c.ink }]}>
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
            {folderCount > 0
              ? `  ·  ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}`
              : ''}
          </Text>
          <Text style={[styles.zipHeaderSize, { color: c.ink3 }]}>
            {formatZipSize(totalUncompressed)} uncompressed
          </Text>
        </View>
        <Text style={[styles.zipHeaderHint, { color: c.ink3 }]}>
          Read-only listing · download the archive to extract files.
        </Text>
      </View>

      {entries.length === 0 ? (
        <View style={styles.imageStatus}>
          <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
            Empty archive
          </Text>
          <Text style={styles.imageStatusSub}>This ZIP contains no files.</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item, i) => `${i}-${item.path}`}
          renderItem={renderRow}
          initialNumToRender={20}
          windowSize={11}
          removeClippedSubviews
        />
      )}
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
  mediaVideo: {
    width: '100%',
    height: '100%',
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
  docxWebView: { width: '100%', height: '100%', borderRadius: radii.md },
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

  // ---- Code / text viewer ----
  codeWebView: { flex: 1, width: '100%', borderRadius: radii.md, overflow: 'hidden' },
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

  // ---- Spreadsheet table ----
  sheetContainer: {
    flex: 1,
    width: '100%',
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  sheetTabs: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTabsText: {
    fontSize: 11,
    fontWeight: '500',
  },
  sheetRow: {
    flexDirection: 'row',
    height: ROW_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetHeaderRow: {
    borderBottomWidth: 1,
  },
  sheetCell: {
    paddingHorizontal: 8,
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  sheetCellText: {
    fontSize: 12,
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
  },
  sheetHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
  },
  sheetFooter: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetFooterText: {
    fontSize: 11,
    fontStyle: 'italic',
  },

  // ---- ZIP archive listing ----
  zipContainer: {
    flex: 1,
    width: '100%',
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  zipHeader: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  zipHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  zipHeaderTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  zipHeaderSize: {
    fontSize: 12,
    fontWeight: '500',
  },
  zipHeaderHint: {
    fontSize: 11,
    fontStyle: 'italic',
  },
  zipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  zipIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zipRowText: {
    flex: 1,
    minWidth: 0,
  },
  zipRowName: {
    fontSize: 13,
    fontWeight: '500',
  },
  zipRowMeta: {
    fontSize: 11,
    marginTop: 2,
  },
});
