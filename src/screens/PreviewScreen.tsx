import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
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
import type { RootStackParamList } from '../App';
import { colors, radii, shadows } from '../theme';
import type { Colors } from '../theme';
import { useTheme } from '../lib/theme-context';
import { getToken, getDownloadUrl, friendlyError } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';

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

type Category =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'docx'
  | 'spreadsheet'
  | 'html'
  | 'doc'
  | 'file';

function fileCategory(mimeType?: string, fileName?: string): Category {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';

  // SVG before generic image — needs WebView, not <Image>, for proper render
  if (mime === 'image/svg+xml' || ext === 'svg') return 'svg';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';

  // HTML before generic text — needs WebView (with source-toggle), not the
  // monospace text viewer.
  if (mime === 'text/html' || ext === 'html' || ext === 'htm') return 'html';

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
  spreadsheet: 'Spreadsheet',
  html: 'Web Page',
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
  spreadsheet: 'XLS',
  html: 'HTML',
  doc: 'DOC',
  file: 'FILE',
};

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
// Screen
// ---------------------------------------------------------------------------

export default function PreviewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<PreviewRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { fileId, fileName, mimeType, sizeBytes, createdAt } = route.params;

  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Image inline preview state
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // PDF inline preview state
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

  const { isUnlocked, decryptChunk } = useCrypto();

  const category = fileCategory(mimeType, fileName);
  const isImage = category === 'image';
  const isSvg = category === 'svg';
  const isPdf = category === 'pdf';
  const isVideo = !!mimeType && mimeType.startsWith('video/');
  const isDocx = category === 'docx';
  const isSpreadsheet = category === 'spreadsheet';
  const isHtml = category === 'html';
  const isText =
    !isDocx &&
    !isSpreadsheet &&
    !isSvg &&
    !isHtml &&
    !!mimeType &&
    (mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml');

  // Theme-aware accent for non-image category badge
  const categoryAccent = (() => {
    switch (category) {
      case 'image':
      case 'svg': return c.amber;
      case 'pdf': return c.red;
      case 'audio': return c.green;
      case 'video':
      case 'docx':
      case 'doc': return c.ink2;
      case 'spreadsheet': return c.green;
      case 'html': return c.amber;
      default: return c.ink3;
    }
  })();

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

    const safeName = fileName.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const encryptedUri = `${FileSystem.cacheDirectory}enc_${safeName}`;

    const dl = FileSystem.createDownloadResumable(
      getDownloadUrl(fileId),
      encryptedUri,
      { headers: { Authorization: `Bearer ${token}` } },
      (p) => {
        if (p.totalBytesExpectedToWrite > 0) {
          setDownloadProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
        }
      },
    );

    const result = await dl.downloadAsync();
    if (!result) throw new Error('Download was interrupted.');

    if (isUnlocked) {
      try {
        const encBase64 = await FileSystem.readAsStringAsync(result.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const encBytes = base64ToUint8Array(encBase64);
        if (encBytes.length > 12) {
          const nonce = encBytes.slice(0, 12);
          const ciphertext = encBytes.slice(12);
          const decrypted = await decryptChunk(fileId, nonce, ciphertext);
          const decUri = `${FileSystem.cacheDirectory}${safeName}`;
          await FileSystem.writeAsStringAsync(decUri, uint8ArrayToBase64(decrypted), {
            encoding: FileSystem.EncodingType.Base64,
          });
          return decUri;
        }
      } catch {
        // Crypto unavailable (stubs not linked) or malformed data — fall through
      }
    }
    return result.uri;
  }, [fileId, fileName, isUnlocked, decryptChunk]);

  // Auto-load images inline on mount
  useEffect(() => {
    if (!isImage) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setImageLoading(true);
    setImageError(null);
    fetchAndDecrypt()
      .then((uri) => {
        if (!cancelled) setImageUri(uri);
      })
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
  }, [isImage, fetchAndDecrypt]);

  // Auto-load PDFs inline on mount — WebView renders them natively on iOS
  useEffect(() => {
    if (!isPdf) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);
    fetchAndDecrypt()
      .then((uri) => {
        if (!cancelled) setPdfUri(uri);
      })
      .catch((err) => {
        if (!cancelled) setPdfError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setPdfLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isPdf, fetchAndDecrypt]);

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

  const handleDownload = useCallback(async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Not available', 'File download is only available on iOS and Android.');
      return;
    }

    setDownloading(true);
    setDownloadProgress(0);

    try {
      const token = await getToken();
      if (!token) {
        Alert.alert('Not signed in', 'Please sign in to download files.');
        return;
      }

      const shareUri = await fetchAndDecrypt();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(shareUri, {
          mimeType: mimeType ?? 'application/octet-stream',
          dialogTitle: fileName,
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
    }
  }, [fileName, mimeType, fetchAndDecrypt]);

  const handleShare = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigation.navigate('ShareSheet', { fileId, fileName, mimeType, sizeBytes });
  }, [navigation, fileId, fileName, mimeType, sizeBytes]);

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
            {fileName}
          </Text>
          <Text style={styles.headerSub}>
            {CATEGORY_LABELS[category] ?? 'File'}
            {sizeBytes != null ? `  ·  ${formatSize(sizeBytes)}` : ''}
          </Text>
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
              accessibilityLabel={fileName}
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
            <WebView
              source={{ uri: pdfUri }}
              style={[styles.pdfWebView, { backgroundColor: c.paper }]}
              originWhitelist={['*']}
            />
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
          textContent != null ? (
            <ScrollView
              style={[styles.codeScroll, { backgroundColor: colors.darkBg }]}
              contentContainerStyle={styles.codeScrollContent}
            >
              <ScrollView horizontal contentContainerStyle={styles.codeHorizontal}>
                <View style={styles.codeBlock}>
                  {textContent.split('\n').map((line, i) => (
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

      {/* ---- Metadata card ---- */}
      <View
        style={[
          styles.metaCard,
          { backgroundColor: c.paper, paddingBottom: Math.max(insets.bottom, 16) + 56 },
        ]}
      >
        <View style={styles.metaSection}>
          <Text style={[styles.metaSectionTitle, { color: c.ink3 }]}>Details</Text>

          <View style={styles.metaRow}>
            <Text style={[styles.metaLabel, { color: c.ink3 }]}>Name</Text>
            <Text style={[styles.metaValue, { color: c.ink }]} numberOfLines={1}>{fileName}</Text>
          </View>

          {mimeType ? (
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: c.ink3 }]}>Type</Text>
              <Text style={[styles.metaValue, { color: c.ink }]}>{mimeType}</Text>
            </View>
          ) : null}

          {sizeBytes != null ? (
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: c.ink3 }]}>Size</Text>
              <Text style={[styles.metaValue, { color: c.ink }]}>{formatSize(sizeBytes)}</Text>
            </View>
          ) : null}

          {createdAt ? (
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: c.ink3 }]}>Created</Text>
              <Text style={[styles.metaValue, { color: c.ink }]}>{formatDate(createdAt)}</Text>
            </View>
          ) : null}
        </View>

        <View style={[styles.encryptionBadge, { borderTopColor: c.line }]}>
          <View style={[styles.encryptionDot, { backgroundColor: c.amber }]} />
          <Text style={[styles.encryptionText, { color: c.ink3 }]}>
            End-to-end encrypted · AES-256-GCM
          </Text>
        </View>
      </View>

      {/* ---- Download bar ---- */}
      <View
        style={[
          styles.downloadBar,
          { backgroundColor: c.paper, paddingBottom: Math.max(insets.bottom, 16) },
        ]}
      >
        {downloading && downloadProgress > 0 && (
          <View style={[styles.progressTrack, { backgroundColor: c.line }]}>
            <View
              style={[
                styles.progressFill,
                { width: `${downloadProgress * 100}%`, backgroundColor: c.amber },
              ]}
            />
          </View>
        )}
        <TouchableOpacity
          style={[
            styles.downloadButton,
            { backgroundColor: c.amber },
            downloading && styles.downloadButtonDisabled,
          ]}
          activeOpacity={0.8}
          onPress={handleDownload}
          disabled={downloading}
        >
          {downloading ? (
            <View style={styles.downloadingRow}>
              <ActivityIndicator size="small" color={c.ink} />
              <Text style={[styles.downloadButtonText, { color: c.ink }]}>
                {downloadProgress > 0
                  ? `Downloading ${Math.round(downloadProgress * 100)}%`
                  : 'Downloading...'}
              </Text>
            </View>
          ) : (
            <Text style={[styles.downloadButtonText, { color: c.ink }]}>
              {isImage ? 'Save & Share' : 'Download & Open'}
            </Text>
          )}
        </TouchableOpacity>
      </View>
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
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
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
  pdfWebView: { width: '100%', height: '100%' },
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
  encryptionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    gap: 8,
  },
  encryptionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  encryptionText: { fontSize: 12, fontWeight: '500' },

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
});
