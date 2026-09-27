/**
 * Trust Details bottom sheet — opened from the lock icon on a file row.
 *
 * Shows the encryption details we know about a file: algorithm, key source,
 * device, storage pool, provider. Bottom-actions launch the "Prove it"
 * verification view and the raw-ciphertext download.
 *
 * Brand voice: honest, name the city, don't reassure.
 */

import React, { useEffect, useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { fonts, onAmber, radii, spacing } from '../theme';
import { BottomSheet, BottomSheetScrollView } from './sheet/BottomSheet';
import { useTheme } from '../lib/theme-context';
import { trustLocation, type FileEntry } from '../lib/api';
import { formatBytes as formatSize } from '../lib/format';
import EncryptionProof from './EncryptionProof';
import {
  TRUST_ENCRYPTED_ON_LABEL,
  trustEncryptedOnValue,
  trustKeySourceLabel,
} from '../lib/trust-details';

interface Props {
  file: FileEntry | null;
  fileName: string;
  /**
   * Task 1593 — the mime the preview uses for this file (FilesScreen's
   * `mimeTypeFor`), so "Prove it" reads the preview's cached copy instead of
   * decrypting a second one under another extension.
   */
  mimeType?: string | null;
  onClose: () => void;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const month = d.toLocaleString('en', { month: 'short' });
  const day = d.getDate();
  const year = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${month} ${day}, ${year} at ${hh}:${mm}`;
}


interface RowProps {
  label: string;
  value: string;
  mono?: boolean;
  inkLabel: string;
  inkValue: string;
  border: string;
}

function DetailRow({ label, value, mono, inkLabel, inkValue, border }: RowProps) {
  return (
    <View style={[styles.row, { borderBottomColor: border }]}>
      <Text style={[styles.rowLabel, { color: inkLabel }]}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          { color: inkValue },
          mono && { fontFamily: fonts.mono, fontSize: 12 },
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

export default function TrustDetailsSheet({ file: fileProp, fileName: fileNameProp, mimeType: mimeTypeProp, onClose }: Props) {
  const { colors: c } = useTheme();
  const [proofOpen, setProofOpen] = useState(false);
  // 1586 — the sheet slides down (shared BottomSheet) before its Modal goes
  // away, so the last file stays rendered through the close animation.
  const [shown, setShown] = useState<{ file: FileEntry; fileName: string; mimeType?: string | null } | null>(
    fileProp ? { file: fileProp, fileName: fileNameProp, mimeType: mimeTypeProp } : null,
  );
  const [modalMounted, setModalMounted] = useState(!!fileProp);
  useEffect(() => {
    if (fileProp) setShown({ file: fileProp, fileName: fileNameProp, mimeType: mimeTypeProp });
    if (fileProp && !proofOpen) setModalMounted(true);
  }, [fileProp, fileNameProp, mimeTypeProp, proofOpen]);
  // Closed (e.g. Android back) while "Prove it" was handing off: the proof
  // must not open once the sheet's Modal is gone (1586 review #6).
  useEffect(() => {
    if (!fileProp) setProofOpen(false);
  }, [fileProp]);

  if (!shown) return null;
  const { file, fileName, mimeType } = shown;

  const loc = trustLocation(file.storage_pool_id);
  const sheetVisible = !!fileProp && !proofOpen;

  const header = (
    <View style={styles.headerRow}>
      <View style={[styles.lockBadge, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
        <Ionicons name="lock-closed" size={16} color={c.amberDeep} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: c.ink }]}>Encryption details</Text>
        <Text style={[styles.subtitle, { color: c.ink3 }]} numberOfLines={1}>
          {fileName}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onClose}
        accessibilityLabel="Close"
        style={styles.closeBtn}
      >
        <Ionicons name="close" size={20} color={c.ink3} />
      </TouchableOpacity>
    </View>
  );

  return (
    <>
      <Modal
        visible={modalMounted}
        animationType="none"
        transparent
        statusBarTranslucent
        onRequestClose={onClose}
      >
        <GestureHandlerRootView style={styles.fill}>
          <BottomSheet
            visible={sheetVisible}
            onRequestClose={onClose}
            onDismissed={() => setModalMounted(false)}
            detents={['half', 'default']}
            initialDetent="default"
            header={header}
            contentStyle={styles.body}
            handleAccessibilityLabel="Encryption details sheet"
            scrimAccessibilityLabel="Close encryption details"
            testID="trust-details-sheet"
          >
            <BottomSheetScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: spacing.md }}>
              <DetailRow
                label="Algorithm"
                value="AES-256-GCM"
                mono
                inkLabel={c.ink3}
                inkValue={c.ink}
                border={c.line}
              />
              <DetailRow
                label="Key source"
                value={trustKeySourceLabel(file)}
                inkLabel={c.ink3}
                inkValue={c.ink}
                border={c.line}
              />
              <DetailRow
                label="Encrypted at"
                value={formatTimestamp(file.created_at)}
                inkLabel={c.ink3}
                inkValue={c.ink}
                border={c.line}
              />
              <DetailRow
                label={TRUST_ENCRYPTED_ON_LABEL}
                value={trustEncryptedOnValue(file)}
                inkLabel={c.ink3}
                inkValue={c.ink}
                border={c.line}
              />
              <DetailRow
                label="Stored in"
                value={`${loc.region} · ${loc.city}`}
                inkLabel={c.ink3}
                inkValue={c.ink}
                border={c.line}
              />
              <DetailRow
                label="Provider"
                value={loc.provider}
                inkLabel={c.ink3}
                inkValue={c.ink}
                border={c.line}
              />
              <DetailRow
                label="File size"
                value={formatSize(file.size_bytes)}
                inkLabel={c.ink3}
                inkValue={c.ink}
                border={c.transparent}
              />

              <View style={[styles.divider, { backgroundColor: c.line }]} />

              <View style={styles.copyBlock}>
                <Text style={[styles.copyLine, { color: c.ink2 }]}>Key never left your device.</Text>
                <Text style={[styles.copyLine, { color: c.ink2 }]}>
                  We store ciphertext. We can't read it.
                </Text>
              </View>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.proveBtn, { backgroundColor: c.amber }]}
                  onPress={() => setProofOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Prove it"
                >
                  <Ionicons name="shield-checkmark" size={16} color={onAmber} />
                  <Text style={[styles.proveBtnText, { color: onAmber }]}>Prove it</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.rawBtn, { borderColor: c.line2 }]}
                  onPress={() => setProofOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Download raw ciphertext"
                >
                  <Ionicons name="download-outline" size={16} color={c.ink2} />
                  <Text style={[styles.rawBtnText, { color: c.ink2 }]}>Download raw</Text>
                </TouchableOpacity>
              </View>
            </BottomSheetScrollView>
          </BottomSheet>
        </GestureHandlerRootView>
      </Modal>

      {/* Presented only once the sheet's Modal is gone — two iOS modals
          presenting/dismissing at once dismiss each other. */}
      <EncryptionProof
        file={file}
        fileName={fileName}
        mimeType={mimeType}
        visible={proofOpen && !modalMounted}
        onClose={() => setProofOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  // 1586 — the sheet itself is the shared BottomSheet (full width, top
  // corners GLASS_RADII.sheet, home-indicator inset inside, draggable handle
  // + header between half / default). Was: radii.xl corners, content height
  // capped at 85 %, a hairline border, drag did nothing.
  fill: { flex: 1 },
  body: { paddingHorizontal: spacing.lg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  lockBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 1 },
  closeBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowLabel: { fontSize: 12, fontWeight: '500', width: 108 },
  rowValue: { flex: 1, fontSize: 13, fontWeight: '500', textAlign: 'right' },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.md },
  copyBlock: { gap: 4, marginBottom: spacing.md },
  copyLine: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  proveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radii.md,
    gap: 6,
  },
  proveBtnText: { fontSize: 14, fontWeight: '600' },
  rawBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 6,
  },
  rawBtnText: { fontSize: 13, fontWeight: '600' },
});
