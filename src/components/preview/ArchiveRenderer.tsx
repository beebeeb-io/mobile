/**
 * ArchiveRenderer — unified browser for ZIP, TAR, GZ/TGZ archives.
 *
 * Extends the existing ZIP viewer pattern from PreviewScreen.
 * - ZIP: parsed with JSZip (already installed)
 * - TAR: minimal 512-byte header parser (no external deps)
 * - GZ/TGZ: decompressed with pako, then parsed as TAR
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import JSZip from 'jszip';
import pako from 'pako';
import { radii } from '../../theme';
import type { Colors } from '../../theme';
import { formatBytes } from '../../lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArchiveEntry {
  /** Full path inside the archive (e.g. "src/foo.ts") */
  path: string;
  /** Display name — last segment of path */
  name: string;
  /** True for directories */
  isFolder: boolean;
  /** Uncompressed size in bytes */
  size: number;
  /** Modified date if available */
  modifiedAt: Date | null;
  /** Lowercase extension, used for icon mapping */
  ext: string;
}

interface ArchiveSummary {
  entries: ArchiveEntry[];
  fileCount: number;
  folderCount: number;
  totalSize: number;
  format: 'zip' | 'tar' | 'gz' | 'tgz';
}

// ---------------------------------------------------------------------------
// TAR parser — minimal header reader
// ---------------------------------------------------------------------------

/**
 * Parse a TAR file from raw bytes. TAR is simple: 512-byte header blocks
 * followed by ceil(size/512)*512 bytes of data. The header contains:
 *   - name at offset 0 (100 bytes, null-terminated)
 *   - size at offset 124 (12 bytes, octal null-terminated string)
 *   - mtime at offset 136 (12 bytes, octal, seconds since epoch)
 *   - typeflag at offset 156 (1 byte: '0'/'\\0' = file, '5' = directory)
 *   - prefix at offset 345 (155 bytes, null-terminated — extended name prefix)
 *
 * An all-zero 512-byte block signals end-of-archive.
 */
function parseTar(data: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;

  while (offset + 512 <= data.length) {
    // Check for end-of-archive (all-zero block)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (data[offset + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readNullString(data, offset, 100);
    const sizeStr = readNullString(data, offset + 124, 12);
    const mtimeStr = readNullString(data, offset + 136, 12);
    const typeflag = data[offset + 156];
    const prefix = readNullString(data, offset + 345, 155);

    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(sizeStr, 8) || 0;
    const mtime = parseInt(mtimeStr, 8) || 0;
    const isFolder = typeflag === 53 /* '5' */ || fullName.endsWith('/');

    if (fullName && fullName !== '.' && fullName !== './') {
      const cleanPath = fullName.replace(/\/$/, '');
      const segments = cleanPath.split('/');
      const displayName = segments[segments.length - 1] || cleanPath;
      const ext = isFolder
        ? ''
        : (displayName.toLowerCase().split('.').pop() ?? '');

      entries.push({
        path: cleanPath,
        name: displayName,
        isFolder,
        size: isFolder ? 0 : size,
        modifiedAt: mtime > 0 ? new Date(mtime * 1000) : null,
        ext,
      });
    }

    // Advance past the header + data (data padded to 512-byte boundary)
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}

/** Read a null-terminated string from a Uint8Array. */
function readNullString(data: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  const limit = Math.min(offset + maxLen, data.length);
  while (end < limit && data[end] !== 0) {
    end++;
  }
  // Use TextDecoder for proper UTF-8 handling
  return new TextDecoder().decode(data.slice(offset, end)).trim();
}

// ---------------------------------------------------------------------------
// Archive parsers
// ---------------------------------------------------------------------------

async function parseZip(arrayBuffer: ArrayBuffer): Promise<ArchiveSummary> {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entries: ArchiveEntry[] = [];
  let fileCount = 0;
  let folderCount = 0;
  let totalSize = 0;

  Object.keys(zip.files).forEach((path) => {
    const f = zip.files[path];
    const cleanPath = f.dir ? path.replace(/\/$/, '') : path;
    const segments = cleanPath.split('/');
    const name = segments[segments.length - 1] || cleanPath;
    const ext = f.dir ? '' : (name.toLowerCase().split('.').pop() ?? '');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalData = (f as any)._data as
      | { uncompressedSize?: number }
      | undefined;
    const size = f.dir ? 0 : internalData?.uncompressedSize ?? 0;

    if (f.dir) {
      folderCount += 1;
    } else {
      fileCount += 1;
      totalSize += size;
    }

    entries.push({
      path: cleanPath,
      name,
      isFolder: !!f.dir,
      size,
      modifiedAt: f.date ?? null,
      ext,
    });
  });

  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return { entries, fileCount, folderCount, totalSize, format: 'zip' };
}

function parseTarBuffer(arrayBuffer: ArrayBuffer): ArchiveSummary {
  const data = new Uint8Array(arrayBuffer);
  const entries = parseTar(data);

  let fileCount = 0;
  let folderCount = 0;
  let totalSize = 0;

  for (const e of entries) {
    if (e.isFolder) {
      folderCount++;
    } else {
      fileCount++;
      totalSize += e.size;
    }
  }

  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return { entries, fileCount, folderCount, totalSize, format: 'tar' };
}

function parseGzBuffer(arrayBuffer: ArrayBuffer, isTgz: boolean): ArchiveSummary {
  const compressed = new Uint8Array(arrayBuffer);
  const decompressed = pako.inflate(compressed);

  if (isTgz) {
    // .tgz / .tar.gz — the decompressed content is a TAR
    const summary = parseTarBuffer(decompressed.buffer as ArrayBuffer);
    return { ...summary, format: 'tgz' };
  }

  // Plain .gz — single file, no TAR inside. Show as a single entry.
  return {
    entries: [
      {
        path: '(decompressed content)',
        name: '(decompressed content)',
        isFolder: false,
        size: decompressed.length,
        modifiedAt: null,
        ext: '',
      },
    ],
    fileCount: 1,
    folderCount: 0,
    totalSize: decompressed.length,
    format: 'gz',
  };
}

// ---------------------------------------------------------------------------
// Icon helper — mirrors PreviewScreen's zipEntryIcon
// ---------------------------------------------------------------------------

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function entryIcon(entry: ArchiveEntry): IoniconName {
  if (entry.isFolder) return 'folder';
  const { ext } = entry;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp', 'tiff'].includes(ext))
    return 'image';
  if (ext === 'pdf') return 'document-text';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext))
    return 'musical-notes';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'videocam';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'document';
  if (['xls', 'xlsx', 'csv', 'ods', 'tsv'].includes(ext)) return 'grid';
  if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext))
    return 'file-tray-stacked';
  if (
    [
      'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'kt', 'swift',
      'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'json',
      'xml', 'html', 'htm', 'css', 'scss', 'yaml', 'yml', 'toml', 'md',
    ].includes(ext)
  )
    return 'code-slash';
  return 'document-outline';
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date | null): string | null {
  if (!d || isNaN(d.getTime())) return null;
  const month = d.toLocaleString('en', { month: 'short' });
  const day = d.getDate();
  const year = d.getFullYear();
  return `${month} ${day}, ${year}`;
}

const FORMAT_LABELS: Record<ArchiveSummary['format'], string> = {
  zip: 'ZIP Archive',
  tar: 'TAR Archive',
  gz: 'GZ Compressed',
  tgz: 'TAR.GZ Archive',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ArchiveRendererProps {
  /** Raw file bytes as an ArrayBuffer */
  data: ArrayBuffer;
  /** Lowercase extension (e.g. "zip", "tar", "gz", "tgz") */
  extension: string;
  /** Theme colors from useTheme() */
  colors: Colors;
}

export function ArchiveRenderer({ data, extension, colors: c }: ArchiveRendererProps) {
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        let result: ArchiveSummary;
        const ext = extension.toLowerCase();

        if (ext === 'zip') {
          result = await parseZip(data);
        } else if (ext === 'tar') {
          result = parseTarBuffer(data);
        } else if (ext === 'tgz') {
          result = parseGzBuffer(data, true);
        } else if (ext === 'gz') {
          // Heuristic: try as .tar.gz first. If the decompressed data
          // looks like a valid TAR (starts with non-zero bytes and has
          // a valid header), treat it as TGZ. Otherwise treat as plain GZ.
          try {
            const compressed = new Uint8Array(data);
            const decompressed = pako.inflate(compressed);
            // Check if decompressed data looks like a TAR (first 100 bytes
            // should contain a filename — at least some non-zero bytes)
            if (decompressed.length >= 512 && decompressed[0] !== 0) {
              const tarEntries = parseTar(decompressed);
              if (tarEntries.length > 0) {
                result = parseGzBuffer(data, true);
              } else {
                result = parseGzBuffer(data, false);
              }
            } else {
              result = parseGzBuffer(data, false);
            }
          } catch {
            result = parseGzBuffer(data, false);
          }
        } else {
          // Fallback: try ZIP
          result = await parseZip(data);
        }

        if (!cancelled) setSummary(result);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to read archive',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data, extension]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={c.amber} size="large" />
        <Text style={[styles.statusText, { color: c.ink3 }]}>
          Reading archive contents...
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.errorTitle, { color: c.ink }]}>
          Couldn't open archive
        </Text>
        <Text style={[styles.statusText, { color: c.ink3 }]}>{error}</Text>
      </View>
    );
  }

  if (!summary) return null;

  return <ArchiveContents summary={summary} colors={c} />;
}

// ---------------------------------------------------------------------------
// ArchiveContents — FlatList of entries (mirrors ZipContents pattern)
// ---------------------------------------------------------------------------

interface ArchiveContentsProps {
  summary: ArchiveSummary;
  colors: Colors;
}

function ArchiveContents({ summary, colors: c }: ArchiveContentsProps) {
  const { entries, fileCount, folderCount, totalSize, format } = summary;
  const formatLabel = FORMAT_LABELS[format];

  const renderRow = useMemo(
    () =>
      ({ item }: { item: ArchiveEntry }) => {
        const iconBg = item.isFolder ? c.amberDeep : c.ink3;
        const iconName = entryIcon(item);
        const dateLabel = formatDate(item.modifiedAt);

        return (
          <View style={[styles.row, { borderBottomColor: c.line }]}>
            <View style={[styles.rowIcon, { backgroundColor: iconBg }]}>
              <Ionicons name={iconName} size={16} color="#FFFFFF" />
            </View>
            <View style={styles.rowText}>
              <Text
                style={[styles.rowName, { color: c.ink }]}
                numberOfLines={1}
              >
                {item.path || item.name}
              </Text>
              <Text
                style={[styles.rowMeta, { color: c.ink3 }]}
                numberOfLines={1}
              >
                {item.isFolder
                  ? 'Folder'
                  : `${formatBytes(item.size)}${dateLabel ? `  ·  ${dateLabel}` : ''}`}
              </Text>
            </View>
          </View>
        );
      },
    [c],
  );

  return (
    <View style={[styles.container, { backgroundColor: c.paper }]}>
      <View style={[styles.header, { borderBottomColor: c.line }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.headerTitle, { color: c.ink }]}>
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
            {folderCount > 0
              ? `  ·  ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}`
              : ''}
          </Text>
          <Text style={[styles.headerSize, { color: c.ink3 }]}>
            {formatBytes(totalSize)} uncompressed
          </Text>
        </View>
        <Text style={[styles.headerHint, { color: c.ink3 }]}>
          {formatLabel} · read-only listing · download to extract files.
        </Text>
      </View>

      {entries.length === 0 ? (
        <View style={styles.centered}>
          <Text style={[styles.errorTitle, { color: c.ink }]}>
            Empty archive
          </Text>
          <Text style={[styles.statusText, { color: c.ink3 }]}>
            This archive contains no files.
          </Text>
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
// Styles — matches PreviewScreen's ZIP styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusText: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
  },
  header: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  headerSize: {
    fontSize: 12,
    fontWeight: '500',
  },
  headerHint: {
    fontSize: 11,
    fontStyle: 'italic',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: 13,
    fontWeight: '500',
  },
  rowMeta: {
    fontSize: 11,
    marginTop: 2,
  },
});
