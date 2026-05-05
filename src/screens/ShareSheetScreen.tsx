import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../App';
import { radii, spacing, shadows } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useToast } from '../lib/toast-context';
import { createShare, friendlyError } from '../lib/api';
import type { Share as ShareLink } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import {
  encryptChunk,
  decryptChunk,
} from '../../modules/beebeeb-crypto';

type ShareRoute = RouteProp<RootStackParamList, 'ShareSheet'>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function makeFileTypeBadge(mime: string | undefined, c: ReturnType<typeof useTheme>['colors']): { label: string; color: string } {
  const m = mime ?? '';
  if (m.startsWith('image/')) return { label: 'IMG', color: c.amber };
  if (m === 'application/pdf') return { label: 'PDF', color: c.red };
  if (m.startsWith('audio/')) return { label: 'AUD', color: c.green };
  if (m.startsWith('video/')) return { label: 'VID', color: c.ink2 };
  if (m.startsWith('text/') || m.includes('document')) return { label: 'DOC', color: c.ink2 };
  return { label: 'FILE', color: c.ink3 };
}

/** Base64-encode a Uint8Array. */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** URL-safe base64 (no +, /, or padding) — safe to embed in #key= fragment. */
function toBase64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Wrap a file key under a client-generated share key (AES-256-GCM via WASM).
 * Output format: nonce(12) || ciphertext(48) = 60 bytes.
 * Compatible with web's wrapKeyForShare() in src/lib/crypto.ts.
 */
async function wrapFileKeyForShare(clientKey: Uint8Array, fileKey: Uint8Array): Promise<Uint8Array> {
  const enc = await encryptChunk(clientKey, fileKey);
  const result = new Uint8Array(enc.nonce.length + enc.ciphertext.length);
  result.set(enc.nonce, 0);
  result.set(enc.ciphertext, enc.nonce.length);
  return result;
}

// ---------------------------------------------------------------------------
// Expiry / max-opens options
// ---------------------------------------------------------------------------

interface ExpiryOption {
  label: string;
  hours: number | null;
}

const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: 'Never', hours: null },
];

interface OpensOption {
  label: string;
  value: number | null;
}

const OPENS_OPTIONS: OpensOption[] = [
  { label: 'One-time', value: 1 },
  { label: '5 opens', value: 5 },
  { label: 'Unlimited', value: null },
];

// App URL for building share links locally (double-encrypted mode)
const APP_URL = 'https://app.beebeeb.io';

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ShareSheetScreen() {
  const navigation = useNavigation();
  const route = useRoute<ShareRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { fileId, fileName, mimeType, sizeBytes } = route.params;
  const { getFileKeyBytes, isUnlocked } = useCrypto();

  const [expiry, setExpiry] = useState<ExpiryOption>(EXPIRY_OPTIONS[1]);
  const [opens, setOpens] = useState<OpensOption>(OPENS_OPTIONS[0]);
  const [passphrase, setPassphrase] = useState('');
  const [doubleEncrypted, setDoubleEncrypted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [share, setShare] = useState<ShareLink | null>(null);
  // For double-encrypted shares, we build the URL locally and store it here.
  // For standard shares, we use share.url from the server.
  const [localShareUrl, setLocalShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  const badge = makeFileTypeBadge(mimeType, c);

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: 'transparent', justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: { backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: spacing.lg, paddingTop: 12, maxHeight: '90%', ...shadows.lg },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.line2, alignSelf: 'center', marginBottom: 14 },
    fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
    fileIcon: { width: 36, height: 36, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
    fileIconText: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
    fileInfo: { flex: 1, minWidth: 0 },
    fileName: { fontSize: 14, fontWeight: '600', color: c.ink },
    fileMeta: { fontSize: 11, color: c.ink3, marginTop: 2 },
    scroll: { maxHeight: 480 },
    scrollContent: { paddingBottom: 8 },
    sectionLabel: { fontSize: 11, fontWeight: '600', color: c.ink3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8, marginBottom: 8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
    chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radii.round, backgroundColor: c.paper2, borderWidth: 1, borderColor: c.line },
    chipActive: { backgroundColor: c.ink, borderColor: c.ink },
    chipText: { fontSize: 12, color: c.ink3 },
    chipTextActive: { color: c.paper, fontWeight: '600' },
    input: { height: 42, borderWidth: 1, borderColor: c.line, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 14, color: c.ink, backgroundColor: c.paper },
    hint: { fontSize: 11, color: c.ink3, marginTop: 6, lineHeight: 15 },
    // Double-encrypted toggle
    toggleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.line, marginTop: 8 },
    toggleInfo: { flex: 1 },
    toggleLabel: { fontSize: 14, fontWeight: '500', color: c.ink },
    toggleSub: { fontSize: 11, color: c.ink3, marginTop: 3, lineHeight: 16 },
    zkBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: c.amberBg, borderWidth: 1, borderColor: c.amber, borderRadius: radii.sm, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start', marginTop: 4 },
    zkBadgeText: { fontSize: 9, fontWeight: '700', color: c.amberDeep, letterSpacing: 0.5 },
    errorBanner: { backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2', borderWidth: 1, borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca', borderRadius: radii.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.lg },
    errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
    createButton: { height: 46, backgroundColor: c.amber, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl },
    buttonDisabled: { opacity: 0.6 },
    createButtonText: { fontSize: 14, fontWeight: '700', color: c.ink },
    fineprint: { fontSize: 11, color: c.ink4, textAlign: 'center', marginTop: 12, lineHeight: 16 },
    successCard: { paddingTop: 8 },
    successHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    successTitle: { fontSize: 11, fontWeight: '600', color: c.ink3, textTransform: 'uppercase', letterSpacing: 0.6, flex: 1 },
    urlBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.paper2, borderWidth: 1, borderColor: c.line, borderRadius: radii.md, paddingLeft: 12, paddingRight: 6, paddingVertical: 6, gap: 8 },
    urlText: { flex: 1, fontSize: 12, color: c.ink, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    copyButton: { paddingHorizontal: 12, paddingVertical: 7, backgroundColor: c.ink, borderRadius: radii.sm },
    copyButtonText: { fontSize: 12, fontWeight: '600', color: c.amber },
    successDetails: { marginTop: 10, gap: 4 },
    successHint: { fontSize: 12, color: c.ink3 },
    doneButton: { height: 44, backgroundColor: c.ink, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl },
    doneButtonText: { fontSize: 14, fontWeight: '600', color: c.paper },
  }), [c, resolved]);

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleCreate = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCreating(true);
    setError(null);

    try {
      let wrappedFileKey: string | undefined;
      let clientKeyUrl: string | undefined;

      if (doubleEncrypted) {
        if (!isUnlocked) {
          setError('Vault is locked. Unlock it to create a double-encrypted share.');
          return;
        }
        // 1. Get the raw file key bytes
        const fileKey = await getFileKeyBytes(fileId);

        // 2. Generate client key K_c (stays in device + URL fragment only)
        const clientKey = new Uint8Array(32);
        crypto.getRandomValues(clientKey);

        // 3. Wrap fileKey under K_c using AES-256-GCM (WASM encryptChunk)
        const wrapped = await wrapFileKeyForShare(clientKey, fileKey);

        // Zero the raw file key immediately after wrapping
        fileKey.fill(0);

        wrappedFileKey = toBase64(wrapped);
        clientKeyUrl = toBase64url(clientKey);

        // Zero client key — it's now in clientKeyUrl string (JS engine manages that)
        clientKey.fill(0);
      }

      const result = await createShare(fileId, {
        expires_in_hours: expiry.hours ?? undefined,
        max_opens: opens.value ?? undefined,
        passphrase: passphrase.trim() || undefined,
        ...(wrappedFileKey ? { wrapped_file_key: wrappedFileKey } : {}),
      });

      setShare(result);

      if (doubleEncrypted && clientKeyUrl) {
        // Build the share URL locally — fragment is never sent to server
        setLocalShareUrl(`${APP_URL}/s/${result.token}#key=${clientKeyUrl}`);
      } else {
        setLocalShareUrl(null);
      }

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(friendlyError(err));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreating(false);
    }
  }, [fileId, expiry, opens, passphrase, doubleEncrypted, isUnlocked, getFileKeyBytes]);

  // The URL shown and copied:
  // double-encrypted → localShareUrl (fragment = K_c, server never sees it)
  // standard         → share.url from server
  const displayUrl = localShareUrl ?? share?.url ?? '';

  const handleCopy = useCallback(async () => {
    if (!displayUrl) return;
    await Clipboard.setStringAsync(displayUrl);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    showToast({ type: 'success', message: 'Link copied to clipboard' });
    setTimeout(() => setCopied(false), 2000);
  }, [displayUrl, showToast]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={handleClose} />

      {/* Sheet */}
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
        <View style={styles.handle} />

        {/* File row */}
        <View style={styles.fileRow}>
          <View style={[styles.fileIcon, { backgroundColor: badge.color }]}>
            <Text style={styles.fileIconText}>{badge.label}</Text>
          </View>
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
            <Text style={styles.fileMeta}>
              {sizeBytes != null ? `${formatSize(sizeBytes)} · ` : ''}encrypted
            </Text>
          </View>
        </View>

        {share ? (
          /* ---- Share created — show URL + copy ---- */
          <View style={styles.successCard}>
            <View style={styles.successHeaderRow}>
              <Text style={styles.successTitle}>Encrypted link</Text>
              {(share.double_encrypted || localShareUrl) && (
                <View style={styles.zkBadge}>
                  <Text style={styles.zkBadgeText}>DOUBLE ENCRYPTED</Text>
                </View>
              )}
            </View>
            <View style={styles.urlBox}>
              <Text style={styles.urlText} numberOfLines={1} selectable>
                {displayUrl}
              </Text>
              <TouchableOpacity
                style={styles.copyButton}
                onPress={handleCopy}
                activeOpacity={0.8}
              >
                <Text style={styles.copyButtonText}>{copied ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.successDetails}>
              {share.expires_at && (
                <Text style={styles.successHint}>
                  Expires {new Date(share.expires_at).toLocaleString()}
                </Text>
              )}
              {share.max_opens != null && (
                <Text style={styles.successHint}>
                  {share.max_opens === 1 ? 'One-time' : `Up to ${share.max_opens} opens`}
                </Text>
              )}
              {(share.double_encrypted || localShareUrl) && (
                <Text style={styles.successHint}>
                  Only someone with the exact link can decrypt this file. Even Beebeeb cannot read it.
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={styles.doneButton}
              onPress={handleClose}
              activeOpacity={0.8}
            >
              <Text style={styles.doneButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* ---- Configure share settings ---- */
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Expiry */}
            <Text style={styles.sectionLabel}>Expires</Text>
            <View style={styles.chipRow}>
              {EXPIRY_OPTIONS.map((opt) => {
                const active = opt.hours === expiry.hours;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setExpiry(opt)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Max opens */}
            <Text style={styles.sectionLabel}>Max opens</Text>
            <View style={styles.chipRow}>
              {OPENS_OPTIONS.map((opt) => {
                const active = opt.value === opens.value;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setOpens(opt)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Passphrase */}
            <Text style={styles.sectionLabel}>Passphrase (optional)</Text>
            <TextInput
              style={styles.input}
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder="Leave empty to skip"
              placeholderTextColor={c.ink4}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!creating}
            />
            <Text style={styles.hint}>
              Recipients will be asked for this before opening the file.
            </Text>

            {/* Double-encrypted toggle */}
            <View style={styles.toggleRow}>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>Double encrypted</Text>
                <Text style={styles.toggleSub}>
                  {doubleEncrypted
                    ? 'Even Beebeeb cannot decrypt this link. Only someone with the exact URL can access the file.'
                    : 'Standard: Beebeeb holds a wrapped copy for revocation. Enable for full client-side control.'}
                </Text>
                {doubleEncrypted && (
                  <View style={styles.zkBadge}>
                    <Text style={styles.zkBadgeText}>ACTIVE</Text>
                  </View>
                )}
              </View>
              <Switch
                value={doubleEncrypted}
                onValueChange={(v) => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setDoubleEncrypted(v);
                }}
                trackColor={{ false: c.line, true: c.amber }}
                thumbColor={c.paper}
                ios_backgroundColor={c.line}
              />
            </View>

            {error && (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.createButton, creating && styles.buttonDisabled]}
              onPress={handleCreate}
              activeOpacity={0.8}
              disabled={creating}
            >
              {creating ? (
                <ActivityIndicator color={c.ink} size="small" />
              ) : (
                <Text style={styles.createButtonText}>Create encrypted link</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.fineprint}>
              {doubleEncrypted
                ? 'Key generated on your device — the server stores an opaque blob and cannot decrypt.'
                : 'The link gives access to a key wrapped for the recipient. We never see the file.'}
            </Text>
          </ScrollView>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
