import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
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
import { useKeyboardLayoutAnimation } from '../lib/useKeyboardLayoutAnimation';
import { ApiError, approveInvite, createInvite, createShare, friendlyError, resolveSharingContact } from '../lib/api';
import type { Share as ShareLink } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import { formatBytes as formatSize } from '../lib/format';
import {
  deriveShareKey,
  encryptChunk,
  generateRandomBytes,
  wrapForOwnerWithHandle,
  x25519SharedSecret,
} from '../../modules/beebeeb-crypto';

type ShareRoute = RouteProp<RootStackParamList, 'ShareSheet'>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


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

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe base64 (no +, /, or padding) — safe to embed in #key= fragment. */
function toBase64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
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

/**
 * Wrap `bytes` under the OWNER's master key (0709 A+) and return the on-wire
 * base64 blob `nonce(12) || AES-256-GCM-ciphertext`. The master key never
 * crosses to JS — it's used inside native via the opaque handle. Same layout as
 * web's `wrapKeyForShare(masterKey, …)`, so the blob round-trips across clients.
 */
async function ownerWrapToBase64(handleId: number, bytes: Uint8Array): Promise<string> {
  const { wrapped, nonce } = await wrapForOwnerWithHandle(handleId, bytes);
  const blob = new Uint8Array(nonce.length + wrapped.length);
  blob.set(nonce, 0);
  blob.set(wrapped, nonce.length);
  return toBase64(blob);
}

async function encryptFileKeyForRecipient(
  derivePrivateKey: () => Promise<Uint8Array>,
  recipientPublicKey: Uint8Array,
  fileId: string,
  fileKey: Uint8Array,
): Promise<Uint8Array> {
  let privateKey: Uint8Array | null = null;
  let sharedSecret: Uint8Array | null = null;
  let shareKey: Uint8Array | null = null;
  try {
    privateKey = await derivePrivateKey();
    sharedSecret = await x25519SharedSecret(privateKey, recipientPublicKey);
    shareKey = await deriveShareKey(sharedSecret, asciiBytes(fileId));
    const enc = await encryptChunk(shareKey, fileKey);
    const result = new Uint8Array(enc.nonce.length + enc.ciphertext.length);
    result.set(enc.nonce, 0);
    result.set(enc.ciphertext, enc.nonce.length);
    return result;
  } finally {
    privateKey?.fill(0);
    sharedSecret?.fill(0);
    shareKey?.fill(0);
  }
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
  const { getFileKeyBytes, deriveX25519PrivateFromHandle, getMasterKeyHandleId, isUnlocked } = useCrypto();
  useKeyboardLayoutAnimation();

  const [expiry, setExpiry] = useState<ExpiryOption>(EXPIRY_OPTIONS[1]);
  const [opens, setOpens] = useState<OpensOption>(OPENS_OPTIONS[0]);
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<'link' | 'person'>('link');
  const [recipient, setRecipient] = useState('');
  const [inviteSentTo, setInviteSentTo] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [share, setShare] = useState<ShareLink | null>(null);
  // For double-encrypted shares, we build the URL locally and store it here.
  // For standard shares, we use share.url from the server.
  const [localShareUrl, setLocalShareUrl] = useState<string | null>(null);
  // The URL without the #key= fragment, and the raw key — shown side-by-side
  // so the recipient gets two distinct things to send through separate
  // channels (maximum security).
  const [shareUrlBase, setShareUrlBase] = useState<string | null>(null);
  const [shareKey, setShareKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<'full' | 'link' | 'key' | null>(null);
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
    modeRow: { flexDirection: 'row', backgroundColor: c.paper2, borderRadius: radii.md, padding: 3, marginBottom: 12 },
    modeButton: { flex: 1, height: 36, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
    modeButtonActive: { backgroundColor: c.paper, borderWidth: 1, borderColor: c.line },
    modeText: { fontSize: 13, fontWeight: '600', color: c.ink3 },
    modeTextActive: { color: c.ink },
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
    fieldLabel: { fontSize: 11, fontWeight: '600', color: c.ink2, marginBottom: 6, marginTop: 10 },
    keyLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, marginTop: 10 },
    keyBadge: { backgroundColor: c.amberBg, borderWidth: 1, borderColor: c.amber, borderRadius: radii.sm, paddingHorizontal: 6, paddingVertical: 2 },
    keyBadgeText: { fontSize: 9, fontWeight: '700', color: c.amberDeep, letterSpacing: 0.5 },
    keyBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.amberBg, borderWidth: 1, borderColor: c.amber, borderRadius: radii.md, paddingLeft: 12, paddingRight: 6, paddingVertical: 6, gap: 8 },
    keyText: { flex: 1, fontSize: 12, color: c.amberDeep, fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    copyButton: { paddingHorizontal: 12, paddingVertical: 7, backgroundColor: c.ink, borderRadius: radii.sm },
    copyButtonText: { fontSize: 12, fontWeight: '600', color: c.amber },
    successDetails: { marginTop: 10, gap: 4 },
    successHint: { fontSize: 12, color: c.ink3 },
    successHintEm: { fontWeight: '700', color: c.ink },
    buttonRow: { flexDirection: 'row', gap: 10, marginTop: spacing.xl },
    shareButton: { flex: 1, height: 44, backgroundColor: c.amber, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
    shareButtonText: { fontSize: 14, fontWeight: '700', color: c.ink },
    doneButton: { flex: 1, height: 44, backgroundColor: 'transparent', borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.line },
    doneButtonText: { fontSize: 14, fontWeight: '600', color: c.ink3 },
  }), [c, resolved]);

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleCreate = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCreating(true);
    setError(null);
    setInviteSentTo(null);

    try {
      if (!isUnlocked) {
        setError('Vault is locked. Unlock it to create a share.');
        return;
      }

      let wrappedFileKey: string | undefined;
      let keyForUrl: string;
      // 0805: owner-recoverable wrap of K_c (double-encrypted public links only).
      let ownerWrappedKey: string | undefined;

      const fileKey = await getFileKeyBytes(fileId);

      // All new shares are double-encrypted: the server requires `wrapped_file_key`
      // and rejects plain shares (shares.rs — "new shares must be double-encrypted").
      // Generate a client key K_c (stays on-device + in the URL fragment only),
      // wrap the file key under K_c, and wrap K_c under the OWNER's master key so
      // the owner can re-copy a working link later (Shared → By me). Beebeeb never
      // sees K_c, so it cannot decrypt the share.
      const clientKey = await generateRandomBytes(32);

      // Wrap fileKey under K_c using AES-256-GCM (WASM encryptChunk)
      const wrapped = await wrapFileKeyForShare(clientKey, fileKey);

      // Zero the raw file key immediately after wrapping
      fileKey.fill(0);

      wrappedFileKey = toBase64(wrapped);
      keyForUrl = toBase64url(clientKey);

      // 0805: wrap K_c under the OWNER's master key. The server stores it opaque
      // and never unwraps it; the master key stays inside native (task 0556).
      ownerWrappedKey = await ownerWrapToBase64(getMasterKeyHandleId(), clientKey);

      // Zero client key — it's now in keyForUrl string (JS engine manages that)
      clientKey.fill(0);

      // A1 client-supplied token (double-encrypted public links only): mint a
      // fresh raw token and wrap it for owner re-copy. token + owner_wrapped_key
      // + owner_wrapped_token are sent ALL-OR-NOTHING — matches web's flow and
      // the server's typed validator. Standard shares fall back to a
      // server-generated token (no owner-recovery — honest, unchanged).
      const mintTokenFields = async (): Promise<{ token: string; owner_wrapped_token: string } | undefined> => {
        if (!ownerWrappedKey) return undefined;
        // URL-safe-no-pad base64 of 20 random bytes (27 chars), like web.
        const token = toBase64url(await generateRandomBytes(20));
        const owner_wrapped_token = await ownerWrapToBase64(getMasterKeyHandleId(), asciiBytes(token));
        return { token, owner_wrapped_token };
      };
      let tokenFields = await mintTokenFields();
      const buildOpts = () => ({
        expires_in_hours: expiry.hours ?? undefined,
        max_opens: opens.value ?? undefined,
        passphrase: passphrase.trim() || undefined,
        ...(wrappedFileKey ? { wrapped_file_key: wrappedFileKey } : {}),
        ...(ownerWrappedKey && tokenFields
          ? {
              token: tokenFields.token,
              owner_wrapped_key: ownerWrappedKey,
              owner_wrapped_token: tokenFields.owner_wrapped_token,
            }
          : {}),
      });

      let result: ShareLink;
      try {
        result = await createShare(fileId, buildOpts());
      } catch (e) {
        // 409 = client-token collision (≈ never at 20 random bytes) → re-mint once.
        if (e instanceof ApiError && e.status === 409 && tokenFields) {
          tokenFields = await mintTokenFields();
          result = await createShare(fileId, buildOpts());
        } else {
          throw e;
        }
      }

      setShare(result);

      // Build the share URL locally so the fragment is always the client-side
      // decryption material. result.token echoes our client-supplied token (or
      // the server-generated one for standard shares).
      const shareBase = `${APP_URL}/s/${result.token}`;
      setLocalShareUrl(`${shareBase}#key=${encodeURIComponent(keyForUrl)}`);
      setShareUrlBase(shareBase);
      setShareKey(keyForUrl);

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(friendlyError(err));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreating(false);
    }
  }, [fileId, expiry, opens, passphrase, isUnlocked, getFileKeyBytes, getMasterKeyHandleId]);

  const handleCreateInvite = useCallback(async () => {
    const raw = recipient.trim();
    if (!raw) {
      setError('Enter an email address.');
      return;
    }

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCreating(true);
    setError(null);
    setInviteSentTo(null);

    try {
      let recipientEmail = raw.toLowerCase();
      let label = recipientEmail;

      if (!isEmail(raw)) {
        const contact = await resolveSharingContact(raw);
        if (!contact) {
          setError('Use an email address to invite someone new.');
          return;
        }
        recipientEmail = contact.email.toLowerCase();
        label = contact.username ? `@${contact.username} · ${contact.email}` : contact.email;
      }

      const result = await createInvite(fileId, recipientEmail);
      if (result.recipient_public_key && result.status === 'claimed') {
        const fileKey = await getFileKeyBytes(fileId);
        try {
          const wrappedFileKey = await encryptFileKeyForRecipient(
            deriveX25519PrivateFromHandle,
            fromBase64(result.recipient_public_key),
            fileId,
            fileKey,
          );
          await approveInvite(result.invite_id, toBase64(wrappedFileKey));
          wrappedFileKey.fill(0);
        } finally {
          fileKey.fill(0);
        }
      }
      setInviteSentTo(label);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(friendlyError(err));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreating(false);
    }
  }, [fileId, recipient, getFileKeyBytes, deriveX25519PrivateFromHandle]);

  // The URL shown and copied is built locally so the fragment always contains
  // client-held decryption material: file key for standard, K_c for double.
  const displayUrl = localShareUrl ?? share?.url ?? '';

  const handleCopy = useCallback(
    async (text: string, target: 'full' | 'link' | 'key', toastLabel: string) => {
      if (!text) return;
      await Clipboard.setStringAsync(text);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCopied(target);
      showToast({ type: 'success', message: `${toastLabel} copied to clipboard` });
      setTimeout(() => setCopied(null), 2000);
      // Auto-clear clipboard after 60s for sensitive payloads (full link
      // contains #key=, key is the raw decryption key). The bare URL is not
      // sensitive on its own.
      if (target === 'full' || target === 'key') {
        setTimeout(() => {
          Clipboard.setStringAsync('').catch(() => {});
        }, 60_000);
      }
    },
    [showToast],
  );

  const handleShare = useCallback(async () => {
    if (!displayUrl) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await Share.share({ url: displayUrl, message: displayUrl });
    } catch {
      // User cancelled or share failed — no action needed
    }
  }, [displayUrl]);

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
          /* ---- Share created — show URL + key as two distinct items ---- */
          <View style={styles.successCard}>
            <View style={styles.successHeaderRow}>
              <Text style={styles.successTitle}>End-to-end encrypted share</Text>
              {share.double_encrypted && (
                <View style={styles.zkBadge}>
                  <Text style={styles.zkBadgeText}>DOUBLE ENCRYPTED</Text>
                </View>
              )}
            </View>

            {/* Step 1 — the link (safe to send through most channels) */}
            <Text style={styles.fieldLabel}>Share link</Text>
            <View style={styles.urlBox}>
              <Text style={styles.urlText} numberOfLines={1} selectable>
                {shareUrlBase ?? displayUrl}
              </Text>
              <TouchableOpacity
                style={styles.copyButton}
                onPress={() => handleCopy(shareUrlBase ?? displayUrl, 'link', 'Link')}
                activeOpacity={0.8}
              >
                <Text style={styles.copyButtonText}>{copied === 'link' ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
            </View>

            {/* Step 2 — the decryption key (must travel via a different channel) */}
            {shareKey && (
              <>
                <View style={styles.keyLabelRow}>
                  <Text style={styles.fieldLabel}>Decryption key</Text>
                  <View style={styles.keyBadge}>
                    <Text style={styles.keyBadgeText}>SEND SEPARATELY</Text>
                  </View>
                </View>
                <View style={styles.keyBox}>
                  <Text style={styles.keyText} numberOfLines={1} selectable>
                    {shareKey}
                  </Text>
                  <TouchableOpacity
                    style={styles.copyButton}
                    onPress={() => handleCopy(shareKey, 'key', 'Key')}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.copyButtonText}>{copied === 'key' ? 'Copied' : 'Copy'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            <View style={styles.successDetails}>
              <Text style={styles.successHint}>
                End-to-end encrypted — Beebeeb cannot decrypt this share. Send the link and the key through separate channels for maximum security.
              </Text>
              <Text style={styles.successHint}>
                The recipient needs <Text style={styles.successHintEm}>both</Text> the link and the key to open the file.
              </Text>
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
            </View>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={styles.shareButton}
                onPress={handleShare}
                activeOpacity={0.8}
              >
                <Text style={styles.shareButtonText}>Share full link</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.doneButton}
                onPress={handleClose}
                activeOpacity={0.8}
              >
                <Text style={styles.doneButtonText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : inviteSentTo ? (
          <View style={styles.successCard}>
            <View style={styles.successHeaderRow}>
              <Text style={styles.successTitle}>Invite sent</Text>
            </View>
            <View style={styles.successDetails}>
              <Text style={styles.successHint}>
                {inviteSentTo} can accept this share from their Beebeeb account.
              </Text>
            </View>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={styles.doneButton}
                onPress={handleClose}
                activeOpacity={0.8}
              >
                <Text style={styles.doneButtonText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          /* ---- Configure share settings ---- */
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.modeRow} accessibilityRole="tablist">
              <TouchableOpacity
                style={[styles.modeButton, mode === 'link' && styles.modeButtonActive]}
                onPress={() => {
                  setMode('link');
                  setError(null);
                }}
                activeOpacity={0.8}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === 'link' }}
              >
                <Text style={[styles.modeText, mode === 'link' && styles.modeTextActive]}>
                  Link
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeButton, mode === 'person' && styles.modeButtonActive]}
                onPress={() => {
                  setMode('person');
                  setError(null);
                }}
                activeOpacity={0.8}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === 'person' }}
              >
                <Text style={[styles.modeText, mode === 'person' && styles.modeTextActive]}>
                  Person
                </Text>
              </TouchableOpacity>
            </View>

            {mode === 'link' ? (
              <>
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

                {/* Every share is end-to-end (double) encrypted — the server
                    requires it, so this is a static indicator, not a toggle. */}
                <View style={styles.toggleRow}>
                  <View style={styles.toggleInfo}>
                    <Text style={styles.toggleLabel}>End-to-end encrypted</Text>
                    <Text style={styles.toggleSub}>
                      Beebeeb cannot decrypt this share. The recipient needs both the link and the key — send them through separate channels.
                    </Text>
                    <View style={styles.zkBadge}>
                      <Text style={styles.zkBadgeText}>ACTIVE</Text>
                    </View>
                  </View>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.sectionLabel}>Recipient</Text>
                <TextInput
                  style={styles.input}
                  value={recipient}
                  onChangeText={setRecipient}
                  placeholder="email@example.com or @handle"
                  placeholderTextColor={c.ink4}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  editable={!creating}
                />
                <Text style={styles.hint}>
                  Handles resolve only for people you already share with.
                </Text>
              </>
            )}

            {error && (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.createButton, creating && styles.buttonDisabled]}
              onPress={mode === 'link' ? handleCreate : handleCreateInvite}
              activeOpacity={0.8}
              disabled={creating}
            >
              {creating ? (
                <ActivityIndicator color={c.ink} size="small" />
              ) : (
                <Text style={styles.createButtonText}>
                  {mode === 'link' ? 'Create encrypted link' : 'Send invite'}
                </Text>
              )}
            </TouchableOpacity>

            <Text style={styles.fineprint}>
              {mode === 'link'
                ? 'End-to-end encrypted — Beebeeb cannot decrypt. The recipient needs both the link and the key.'
                : 'Email invites appear as pending until the recipient can accept them.'}
            </Text>
          </ScrollView>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
