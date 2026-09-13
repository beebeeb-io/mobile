/**
 * Delete-account screen — task 1399, App Review guideline 5.1.1(v).
 *
 * "If your app supports account creation, you must also offer account
 * deletion within the app" — the web may only FINISH a deletion that was
 * INITIATED in-app. This screen replaces the old PrivacyScreen alert that
 * sent users to a web page (App Review rejects that pattern for an app like
 * ours — cloud storage is not on Apple's "highly regulated industries"
 * exception list).
 *
 * Mirrors the web client's `src/pages/delete-account.tsx`: irreversibility
 * copy, a typed "DELETE" confirmation, an acknowledgement checkbox, then
 * step-up re-auth before the destructive call. On mobile, step-up re-auth is
 * `requestConfirmation()` (native password prompt → `confirmAction`,
 * already used by BiometricLockScreen) rather than a separate inline
 * password field — one password prompt, not two.
 *
 * Voice: honest, no reassurance ("We can't recover this," not "your data is
 * safe"). No emojis. Danger styling matches PrivacyScreen's `ActionRow
 * danger` (c.red icon/text, no gradient, no icon decoration for drama).
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { radii, spacing, type Colors } from '../theme';
import { useAuth } from '../lib/auth';
import { requestConfirmation } from '../lib/confirm-action';
import { deleteAccountPermanently, friendlyError } from '../lib/api';
import { purgeAllPlaintextCaches, purgeThenSignOut } from '../lib/account-cleanup';

type C = Colors;

/** What deletion destroys — mirrors web's `deletionItems`, mobile-specific items added. */
const DESTROYED_ITEMS: [string, string][] = [
  ['Encryption keys', 'Master key and every derived file key'],
  ['All files and versions', 'Encrypted blobs shredded from all regions'],
  ['All shared links', 'Active links stop working immediately'],
  ['Device backups', 'Photo, contact, and calendar backups'],
];

function formatShredDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function DeleteAccountScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { signOut } = useAuth();

  const [confirmation, setConfirmation] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-side gate — tapping "Delete permanently" while this is false never
  // calls handleDelete, so a typo in the confirmation field sends ZERO
  // network requests (task 1399 verification).
  const canDelete = confirmation === 'DELETE' && understood && !loading;

  const styles = useMemo(() => makeStyles(c, resolved), [c, resolved]);

  const handleDelete = useCallback(async () => {
    if (!canDelete) return;
    setError(null);

    // Step-up re-auth: prompts for the password and exchanges it for a
    // confirmation token via `confirmAction` (OPAQUE, with the plaintext
    // fallback for legacy accounts). A wrong password re-prompts in place
    // (requestConfirmation's own retry loop) and NEVER returns a token, so
    // `deleteAccountPermanently` below is never reached — the destructive
    // DELETE /api/v1/auth/account call is not made until a correct password
    // has been proven to the server.
    const token = await requestConfirmation({
      title: 'Confirm account deletion',
      message: 'Enter your password to permanently delete your account. This cannot be undone.',
    });
    if (!token) return; // cancelled, or requestConfirmation already alerted

    setLoading(true);
    try {
      const { shred_after } = await deleteAccountPermanently(confirmation, token);
      const shredDate = formatShredDate(shred_after);
      // Show the honest outcome BEFORE signing out — signOut() flips
      // isAuthenticated and the navigator swaps to the unauthenticated stack
      // out from under this screen, so the notice must be seen first.
      await new Promise<void>((resolve) => {
        Alert.alert(
          'Account deleted',
          `Your account has been permanently deleted. Encrypted data still on our servers is shredded after ${shredDate}.`,
          [{ text: 'OK', onPress: () => resolve() }],
        );
      });
      // Purge every on-disk plaintext cache BEFORE signing out (Codex P1 —
      // the account is deleted server-side, but decrypted thumbnails/names/
      // caches from this session must not survive on the device either).
      // signOut() also purges internally (every ordinary sign-out does), but
      // this call makes the deletion flow's own cleanup guarantee explicit
      // rather than solely dependent on signOut()'s internal step order.
      await purgeThenSignOut({ purge: purgeAllPlaintextCaches, signOut });
    } catch (err) {
      setError(friendlyError(err));
      setLoading(false);
    }
  }, [canDelete, confirmation, signOut]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          disabled={loading}
          testID="delete-account-back"
        >
          <Ionicons name="chevron-back" size={22} color={c.amber} />
          <Text style={{ fontSize: 16, color: c.amber, marginLeft: 2 }}>Privacy</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <Ionicons name="trash" size={18} color={c.red} />
          <Text style={styles.title}>Delete account</Text>
        </View>
        <Text style={styles.subtitle}>This cannot be undone. Read carefully.</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Warning banner */}
        <View style={styles.warningBanner} testID="delete-account-warning">
          <Text style={styles.warningText}>
            Within 30 days, your encrypted data is permanently shredded from all regions.
            After that there is nothing to recover — not for you, not for us, not for anyone
            with a court order. We can't recover this.
          </Text>
        </View>

        {/* What gets destroyed */}
        <Text style={styles.sectionHeader}>What gets destroyed</Text>
        <View style={styles.card}>
          {DESTROYED_ITEMS.map(([label, detail], i) => (
            <View
              key={label}
              style={[styles.itemRow, i < DESTROYED_ITEMS.length - 1 && styles.itemRowBorder]}
            >
              <Ionicons name="trash-outline" size={12} color={c.ink3} style={{ marginRight: 10 }} />
              <Text style={styles.itemLabel}>{label}</Text>
              <Text style={styles.itemDetail}>{detail}</Text>
            </View>
          ))}
        </View>

        {/* Type DELETE */}
        <Text style={styles.label}>Type DELETE to confirm</Text>
        <TextInput
          style={styles.input}
          value={confirmation}
          onChangeText={setConfirmation}
          placeholder="DELETE"
          placeholderTextColor={c.ink4}
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          editable={!loading}
          testID="delete-account-confirmation-input"
          accessibilityLabel="Type DELETE to confirm"
        />

        {/* Acknowledge checkbox */}
        <TouchableOpacity
          style={styles.checkRow}
          onPress={() => setUnderstood((v) => !v)}
          activeOpacity={0.7}
          disabled={loading}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: understood }}
          accessibilityLabel="I understand my files are encrypted and cannot be recovered after deletion"
          testID="delete-account-understood-checkbox"
        >
          <View style={[styles.checkbox, understood && styles.checkboxChecked]}>
            {understood && <Text style={styles.checkmark}>{'✓'}</Text>}
          </View>
          <Text style={styles.checkLabel}>
            I understand my files are encrypted and cannot be recovered after deletion.
          </Text>
        </TouchableOpacity>

        {error && (
          <View style={styles.errorBanner} testID="delete-account-error">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton]}
            onPress={() => navigation.goBack()}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="delete-account-cancel"
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.dangerButton, !canDelete && styles.buttonDisabled]}
            onPress={handleDelete}
            disabled={!canDelete}
            accessibilityRole="button"
            accessibilityLabel="Delete account permanently"
            accessibilityState={{ disabled: !canDelete }}
            testID="delete-account-submit"
          >
            {loading
              ? <ActivityIndicator size="small" color={c.paper} />
              : <Text style={styles.dangerButtonText}>Delete permanently</Text>
            }
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(c: C, resolved: 'light' | 'dark') {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    header: {
      paddingHorizontal: 14,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.line,
    },
    backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    title: { fontSize: 22, fontWeight: '700', color: c.ink },
    subtitle: { fontSize: 12, color: c.ink3, marginTop: 2 },
    scrollContent: { paddingHorizontal: 14, paddingTop: spacing.md },
    warningBanner: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca',
      backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2',
      marginBottom: spacing.lg,
    },
    warningText: { fontSize: 12.5, lineHeight: 18, color: c.red },
    sectionHeader: {
      fontSize: 10,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: c.ink3,
      marginBottom: 6,
    },
    card: {
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.paper,
      marginBottom: spacing.lg,
      overflow: 'hidden',
    },
    itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 12 },
    itemRowBorder: { borderBottomWidth: 1, borderBottomColor: c.line },
    itemLabel: { fontSize: 13, color: c.ink, flex: 1 },
    itemDetail: { fontSize: 11, color: c.ink3 },
    label: { fontSize: 12, fontWeight: '600', color: c.ink2, marginBottom: 6 },
    input: {
      height: 44,
      borderWidth: 1,
      borderColor: c.line,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      fontSize: 14,
      fontWeight: '600',
      color: c.ink,
      backgroundColor: c.paper,
      marginBottom: spacing.md,
    },
    checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: spacing.lg },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: c.line2,
      backgroundColor: c.paper,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    checkboxChecked: { backgroundColor: c.red, borderColor: c.red },
    checkmark: { fontSize: 12, color: c.paper, fontWeight: '700' },
    checkLabel: { flex: 1, fontSize: 12, color: c.ink2, lineHeight: 17 },
    errorBanner: {
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: radii.md,
      backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2',
      borderWidth: 1,
      borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca',
      marginBottom: spacing.md,
    },
    errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
    buttonRow: { flexDirection: 'row', gap: 10 },
    button: {
      flex: 1,
      height: 46,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: { borderWidth: 1, borderColor: c.line, backgroundColor: c.paper },
    cancelButtonText: { fontSize: 14, fontWeight: '600', color: c.ink },
    dangerButton: { backgroundColor: c.red },
    dangerButtonText: { fontSize: 14, fontWeight: '700', color: c.paper },
    buttonDisabled: { opacity: 0.5 },
  });
}
