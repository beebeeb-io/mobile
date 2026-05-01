import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { WebView } from 'react-native-webview';
import type { RootStackParamList } from '../App';
import { colors, radii, shadows } from '../theme';
import { useTheme } from '../lib/theme-context';
import { getToken, getDownloadUrl, friendlyError } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PreviewRoute = RouteProp<RootStackParamList, 'Preview'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString('en', { month: 'short' });
  const day = d.getDate();
  const year = d.getFullYear();
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${month} ${day}, ${year} at ${hours}:${mins}`;
}

function fileCategory(
  mimeType?: string,
): 'image' | 'pdf' | 'audio' | 'video' | 'doc' | 'file' {
  const mime = mimeType ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || mime.includes('document') || mime.includes('spreadsheet'))
    return 'doc';
  return 'file';
}

const CATEGORY_LABELS: Record<string, string> = {
  image: 'Image',
  pdf: 'PDF Document',
  audio: 'Audio',
  video: 'Video',
  doc: 'Document',
  file: 'File',
};

const CATEGORY_BADGE: Record<string, string> = {
  image: 'IMG',
  pdf: 'PDF',
  audio: 'AUD',
  video: 'VID',
  doc: 'DOC',
  file: 'FILE',
};

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PreviewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<PreviewRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { fileId, fileName, mimeType, sizeBytes, createdAt } = route.params;

  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Image inline preview state
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // PDF inline preview state
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const { isUnlocked, decryptChunk } = useCrypto();

  const category = fileCategory(mimeType);
  const isImage = category === 'image';
  const isPdf = category === 'pdf';

  // Theme-aware accent for non-image category badge
  const categoryAccent = (() => {
    switch (category) {
      case 'image': return c.amber;
      case 'pdf': return c.red;
      case 'audio': return c.green;
      case 'video':
      case 'doc': return c.ink2;
      default: return c.ink3;
    }
  })();

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  /**
   * Download the encrypted file to cache and decrypt it (when the vault is
   * unlocked). Returns a local URI suitable for an <Image> source or sharing.
   * Falls back to the encrypted URI if crypto is unavailable.
   */
  const fetchAndDecrypt = useCallback(async (): Promise<string> => {
    const token = await getToken();
    if (!token) throw new Error('Not signed in');

    const safeName = fileName.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const encryptedUri = `${FileSystem.cacheDirectory}enc_${safeName}`;

    const dl = FileSystem.createDownloadResumable(
      getDownloadUrl(fileId),
      encryptedUri,
      { headers: { Authorization: `Bearer ${token}` } },
      (p) => {
        if (p.totalBytesExpectedToWrite > 0) {
          setDownloadProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
        }
      },
    );

    const result = await dl.downloadAsync();
    if (!result) throw new Error('Download was interrupted.');

    if (isUnlocked) {
      try {
        const encBase64 = await FileSystem.readAsStringAsync(result.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const encBytes = base64ToUint8Array(encBase64);
        if (encBytes.length > 12) {
          const nonce = encBytes.slice(0, 12);
          const ciphertext = encBytes.slice(12);
          const decrypted = await decryptChunk(fileId, nonce, ciphertext);
          const decUri = `${FileSystem.cacheDirectory}${safeName}`;
          await FileSystem.writeAsStringAsync(decUri, uint8ArrayToBase64(decrypted), {
            encoding: FileSystem.EncodingType.Base64,
          });
          return decUri;
        }
      } catch {
        // Crypto unavailable (stubs not linked) or malformed data — fall through
      }
    }
    return result.uri;
  }, [fileId, fileName, isUnlocked, decryptChunk]);

  // Auto-load images inline on mount
  useEffect(() => {
    if (!isImage) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setImageLoading(true);
    setImageError(null);
    fetchAndDecrypt()
      .then((uri) => {
        if (!cancelled) setImageUri(uri);
      })
      .catch((err) => {
        if (!cancelled) setImageError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setImageLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isImage, fetchAndDecrypt]);

  // Auto-load PDFs inline on mount — WebView renders them natively on iOS
  useEffect(() => {
    if (!isPdf) return;
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);
    fetchAndDecrypt()
      .then((uri) => {
        if (!cancelled) setPdfUri(uri);
      })
      .catch((err) => {
        if (!cancelled) setPdfError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setPdfLoading(false);
          setDownloadProgress(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isPdf, fetchAndDecrypt]);

  const handleDownload = useCallback(async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Not available', 'File download is only available on iOS and Android.');
      return;
    }

    setDownloading(true);
    setDownloadProgress(0);

    try {
      const token = await getToken();
      if (!token) {
        Alert.alert('Not signed in', 'Please sign in to download files.');
        return;
      }

      const shareUri = await fetchAndDecrypt();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(shareUri, {
          mimeType: mimeType ?? 'application/octet-stream',
          dialogTitle: fileName,
        });
      } else {
        Alert.alert('Downloaded', `Saved to ${shareUri}`);
      }
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Download failed', friendlyError(err));
    } finally {
      setDownloading(false);
      setDownloadProgress(0);
    }
  }, [fileName, mimeType, fetchAndDecrypt]);

  const handleShare = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigation.navigate('ShareSheet', { fileId, fileName, mimeType, sizeBytes });
  }, [navigation, fileId, fileName, mimeType, sizeBytes]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ---- Header ---- */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={handleClose}
          style={styles.closeButton}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.closeIcon}>{'×'}</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {fileName}
          </Text>
          <Text style={styles.headerSub}>
            {CATEGORY_LABELS[category] ?? 'File'}
            {sizeBytes != null ? `  ·  ${formatSize(sizeBytes)}` : ''}
          </Text>
        </View>

        <TouchableOpacity
          onPress={handleShare}
          style={styles.headerAction}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.headerActionText}>Share</Text>
        </TouchableOpacity>
      </View>

      {/* ---- Preview area ---- */}
      <View style={styles.previewArea}>
        {isImage ? (
          imageUri ? (
            <Image
              source={{ uri: imageUri }}
              style={styles.image}
              resizeMode="contain"
              accessibilityLabel={fileName}
            />
          ) : imageError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load image
              </Text>
              <Text style={styles.imageStatusSub}>{imageError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {imageLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to view this image.'}
              </Text>
            </View>
          )
        ) : isPdf ? (
          pdfUri ? (
            <WebView
              source={{ uri: pdfUri }}
              style={[styles.pdfWebView, { backgroundColor: c.paper }]}
              originWhitelist={['*']}
            />
          ) : pdfError ? (
            <View style={styles.imageStatus}>
              <Text style={[styles.imageStatusTitle, { color: colors.white }]}>
                Couldn't load PDF
              </Text>
              <Text style={styles.imageStatusSub}>{pdfError}</Text>
            </View>
          ) : (
            <View style={styles.imageStatus}>
              <ActivityIndicator color={c.amber} size="large" />
              <Text style={styles.imageStatusSub}>
                {pdfLoading && downloadProgress > 0
                  ? `Decrypting · ${Math.round(downloadProgress * 100)}%`
                  : isUnlocked
                  ? 'Downloading and decrypting...'
                  : 'Unlock your vault to view this PDF.'}
              </Text>
            </View>
          )
        ) : (
          <View style={styles.genericPlaceholder}>
            <View style={[styles.genericIcon, { backgroundColor: categoryAccent }]}>
              <Text style={styles.genericIconText}>
                {CATEGORY_BADGE[category] ?? 'FILE'}
              </Text>
            </View>
            <Text style={styles.genericTitle}>{CATEGORY_LABELS[category] ?? 'File'}</Text>
            <Text style={styles.genericSub}>
              {isUnlocked
                ? 'Download to decrypt and open this file.'
                : 'Unlock your vault to decrypt this file.'}
            </Text>
          </View>
        )}
      </View>

      {/* ---- Metadata card ---- */}
      <View
        style={[
          styles.metaCard,
          { backgroundColor: c.paper, paddingBottom: Math.max(insets.bottom, 16) + 56 },
        ]}
      >
        <View style={styles.metaSection}>
          <Text style={[styles.metaSectionTitle, { color: c.ink3 }]}>Details</Text>

          <View style={styles.metaRow}>
            <Text style={[styles.metaLabel, { color: c.ink3 }]}>Name</Text>
            <Text style={[styles.metaValue, { color: c.ink }]} numberOfLines={1}>{fileName}</Text>
          </View>

          {mimeType ? (
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: c.ink3 }]}>Type</Text>
              <Text style={[styles.metaValue, { color: c.ink }]}>{mimeType}</Text>
            </View>
          ) : null}

          {sizeBytes != null ? (
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: c.ink3 }]}>Size</Text>
              <Text style={[styles.metaValue, { color: c.ink }]}>{formatSize(sizeBytes)}</Text>
            </View>
          ) : null}

          {createdAt ? (
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: c.ink3 }]}>Created</Text>
              <Text style={[styles.metaValue, { color: c.ink }]}>{formatDate(createdAt)}</Text>
            </View>
          ) : null}
        </View>

        <View style={[styles.encryptionBadge, { borderTopColor: c.line }]}>
          <View style={[styles.encryptionDot, { backgroundColor: c.amber }]} />
          <Text style={[styles.encryptionText, { color: c.ink3 }]}>
            End-to-end encrypted · AES-256-GCM
          </Text>
        </View>
      </View>

      {/* ---- Download bar ---- */}
      <View
        style={[
          styles.downloadBar,
          { backgroundColor: c.paper, paddingBottom: Math.max(insets.bottom, 16) },
        ]}
      >
        {downloading && downloadProgress > 0 && (
          <View style={[styles.progressTrack, { backgroundColor: c.line }]}>
            <View
              style={[
                styles.progressFill,
                { width: `${downloadProgress * 100}%`, backgroundColor: c.amber },
              ]}
            />
          </View>
        )}
        <TouchableOpacity
          style={[
            styles.downloadButton,
            { backgroundColor: c.amber },
            downloading && styles.downloadButtonDisabled,
          ]}
          activeOpacity={0.8}
          onPress={handleDownload}
          disabled={downloading}
        >
          {downloading ? (
            <View style={styles.downloadingRow}>
              <ActivityIndicator size="small" color={c.ink} />
              <Text style={[styles.downloadButtonText, { color: c.ink }]}>
                {downloadProgress > 0
                  ? `Downloading ${Math.round(downloadProgress * 100)}%`
                  : 'Downloading...'}
              </Text>
            </View>
          ) : (
            <Text style={[styles.downloadButtonText, { color: c.ink }]}>
              {isImage ? 'Save & Share' : 'Download & Open'}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.darkBg,
  },

  // ---- Header ----
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIcon: {
    fontSize: 18,
    fontWeight: '400',
    color: colors.white,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.white,
  },
  headerSub: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },
  headerAction: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.md,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  headerActionText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.white,
  },

  // ---- Preview area ----
  previewArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },

  image: { width: '100%', height: '100%' },
  pdfWebView: { width: '100%', height: '100%' },
  imageStatus: { alignItems: 'center', gap: 12 },
  imageStatusTitle: { fontSize: 16, fontWeight: '600' },
  imageStatusSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    lineHeight: 20,
  },

  genericPlaceholder: { alignItems: 'center', gap: 16 },
  genericIcon: {
    width: 72,
    height: 72,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  genericIconText: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.white,
    letterSpacing: 0.5,
  },
  genericTitle: { fontSize: 18, fontWeight: '600', color: colors.white },
  genericSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    lineHeight: 20,
  },

  // ---- Metadata card ----
  metaCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  metaSection: { gap: 10 },
  metaSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: { fontSize: 13 },
  metaValue: {
    fontSize: 13,
    fontWeight: '500',
    maxWidth: '60%',
    textAlign: 'right',
  },
  encryptionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    gap: 8,
  },
  encryptionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  encryptionText: { fontSize: 12, fontWeight: '500' },

  // ---- Download bar ----
  downloadBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 8,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  downloadButton: {
    borderRadius: radii.lg,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  downloadButtonDisabled: {
    opacity: 0.7,
  },
  downloadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  downloadButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
