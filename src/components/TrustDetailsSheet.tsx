/**
 * Trust Details bottom sheet — opened from the lock icon on a file row.
 *
 * Shows the encryption details we know about a file: algorithm, key source,
 * device, storage pool, provider. Bottom-actions launch the "Prove it"
 * verification view and the raw-ciphertext download.
 *
 * Brand voice: honest, name the city, don't reassure.
 */

import React, { useState } from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Device from 'expo-device';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { trustLocation, type FileEntry } from '../lib/api';
import EncryptionProof from './EncryptionProof';

interface Props {
  file: FileEntry | null;
  fileName: string;
  onClose: () => void;
}

function deviceLabel(): string {
  if (Platform.OS === 'web') return 'This browser';
  const name = Device.deviceName?.trim();
  if (name && name.length > 0) return name;
  if (Platform.OS === 'ios') return 'This iPhone';
  if (Platform.OS === 'android') return Device.modelName ? `This ${Device.modelName}` : 'This Android';
  return 'This device';
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

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
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

export default function TrustDetailsSheet({ file, fileName, onClose }: Props) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [proofOpen, setProofOpen] = useState(false);

  if (!file) return null;

  const loc = trustLocation(file.storage_pool_id);
  const dev = deviceLabel();
  const sheetVisible = !!file && !proofOpen;

  return (
    <>
      <Modal
        visible={sheetVisible}
        animationType="slide"
        transparent
        onRequestClose={onClose}
      >
        <View style={styles.overlay}>
          <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={onClose} />
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: c.paper,
                borderColor: c.line,
                paddingBottom: (insets.bottom || spacing.md) + spacing.sm,
              },
            ]}
          >
            <View style={styles.handle}>
              <View style={[styles.handleBar, { backgroundColor: c.line2 }]} />
            </View>

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

            <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: spacing.md }}>
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
                value="Derived from file ID"
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
                label="Encrypted by"
                value={dev}
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
            </ScrollView>

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
                <Ionicons name="shield-checkmark" size={16} color={c.ink} />
                <Text style={[styles.proveBtnText, { color: c.ink }]}>Prove it</Text>
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
          </View>
        </View>
      </Modal>

      <EncryptionProof
        file={file}
        fileName={fileName}
        visible={proofOpen}
        onClose={() => setProofOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    maxHeight: '85%',
  },
  handle: { alignItems: 'center', paddingVertical: 6 },
  handleBar: { width: 36, height: 4, borderRadius: 2 },
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
  scroll: { maxHeight: 320 },
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
