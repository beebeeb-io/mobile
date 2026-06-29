/**
 * ZipRenderer — read-only, NAVIGABLE listing for .zip archives via JSZip.
 *
 * Owns the JSZip import so the library only enters Hermes when the user opens a
 * ZIP. (.tar / .gz / .tgz are handled by ArchiveRenderer.)
 *
 * Nested folders are navigable (task 0779): the flat central-directory entries
 * are projected into a folder tree on the fly — tap a folder to drill in, tap a
 * breadcrumb to ascend. Still read-only (no extraction needed to browse).
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import JSZip from 'jszip';
import { colors, radii } from '../../theme';
import type { Colors } from '../../theme';
import { type ZipEntry, type ZipRow, levelRows, isMacOsNoise } from '../../lib/zip-tree';
import { formatBytes } from '../../lib/format';

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
    // Hide macOS resource-fork noise (__MACOSX/ + ._* AppleDouble) — task 0779.
    if (isMacOsNoise(path)) return;
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
  // Current folder prefix being browsed ('' = archive root, 'a/b/' = nested).
  const [prefix, setPrefix] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    setPrefix('');
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

  const rows = useMemo(
    () => (summary ? levelRows(summary.entries, prefix) : []),
    [summary, prefix],
  );
  const segments = useMemo(() => prefix.split('/').filter(Boolean), [prefix]);

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

  const { fileCount, folderCount, totalUncompressed } = summary;

  const renderRow = ({ item }: { item: ZipRow }) => {
    if (item.kind === 'folder') {
      return (
        <TouchableOpacity
          style={[styles.zipRow, { borderBottomColor: c.line }]}
          onPress={() => setPrefix(`${prefix}${item.name}/`)}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, folder, open`}
        >
          <View style={[styles.zipIcon, { backgroundColor: c.amberDeep }]}>
            <Ionicons name="folder" size={16} color="#FFFFFF" />
          </View>
          <View style={styles.zipRowText}>
            <Text style={[styles.zipRowName, { color: c.ink }]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.zipRowMeta, { color: c.ink3 }]} numberOfLines={1}>
              {item.fileCount > 0
                ? `${item.fileCount} ${item.fileCount === 1 ? 'file' : 'files'}`
                : 'Folder'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={c.ink3} />
        </TouchableOpacity>
      );
    }

    const entry = item.entry;
    const dateLabel = formatZipDate(entry.modifiedAt);
    return (
      <View style={[styles.zipRow, { borderBottomColor: c.line }]}>
        <View style={[styles.zipIcon, { backgroundColor: c.ink3 }]}>
          <Ionicons name={zipEntryIcon(entry)} size={16} color="#FFFFFF" />
        </View>
        <View style={styles.zipRowText}>
          <Text style={[styles.zipRowName, { color: c.ink }]} numberOfLines={1}>
            {entry.name}
          </Text>
          <Text style={[styles.zipRowMeta, { color: c.ink3 }]} numberOfLines={1}>
            {`${formatBytes(entry.uncompressedSize)}${dateLabel ? `  ·  ${dateLabel}` : ''}`}
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
            {formatBytes(totalUncompressed)} uncompressed
          </Text>
        </View>
        <Text style={[styles.zipHeaderHint, { color: c.ink3 }]}>
          Read-only listing · download the archive to extract files.
        </Text>
      </View>

      {/* Breadcrumb — shown once you drill into a nested folder. Each crumb is
          tappable to jump back up; the last crumb is the current folder. */}
      {segments.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.breadcrumbBar, { borderBottomColor: c.line }]}
          contentContainerStyle={styles.breadcrumb}
        >
          <TouchableOpacity onPress={() => setPrefix('')} accessibilityRole="button">
            <Text style={[styles.crumb, { color: c.amberDeep }]}>Archive</Text>
          </TouchableOpacity>
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1;
            const target = `${segments.slice(0, i + 1).join('/')}/`;
            return (
              <View key={target} style={styles.crumbGroup}>
                <Ionicons name="chevron-forward" size={12} color={c.ink3} />
                <TouchableOpacity
                  onPress={() => setPrefix(target)}
                  disabled={isLast}
                  accessibilityRole="button"
                >
                  <Text
                    style={[styles.crumb, { color: isLast ? c.ink : c.amberDeep }]}
                    numberOfLines={1}
                  >
                    {seg}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      )}

      {summary.entries.length === 0 ? (
        <View style={styles.imageStatus}>
          <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
            Empty archive
          </Text>
          <Text style={styles.imageStatusSub}>This ZIP contains no files.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item, i) =>
            item.kind === 'folder' ? `d:${i}:${item.name}` : `f:${i}:${item.entry.path}`
          }
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
  breadcrumbBar: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 4,
  },
  crumbGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  crumb: { fontSize: 12, fontWeight: '600', maxWidth: 160 },
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
