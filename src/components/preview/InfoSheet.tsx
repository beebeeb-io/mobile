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
 * Content surface, not control-layer glass (task 1315's own rule, followed
 * verbatim from the app's one PROVEN bottom-sheet precedent,
 * `ShareSheetScreen.tsx`): opaque `c.paper`, all four corners at
 * `GLASS_RADII.sheet` (38), inset from the screen edges, backdrop via
 * `modalScrim`. `GlassSheet` (task 1311) was considered and rejected here —
 * it is unused anywhere outside the dev gallery, and its glass material is
 * documented as "the floating CONTROL layer", not a content surface; reusing
 * the proven opaque pattern instead of the unproven glass one is the lower-risk
 * call under this task's time budget (recorded in DEVIATIONS.md).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { fonts, radii, shadows } from '../../theme';
import type { Colors } from '../../theme';
import { useTheme } from '../../lib/theme-context';
import { useCrypto } from '../../lib/crypto-context';
import { getFile, listFileVersions, type FileVersionEntry } from '../../lib/api';
import { encryptedMetadataPayloadToBytes } from '../../lib/encrypted-metadata';
import { modalScrim } from '../glass';
import { formatBytes as formatSize } from '../../lib/format';
import { buildInfoSubline, formatShareStatus, resolveFolderLabel } from '../../lib/preview-chrome';

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
  storageLocation: string;
  /** Every field the old DetailsSheet showed (Format / Type / Version /
   * Chunks / Encryption) — carried over verbatim, nothing dropped. */
  extraRows: InfoSheetExtraRow[];
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
  storageLocation,
  extraRows,
}: InfoSheetProps) {
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { decryptMetadata } = useCrypto();
  const { height: windowHeight } = Dimensions.get('window');

  const [parentId, setParentId] = useState<string | null | undefined>(undefined);
  const [shareCount, setShareCount] = useState<number | null>(null);
  const [modifiedLabel, setModifiedLabel] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [versions, setVersions] = useState<FileVersionEntry[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Fetch fresh metadata + the version list every time the sheet opens for a
  // (possibly new) file — never on every render, and never while closed.
  useEffect(() => {
    if (!visible || !fileId) return;
    let cancelled = false;

    setMetaLoading(true);
    setMetaError(null);
    setParentId(undefined);
    setFolderName(null);
    (async () => {
      try {
        const file = await getFile(fileId);
        if (cancelled) return;
        setParentId(file.parent_id ?? null);
        setShareCount(file.share_count ?? 0);
        setModifiedLabel(formatModified(file.updated_at));

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
    listFileVersions(fileId)
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((err) => {
        if (!cancelled) setVersionsError(err instanceof Error ? err.message : 'Could not load version history.');
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [visible, fileId, decryptMetadata]);

  // ---- Presentation (slide up / down, drag-to-dismiss) ----
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, {
      toValue: visible ? 1 : 0,
      damping: 26,
      stiffness: 240,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
  }, [anim, visible]);

  const safeBottom = Math.max(insets.bottom, 16);
  const sheetHeight = Math.min(Math.round(windowHeight * 0.72), windowHeight - insets.top - 40);
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight + 40, 0] });
  const backdropOpacity = anim;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_evt, gesture) => {
          if (gesture.dy > 40 || gesture.vy > 0.7) onClose();
        },
      }),
    [onClose],
  );

  const subline = buildInfoSubline({
    kindLabel,
    sizeLabel: sizeBytes != null ? formatSize(sizeBytes) : null,
    pageCount,
  });
  const folderLabel = resolveFolderLabel(parentId, folderName);
  const shareLabel = formatShareStatus(shareCount);

  const styles = useMemo(() => infoSheetStyles(c), [c]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdropOpacity }]}>
        <TouchableOpacity
          style={[StyleSheet.absoluteFill, { backgroundColor: modalScrim(resolved) }]}
          activeOpacity={1}
          onPress={onClose}
          accessibilityLabel="Close file info"
          testID="preview-info-backdrop"
        />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          {
            height: sheetHeight,
            paddingBottom: safeBottom,
            transform: [{ translateY }],
          },
        ]}
        testID="preview-info-sheet"
      >
        <View {...panResponder.panHandlers}>
          <View style={styles.grabber} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
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
              <KvRow label="Modified" value={modifiedLabel ?? (metaLoading ? '…' : '—')} />
              <KvRow label="Folder" value={folderLabel} />
              <KvRow label="Shared" value={shareLabel} />
              {extraRows.map((row) => (
                <KvRow key={row.label} label={row.label} value={row.value} mono={row.mono} />
              ))}
              <KvRow label="Storage" value={storageLocation} />
            </View>
          )}

          <Text style={styles.sectionHeading} testID="preview-info-versions-heading">Versions</Text>
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
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function KvRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={[rowStyles.value, mono && rowStyles.mono]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    minHeight: 36,
    paddingVertical: 7,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.18)',
  },
  label: { fontSize: 12, fontWeight: '600', opacity: 0.55 },
  value: { flex: 1, textAlign: 'right', fontSize: 12, fontWeight: '600' },
  mono: { fontFamily: fonts.mono, fontSize: 11 },
});

function infoSheetStyles(c: Colors) {
  return StyleSheet.create({
    sheet: {
      position: 'absolute',
      left: 10,
      right: 10,
      bottom: 10,
      borderRadius: 38,
      backgroundColor: c.paper,
      paddingTop: 12,
      paddingHorizontal: 20,
      ...shadows.lg,
    },
    grabber: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.line2,
      alignSelf: 'center',
      marginBottom: 14,
    },
    scrollContent: { paddingBottom: 12 },
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
