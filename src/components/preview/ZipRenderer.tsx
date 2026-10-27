/**
 * ZipRenderer — read-only, NAVIGABLE listing for .zip archives.
 *
 * Task 2233 item 6: the archive is NOT loaded. The listing comes from the
 * central directory (zip-reader.ts, ranged reads) and one entry is read on
 * demand, so a 50 MB+ archive no longer exhausts the JS heap.
 * (.tar / .gz / .tgz are handled by ArchiveRenderer.)
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
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import {
  MAX_ENTRY_BYTES,
  ZipReadError,
  readZipEntry,
  type ByteSource,
  type ZipEntryMeta,
  type ZipListing,
} from '../../lib/zip-reader';
import { withPlaintextLease, writePlaintext } from '../../lib/plaintext-gate';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
// 1346 — the static `colors` (light-only) import that used to live here was
// removed: it was shadowing the `c` prop (`colors: c` below, the real
// scheme-aware palette) and got read by mistake in three error/loading
// states.
import { radii } from '../../theme';
import type { Colors } from '../../theme';
import { type ZipEntry, type ZipRow, levelRows, withoutMacOsNoise } from '../../lib/zip-tree';
import { formatBytes } from '../../lib/format';
import { formatDate, zipDosDateAsLocal } from '../../lib/date-format';

interface ZipSummary {
  entries: ZipEntry[];
  fileCount: number;
  folderCount: number;
  totalUncompressed: number;
}

interface ZipRendererProps {
  /** Ranged access to the decrypted archive on disk (never its bytes). */
  source: ByteSource;
  /** Central-directory listing, produced by `readZipListing`. */
  listing: ZipListing;
  /** Share/save the whole decrypted archive when one entry cannot be previewed. */
  onShareArchive?: () => void;
  colors: Colors;
  /**
   * Task 1592 — the preview is full-bleed (PreviewScreen's `fullBleedFill`),
   * with the close / title / ⋯ chrome floating over the top and the action bar
   * over the bottom. `topInset` pads the whole container (header stays pinned
   * below the chrome), `bottomInset` is the list's scroll-content inset.
   */
  topInset?: number;
  bottomInset?: number;
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/** Stable short hash for a temp file name — the entry path may be hostile. */
function entryHash(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i += 1) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The listing as the navigable tree expects it. */
function listingToTreeEntries(listing: ZipListing): ZipEntry[] {
  return withoutMacOsNoise(
    listing.entries.map((e) => ({
      path: e.path,
      name: e.name,
      isFolder: e.isFolder,
      uncompressedSize: e.uncompressedSize,
      modifiedAt: e.modifiedAt,
      ext: e.isFolder ? '' : (e.name.toLowerCase().split('.').pop() ?? ''),
    })),
  );
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

// Task 1592 — the device locale's date form (src/lib/date-format.ts).
function formatZipDate(d: Date | null): string | null {
  return formatDate(d) || null;
}

/** Writes one entry under the pre-existing `zip-extract/` plaintext cache entry
 *  and hands it to the OS share sheet. The temp name is hashed so an entry's
 *  own (`..`-bearing) name never reaches the filesystem. */
async function extractAndShare(source: ByteSource, entry: ZipEntryMeta): Promise<void> {
  const bytes = await readZipEntry(source, entry, { maxOutputBytes: MAX_ENTRY_BYTES });
  const safeName = entry.name.replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'extracted';
  const dir = `${FileSystem.cacheDirectory}zip-extract/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const target = `${dir}${entryHash(entry.path)}-${safeName}`;
  // Task 1593 round 3 — plaintext writer: gated by the sign-out purge.
  await withPlaintextLease('ZIP entry extract', (lease) =>
    writePlaintext(lease, target, FileSystem, async () => {
      new File(target).write(bytes);
    }),
  );
  try {
    await Sharing.shareAsync(target);
  } finally {
    // Best-effort cleanup once the sheet resolves; the dir lives under the
    // auto-pruned cache either way.
    FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
  }
}

/** Copy for the states where an entry cannot be opened in place. */
function entryRefusal(err: unknown): { title: string; body: string } {
  if (err instanceof ZipReadError) {
    if (err.code === 'too-large') {
      return {
        title: 'Too large to preview here',
        body: 'This file is too large to open in the app. Share the archive to open it somewhere else.',
      };
    }
    if (err.code === 'encrypted') {
      return {
        title: 'Password-protected file',
        body: 'This file is encrypted inside the archive. Share the archive to open it in another app.',
      };
    }
    if (err.code === 'unsupported-method') {
      return {
        title: 'Cannot preview this file',
        body: 'This file uses a compression method the app cannot open. Share the archive to open it in another app.',
      };
    }
  }
  return {
    title: 'Could not read this file',
    body: 'The archive may be damaged. Share it to open it in another app.',
  };
}

export function ZipRenderer({
  source,
  listing,
  onShareArchive,
  colors: c,
  topInset = 0,
  bottomInset = 0,
}: ZipRendererProps) {
  // Current folder prefix being browsed ('' = archive root, 'a/b/' = nested).
  const [prefix, setPrefix] = useState('');
  // 1291 — path of the entry currently being extracted (one at a time).
  const [extracting, setExtracting] = useState<string | null>(null);

  const summary = useMemo<ZipSummary>(() => {
    const entries = listingToTreeEntries(listing);
    return {
      entries,
      fileCount: entries.filter((e) => !e.isFolder).length,
      folderCount: entries.filter((e) => e.isFolder).length,
      // Summed over the visible entries so macOS metadata noise cannot inflate it.
      totalUncompressed: entries.reduce((sum, e) => sum + (e.isFolder ? 0 : e.uncompressedSize), 0),
    };
  }, [listing]);

  const rows = useMemo(() => levelRows(summary.entries, prefix), [summary, prefix]);
  const segments = useMemo(() => prefix.split('/').filter(Boolean), [prefix]);

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
          {/* 1346 — #FFFFFF reviewed, not part of the review finding above:
              this icon sits on its own solid `c.amberDeep` tile (below), not
              on PreviewScreen's doc root — amberDeep is the same hex in both
              palettes (theme.ts), so this tile's contrast never changes with
              scheme. Different bug class from the colors.white/root-text
              finding this task fixed. */}
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
    const isExtracting = extracting === entry.path;
    // 1291 (Guus) — a file row is no longer inert: tap extracts the single entry to the
    // auto-pruned cache and opens the OS share sheet (Quick Look / Save to Files / AirDrop).
    const onExtract = async () => {
      if (extracting) return;
      const meta = listing.entries.find((e) => e.path === entry.path);
      if (!meta) return;
      if (meta.uncompressedSize > MAX_ENTRY_BYTES) {
        Alert.alert(
          'Too large to preview here',
          'This file is too large to open in the app. Share the archive to open it somewhere else.',
          onShareArchive
            ? [{ text: 'Cancel', style: 'cancel' }, { text: 'Share archive', onPress: onShareArchive }]
            : [{ text: 'OK' }],
        );
        return;
      }
      setExtracting(entry.path);
      try {
        await extractAndShare(source, meta);
      } catch (err) {
        const refused = entryRefusal(err);
        Alert.alert(
          refused.title,
          refused.body,
          onShareArchive
            ? [{ text: 'Cancel', style: 'cancel' }, { text: 'Share archive', onPress: onShareArchive }]
            : [{ text: 'OK' }],
        );
      } finally {
        setExtracting(null);
      }
    };
    return (
      <TouchableOpacity
        style={[styles.zipRow, { borderBottomColor: c.line }]}
        onPress={() => void onExtract()}
        disabled={extracting != null}
        accessibilityRole="button"
        accessibilityLabel={`${entry.name}, extract and preview`}
        testID={`zip-entry-${entry.path}`}
      >
        {/* 1346 — #FFFFFF reviewed, not part of the review finding above:
            this icon sits on its own solid `c.ink3` tile, not on
            PreviewScreen's doc root. `c.ink3` is a medium-toned gray in
            BOTH palettes (#7d7770 light / #8a867f dark, theme.ts) — never
            near-white — so this tile keeps workable contrast in either
            scheme; it never approaches the invisible white-on-#faf8f5 case
            this task fixed. Pre-existing, unrelated to the root-background
            decision. */}
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
        {isExtracting ? (
          <ActivityIndicator size="small" color={c.amber} />
        ) : (
          <Ionicons name="open-outline" size={16} color={c.ink3} />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.zipContainer, { backgroundColor: c.paper, paddingTop: topInset }]}>
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
          Tap a file to extract and preview it · folders open in place.
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
          <Text style={[styles.imageStatusTitle, { color: c.ink }]}>
            Empty archive
          </Text>
          <Text style={[styles.imageStatusSub, { color: c.ink3 }]}>This ZIP contains no files.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item, i) =>
            item.kind === 'folder' ? `d:${i}:${item.name}` : `f:${i}:${item.entry.path}`
          }
          renderItem={renderRow}
          contentContainerStyle={bottomInset ? { paddingBottom: bottomInset } : undefined}
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
