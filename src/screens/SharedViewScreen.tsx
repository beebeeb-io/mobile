import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { getShareByToken, friendlyError } from '../lib/api';
import type { ShareInfo } from '../lib/api';
import { consumeShareKey } from '../lib/share-key-store';
import type { RootStackParamList } from '../App';

type SharedViewRoute = RouteProp<RootStackParamList, 'SharedView'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d < now) return 'Expired';
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return 'Expires today';
  if (diffDays === 1) return 'Expires tomorrow';
  return `Expires in ${diffDays} days`;
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function fileTypeIcon(mime?: string | null, isFolder?: boolean): IoniconName {
  if (isFolder) return 'folder';
  const m = mime ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'document-text';
  if (m.startsWith('audio/')) return 'musical-notes';
  if (m.startsWith('video/')) return 'videocam';
  if (m.startsWith('text/') || m.includes('document')) return 'document';
  return 'document-outline';
}

function fileTypeBg(mime?: string | null, isFolder?: boolean, colors?: { amberDeep: string; amber: string; red: string; green: string; ink2: string; ink3: string }): string {
  if (!colors) return '#8a867f';
  if (isFolder) return colors.amberDeep;
  const m = mime ?? '';
  if (m.startsWith('image/')) return colors.amber;
  if (m === 'application/pdf') return colors.red;
  if (m.startsWith('audio/')) return colors.green;
  if (m.startsWith('video/')) return colors.ink2;
  return colors.ink3;
}

function displayFileName(info: ShareInfo): string {
  const raw = info.file_name_encrypted;
  if (!raw) return info.is_folder ? 'Shared folder' : 'Shared file';
  if (raw.startsWith('{')) return info.is_folder ? 'Encrypted folder' : 'Encrypted file';
  if (raw.length > 48) return raw.slice(0, 40) + '...';
  return raw;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SharedViewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<SharedViewRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { token } = route.params;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  // Captured from the #key= URL fragment (stored before React Navigation
  // strips it). Available only when the user arrives via a deep link.
  const [shareKey] = useState<string | null>(() => consumeShareKey(token));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getShareByToken(token);
        if (!cancelled) setInfo(result);
      } catch (err) {
        if (!cancelled) setError(friendlyError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const handleClose = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Tabs');
  }, [navigation]);

  const handleOpenInBrowser = useCallback(() => {
    // Include the #key= fragment when available so double-encrypted shares
    // open correctly in Safari (the web app reads the key from the fragment).
    const base = `https://app.beebeeb.io/s/${token}`;
    const url = shareKey ? `${base}#key=${encodeURIComponent(shareKey)}` : base;
    Linking.openURL(url).catch(() => {});
  }, [token, shareKey]);

  const iconName = fileTypeIcon(info?.mime_type, info?.is_folder);
  const iconBg = fileTypeBg(info?.mime_type, info?.is_folder, c);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: c.paper2 }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: c.line }]}>
        <TouchableOpacity
          onPress={handleClose}
          style={[styles.closeBtn, { backgroundColor: c.paper, borderColor: c.line }]}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={18} color={c.ink2} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Shared file</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Body */}
      {loading ? (
        <View style={styles.centeredBody}>
          <ActivityIndicator color={c.amber} size="large" />
          <Text style={[styles.loadingText, { color: c.ink3 }]}>Loading share info...</Text>
        </View>
      ) : error ? (
        <View style={styles.centeredBody}>
          <Ionicons name="alert-circle-outline" size={48} color={c.red} style={{ opacity: 0.7 }} />
          <Text style={[styles.errorTitle, { color: c.ink }]}>Link unavailable</Text>
          <Text style={[styles.errorSub, { color: c.ink3 }]}>{error}</Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: c.amber }]}
            onPress={handleOpenInBrowser}
            activeOpacity={0.8}
          >
            <Ionicons name="open-outline" size={16} color={c.ink} />
            <Text style={[styles.primaryBtnText, { color: c.ink }]}>Try in browser</Text>
          </TouchableOpacity>
        </View>
      ) : info ? (
        <View style={styles.body}>
          {/* File icon */}
          <View style={[styles.fileIconBox, { backgroundColor: iconBg }]}>
            <Ionicons name={iconName} size={36} color="#FFFFFF" />
          </View>

          {/* File name */}
          <Text style={[styles.fileName, { color: c.ink }]} numberOfLines={3}>
            {displayFileName(info)}
          </Text>

          {/* Meta card */}
          <View style={[styles.metaCard, { backgroundColor: c.paper, borderColor: c.line }]}>
            {info.size_bytes != null && info.size_bytes > 0 && (
              <View style={styles.metaRow}>
                <Ionicons name="cube-outline" size={14} color={c.ink3} />
                <Text style={[styles.metaLabel, { color: c.ink3 }]}>Size</Text>
                <Text style={[styles.metaValue, { color: c.ink }]}>{formatSize(info.size_bytes)}</Text>
              </View>
            )}
            {info.mime_type && (
              <View style={styles.metaRow}>
                <Ionicons name="document-outline" size={14} color={c.ink3} />
                <Text style={[styles.metaLabel, { color: c.ink3 }]}>Type</Text>
                <Text style={[styles.metaValue, { color: c.ink }]} numberOfLines={1}>{info.mime_type}</Text>
              </View>
            )}
            {info.sender_email && (
              <View style={styles.metaRow}>
                <Ionicons name="person-outline" size={14} color={c.ink3} />
                <Text style={[styles.metaLabel, { color: c.ink3 }]}>Shared by</Text>
                <Text style={[styles.metaValue, { color: c.ink }]} numberOfLines={1}>{info.sender_email}</Text>
              </View>
            )}
            {info.expires_at && (
              <View style={styles.metaRow}>
                <Ionicons name="time-outline" size={14} color={c.ink3} />
                <Text style={[styles.metaLabel, { color: c.ink3 }]}>Expiry</Text>
                <Text style={[styles.metaValue, { color: c.ink }]}>{formatExpiry(info.expires_at)}</Text>
              </View>
            )}
            {info.passphrase_required && (
              <View style={styles.metaRow}>
                <Ionicons name="lock-closed-outline" size={14} color={c.amber} />
                <Text style={[styles.metaLabel, { color: c.ink3 }]}>Passphrase</Text>
                <Text style={[styles.metaValue, { color: c.amber }]}>Required</Text>
              </View>
            )}
            <View style={styles.metaRow}>
              <Ionicons name="key-outline" size={14} color={c.ink3} />
              <Text style={[styles.metaLabel, { color: c.ink3 }]}>Token</Text>
              <Text style={[styles.metaToken, { color: c.ink2 }]} numberOfLines={1}>{token}</Text>
            </View>
          </View>

          {/* Encryption badges */}
          <View style={{ gap: 6, alignItems: 'center' }}>
            <View style={[styles.encBadge, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
              <View style={[styles.encDot, { backgroundColor: c.amber }]} />
              <Text style={[styles.encText, { color: c.amberDeep }]}>End-to-end encrypted · AES-256-GCM</Text>
            </View>
            {info.double_encrypted && (
              <View style={[styles.encBadge, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
                <Ionicons name="shield-checkmark" size={12} color={c.amberDeep} />
                <Text style={[styles.encText, { color: c.amberDeep }]}>Double encrypted</Text>
              </View>
            )}
          </View>

          {/* CTA */}
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: c.ink }]}
            onPress={handleOpenInBrowser}
            activeOpacity={0.8}
          >
            <Ionicons name="download-outline" size={18} color={c.amber} />
            <Text style={[styles.primaryBtnText, { color: c.amber }]}>Download in browser</Text>
          </TouchableOpacity>

          <Text style={[styles.footnote, { color: c.ink4 }]}>
            {info.double_encrypted && !shareKey
              ? 'Double-encrypted share: use the original full link (with #key=…) to open in your browser.'
              : 'Native in-app decryption coming soon.'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },

  centeredBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  loadingText: { fontSize: 13 },
  errorTitle: { fontSize: 18, fontWeight: '700', marginTop: 4 },
  errorSub: { fontSize: 13, textAlign: 'center', lineHeight: 18 },

  body: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 32,
    gap: 16,
  },

  fileIconBox: {
    width: 80,
    height: 80,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  fileName: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.3,
  },

  metaCard: {
    width: '100%',
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  metaLabel: { fontSize: 12, width: 80 },
  metaValue: { fontSize: 13, fontWeight: '500', flex: 1 },
  metaToken: { fontSize: 11, fontFamily: 'Courier', flex: 1 },

  encBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.round,
    borderWidth: 1,
  },
  encDot: { width: 6, height: 6, borderRadius: 3 },
  encText: { fontSize: 11, fontWeight: '500' },

  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: radii.md,
    width: '100%',
    justifyContent: 'center',
  },
  primaryBtnText: { fontSize: 15, fontWeight: '700' },

  footnote: { fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
