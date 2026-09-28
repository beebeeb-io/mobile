/**
 * "Prove it" — the decrypted file next to the stored ciphertext, plus the
 * raw-ciphertext download.
 *
 * Left ("What you see"): the first 512 bytes of the file DECRYPTED on this
 * device, read as text. Right ("What our server stores"): the first 512
 * bytes of the ciphertext as the server holds it, as hex.
 *
 * Task 1591 (bug 2): this screen used to decrypt nothing — both panes showed
 * the ciphertext, so "What you see" was noise too. It also printed the API
 * download URL (a local dev address in a dev build) above the button; infrastructure
 * URLs are not shown to users. The pane logic lives in
 * src/lib/encryption-proof.ts.
 *
 * Task 1593: the data flow lives in src/lib/proof-session.ts — the plaintext
 * is the preview's cached copy (same cache key) or ONE decrypt that is deleted
 * after its 512-byte read, the ciphertext pane fetches only bytes 0..511, and
 * closing the sheet aborts both and clears the plaintext from state.
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
import * as FileSystem from 'expo-file-system/legacy';
import { gatedPlaintextWrite } from '../lib/plaintext-gate';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, onAmber, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useCrypto } from '../lib/crypto-context';
import { fetch as streamingFetch } from 'expo/fetch';
import { downloadFile, getDownloadUrl, getToken, type FileEntry } from '../lib/api';
import { decryptToTempFile, releasePreviewCopy } from '../lib/native-decrypt';
import { previewDecryptExtension } from '../lib/preview-cache-key';
import {
  CLOSED_CIPHER_STATE,
  CLOSED_PLAIN_STATE,
  fetchCiphertextPrefix,
  startProofSession,
  type CipherPrefixState,
} from '../lib/proof-session';
import { isRequestUpload } from '../lib/file-request-crypto';
import { guessMimeType } from '../lib/media';
import {
  PROOF_BYTES,
  bytesToHex,
  proofSeePane,
  type PlaintextPrefixState,
} from '../lib/encryption-proof';
import { useRegionCity } from '../lib/storage-region';
import { storageLocationLabel } from '../lib/preview-info';

interface Props {
  file: FileEntry;
  fileName: string;
  /** The preview's mime for this file (task 1593 — preview cache key parity). */
  mimeType?: string | null;
  visible: boolean;
  onClose: () => void;
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

export default function EncryptionProof({ file, fileName, mimeType, visible, onClose }: Props) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [cipher, setCipher] = useState<CipherPrefixState>(CLOSED_CIPHER_STATE);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [plain, setPlain] = useState<PlaintextPrefixState>(CLOSED_PLAIN_STATE);
  const { getFileKeyBytes, getMasterKeyHandleId, getRequestContentKey } = useCrypto();

  // Task 1593 — one session per open (src/lib/proof-session.ts): the
  // plaintext comes from the preview cache (same key as PreviewScreen) or ONE
  // decrypt, the ciphertext pane fetches only bytes 0..511, and closing the
  // sheet (visible=false, unmount, a different file) aborts both and clears
  // the 512 plaintext bytes from state.
  useEffect(() => {
    if (!visible) {
      setPlain(CLOSED_PLAIN_STATE);
      setCipher(CLOSED_CIPHER_STATE);
      return;
    }
    setDownloadError(null);
    const request = isRequestUpload(file);
    const cacheExt = previewDecryptExtension(mimeType ?? file.mime_type ?? guessMimeType(fileName), fileName);
    const session = startProofSession({
      sizeBytes: file.size_bytes,
      decrypt: (signal, onSource) =>
        decryptToTempFile(
          file.id,
          request ? () => getRequestContentKey(file) : () => getFileKeyBytes(file.id),
          cacheExt,
          file.size_bytes,
          file.chunk_count,
          request ? null : getMasterKeyHandleId(),
          { signal, onSource },
        ),
      readPrefix: async (path, length) =>
        base64ToBytes(
          await FileSystem.readAsStringAsync(path, {
            encoding: FileSystem.EncodingType.Base64,
            position: 0,
            length,
          }),
        ),
      releaseCopy: () => releasePreviewCopy(file.id, cacheExt),
      fetchCiphertextPrefix: async (length, signal) => {
        const token = await getToken();
        if (!token) throw new Error('Not signed in');
        return fetchCiphertextPrefix(getDownloadUrl(file.id), token, length, streamingFetch, signal);
      },
      onPlain: setPlain,
      onCipher: setCipher,
    });
    return () => session.close();
  }, [file, fileName, mimeType, visible, getFileKeyBytes, getMasterKeyHandleId, getRequestContentKey]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await downloadFile(file.id);
      const buf = await res.arrayBuffer();
      const all = new Uint8Array(buf);
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      // caches-registry: example=report.pdf.beebeeb.enc
      const target = `${FileSystem.cacheDirectory}${safeName}.beebeeb.enc`;
      // Task 1593 round 3 — plaintext writer, gated by the sign-out purge.
      await gatedPlaintextWrite('ciphertext export', target, FileSystem, () =>
        FileSystem.writeAsStringAsync(target, bytesToBase64(all), {
          encoding: FileSystem.EncodingType.Base64,
        }),
      );
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(target, {
          mimeType: 'application/octet-stream',
          dialogTitle: 'Raw ciphertext',
          UTI: 'public.data',
        });
      }
    } catch {
      setDownloadError('Download failed.');
    } finally {
      setDownloading(false);
    }
  };

  const bytes = cipher.status === 'ready' ? cipher.bytes : null;
  const loading = cipher.status === 'loading';
  const error = cipher.status === 'failed' ? 'Could not load proof bytes.' : downloadError;
  const hex = bytes ? bytesToHex(bytes) : '';
  const seePane = proofSeePane(plain);
  const totalBytes = file.size_bytes;
  // Task 1592 item 11 — "Stored in" from the one shared source
  // (GET /api/v1/region), so this pane names the same place as the Info and
  // Encryption details sheets; "Europe" while loading, unknown, or on a
  // failed fetch — never the "EU region" filler.
  const regionCity = useRegionCity(visible);
  const storedInCity = storageLocationLabel({ city: regionCity ?? null });

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
            {totalBytes > PROOF_BYTES
              ? `First ${PROOF_BYTES.toLocaleString()} bytes of ${totalBytes.toLocaleString()}.`
              : `All ${totalBytes.toLocaleString()} bytes.`}
            {' '}Inspect with any hex editor to confirm what we store.
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
                <Text style={[styles.paneNote, { color: c.ink3 }]} testID="proof-see-note">
                  {seePane.note}
                </Text>
                {plain.status === 'loading' && (
                  <ActivityIndicator color={c.ink3} style={styles.paneSpinner} />
                )}
                {seePane.body != null && (
                  <Text style={[styles.monoBlock, { color: c.ink, borderColor: c.line }]} selectable testID="proof-see-body">
                    {seePane.body}
                  </Text>
                )}
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
                  Hex dump as it lives on disk in {storedInCity}. Without your key, this is noise.
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
          <TouchableOpacity
            style={[styles.downloadBtn, { backgroundColor: c.amber, opacity: downloading ? 0.6 : 1 }]}
            onPress={handleDownload}
            disabled={downloading}
            accessibilityRole="button"
            accessibilityLabel="Download raw ciphertext"
          >
            {downloading ? (
              <ActivityIndicator color={onAmber} size="small" />
            ) : (
              <Ionicons name="download-outline" size={16} color={onAmber} />
            )}
            <Text style={[styles.downloadBtnText, { color: onAmber }]}>
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
  paneSpinner: { alignSelf: 'flex-start', marginTop: 4 },
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
