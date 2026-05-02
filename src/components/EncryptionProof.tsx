/**
 * "Prove it" — split hex-dump comparison and raw-ciphertext download.
 *
 * Shows the first 512 bytes of the file as it is stored on the server.
 * On the left, a readable-text view ("what you see"); on the right, the
 * raw hex dump ("what we store"). Once client-side AES-256-GCM ships,
 * the right side becomes random bytes and the comparison gets sharper.
 *
 * This screen does not decrypt anything — the bytes shown on the left are
 * the same bytes shown on the right, decoded best-effort. The point is the
 * UX scaffolding: the panels light up automatically when crypto is real.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { downloadFile, getDownloadUrl, trustLocation, type FileEntry } from '../lib/api';

interface Props {
  file: FileEntry;
  fileName: string;
  visible: boolean;
  onClose: () => void;
}

const PROOF_BYTES = 512;

function bytesToHex(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return out.join(' ');
}

function bytesToReadable(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // Printable ASCII + common whitespace; everything else collapses to '.'
    if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x09) {
      out.push(String.fromCharCode(b));
    } else {
      out.push('.');
    }
  }
  return out.join('');
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export default function EncryptionProof({ file, fileName, visible, onClose }: Props) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBytes(null);
    (async () => {
      try {
        const res = await downloadFile(file.id);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const all = new Uint8Array(buf);
        setBytes(all.slice(0, PROOF_BYTES));
      } catch {
        if (!cancelled) setError('Could not load proof bytes.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [file.id, visible]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await downloadFile(file.id);
      const buf = await res.arrayBuffer();
      const all = new Uint8Array(buf);
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const target = `${FileSystem.cacheDirectory}${safeName}.beebeeb.enc`;
      await FileSystem.writeAsStringAsync(target, bytesToBase64(all), {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(target, {
          mimeType: 'application/octet-stream',
          dialogTitle: 'Raw ciphertext',
          UTI: 'public.data',
        });
      }
    } catch {
      setError('Download failed.');
    } finally {
      setDownloading(false);
    }
  };

  const hex = bytes ? bytesToHex(bytes) : '';
  const readable = bytes ? bytesToReadable(bytes) : '';
  const totalBytes = file.size_bytes;
  const loc = trustLocation(file.storage_pool_id);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: c.paper }]}>
        <View style={[styles.header, { borderBottomColor: c.line }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: c.ink }]}>Prove it</Text>
            <Text style={[styles.subtitle, { color: c.ink3 }]} numberOfLines={1}>
              {fileName}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close" style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={c.ink2} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        >
          <Text style={[styles.lead, { color: c.ink2 }]}>
            First {PROOF_BYTES.toLocaleString()} bytes of {totalBytes.toLocaleString()}.
            Inspect with any hex editor to confirm what we store.
          </Text>

          {loading && (
            <View style={styles.loading}>
              <ActivityIndicator color={c.amber} />
              <Text style={[styles.loadingText, { color: c.ink3 }]}>Fetching bytes...</Text>
            </View>
          )}
          {error && !loading && (
            <Text style={[styles.error, { color: c.red }]}>{error}</Text>
          )}

          {bytes && !loading && (
            <>
              <View style={[styles.pane, { borderColor: c.line, backgroundColor: c.paper2 }]}>
                <View style={styles.paneHeader}>
                  <Ionicons name="eye-outline" size={14} color={c.ink2} />
                  <Text style={[styles.paneLabel, { color: c.ink2 }]}>What you see</Text>
                </View>
                <Text style={[styles.paneNote, { color: c.ink3 }]}>
                  The file's bytes interpreted as text. Readable structure is visible.
                </Text>
                <Text style={[styles.monoBlock, { color: c.ink, borderColor: c.line }]} selectable>
                  {readable}
                </Text>
              </View>

              <View style={styles.divider}>
                <View style={[styles.dividerLine, { backgroundColor: c.line }]} />
                <Text style={[styles.dividerText, { color: c.ink4 }]}>vs</Text>
                <View style={[styles.dividerLine, { backgroundColor: c.line }]} />
              </View>

              <View style={[styles.pane, { borderColor: c.amberDeep, backgroundColor: c.amberBg }]}>
                <View style={styles.paneHeader}>
                  <Ionicons name="server-outline" size={14} color={c.amberDeep} />
                  <Text style={[styles.paneLabel, { color: c.amberDeep }]}>What our server stores</Text>
                </View>
                <Text style={[styles.paneNote, { color: c.ink3 }]}>
                  Hex dump as it lives on disk in {loc.city}. Without your key, this is noise.
                </Text>
                <Text style={[styles.monoBlock, { color: c.ink, borderColor: c.amberDeep }]} selectable>
                  {hex}
                </Text>
              </View>

              <Text style={[styles.footnote, { color: c.ink3 }]}>
                These are the bytes on our servers. Without your key, this is noise.
                That's zero-knowledge encryption.
              </Text>
            </>
          )}
        </ScrollView>

        <View style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.line, paddingBottom: insets.bottom || spacing.md }]}>
          <Text style={[styles.urlLabel, { color: c.ink4 }]} numberOfLines={1}>
            {getDownloadUrl(file.id)}
          </Text>
          <TouchableOpacity
            style={[styles.downloadBtn, { backgroundColor: c.amber, opacity: downloading ? 0.6 : 1 }]}
            onPress={handleDownload}
            disabled={downloading}
            accessibilityRole="button"
            accessibilityLabel="Download raw ciphertext"
          >
            {downloading ? (
              <ActivityIndicator color={c.ink} size="small" />
            ) : (
              <Ionicons name="download-outline" size={16} color={c.ink} />
            )}
            <Text style={[styles.downloadBtnText, { color: c.ink }]}>
              {downloading ? 'Preparing...' : 'Download raw ciphertext'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg, gap: spacing.md },
  lead: { fontSize: 13, lineHeight: 19 },
  loading: { paddingVertical: spacing.xl, alignItems: 'center', gap: 8 },
  loadingText: { fontSize: 12 },
  error: { fontSize: 13, paddingVertical: spacing.md },
  pane: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 6,
  },
  paneHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  paneLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  paneNote: { fontSize: 11, lineHeight: 15 },
  monoBlock: {
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: 14,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    marginTop: 4,
  },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  footnote: { fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  urlLabel: { fontSize: 10, fontFamily: fonts.mono },
  downloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radii.md,
    gap: 8,
  },
  downloadBtnText: { fontSize: 14, fontWeight: '600' },
});
