import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import type { RootStackParamList } from '../App';
import { colors, radii, spacing, shadows } from '../theme';
import { getToken, getDownloadUrl, friendlyError } from '../lib/api';

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

const CATEGORY_COLORS: Record<string, string> = {
  image: colors.amber,
  pdf: colors.red,
  audio: colors.green,
  video: colors.ink2,
  doc: colors.ink2,
  file: colors.ink3,
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PreviewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<PreviewRoute>();
  const insets = useSafeAreaInsets();
  const { fileId, fileName, mimeType, sizeBytes, createdAt } = route.params;

  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  const category = fileCategory(mimeType);
  const isImage = category === 'image';

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

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

      // Use a sanitized filename for the local cache path
      const safeName = fileName.replace(/[^a-zA-Z0-9._\-]/g, '_');
      const localUri = `${FileSystem.cacheDirectory}${safeName}`;

      const downloadResumable = FileSystem.createDownloadResumable(
        getDownloadUrl(fileId),
        localUri,
        { headers: { Authorization: `Bearer ${token}` } },
        (progress) => {
          if (progress.totalBytesExpectedToWrite > 0) {
            setDownloadProgress(
              progress.totalBytesWritten / progress.totalBytesExpectedToWrite,
            );
          }
        },
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) {
        throw new Error('Download was interrupted.');
      }

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(result.uri, {
          mimeType: mimeType ?? 'application/octet-stream',
          dialogTitle: fileName,
        });
      } else {
        Alert.alert('Downloaded', `Saved to ${result.uri}`);
      }
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Download failed', friendlyError(err));
    } finally {
      setDownloading(false);
      setDownloadProgress(0);
    }
  }, [fileId, fileName, mimeType]);

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
          <View style={styles.imagePlaceholder}>
            <View style={styles.imagePlaceholderIcon}>
              <Text style={styles.imagePlaceholderIconText}>IMG</Text>
            </View>
            <Text style={styles.imagePlaceholderTitle}>Encrypted image</Text>
            <Text style={styles.imagePlaceholderSub}>
              Preview requires native crypto bindings.{'\n'}
              UniFFI integration is in progress.
            </Text>
          </View>
        ) : (
          <View style={styles.genericPlaceholder}>
            <View
              style={[
                styles.genericIcon,
                { backgroundColor: CATEGORY_COLORS[category] ?? colors.ink3 },
              ]}
            >
              <Text style={styles.genericIconText}>
                {CATEGORY_BADGE[category] ?? 'FILE'}
              </Text>
            </View>
            <Text style={styles.genericTitle}>{CATEGORY_LABELS[category] ?? 'File'}</Text>
            <Text style={styles.genericSub}>
              Preview not available.{'\n'}
              Decryption requires native crypto bindings.
            </Text>
          </View>
        )}
      </View>

      {/* ---- Metadata card ---- */}
      <View style={[styles.metaCard, { paddingBottom: Math.max(insets.bottom, 16) + 56 }]}>
        <View style={styles.metaSection}>
          <Text style={styles.metaSectionTitle}>Details</Text>

          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Name</Text>
            <Text style={styles.metaValue} numberOfLines={1}>{fileName}</Text>
          </View>

          {mimeType ? (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Type</Text>
              <Text style={styles.metaValue}>{mimeType}</Text>
            </View>
          ) : null}

          {sizeBytes != null ? (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Size</Text>
              <Text style={styles.metaValue}>{formatSize(sizeBytes)}</Text>
            </View>
          ) : null}

          {createdAt ? (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Created</Text>
              <Text style={styles.metaValue}>{formatDate(createdAt)}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.encryptionBadge}>
          <View style={styles.encryptionDot} />
          <Text style={styles.encryptionText}>
            End-to-end encrypted · AES-256-GCM
          </Text>
        </View>
      </View>

      {/* ---- Download bar ---- */}
      <View
        style={[
          styles.downloadBar,
          { paddingBottom: Math.max(insets.bottom, 16) },
        ]}
      >
        {downloading && downloadProgress > 0 && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${downloadProgress * 100}%` }]} />
          </View>
        )}
        <TouchableOpacity
          style={[styles.downloadButton, downloading && styles.downloadButtonDisabled]}
          activeOpacity={0.8}
          onPress={handleDownload}
          disabled={downloading}
        >
          {downloading ? (
            <View style={styles.downloadingRow}>
              <ActivityIndicator size="small" color={colors.ink} />
              <Text style={styles.downloadButtonText}>
                {downloadProgress > 0
                  ? `Downloading ${Math.round(downloadProgress * 100)}%`
                  : 'Downloading...'}
              </Text>
            </View>
          ) : (
            <Text style={styles.downloadButtonText}>Download &amp; Open</Text>
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

  imagePlaceholder: { alignItems: 'center', gap: 16 },
  imagePlaceholderIcon: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: colors.amber,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.9,
  },
  imagePlaceholderIconText: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: 0.5,
  },
  imagePlaceholderTitle: { fontSize: 18, fontWeight: '600', color: colors.white },
  imagePlaceholderSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
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
    backgroundColor: colors.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  metaSection: { gap: 10 },
  metaSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: { fontSize: 13, color: colors.ink3 },
  metaValue: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.ink,
    maxWidth: '60%',
    textAlign: 'right',
  },
  encryptionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    gap: 8,
  },
  encryptionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.amber,
  },
  encryptionText: { fontSize: 12, color: colors.ink3, fontWeight: '500' },

  // ---- Download bar ----
  downloadBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: colors.paper,
    gap: 8,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.line,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.amber,
    borderRadius: 2,
  },
  downloadButton: {
    backgroundColor: colors.amber,
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
    color: colors.ink,
  },
});
