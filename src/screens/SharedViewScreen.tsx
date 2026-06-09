import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { downloadSharedFileBlob, getShareByToken, friendlyError } from '../lib/api';
import type { ShareInfo } from '../lib/api';
import { consumeShareKey, consumeShareKeyAsync } from '../lib/share-key-store';
import {
  decryptEncryptedBytes,
  inferChunkCountFromEncryptedSize,
} from '../lib/encrypted-download';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
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

/**
 * Decode a key from the URL #key= fragment. The web client emits base64url
 * (URL-safe, unpadded) for double-encrypted shares but standard base64 for
 * legacy links — accept both by normalizing to base64.
 */
function fragmentKeyToBytes(key: string): Uint8Array {
  let normalized = key.replace(/-/g, '+').replace(/_/g, '/');
  // Re-add padding if it was stripped (base64url convention).
  const pad = normalized.length % 4;
  if (pad === 2) normalized += '==';
  else if (pad === 3) normalized += '=';
  return base64ToUint8Array(normalized);
}

function splitShareTokenParam(rawToken: string): { token: string; shareKey: string | null } {
  const hashIndex = rawToken.indexOf('#');
  if (hashIndex < 0) {
    return { token: rawToken, shareKey: null };
  }

  const token = rawToken.slice(0, hashIndex);
  const hash = rawToken.slice(hashIndex + 1);
  const key = new URLSearchParams(hash).get('key');
  return { token, shareKey: key ? decodeURIComponent(key) : null };
}

/** Sanitise the saved file's basename so it survives the fs cache path. */
function safeBasename(name: string | undefined, fallback: string): string {
  const raw = (name ?? fallback).trim();
  const cleaned = raw.replace(/[^\w.\-]+/g, '_');
  if (cleaned.length === 0) return fallback;
  if (cleaned.length > 64) return cleaned.slice(0, 64);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SharedViewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<SharedViewRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const rawToken = route.params.token;
  const { token, shareKey: routeShareKey } = useMemo(
    () => splitShareTokenParam(rawToken),
    [rawToken],
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  // Captured from the #key= URL fragment (stored before React Navigation
  // strips it). Available only when the user arrives via a deep link.
  // Sync fast-path hits the in-memory queue; the effect below covers the
  // cold-start race where the fragment was persisted by a prior process but
  // not yet hydrated into memory (task 0710).
  const [shareKey, setShareKey] = useState<string | null>(() => routeShareKey ?? consumeShareKey(token));

  useEffect(() => {
    if (shareKey) return;
    let cancelled = false;
    void consumeShareKeyAsync(token).then((key) => {
      if (!cancelled && key) setShareKey(key);
    });
    return () => {
      cancelled = true;
    };
    // Run once per token; shareKey is intentionally excluded so a resolved key
    // doesn't re-trigger the async consume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Decryption state — driven by the "Decrypt & save" button.
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decryptedUri, setDecryptedUri] = useState<string | null>(null);

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

  /**
   * Download the encrypted blob, derive the file key (unwrapping K_c → file
   * key for double-encrypted shares), decrypt the chunks natively, write the
   * plaintext to the cache directory, then hand it to the system share sheet
   * so the user can save it locally or pass it to another app.
   */
  const handleDecrypt = useCallback(async (): Promise<void> => {
    if (!info) return;
    if (!shareKey) {
      setDecryptError('Share key missing from link.');
      return;
    }
    if (!BeebeebCrypto.isNativeAvailable) {
      setDecryptError('Decryption requires a dev client build with native crypto.');
      return;
    }

    setDecrypting(true);
    setDecryptError(null);

    try {
      const { encryptedBytes, chunkCount, chunkSize, originalSize } =
        await downloadSharedFileBlob(token);

      // 1. Resolve the per-file AES-256-GCM key.
      let fileKey: Uint8Array;
      const kcBytes = fragmentKeyToBytes(shareKey);

      if (info.double_encrypted) {
        if (!info.wrapped_file_key) {
          throw new Error('Double-encrypted share is missing its wrapped key.');
        }
        // wrapped_file_key = base64( nonce(12) || ciphertext(file_key + GCM tag) )
        const wrapped = base64ToUint8Array(info.wrapped_file_key);
        if (wrapped.length < 13) {
          throw new Error('Wrapped key blob is too small to decrypt.');
        }
        const nonce = wrapped.slice(0, 12);
        const ciphertext = wrapped.slice(12);
        fileKey = await BeebeebCrypto.decryptChunk(kcBytes, nonce, ciphertext);
      } else {
        // Standard share: the URL fragment IS the file key.
        fileKey = kcBytes;
      }

      // 2. Resolve canonical chunk metadata. Prefer authoritative server
      // headers, fall back to the share-info `chunk_count`, then to byte-math
      // inference (same precedence the PreviewScreen uses for owned files).
      const effectiveOriginalSize =
        originalSize ?? info.size_bytes ?? encryptedBytes.length - 28;
      if (effectiveOriginalSize <= 0) {
        throw new Error('Could not determine plaintext size for decryption.');
      }

      const inferred = inferChunkCountFromEncryptedSize(
        encryptedBytes.length,
        effectiveOriginalSize,
      );
      const effectiveChunkCount =
        chunkCount ?? info.chunk_count ?? inferred ?? 1;
      const effectiveChunkSize =
        chunkSize && chunkSize > 0 ? chunkSize : undefined;

      // 3. Decrypt natively — runs through the JSI bridge to the AES-GCM
      // implementation in beebeeb-core.
      const decrypted = await decryptEncryptedBytes(
        fileKey,
        encryptedBytes,
        effectiveChunkCount,
        effectiveOriginalSize,
        effectiveChunkSize,
      );

      // 4. Persist plaintext to the cache directory so the system share sheet
      // can hand it off to other apps (Files / Photos / Mail).
      const baseName = safeBasename(info.file_name_encrypted, `shared_${token}`);
      const decUri = `${FileSystem.cacheDirectory}shared_${token}_${baseName}`;
      try {
        await FileSystem.deleteAsync(decUri, { idempotent: true });
      } catch {
        // Best-effort — continue regardless.
      }
      await FileSystem.writeAsStringAsync(decUri, uint8ArrayToBase64(decrypted), {
        encoding: FileSystem.EncodingType.Base64,
      });
      setDecryptedUri(decUri);

      // 5. Try the share sheet immediately so the user can save / open it.
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(decUri, {
          mimeType: info.mime_type ?? 'application/octet-stream',
          dialogTitle: baseName,
        });
      }
    } catch (e) {
      setDecryptError(e instanceof Error ? e.message : 'Decryption failed.');
    } finally {
      setDecrypting(false);
    }
  }, [info, shareKey, token]);

  /** Re-open the share sheet for an already-decrypted file. */
  const handleOpenDecrypted = useCallback(async (): Promise<void> => {
    if (!decryptedUri) return;
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(decryptedUri, {
          mimeType: info?.mime_type ?? 'application/octet-stream',
          dialogTitle: info?.file_name_encrypted,
        });
      }
    } catch {
      // Share sheet dismissal is not an error worth surfacing.
    }
  }, [decryptedUri, info]);

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

          {/* CTA — primary action depends on whether we can decrypt natively */}
          {!info.is_folder && shareKey ? (
            decryptedUri ? (
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: c.ink }]}
                onPress={handleOpenDecrypted}
                activeOpacity={0.8}
              >
                <Ionicons name="checkmark-circle" size={18} color={c.amber} />
                <Text style={[styles.primaryBtnText, { color: c.amber }]}>
                  Share or save
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[
                  styles.primaryBtn,
                  {
                    backgroundColor: decrypting ? c.line2 : c.ink,
                    opacity: decrypting ? 0.6 : 1,
                  },
                ]}
                onPress={handleDecrypt}
                disabled={decrypting}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={decrypting ? 'hourglass-outline' : 'key-outline'}
                  size={18}
                  color={c.amber}
                />
                <Text style={[styles.primaryBtnText, { color: c.amber }]}>
                  {decrypting ? 'Decrypting...' : 'Decrypt & save'}
                </Text>
              </TouchableOpacity>
            )
          ) : null}

          {/* Secondary: open in browser. Always available as a fallback. */}
          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: c.line, backgroundColor: c.paper }]}
            onPress={handleOpenInBrowser}
            activeOpacity={0.8}
          >
            <Ionicons name="open-outline" size={16} color={c.ink2} />
            <Text style={[styles.secondaryBtnText, { color: c.ink2 }]}>
              Open in browser
            </Text>
          </TouchableOpacity>

          {decryptError ? (
            <Text style={[styles.footnote, { color: c.red }]}>{decryptError}</Text>
          ) : info.is_folder ? (
            <Text style={[styles.footnote, { color: c.ink4 }]}>
              Folder shares open in your browser.
            </Text>
          ) : !shareKey ? (
            <Text style={[styles.footnote, { color: c.ink4 }]}>
              Open the original full link (with #key=…) to decrypt this share on
              this device.
            </Text>
          ) : decryptedUri ? (
            <Text style={[styles.footnote, { color: c.ink4 }]}>
              Decrypted on-device. The plaintext never reached our servers.
            </Text>
          ) : null}
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

  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 11,
    borderRadius: radii.md,
    borderWidth: 1,
    width: '100%',
    justifyContent: 'center',
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '600' },

  footnote: { fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
