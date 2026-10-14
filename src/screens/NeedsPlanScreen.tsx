/**
 * Task 1037: the full-screen state for a `needs_plan` account.
 *
 * The account exists but is not active, so the server gives it quota 0. The app
 * blocks the file UI behind this screen until `account_state` is no longer
 * `needs_plan`.
 *
 * App Store 3.1.1 / 3.1.3, tasks 1400 and 1821: this screen states what is true
 * about the account and offers nothing to buy: no plan name, no price, no link.
 * The user can:
 *  - Refresh, which re-reads the account state;
 *  - Sign out, for example to use a different account.
 *
 * Styled like its blocking siblings (`PhraseNotConfirmedScreen`,
 * `RecoveryUnlockScreen`): plain surface, brand mark, one amber primary. No
 * `design/ios26-canvas/` artboard covers account-setup states.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BBLogo } from '../components/BBLogo';
import { BBWordmark } from '../components/BBWordmark';
import { onAmber, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useAuth } from '../lib/auth';
import { useAccountState } from '../lib/account-state-context';
import { needsPlanCopy } from '../lib/web-links';

type RefreshOutcome = 'idle' | 'still_needs_plan';

export default function NeedsPlanScreen() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { user, signOut } = useAuth();
  const { refresh } = useAccountState();
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [outcome, setOutcome] = useState<RefreshOutcome>('idle');
  const copy = needsPlanCopy();
  const busy = refreshing || signingOut;

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    content: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
      paddingTop: insets.top + spacing.xl,
      paddingBottom: insets.bottom + spacing.xl,
    },
    brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: spacing['2xl'] },
    iconWrap: {
      alignSelf: 'center',
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: c.amberBg,
      borderWidth: 1,
      borderColor: c.amber,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.lg,
    },
    heading: { fontSize: 22, fontWeight: '800', color: c.ink, textAlign: 'center', letterSpacing: -0.2, marginBottom: spacing.sm },
    body: { fontSize: 15, color: c.ink2, lineHeight: 22, textAlign: 'center', marginBottom: spacing.md },
    account: { fontSize: 13, color: c.ink3, textAlign: 'center', marginBottom: spacing.xl },
    accountEmail: { color: c.ink2, fontWeight: '600' },
    note: {
      padding: spacing.md,
      backgroundColor: c.paper2,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: c.line,
      marginBottom: spacing.lg,
    },
    noteText: { fontSize: 13, color: c.ink2, lineHeight: 19, textAlign: 'center' },
    buttonStack: { gap: spacing.md },
    button: {
      minHeight: 48,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    primaryButton: { backgroundColor: c.amber },
    secondaryButton: { backgroundColor: c.paper, borderWidth: 1, borderColor: c.line },
    buttonDisabled: { opacity: 0.45 },
    primaryText: { color: onAmber, fontSize: 15, fontWeight: '800', textAlign: 'center' },
    secondaryText: { color: c.ink2, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  }), [c, insets.bottom, insets.top]);

  async function handleRefresh() {
    if (busy) return;
    setRefreshing(true);
    try {
      const gate = await refresh();
      // When the account is active the overlay unmounts by itself. Otherwise say so,
      // so the button does not look like it did nothing.
      setOutcome(gate.kind === 'needs_plan' ? 'still_needs_plan' : 'idle');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSignOut() {
    if (busy) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      testID="needs-plan-screen"
    >
      <View style={styles.brand}>
        <BBLogo size={36} />
        <BBWordmark size={20} />
      </View>

      <View style={styles.iconWrap}>
        <Ionicons name="sparkles-outline" size={26} color={c.amberDeep} />
      </View>

      <Text style={styles.heading} accessibilityRole="header">{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      {user?.email ? (
        <Text style={styles.account}>
          Signed in as <Text style={styles.accountEmail}>{user.email}</Text>
        </Text>
      ) : null}

      {outcome === 'still_needs_plan' && (
        <View style={styles.note} accessibilityLiveRegion="polite">
          <Text style={styles.noteText}>
            Uploads are still paused on this account. Nothing has changed yet.
          </Text>
        </View>
      )}

      <View style={styles.buttonStack}>
        <TouchableOpacity
          style={[styles.button, styles.primaryButton, busy && styles.buttonDisabled]}
          onPress={() => { void handleRefresh(); }}
          disabled={busy}
          activeOpacity={0.82}
          accessibilityRole="button"
          accessibilityLabel="Refresh"
          accessibilityHint="Checks the status of this account again"
          accessibilityState={{ disabled: busy, busy: refreshing }}
          testID="needs-plan-refresh"
        >
          {refreshing ? <ActivityIndicator color={onAmber} /> : <Text style={styles.primaryText}>Refresh</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.secondaryButton, busy && styles.buttonDisabled]}
          onPress={() => { void handleSignOut(); }}
          disabled={busy}
          activeOpacity={0.78}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy: signingOut }}
          testID="needs-plan-sign-out"
        >
          {signingOut ? <ActivityIndicator color={c.ink2} /> : <Text style={styles.secondaryText}>Sign out</Text>}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

/**
 * Rendered by App.tsx above the navigator for a signed-in user. Shows
 * NeedsPlanScreen, covering the file UI, only while the account is
 * `needs_plan`. `accessibilityViewIsModal` keeps VoiceOver off the UI behind it.
 * No zIndex on purpose: render order keeps the biometric lock (rendered after
 * it in App.tsx) on top.
 */
export function NeedsPlanOverlay() {
  const { gate } = useAccountState();
  const { colors: c } = useTheme();
  if (gate.kind !== 'needs_plan') return null;
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: c.paper }]}
      accessibilityViewIsModal
    >
      <NeedsPlanScreen />
    </View>
  );
}
