/**
 * ZipRenderer — read-only listing for .zip archives via JSZip.
 *
 * Owns the JSZip import so the library only enters Hermes when the user
 * opens a ZIP. (.tar / .gz / .tgz are handled by ArchiveRenderer.)
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import JSZip from 'jszip';
import { colors, radii } from '../../theme';
import type { Colors } from '../../theme';

interface ZipEntry {
  path: string;
  name: string;
  isFolder: boolean;
  uncompressedSize: number;
  modifiedAt: Date | null;
  ext: string;
}

interface ZipSummary {
  entries: ZipEntry[];
  fileCount: number;
  folderCount: number;
  totalUncompressed: number;
}

interface ZipRendererProps {
  data: ArrayBuffer;
  colors: Colors;
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

async function parseZip(arrayBuffer: ArrayBuffer): Promise<ZipSummary> {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entries: ZipEntry[] = [];
  let fileCount = 0;
  let folderCount = 0;
  let totalUncompressed = 0;

  Object.keys(zip.files).forEach((path) => {
    const f = zip.files[path];
    const cleanPath = f.dir ? path.replace(/\/$/, '') : path;
    const segments = cleanPath.split('/');
    const name = segments[segments.length - 1] || cleanPath;
    const ext = f.dir ? '' : (name.toLowerCase().split('.').pop() ?? '');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalData = (f as any)._data as { uncompressedSize?: number } | undefined;
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

  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return { entries, fileCount, folderCount, totalUncompressed };
}

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

export function ZipRenderer({ data, colors: c }: ZipRendererProps) {
  const [summary, setSummary] = useState<ZipSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    (async () => {
      try {
        const result = await parseZip(data);
        if (!cancelled) setSummary(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to read archive.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (error) {
    return (
      <View style={styles.imageStatus}>
        <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
          Couldn't open archive
        </Text>
        <Text style={styles.imageStatusSub}>{error}</Text>
      </View>
    );
  }

  if (!summary) {
    return (
      <View style={styles.imageStatus}>
        <ActivityIndicator color={c.amber} />
        <Text style={[styles.imageStatusSub, { color: colors.white }]}>Reading archive…</Text>
      </View>
    );
  }

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

const styles = StyleSheet.create({
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
  zipHeaderTitle: { fontSize: 14, fontWeight: '700' },
  zipHeaderSize: { fontSize: 12, fontWeight: '500' },
  zipHeaderHint: { fontSize: 11, fontStyle: 'italic' },
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
  zipRowText: { flex: 1, minWidth: 0 },
  zipRowName: { fontSize: 13, fontWeight: '500' },
  zipRowMeta: { fontSize: 11, marginTop: 2 },
  imageStatus: {
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  imageStatusTitle: { fontSize: 16, fontWeight: '600' },
  imageStatusSub: { fontSize: 12, opacity: 0.85, textAlign: 'center' },
});
