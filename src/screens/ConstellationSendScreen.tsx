/**
 * ConstellationSendScreen — sender side of the peer transfer flow.
 *
 * Flow:
 *   1. Generate ephemeral keypair, init session on the server.
 *   2. Show the constellation + 6-digit fallback code.
 *   3. Poll status every 2s until receiver joins.
 *   4. Derive SAS words (matching the receiver) and ask the user to verify.
 *   5. On approve: encrypt the file, upload, show progress, show "Delivered".
 *
 * v1 simplifications (see team-lead brief):
 *   - Mock shared secret — random bytes used in place of X25519 ECDH output.
 *     The constellation still encodes a real session_id and the SAS words
 *     still derive deterministically from the public-key bundle, so the
 *     end-to-end flow exercises every server endpoint and every UI state.
 *   - "Encryption" of the blob uploads the raw ciphertext returned by the
 *     server's existing /files/{id}/download endpoint (already E2E-encrypted
 *     under the user's master key). Real per-transfer AES-256-GCM lands when
 *     UniFFI exposes encrypt_chunk to JS.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { darkColors, fonts, spacing } from '../theme';
import { generateConstellationHTML } from '../lib/constellation-renderer';
import {
  approveTransfer,
  bytesToBase64,
  cancelTransfer,
  getTransferStatus,
  initTransfer,
  randomBytes,
  uploadTransferBlob,
} from '../lib/transfer-api';
import { downloadFile, friendlyError } from '../lib/api';
import { deriveSasWords } from '../lib/sas-words';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type RouteProps = NativeStackScreenProps<RootStackParamList, 'ConstellationSend'>['route'];

type Phase =
  | 'initializing'   // creating ephemeral keys + POST /init
  | 'waiting'        // showing constellation + fallback, polling for join
  | 'verifying'      // receiver joined; sender confirms SAS
  | 'sending'        // approved; downloading + uploading the blob
  | 'delivered'      // receiver ACKed (or upload completed in v1)
  | 'cancelled'      // sender tapped "Don't match" or hit Cancel
  | 'error';

const POLL_INTERVAL_MS = 2_000;

export default function ConstellationSendScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProps>();
  const insets = useSafeAreaInsets();
  const { fileId, fileName } = route.params;

  const [phase, setPhase] = useState<Phase>('initializing');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fallbackCode, setFallbackCode] = useState<string | null>(null);
  const [senderPk, setSenderPk] = useState<string | null>(null);
  const [receiverPk, setReceiverPk] = useState<string | null>(null);

  // Polling guard — the latest sessionId we should still be tracking. Mirrors
  // the React state but accessed inside the timer callback without rerunning
  // the effect on every tick.
  const activeSessionRef = useRef<string | null>(null);

  const html = useMemo(() => generateConstellationHTML(), []);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1 — initialise on mount.
  //
  // Generates an ephemeral 32-byte "public key" stand-in (real X25519 lands
  // when UniFFI exposes it) and posts to /transfer/init. Errors fall through
  // to the 'error' phase — the user can hit Back and retry.
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pkBytes = randomBytes(32);
        const pkB64 = bytesToBase64(pkBytes);
        const res = await initTransfer(pkB64);
        if (cancelled) return;
        setSenderPk(pkB64);
        setSessionId(res.session_id);
        setFallbackCode(res.fallback_code);
        activeSessionRef.current = res.session_id;
        setPhase('waiting');
      } catch (err) {
        if (cancelled) return;
        setErrorText(friendlyError(err));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2 — poll for receiver join while we're in 'waiting'.
  //
  // We tear down the timer the moment we move past 'waiting' so we don't
  // keep hammering the server during SAS verification or upload.
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'waiting' || !sessionId) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || activeSessionRef.current !== sessionId) return;
      try {
        const status = await getTransferStatus(sessionId);
        if (stopped) return;
        if (status.receiver_pk) {
          setReceiverPk(status.receiver_pk);
          setPhase('verifying');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else if (status.status === 'expired' || status.status === 'cancelled') {
          setPhase('cancelled');
        }
      } catch {
        // Transient network blips during polling — silently retry on the
        // next tick. A real failure surfaces on the next user action.
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [phase, sessionId]);

  // ──────────────────────────────────────────────────────────────────────────
  // Cleanup on unmount: cancel the session if we never reached 'delivered'.
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      const id = activeSessionRef.current;
      if (!id) return;
      // Fire-and-forget; the user is leaving the screen anyway.
      cancelTransfer(id).catch(() => {});
    };
  }, []);

  // SAS words are derived once we have both public keys — both sides compute
  // the same four words from the same context.
  const sasWords = useMemo(() => {
    if (!sessionId || !senderPk || !receiverPk) return null;
    return deriveSasWords(sessionId, senderPk, receiverPk);
  }, [sessionId, senderPk, receiverPk]);

  // ──────────────────────────────────────────────────────────────────────────
  // Approve handler — runs the upload pipeline.
  //
  // Sequence: POST /approve → GET /files/{id}/download (existing E2E
  // ciphertext) → PUT /transfer/{id}/blob with the bytes → 'delivered'.
  // Any failure flips to 'error' with the friendly message.
  // ──────────────────────────────────────────────────────────────────────────
  const handleApprove = useCallback(async () => {
    if (!sessionId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase('sending');
    try {
      await approveTransfer(sessionId);
      const res = await downloadFile(fileId);
      const blob = await res.blob();
      // v1 sends the existing user-key ciphertext as the transfer payload.
      // Real per-transfer key wrapping replaces this once the core exposes
      // encrypt_chunk via UniFFI.
      await uploadTransferBlob(sessionId, blob, fileName);
      setPhase('delivered');
      activeSessionRef.current = null;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setErrorText(friendlyError(err));
      setPhase('error');
    }
  }, [sessionId, fileId, fileName]);

  const handleReject = useCallback(() => {
    Alert.alert(
      'Codes don\'t match?',
      'Cancel this transfer. The other device will be notified.',
      [
        { text: 'Keep waiting', style: 'cancel' },
        {
          text: 'Cancel transfer',
          style: 'destructive',
          onPress: () => {
            const id = activeSessionRef.current;
            activeSessionRef.current = null;
            if (id) void cancelTransfer(id);
            setPhase('cancelled');
          },
        },
      ],
    );
  }, []);

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <TouchableOpacity
        style={styles.backRow}
        onPress={handleClose}
        activeOpacity={0.7}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Text style={styles.backText}>{phase === 'delivered' ? 'Done' : 'Cancel'}</Text>
      </TouchableOpacity>

      <View style={styles.constellation}>
        <WebView
          source={{ html }}
          style={styles.webview}
          containerStyle={styles.webviewContainer}
          javaScriptEnabled
          scrollEnabled={false}
          bounces={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          originWhitelist={['*']}
          androidLayerType="hardware"
          setSupportMultipleWindows={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      </View>

      <View style={styles.footer}>
        {phase === 'initializing' && (
          <Text style={styles.status}>Preparing transfer…</Text>
        )}

        {phase === 'waiting' && (
          <>
            <Text style={styles.title}>Sending “{fileName}”</Text>
            <Text style={styles.status}>Waiting for someone to scan…</Text>
            {fallbackCode && (
              <View style={styles.codeWrap}>
                <Text style={styles.codeLabel}>Or enter code on the other device</Text>
                <Text style={styles.codeText}>{formatCode(fallbackCode)}</Text>
              </View>
            )}
            <Text style={styles.disclaimer}>
              Encrypted relay via Frankfurt. Deleted after pickup.
            </Text>
          </>
        )}

        {phase === 'verifying' && sasWords && (
          <>
            <Text style={styles.title}>Verify with the receiver</Text>
            <Text style={styles.sasWords}>{sasWords.join('  ')}</Text>
            <Text style={styles.status}>
              Both screens should show the same four words.
            </Text>
            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleApprove}
                activeOpacity={0.8}
                accessibilityRole="button"
              >
                <Text style={styles.primaryButtonText}>Codes match — Send</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.outlineButton}
                onPress={handleReject}
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Text style={styles.outlineButtonText}>Don't match</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {phase === 'sending' && (
          <>
            <Text style={styles.title}>Encrypting and sending…</Text>
            <Text style={styles.status}>Don't close the app.</Text>
          </>
        )}

        {phase === 'delivered' && (
          <>
            <Text style={styles.titleAmber}>Delivered</Text>
            <Text style={styles.status}>
              The other device has the file. Server copy is being deleted.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleClose}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>Done</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === 'cancelled' && (
          <>
            <Text style={styles.title}>Transfer cancelled</Text>
            <TouchableOpacity
              style={styles.outlineButton}
              onPress={handleClose}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Text style={styles.outlineButtonText}>Close</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === 'error' && (
          <>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.status}>{errorText ?? 'Please try again.'}</Text>
            <TouchableOpacity
              style={styles.outlineButton}
              onPress={handleClose}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Text style={styles.outlineButtonText}>Close</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

/** Insert a thin space in the middle of a 6-digit code for readability. */
function formatCode(code: string): string {
  if (code.length !== 6) return code;
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: darkColors.darkBg,
  },
  backRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backText: {
    fontSize: 14,
    color: darkColors.ink2,
  },
  constellation: {
    flex: 1,
    backgroundColor: darkColors.darkBg,
  },
  webview: {
    flex: 1,
    backgroundColor: darkColors.darkBg,
  },
  webviewContainer: {
    backgroundColor: darkColors.darkBg,
  },
  footer: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    minHeight: 220,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: darkColors.ink,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  titleAmber: {
    fontSize: 18,
    fontWeight: '700',
    color: darkColors.amber,
    marginBottom: spacing.sm,
    letterSpacing: 0.5,
  },
  status: {
    fontSize: 13,
    color: darkColors.ink2,
    letterSpacing: 0.3,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  codeWrap: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  codeLabel: {
    fontSize: 11,
    color: darkColors.ink3,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  codeText: {
    fontSize: 28,
    fontWeight: '600',
    color: darkColors.amber,
    fontFamily: fonts.mono,
    letterSpacing: 4,
  },
  disclaimer: {
    fontSize: 11,
    color: darkColors.ink3,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  sasWords: {
    fontSize: 22,
    fontWeight: '700',
    color: darkColors.amber,
    fontFamily: fonts.mono,
    letterSpacing: 1,
    textAlign: 'center',
    marginVertical: spacing.md,
  },
  buttonRow: {
    flexDirection: 'column',
    gap: spacing.sm,
    width: '100%',
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: darkColors.amber,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 10,
    minWidth: 240,
    alignItems: 'center',
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: darkColors.black,
    letterSpacing: 0.5,
  },
  outlineButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: darkColors.line2,
    minWidth: 240,
    alignItems: 'center',
  },
  outlineButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: darkColors.ink2,
    letterSpacing: 0.5,
  },
});
