import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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
import { createShare, friendlyError } from '../lib/api';
import type { Share as ShareLink } from '../lib/api';

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

// ---------------------------------------------------------------------------
// Expiry / max-opens options
// ---------------------------------------------------------------------------

interface ExpiryOption {
  label: string;
  hours: number | null; // null = never
}

const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: 'Never', hours: null },
];

interface OpensOption {
  label: string;
  value: number | null; // null = unlimited
}

const OPENS_OPTIONS: OpensOption[] = [
  { label: 'One-time', value: 1 },
  { label: '5 opens', value: 5 },
  { label: 'Unlimited', value: null },
];

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ShareSheetScreen() {
  const navigation = useNavigation();
  const route = useRoute<ShareRoute>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { fileId, fileName, mimeType, sizeBytes } = route.params;

  const [expiry, setExpiry] = useState<ExpiryOption>(EXPIRY_OPTIONS[1]);
  const [opens, setOpens] = useState<OpensOption>(OPENS_OPTIONS[0]);
  const [passphrase, setPassphrase] = useState('');
  const [creating, setCreating] = useState(false);
  const [share, setShare] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  const badge = makeFileTypeBadge(mimeType, c);

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: 'transparent', justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: { backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: spacing.lg, paddingTop: 12, maxHeight: '85%', ...shadows.lg },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.line2, alignSelf: 'center', marginBottom: 14 },
    fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
    fileIcon: { width: 36, height: 36, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
    fileIconText: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
    fileInfo: { flex: 1, minWidth: 0 },
    fileName: { fontSize: 14, fontWeight: '600', color: c.ink },
    fileMeta: { fontSize: 11, color: c.ink3, marginTop: 2 },
    scroll: { maxHeight: 460 },
    scrollContent: { paddingBottom: 8 },
    sectionLabel: { fontSize: 11, fontWeight: '600', color: c.ink3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8, marginBottom: 8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
    chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radii.round, backgroundColor: c.paper2, borderWidth: 1, borderColor: c.line },
    chipActive: { backgroundColor: c.ink, borderColor: c.ink },
    chipText: { fontSize: 12, color: c.ink3 },
    chipTextActive: { color: c.paper, fontWeight: '600' },
    input: { height: 42, borderWidth: 1, borderColor: c.line, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 14, color: c.ink, backgroundColor: c.paper },
    hint: { fontSize: 11, color: c.ink3, marginTop: 6, lineHeight: 15 },
    errorBanner: { backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2', borderWidth: 1, borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca', borderRadius: radii.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.lg },
    errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
    createButton: { height: 46, backgroundColor: c.amber, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl },
    buttonDisabled: { opacity: 0.6 },
    createButtonText: { fontSize: 14, fontWeight: '700', color: c.ink },
    fineprint: { fontSize: 11, color: c.ink4, textAlign: 'center', marginTop: 12, lineHeight: 16 },
    successCard: { paddingTop: 8 },
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
      const result = await createShare(fileId, {
        expires_in_hours: expiry.hours ?? undefined,
        max_opens: opens.value ?? undefined,
        passphrase: passphrase.trim() || undefined,
      });
      setShare(result);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(friendlyError(err));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreating(false);
    }
  }, [fileId, expiry, opens, passphrase]);

  const handleCopy = useCallback(async () => {
    if (!share) return;
    await Clipboard.setStringAsync(share.url);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    showToast({ type: 'success', message: 'Link copied to clipboard' });
    setTimeout(() => setCopied(false), 2000);
  }, [share, showToast]);

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
            <Text style={styles.sectionLabel}>Encrypted link</Text>
            <View style={styles.urlBox}>
              <Text style={styles.urlText} numberOfLines={1} selectable>
                {share.url}
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
              The link gives access to a key wrapped for the recipient. We never see the file.
            </Text>
          </ScrollView>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

