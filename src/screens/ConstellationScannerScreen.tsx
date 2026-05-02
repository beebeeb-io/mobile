/**
 * Constellation receive screen.
 *
 * Camera-based scanning isn't wired up yet (the original stub noted that
 * react-native-vision-camera needs a newer Xcode) so this screen implements
 * the manual-fallback path: the receiver types the 6-digit code shown on the
 * sender's device, joins the session, verifies the SAS, then downloads + saves
 * the file.
 *
 * Flow:
 *   1. Receiver enters the 6-digit code from the sender's screen.
 *   2. POST /transfer/join-by-code → session_id + sender_pk + download_token.
 *   3. Derive SAS words and ask the user to verify.
 *   4. Poll /status until the sender approves and uploads.
 *   5. GET /blob → save bytes to FileSystem cache → expo-sharing share sheet.
 *   6. POST /ack to confirm and trigger server-side blob deletion.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { darkColors, fonts, spacing } from '../theme';
import {
  ackTransfer,
  bytesToBase64,
  bytesToHex,
  downloadTransferBlob,
  getTransferStatus,
  joinTransferByCode,
  randomBytes,
} from '../lib/transfer-api';
import { friendlyError } from '../lib/api';
import { deriveSasWords } from '../lib/sas-words';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type Phase =
  | 'idle'        // initial — show the code input
  | 'joining'     // POST /join in flight
  | 'verifying'   // SAS shown; waiting for sender approval
  | 'receiving'   // sender approved; downloading + decrypting
  | 'received'    // saved; offering "Save to device"
  | 'cancelled'
  | 'error';

const POLL_INTERVAL_MS = 2_000;

export function ConstellationScannerScreen() {
  const navigation = useNavigation<Nav>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [senderPk, setSenderPk] = useState<string | null>(null);
  const [receiverPk, setReceiverPk] = useState<string | null>(null);
  const [downloadToken, setDownloadToken] = useState<string | null>(null);

  const [savedUri, setSavedUri] = useState<string | null>(null);
  const [savedMime, setSavedMime] = useState<string | null>(null);

  // Mirrors sessionId for the polling timer; lets the closure observe the
  // current session without rebinding every state change.
  const activeSessionRef = useRef<string | null>(null);

  // Best-effort cleanup of the temp file on unmount.
  useEffect(() => {
    return () => {
      if (savedUri) FileSystem.deleteAsync(savedUri, { idempotent: true }).catch(() => {});
    };
  }, [savedUri]);

  // ──────────────────────────────────────────────────────────────────────────
  // Code submission — kicks off the join handshake.
  // ──────────────────────────────────────────────────────────────────────────
  const handleSubmitCode = useCallback(async () => {
    const code = codeInput.replace(/\D/g, '');
    if (code.length !== 6) {
      Alert.alert('Enter the 6-digit code', 'It\'s shown on the other device.');
      return;
    }
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPhase('joining');
    try {
      const pkBytes = randomBytes(32);
      const pkB64 = bytesToBase64(pkBytes);
      const res = await joinTransferByCode(code, pkB64);
      setSessionId(res.session_id);
      setSenderPk(res.sender_pk);
      setReceiverPk(pkB64);
      setDownloadToken(res.download_token);
      activeSessionRef.current = res.session_id;
      setPhase('verifying');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setErrorText(friendlyError(err));
      setPhase('error');
    }
  }, [codeInput]);

  // ──────────────────────────────────────────────────────────────────────────
  // Status polling while waiting for sender approval + upload.
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'verifying' || !sessionId || !downloadToken) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || activeSessionRef.current !== sessionId) return;
      try {
        const status = await getTransferStatus(sessionId, downloadToken);
        if (stopped) return;
        if (status.status === 'cancelled' || status.status === 'expired') {
          setPhase('cancelled');
          return;
        }
        if (status.status === 'ready' || (status.blob_size != null && status.blob_size > 0)) {
          setPhase('receiving');
        }
      } catch {
        // Ignore transient network errors; next tick will retry.
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [phase, sessionId, downloadToken]);

  // ──────────────────────────────────────────────────────────────────────────
  // Download + save once the sender's blob is ready.
  //
  // Writes to FileSystem.cacheDirectory using a hex-prefixed name so the
  // file survives the share sheet round-trip. Errors fall through to the
  // 'error' phase with the friendly message.
  // ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'receiving' || !sessionId || !downloadToken) return;
    let cancelled = false;
    (async () => {
      try {
        const buf = await downloadTransferBlob(sessionId, downloadToken);
        if (cancelled) return;

        // v1: the bytes we receive are the existing user-key ciphertext from
        // the sender's vault. Saving them as-is means the receiver can hand
        // the file to a Beebeeb-aware app for decryption later. When per-
        // transfer AES-GCM lands we'll decrypt here with the derived
        // transfer_key before saving.
        const bytes = new Uint8Array(buf);
        const fileName = `beebeeb-transfer-${bytesToHex(randomBytes(4))}.enc`;
        const localUri = `${FileSystem.cacheDirectory}${fileName}`;
        const base64 = bytesToBase64(bytes);
        await FileSystem.writeAsStringAsync(localUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });

        if (cancelled) return;
        setSavedUri(localUri);
        setSavedMime('application/octet-stream');

        // ACK so the server can drop the blob. Best-effort — if it fails the
        // server's expiry sweep cleans up after 24h.
        ackTransfer(sessionId, downloadToken).catch(() => {});
        activeSessionRef.current = null;
        setPhase('received');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        if (cancelled) return;
        setErrorText(friendlyError(err));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, sessionId, downloadToken]);

  const handleSave = useCallback(async () => {
    if (!savedUri) return;
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert('Sharing unavailable', 'This device does not support the system share sheet.');
        return;
      }
      await Sharing.shareAsync(savedUri, {
        mimeType: savedMime ?? 'application/octet-stream',
        UTI: 'public.data',
        dialogTitle: 'Save received file',
      });
    } catch (err) {
      Alert.alert('Could not save', friendlyError(err));
    }
  }, [savedUri, savedMime]);

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // SAS words once both pks are known.
  const sasWords = useMemo(() => {
    if (!sessionId || !senderPk || !receiverPk) return null;
    return deriveSasWords(sessionId, senderPk, receiverPk);
  }, [sessionId, senderPk, receiverPk]);

  return (
    <SafeAreaView style={styles.root}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={styles.container}>
          <TouchableOpacity
            style={styles.backRow}
            onPress={handleClose}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Text style={styles.backText}>{phase === 'received' ? 'Done' : 'Cancel'}</Text>
          </TouchableOpacity>

          <View style={styles.body}>
            {phase === 'idle' && (
              <>
                <Text style={styles.title}>Receive a file</Text>
                <Text style={styles.subtitle}>
                  Scan a constellation to receive a file.
                  Camera scanning will be available in the next build.
                </Text>
                <Text style={styles.sectionLabel}>Enter code manually</Text>
                <TextInput
                  style={styles.codeInput}
                  value={codeInput}
                  onChangeText={(s) => setCodeInput(s.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  placeholderTextColor={darkColors.ink4}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleSubmitCode}
                  accessibilityLabel="Six-digit transfer code"
                />
                <TouchableOpacity
                  style={[styles.primaryButton, codeInput.length !== 6 && styles.primaryButtonDisabled]}
                  onPress={handleSubmitCode}
                  disabled={codeInput.length !== 6}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryButtonText}>Continue</Text>
                </TouchableOpacity>
                <Text style={styles.disclaimer}>
                  Encrypted relay via Falkenstein. Deleted after pickup.
                </Text>
              </>
            )}

            {phase === 'joining' && (
              <>
                <ActivityIndicator color={darkColors.amber} size="large" />
                <Text style={styles.status}>Joining transfer…</Text>
              </>
            )}

            {phase === 'verifying' && sasWords && (
              <>
                <Text style={styles.title}>Verify with the sender</Text>
                <Text style={styles.sasWords}>{sasWords.join('  ')}</Text>
                <Text style={styles.status}>
                  Both screens should show the same four words.
                  Waiting for the sender to confirm…
                </Text>
                <ActivityIndicator color={darkColors.amber} />
              </>
            )}

            {phase === 'receiving' && (
              <>
                <Text style={styles.title}>Receiving file…</Text>
                <ActivityIndicator color={darkColors.amber} size="large" />
                <Text style={styles.status}>Don't close the app.</Text>
              </>
            )}

            {phase === 'received' && (
              <>
                <Text style={styles.titleAmber}>File received</Text>
                <Text style={styles.status}>
                  The encrypted file is on your device.
                  Server copy is being deleted.
                </Text>
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={handleSave}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryButtonText}>Save to device</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.outlineButton}
                  onPress={handleClose}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                >
                  <Text style={styles.outlineButtonText}>Done</Text>
                </TouchableOpacity>
              </>
            )}

            {phase === 'cancelled' && (
              <>
                <Text style={styles.title}>Transfer cancelled</Text>
                <Text style={styles.status}>The other side ended this transfer.</Text>
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
      </TouchableWithoutFeedback>
    </SafeAreaView>
  );
}

export default ConstellationScannerScreen;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: darkColors.darkBg,
  },
  container: {
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
  body: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    gap: spacing.md,
  },
  title: {
    fontSize: 18,
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
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    color: darkColors.ink2,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  sectionLabel: {
    fontSize: 11,
    color: darkColors.ink3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: spacing.md,
  },
  codeInput: {
    fontSize: 32,
    fontWeight: '600',
    color: darkColors.amber,
    fontFamily: fonts.mono,
    letterSpacing: 8,
    textAlign: 'center',
    borderBottomWidth: 1,
    borderBottomColor: darkColors.line2,
    paddingVertical: spacing.sm,
    minWidth: 220,
    marginBottom: spacing.lg,
  },
  primaryButton: {
    backgroundColor: darkColors.amber,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 10,
    minWidth: 240,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.4,
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
    marginTop: spacing.sm,
  },
  outlineButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: darkColors.ink2,
    letterSpacing: 0.5,
  },
  status: {
    fontSize: 13,
    color: darkColors.ink2,
    letterSpacing: 0.3,
    textAlign: 'center',
    marginVertical: spacing.md,
  },
  disclaimer: {
    fontSize: 11,
    color: darkColors.ink3,
    textAlign: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  sasWords: {
    fontSize: 22,
    fontWeight: '700',
    color: darkColors.amber,
    fontFamily: fonts.mono,
    letterSpacing: 1,
    textAlign: 'center',
    marginVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
});
