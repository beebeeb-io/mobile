/**
 * Storage screen — usage breakdown + the account's state.
 *
 * No purchase or subscription-management call to action lives on this screen, and
 * no hint at one (tasks 1400 and 1821, App Store 3.1.1 / 3.1.3): no price list, no
 * plan to buy, no "manage it on the web". The account card reads the server's
 * onboarding document (allowance / trialing / trial_ended / lapsed / active).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { SCROLL_EDGE, ScrollEdgeBlur } from '../components/glass';
import { spacing, type Colors } from '../theme';
import { formatBytes } from '../lib/format';
import {
  getSubscription,
  type StorageUsage,
  type Subscription,
} from '../lib/api';
import { loadCachedBilling, saveCachedBilling } from '../lib/billing-cache';
import { trialCapNote } from '../lib/billing-status';
import { effectivePlan, planDisplayName } from '../lib/effective-plan';
import { accountChip } from '../lib/plan-chip';
import type { PlanCardView } from '../lib/onboarding/plan-card';
import { accountGateFor, uploadsBlocked } from '../lib/account-state';
import { useAccountState } from '../lib/account-state-context';
import { AccountStatusCard } from '../components/onboarding/AccountStatusCard';
import { useAuth } from '../lib/auth';

type C = Colors;

// ── Helpers ───────────────────────────────────────────────────────────────────



/**
 * Derive the storage-usage view-model from the subscription payload. The
 * `/billing/subscription` response already embeds `used_bytes` + `quota_bytes`
 * (server `billing.rs` sources both from the same `get_user_quota` that backs
 * `/files/usage`), so this screen no longer needs the separate
 * `getStorageUsage()` round-trip. `plan_name` maps to `effectivePlan(sub)`
 * (task 1601 — NOT the raw `subscription.plan`: a cancelled paid row still
 * carries its old `plan` slug with no entitlement behind it, and this label
 * sits directly next to the quota bar the server already computes from the
 * entitled plan, so the two must never disagree). `quota_bytes <= 0` is the
 * unlimited sentinel — preserved here so `StorageUsageCard` renders "no
 * fixed cap" exactly as before.
 */
function usageFromSubscription(sub: Subscription | null): StorageUsage | null {
  if (!sub || sub.used_bytes == null || sub.quota_bytes == null) return null;
  return {
    used_bytes: sub.used_bytes,
    plan_limit_bytes: sub.quota_bytes,
    plan_name: effectivePlan(sub),
  };
}

// ── Layout ────────────────────────────────────────────────────────────────────

const layout = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 14, paddingBottom: 48 },
  section: { marginBottom: 16 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12 },
  divider: { height: 1, marginLeft: 12 },
  headerLabel: {
    fontSize: 10, fontWeight: '600', textTransform: 'uppercase',
    letterSpacing: 0.5, paddingHorizontal: 6, marginBottom: 6,
  },
  noteText: { fontSize: 11, paddingHorizontal: 6, marginTop: 6, lineHeight: 16 },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
});

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, c }: { title: string; c: C }) {
  return <Text style={[layout.headerLabel, { color: c.ink3 }]}>{title}</Text>;
}

function Divider({ c }: { c: C }) {
  return <View style={[layout.divider, { backgroundColor: c.line }]} />;
}

// ── Storage bar ───────────────────────────────────────────────────────────────

function StorageUsageCard({
  usage, readOnly, chip, c,
}: { usage: StorageUsage; readOnly: boolean; chip: PlanCardView | null; c: C }) {
  // plan_limit_bytes <= 0 is the "no fixed cap" sentinel (e.g. enterprise);
  // never render it as a byte value ("-1 B") and don't show a denominator/%.
  // Task 1037: a needs_plan / lapsed account also reports quota 0, but that
  // means "no uploads", not "no cap". It gets the read-only line instead.
  const hasCap = !readOnly && usage.plan_limit_bytes > 0;
  const pct = hasCap
    ? Math.min(1, usage.used_bytes / usage.plan_limit_bytes)
    : 0;
  const isWarning = pct >= 0.8;
  const isFull = pct >= 1;

  const fillColor = isFull ? c.red : isWarning ? c.amberDeep : c.amber;
  const barPct = Math.max(0.02, pct); // always show a sliver

  return (
    <View style={{ padding: 14, gap: 10 }}>
      {/* Labels row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: c.ink }}>
          {formatBytes(usage.used_bytes)} used
        </Text>
        {hasCap ? (
          <Text style={{ fontSize: 13, color: c.ink3 }}>
            of {formatBytes(usage.plan_limit_bytes)}
          </Text>
        ) : null}
      </View>

      {/* Progress bar */}
      <View style={{ height: 6, backgroundColor: c.line, borderRadius: 3, overflow: 'hidden' }}>
        <View
          style={{
            height: '100%',
            width: `${barPct * 100}%` as any,
            backgroundColor: fillColor,
            borderRadius: 3,
          }}
        />
      </View>

      {/* Warning note */}
      {isWarning && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons
            name={isFull ? 'warning' : 'information-circle-outline'}
            size={13}
            color={isFull ? c.red : c.amberDeep}
          />
          <Text style={{ fontSize: 12, color: isFull ? c.red : c.amberDeep }}>
            {isFull
              ? 'Storage full — uploads are paused'
              : `${Math.round(pct * 100)}% used`}
          </Text>
        </View>
      )}

      {readOnly && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} testID="storage-read-only-note">
          <Ionicons name="lock-closed-outline" size={13} color={c.amberDeep} />
          <Text style={{ fontSize: 12, color: c.amberDeep }}>Read-only · uploads are off</Text>
        </View>
      )}

      {/* Account label: what the account is, never "<x> plan" (task 1821). */}
      <Text style={{ fontSize: 11, color: c.ink3 }} testID="storage-account-label">
        {`${chip?.label ?? planDisplayName(usage.plan_name)}${hasCap ? ` · ${formatBytes(usage.plan_limit_bytes)} total` : ''}`}
      </Text>
    </View>
  );
}

// ── Account card ──────────────────────────────────────────────────────────────

function AccountCard({ chip, c }: { chip: PlanCardView | null; c: C }) {
  if (!chip) return <Text style={{ padding: 14, fontSize: 13, color: c.ink3 }}>Could not load account status</Text>;
  const pill = {
    backgroundColor: c.amberBg, borderColor: c.amber, borderWidth: 1,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5,
  } as const;
  const pillText = { fontSize: 11, fontWeight: '700', color: c.amberDeep, letterSpacing: 0.3 } as const;
  return (
    <View style={{ padding: 14, gap: 8 }} testID="storage-account-card">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <View style={pill}>
          <Text style={pillText} testID="storage-account-chip">{chip.label.toUpperCase()}</Text>
        </View>
        {chip.badge && (
          <View style={pill}>
            <Text style={pillText}>{chip.badge}</Text>
          </View>
        )}
        {chip.statusLine && (
          <Text style={{ fontSize: 11, color: c.ink3 }} testID="storage-account-line">{chip.statusLine}</Text>
        )}
      </View>
      {/* Task 1821: state only. No "Manage subscription", no "managed on the web" hint. */}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function StorageScreen() {
  const { colors: c } = useTheme();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // Task 1601, root cause 4 — the billing cache is keyed by this. `null`
  // (never actually reachable — this screen is only navigable to while
  // signed in) makes both loadCachedBilling/saveCachedBilling no-ops rather
  // than reading/writing an unscoped, cross-account-leakable entry.
  const { user } = useAuth();
  const userId = user?.user_id ?? null;
  // 1315 — measured floating-header height feeding the scroll inset.
  const [headerHeight, setHeaderHeight] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  // Task 1746: the account-stage onboarding document, as status text (no purchase UI).
  const { document: accountDocument, gate: accountGate } = useAccountState();

  // Storage usage is derived from the subscription payload (used_bytes +
  // quota_bytes are embedded there), so there is no separate usage round-trip.
  const usage = usageFromSubscription(subscription);
  // Task 1037/1605: needs_plan / lapsed / a never-paid trial cancelled
  // before its first charge. Missing account_state (older server) is ok.
  const readOnly = accountDocument ? uploadsBlocked(accountGate) : uploadsBlocked(accountGateFor(subscription));
  // Task 1605 — informational only, no purchase CTA (task 1400).
  const trialCapMessage = trialCapNote(subscription, formatBytes);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. Instant paint: render last-known billing values from cache so a warm
      //    open shows content immediately instead of a spinner. (Briefly stale —
      //    confirmed by the network refresh below.)
      const cached = await loadCachedBilling(userId);
      if (cancelled) return;
      if (cached) {
        setSubscription(cached.subscription);
        setLoading(false);
      }

      // 2. Revalidate in the background. (Task 1821: the plan catalog is no
      //    longer fetched; the screen shows no prices.)
      const sub = await getSubscription().catch(() => null);
      if (cancelled) return;

      if (sub) setSubscription(sub);

      // 3. Re-persist the freshest known-good snapshot. Don't clobber a good
      //    warm cache with an error result.
      if (sub) void saveCachedBilling(sub, [], userId);

      // Cold first-ever open (no cache) ends its spinner here.
      setLoading(false);
    })();

    return () => { cancelled = true; };
    // `userId` included: if this screen were ever to stay mounted across a
    // sign-out/sign-in (it doesn't today — navigation unmounts it), a stale
    // closure over the PREVIOUS user's id must not go on reading/writing
    // that user's cache entry under the new session.
  }, [userId]);

  // Task 1821: the account chip reads the onboarding document's state, so a trial
  // that ended is never "TRIAL" and an account with no plan is never "No plan plan".
  // Task 1601: without a document it falls back to the ENTITLED plan, not the raw row.
  const chip = accountChip({ doc: accountDocument, subscription, fallbackPlanSlug: usage?.plan_name ?? null });
  // Task 1400 / 1821: no purchase or manage call to action lives in this screen.

  return (
    <View style={[layout.root, { backgroundColor: c.paper }]}>
      {/* 1315 — content runs under the chrome; the header floats with a
          scroll-edge blur, replacing its opaque fill and hairline border. */}
      {isScrolled ? <ScrollEdgeBlur height={headerHeight || SCROLL_EDGE.chromeFallback} /> : null}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          paddingTop: insets.top + (Platform.OS === 'android' ? 8 : 4),
          paddingHorizontal: 14,
          paddingBottom: 12,
        }}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          setHeaderHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
        }}
      >
        <TouchableOpacity
          style={layout.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={c.amber} />
          <Text style={{ fontSize: 16, color: c.amber, marginLeft: 2 }}>Settings</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 22, fontWeight: '700', color: c.ink, marginTop: 4 }}>
          Storage
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={c.amber} />
        </View>
      ) : (
        <ScrollView
          style={layout.scroll}
          contentContainerStyle={[
            layout.content,
            { paddingTop: headerHeight + spacing.md, paddingBottom: insets.bottom + 40 },
          ]}
          onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
          scrollEventThrottle={100}
          showsVerticalScrollIndicator={false}
        >
          {/* Storage usage */}
          <View style={layout.section}>
            <SectionHeader title="Storage usage" c={c} />
            <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
              {usage
                ? <StorageUsageCard usage={usage} readOnly={readOnly} chip={chip} c={c} />
                : <Text style={{ padding: 14, fontSize: 13, color: c.ink3 }}>Could not load storage info</Text>
              }
            </View>
          </View>

          {/* Task 1746: the account's state in words, from the server's onboarding
              document. Status only: nothing here is tappable (task 1400). */}
          {accountDocument ? (
            <View style={layout.section} testID="storage-account-status">
              <SectionHeader title="Account status" c={c} />
              <AccountStatusCard doc={accountDocument} />
            </View>
          ) : null}

          {/* Account */}
          <View style={layout.section}>
            <SectionHeader title="Account" c={c} />
            <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
              <AccountCard chip={chip} c={c} />
            </View>
            {/* Task 1605 / 1821: the trial storage cap, as a fact. No action, no hint of one. */}
            {trialCapMessage && (
              <Text
                style={[layout.noteText, { color: c.amberDeep }]}
                testID="storage-trial-cap-note"
              >
                {trialCapMessage}
              </Text>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
