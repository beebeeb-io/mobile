/**
 * InfoSheet — the Preview redesign's Info sheet (design item 5,
 * `design/preview-redesign-ios.html` section 03).
 *
 * Replaces the old `DetailsSheet` — a permanently-visible collapsed peek bar
 * that ate ~24pt + safe-bottom of every preview, always. This sheet is
 * closed by default and opens on demand (bottom-bar "Info"/"Versions", the
 * ⋯ menu's "Version history", or a swipe-up on the content) — see design
 * note: "Details on demand, not a permanent bar."
 *
 * Content surface, not control-layer glass (task 1315's own rule): opaque
 * `c.paper`, backdrop via `modalScrim`. Since task 1586 it renders through
 * the shared `BottomSheet` (src/components/sheet/BottomSheet.tsx): full
 * width, bottom edge attached, top corners only at `GLASS_RADII.sheet` (38),
 * draggable by the handle between half / default (72 %) / large detents.
 * `GlassSheet` (task 1311) was considered and rejected here —
 * it is unused anywhere outside the dev gallery, and its glass material is
 * documented as "the floating CONTROL layer", not a content surface; reusing
 * the proven opaque pattern instead of the unproven glass one is the lower-risk
 * call under this task's time budget (recorded in DEVIATIONS.md).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { fonts, radii } from '../../theme';
import type { Colors } from '../../theme';
import { useTheme } from '../../lib/theme-context';
import { useCrypto } from '../../lib/crypto-context';
import { getFile, listFileShareLinks, listFileVersions, type FileVersionEntry } from '../../lib/api';
import { useRegionCity } from '../../lib/storage-region';
import { encryptedMetadataPayloadToBytes } from '../../lib/encrypted-metadata';
import { BottomSheet, BottomSheetScrollView } from '../sheet/BottomSheet';
import { formatBytes as formatSize } from '../../lib/format';
import { buildInfoSubline, formatShareStatus, resolveFolderLabel } from '../../lib/preview-chrome';
import { resolveInfoShareCount, storageLocationLabel, type InfoSheetFocus } from '../../lib/preview-info';

/**
 * Task 1583 — the stacking slot of the whole sheet layer (scrim + sheet)
 * inside PreviewScreen's root: ABOVE the floating bottom bar
 * (`bottomBarWrap`, zIndex 15 — on Guus's device it floated over the sheet
 * and covered the Versions list) and BELOW the top chrome (`chromeLayer`,
 * zIndex 20), so close and ⋯ stay tappable while the sheet is open, as in
 * the design's section 03 mock (top bar visible, sheet over the bottom bar).
 */
export const INFO_SHEET_Z_INDEX = 18;

/** Task 1586 — the preview's top chrome row (48pt capsule + its top offset)
 * plus a gap, below the top inset: the Info sheet's large detent stops here
 * so its handle is never under the close / title / ⋯ buttons. */
const PREVIEW_CHROME_CLEARANCE = 68;

export interface InfoSheetExtraRow {
  label: string;
  value: string;
  mono?: boolean;
}

interface InfoSheetProps {
  visible: boolean;
  onClose: () => void;
  fileId: string;
  filename: string;
  kindLabel: string;
  sizeBytes: number | null;
  pageCount?: number | null;
  /** Task 1583 — built by `buildInfoSheetRows` (src/lib/preview-info.ts),
   * which documents which detail rows the sheet leaves out and why. */
  extraRows: InfoSheetExtraRow[];
  /** Task 1583 — 'versions' opens the sheet scrolled to the Versions
   * section (bottom bar "Versions", ⋯ "Version history"). */
  focus?: InfoSheetFocus;
}

/** Same shape as FilesScreen's private `parseDecryptedMetadata` — duplicated
 * (not imported: that one is a FilesScreen-local, unexported function) per
 * this codebase's existing per-screen-helper convention (see e.g. each
 * screen's own `displayName`). */
function decodedMetadataName(plaintext: string): string | null {
  try {
    const parsed = JSON.parse(plaintext) as { name?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      const name = parsed.name.trim();
      if (name) return name;
    }
  } catch {
    // Legacy metadata format: plaintext IS the bare name.
  }
  return plaintext || null;
}

function formatModified(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

function formatVersionDate(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

export function InfoSheet({
  visible,
  onClose,
  fileId,
  filename,
  kindLabel,
  sizeBytes,
  pageCount,
  extraRows,
  focus = 'info',
}: InfoSheetProps) {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { decryptMetadata } = useCrypto();

  const [parentId, setParentId] = useState<string | null | undefined>(undefined);
  /** Task 1592 — `undefined` while loading, `null` when unknown (row hidden). */
  const [shareCount, setShareCount] = useState<number | null | undefined>(undefined);
  const [modifiedLabel, setModifiedLabel] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [versions, setVersions] = useState<FileVersionEntry[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  /** True once THIS open's version fetch has settled (the state flags still
   * hold the previous open's values during the first render after opening). */
  const versionsLoadedRef = useRef(false);
  const scrollRef = useRef<React.ElementRef<typeof BottomSheetScrollView>>(null);
  const [versionsY, setVersionsY] = useState<number | null>(null);

  // Task 1583 — "Stored in" names the city (brand rule), from the server's
  // own "stored in {city}" source. A failure leaves `null` → "Europe".
  // Task 1592 — the same shared source as the Encryption details sheet.
  const regionCity = useRegionCity(visible);

  // Task 1583 — "Versions" lands on the Versions section, "Info" on the top.
  useEffect(() => {
    if (!visible || focus !== 'info') return;
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [visible, focus]);
  // The jump waits for the version list to load: while it loads the content
  // is too short to scroll that far (UIScrollView clamps the offset), which
  // on the simulator left "Versions" opening at the top.
  const pendingVersionsScrollRef = useRef(false);
  useEffect(() => {
    pendingVersionsScrollRef.current = visible && focus === 'versions';
  }, [visible, focus, fileId]);
  const scrollToVersionsIfPending = useCallback(() => {
    if (!pendingVersionsScrollRef.current || versionsY == null || !versionsLoadedRef.current) return;
    pendingVersionsScrollRef.current = false;
    scrollRef.current?.scrollTo({ y: Math.max(0, versionsY - 8), animated: true });
  }, [versionsY, versionsLoading]);
  useEffect(() => {
    scrollToVersionsIfPending();
  }, [scrollToVersionsIfPending]);

  // Fetch fresh metadata + the version list every time the sheet opens for a
  // (possibly new) file — never on every render, and never while closed.
  useEffect(() => {
    if (!visible || !fileId) return;
    let cancelled = false;

    setMetaLoading(true);
    setMetaError(null);
    setParentId(undefined);
    setFolderName(null);
    setShareCount(undefined);
    (async () => {
      try {
        const file = await getFile(fileId);
        if (cancelled) return;
        setParentId(file.parent_id ?? null);
        setModifiedLabel(formatModified(file.updated_at));
        // Task 1592 — never "Not shared" by default (see resolveInfoShareCount).
        void resolveInfoShareCount(file, () => listFileShareLinks(fileId)).then((count) => {
          if (!cancelled) setShareCount(count);
        });

        if (file.parent_id) {
          try {
            const parent = await getFile(file.parent_id);
            if (cancelled) return;
            let name: string | null = null;
            const raw = parent.name_encrypted;
            if (raw && !raw.startsWith('{')) {
              name = raw;
            } else if (raw) {
              const payload = encryptedMetadataPayloadToBytes(raw);
              if (payload) {
                const plaintext = await decryptMetadata(parent.id, payload.nonce, payload.ciphertext);
                if (cancelled) return;
                name = decodedMetadataName(plaintext);
              }
            }
            setFolderName(name ?? 'Untitled folder');
          } catch {
            if (!cancelled) setFolderName('Untitled folder');
          }
        }
      } catch (err) {
        if (!cancelled) setMetaError(err instanceof Error ? err.message : 'Could not load file info.');
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    })();

    setVersionsLoading(true);
    setVersionsError(null);
    versionsLoadedRef.current = false;
    listFileVersions(fileId)
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((err) => {
        if (!cancelled) setVersionsError(err instanceof Error ? err.message : 'Could not load version history.');
      })
      .finally(() => {
        if (!cancelled) {
          versionsLoadedRef.current = true;
          setVersionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [visible, fileId, decryptMetadata]);

  const subline = buildInfoSubline({
    kindLabel,
    sizeLabel: sizeBytes != null ? formatSize(sizeBytes) : null,
    pageCount,
  });
  const folderLabel = resolveFolderLabel(parentId, folderName);
  const shareLabel = shareCount === undefined ? '…' : shareCount === null ? null : formatShareStatus(shareCount);

  const styles = useMemo(() => infoSheetStyles(c), [c]);
  const locationLabel = storageLocationLabel({ city: regionCity ?? null });

  return (
    <BottomSheet
      visible={visible}
      onRequestClose={onClose}
      zIndex={INFO_SHEET_Z_INDEX}
      // The top chrome (close / title / ⋯, zIndex above the sheet) stays
      // usable, so even the large detent stops below it.
      topClearance={insets.top + PREVIEW_CHROME_CLEARANCE}
      detents={['half', 'default', 'large']}
      initialDetent="default"
      contentStyle={styles.body}
      handleAccessibilityLabel="File info sheet"
      scrimAccessibilityLabel="Close file info"
      testID="preview-info-sheet"
      layerTestID="preview-info-layer"
      scrimTestID="preview-info-backdrop"
    >
      <BottomSheetScrollView
        ref={scrollRef}
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        onContentSizeChange={scrollToVersionsIfPending}
        testID="preview-info-scroll"
      >
        <Text style={styles.title} numberOfLines={2}>{filename}</Text>
        <Text style={styles.subline}>{subline}</Text>

        <View style={styles.encBox}>
          <Ionicons name="lock-closed" size={20} color={c.amber} />
          <View style={{ flex: 1 }}>
            <Text style={styles.encTitle}>Encrypted on your device</Text>
            <Text style={styles.encBody}>
              Only your devices hold the key. We store it in Europe and cannot read it.
            </Text>
          </View>
        </View>

        {metaError ? (
          <Text style={styles.errorText}>{metaError}</Text>
        ) : (
          <View style={styles.kvBlock}>
            <KvRow styles={styles} label="Modified" value={modifiedLabel ?? (metaLoading ? '…' : '—')} />
            <KvRow styles={styles} label="Folder" value={folderLabel} />
            {shareLabel != null && (
              <KvRow styles={styles} label="Shared" value={shareLabel} testID="preview-info-shared" />
            )}
            {extraRows.map((row) => (
              <KvRow styles={styles} key={row.label} label={row.label} value={row.value} mono={row.mono} />
            ))}
            <KvRow styles={styles} label="Stored in" value={locationLabel} testID="preview-info-stored-in" />
          </View>
        )}

        <Text
          style={styles.sectionHeading}
          testID="preview-info-versions-heading"
          onLayout={(e) => setVersionsY(e.nativeEvent.layout.y)}
        >
          Versions
        </Text>
        {versionsLoading ? (
          <ActivityIndicator color={c.amber} style={{ marginTop: 8 }} />
        ) : versionsError ? (
          <Text style={styles.errorText}>{versionsError}</Text>
        ) : versions && versions.length > 0 ? (
          <View style={styles.versionsBlock}>
            {versions.map((v) => (
              <View key={v.id} style={styles.versionRow}>
                <Text style={styles.versionLabel}>Version {v.version_number}</Text>
                <Text style={styles.versionMeta}>
                  {formatVersionDate(v.created_at)} · {formatSize(v.size_bytes)}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.versionEmpty}>No earlier versions.</Text>
        )}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

function KvRow({
  styles,
  label,
  value,
  mono,
  testID,
}: {
  styles: ReturnType<typeof infoSheetStyles>;
  label: string;
  value: string;
  mono?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.kvRow} testID={testID}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, mono && styles.kvMono]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function infoSheetStyles(c: Colors) {
  return StyleSheet.create({
    // Task 1586 — the sheet itself (full width, bottom attached, top corners
    // at GLASS_RADII.sheet, the home-indicator inset inside it, the draggable
    // handle and detents) is the shared `BottomSheet`; #137's geometry moved
    // there verbatim. This is only the area below the handle.
    body: { paddingHorizontal: 20 },
    scroll: { flex: 1 },
    scrollContent: { paddingBottom: 12 },
    // Task 1583 — Guus's device: the labels were near-invisible (no colour at
    // all, so the platform's black at opacity 0.55 on the dark sheet) and
    // the values dim. Labels use ink2 (on paper: 9.2:1 dark, 6.8:1 light;
    // ink3 is only 4.2:1 in light, under AA for 13pt), values ink.
    kvRow: {
      minHeight: 40,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    kvLabel: { fontSize: 13, color: c.ink2 },
    kvValue: { flex: 1, textAlign: 'right', fontSize: 13, fontWeight: '500', color: c.ink },
    kvMono: { fontFamily: fonts.mono, fontSize: 12 },
    title: { fontSize: 18, fontWeight: '700', color: c.ink, letterSpacing: -0.2 },
    subline: {
      marginTop: 3,
      fontFamily: fonts.mono,
      fontSize: 12,
      color: c.ink3,
      marginBottom: 14,
    },
    encBox: {
      flexDirection: 'row',
      gap: 10,
      alignItems: 'flex-start',
      backgroundColor: c.amberBg,
      borderWidth: 1,
      borderColor: c.amber,
      borderRadius: radii.md,
      padding: 12,
      marginBottom: 16,
    },
    encTitle: { fontSize: 13, fontWeight: '700', color: c.ink },
    encBody: { fontSize: 12, color: c.ink2, marginTop: 2, lineHeight: 16 },
    kvBlock: { marginBottom: 8 },
    sectionHeading: {
      fontSize: 13,
      fontWeight: '700',
      color: c.ink,
      marginTop: 18,
      marginBottom: 6,
    },
    versionsBlock: { gap: 6 },
    versionRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: radii.sm,
      backgroundColor: c.paper2,
    },
    versionLabel: { fontSize: 12.5, fontWeight: '600', color: c.ink },
    versionMeta: { fontSize: 11.5, fontFamily: fonts.mono, color: c.ink3 },
    versionEmpty: { fontSize: 12.5, color: c.ink3, marginTop: 4 },
    errorText: { fontSize: 12.5, color: c.red, marginTop: 4 },
  });
}

export default InfoSheet;
