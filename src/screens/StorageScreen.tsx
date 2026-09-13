/**
 * Storage & Plan screen — usage breakdown + read-only plan facts.
 *
 * No purchase or subscription-management call to action lives on this screen
 * (task 1400, App Review 3.1.1(a)): the app has no In-App Purchase product
 * configured, and a button/link to an external purchasing mechanism is not
 * allowed on most storefronts. Plan/price/storage facts are shown as
 * information only, with one line of non-tappable copy telling the user
 * plans are managed from their account on the web — no URL is rendered.
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
  getPlans,
  type StorageUsage,
  type Subscription,
  type Plan,
} from '../lib/api';
import { loadCachedBilling, saveCachedBilling } from '../lib/billing-cache';

type C = Colors;

// ── Helpers ───────────────────────────────────────────────────────────────────


function planLabel(slug: string): string {
  // Server is migrating personal -> basic and data_hoarder -> business; the
  // legacy keys map to the new labels so a live response carrying an old slug
  // still renders correctly.
  const map: Record<string, string> = {
    free: 'Free',
    basic: 'Basic', personal: 'Basic',
    pro: 'Pro',
    business: 'Business', data_hoarder: 'Business',
    team: 'Team',
  };
  return map[slug.toLowerCase()] ?? slug;
}

/**
 * Derive the storage-usage view-model from the subscription payload. The
 * `/billing/subscription` response already embeds `used_bytes` + `quota_bytes`
 * (server `billing.rs` sources both from the same `get_user_quota` that backs
 * `/files/usage`), so this screen no longer needs the separate
 * `getStorageUsage()` round-trip. `plan_name` maps to `subscription.plan` (both
 * are the plan slug). `quota_bytes <= 0` is the unlimited sentinel — preserved
 * here so `StorageUsageCard` renders "no fixed cap" exactly as before.
 */
function usageFromSubscription(sub: Subscription | null): StorageUsage | null {
  if (!sub || sub.used_bytes == null || sub.quota_bytes == null) return null;
  return {
    used_bytes: sub.used_bytes,
    plan_limit_bytes: sub.quota_bytes,
    plan_name: sub.plan,
  };
}

/** Plans shown as upgrade options — active, excluding free (matches prior filter). */
function visiblePlans(all: Plan[]): Plan[] {
  return all.filter((pl) => pl.is_active !== false && pl.id !== 'free');
}

/**
 * Non-interactive copy shown in place of every removed purchase/manage
 * button (task 1400) — the Kindle/Netflix pattern: informational text that
 * names no URL and is not a call to action, so it sits outside App Review
 * guideline 3.1.1(a).
 */
const PLAN_MANAGEMENT_NOTE = 'Plans are managed from your account on the web.';

/**
 * Task 1400 follow-up (lead review on PR #80): a full price list sitting
 * directly under PLAN_MANAGEMENT_NOTE still reads as a call to action to buy
 * elsewhere, even with no button attached — a reviewer can read "here are the
 * prices" + "managed on the web" as directions to a purchase mechanism
 * (3.1.1(a)). For the first submission, hide the plan catalog entirely and
 * show only Storage usage + Current plan + the one sentence. Flip this back
 * to `true` in one place once the EU External Purchase Link entitlement (or
 * real IAP) makes showing prices safe again — no other code changes needed.
 */
const SHOW_PLAN_CATALOG = false;

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
  usage, c,
}: { usage: StorageUsage; c: C }) {
  // plan_limit_bytes <= 0 is the "no fixed cap" sentinel (e.g. enterprise);
  // never render it as a byte value ("-1 B") and don't show a denominator/%.
  const hasCap = usage.plan_limit_bytes > 0;
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
              : `${Math.round(pct * 100)}% used — consider upgrading`}
          </Text>
        </View>
      )}

      {/* Plan label */}
      <Text style={{ fontSize: 11, color: c.ink3 }}>
        {planLabel(usage.plan_name)} plan{hasCap ? ` · ${formatBytes(usage.plan_limit_bytes)} total` : ''}
      </Text>
    </View>
  );
}

// ── Current plan card ─────────────────────────────────────────────────────────

function CurrentPlanCard({
  subscription, usage, c,
}: {
  subscription: Subscription | null;
  usage: StorageUsage | null;
  c: C;
}) {
  const planSlug = subscription?.plan ?? usage?.plan_name ?? 'free';
  const isFree = planSlug.toLowerCase() === 'free';
  const label = planLabel(planSlug);
  const renewalDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : null;

  return (
    <View style={{ padding: 14, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{
          backgroundColor: c.amberBg, borderColor: c.amber, borderWidth: 1,
          paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5,
        }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.amberDeep, letterSpacing: 0.3 }}>
            {label.toUpperCase()}
          </Text>
        </View>
        {renewalDate && !isFree && (
          <Text style={{ fontSize: 11, color: c.ink3 }}>Renews {renewalDate}</Text>
        )}
      </View>

      {/* No "Manage subscription" call to action here (task 1400) — informational
          plan facts only. See PLAN_MANAGEMENT_NOTE below the card. */}
    </View>
  );
}

// ── Plan info card (read-only — no purchase CTA, task 1400) ───────────────────

function PlanCard({
  plan, currentPlanSlug, c,
}: {
  plan: Plan;
  currentPlanSlug: string;
  c: C;
}) {
  const isCurrent = plan.id === currentPlanSlug;

  return (
    <View style={{
      borderWidth: 1,
      borderColor: isCurrent ? c.amber : c.line,
      borderRadius: 10,
      backgroundColor: isCurrent ? c.amberBg : c.paper,
      padding: 14,
      gap: 8,
    }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: c.ink }}>{plan.name}</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.ink, fontVariant: ['tabular-nums'] }}>
            {plan.price_eur === 0 ? 'Free' : `€${plan.price_eur.toFixed(2)}/mo`}
          </Text>
          {plan.price_yearly_eur > 0 && (
            <Text style={{ fontSize: 10, color: c.ink3, fontVariant: ['tabular-nums'] }}>
              €{plan.price_yearly_eur.toFixed(2)}/yr
            </Text>
          )}
        </View>
      </View>

      {/* Storage label */}
      <Text style={{ fontSize: 13, color: c.ink2 }}>{plan.storage_label}</Text>

      {/* Top feature */}
      {plan.features[0] && (
        <Text style={{ fontSize: 11, color: c.ink3, lineHeight: 15 }} numberOfLines={2}>
          {plan.features[0]}
        </Text>
      )}

      {/* No upgrade/purchase call to action here (task 1400) — plan facts only. */}

      {isCurrent && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Ionicons name="checkmark-circle" size={14} color={c.amber} />
          <Text style={{ fontSize: 12, color: c.amberDeep, fontWeight: '600' }}>Current plan</Text>
        </View>
      )}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function StorageScreen() {
  const { colors: c } = useTheme();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // 1315 — measured floating-header height feeding the scroll inset.
  const [headerHeight, setHeaderHeight] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  // Storage usage is derived from the subscription payload (used_bytes +
  // quota_bytes are embedded there), so there is no separate usage round-trip.
  const usage = usageFromSubscription(subscription);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. Instant paint: render last-known billing values from cache so a warm
      //    open shows content immediately instead of a spinner. (Briefly stale —
      //    confirmed by the network refresh below.)
      const cached = await loadCachedBilling();
      if (cancelled) return;
      if (cached) {
        setSubscription(cached.subscription);
        setPlans(visiblePlans(cached.plans));
        setLoading(false);
      }

      // 2. Revalidate in the background. Billing + plans now sit in their own
      //    zero-spacing rate-limit bucket, so these two run in parallel.
      const [sub, freshPlans] = await Promise.all([
        getSubscription().catch(() => null),
        getPlans().catch(() => [] as Plan[]),
      ]);
      if (cancelled) return;

      if (sub) setSubscription(sub);
      if (freshPlans.length > 0) setPlans(visiblePlans(freshPlans));

      // 3. Re-persist the freshest known-good snapshot. Don't clobber a good
      //    warm cache with an all-empty error result (sub null + no plans).
      if (sub || freshPlans.length > 0) {
        void saveCachedBilling(
          sub ?? cached?.subscription ?? null,
          freshPlans.length > 0 ? freshPlans : cached?.plans ?? [],
        );
      }

      // Cold first-ever open (no cache) ends its spinner here.
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, []);

  const currentPlanSlug = subscription?.plan ?? usage?.plan_name ?? 'free';
  const isFree = currentPlanSlug.toLowerCase() === 'free';
  // Task 1400: no purchase/manage call to action lives in this screen — see
  // the file header comment and PLAN_MANAGEMENT_NOTE.

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
          Storage & Plan
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
                ? <StorageUsageCard usage={usage} c={c} />
                : <Text style={{ padding: 14, fontSize: 13, color: c.ink3 }}>Could not load storage info</Text>
              }
            </View>
          </View>

          {/* Current plan */}
          <View style={layout.section}>
            <SectionHeader title="Current plan" c={c} />
            <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
              <CurrentPlanCard
                subscription={subscription}
                usage={usage}
                c={c}
              />
            </View>
            <Text
              style={[layout.noteText, { color: c.ink3 }]}
              testID="storage-plan-management-note"
            >
              {PLAN_MANAGEMENT_NOTE}
            </Text>
          </View>

          {/* Available plans — informational only, shown for free users or when
              plans are available. No purchase/upgrade call to action (task 1400).
              Gated off entirely behind SHOW_PLAN_CATALOG for the first submission
              (lead review on PR #80): a price list directly under
              PLAN_MANAGEMENT_NOTE still reads as directions to buy elsewhere. */}
          {SHOW_PLAN_CATALOG && plans.length > 0 && (
            <View style={layout.section}>
              <SectionHeader title={isFree ? 'Plans' : 'Available plans'} c={c} />
              <View style={{ gap: 8 }}>
                {plans.map(plan => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    currentPlanSlug={currentPlanSlug}
                    c={c}
                  />
                ))}
              </View>
              <Text style={[layout.noteText, { color: c.ink3, marginTop: 8 }]}>
                Prices in EUR. Annual billing includes a discount.
              </Text>
            </View>
          )}

          {/* Note when no plans loaded — informational text, not a call to action.
              Also gated: with the catalog hidden, PLAN_MANAGEMENT_NOTE already
              shown once under Current plan is enough; a second copy here would
              be a redundant duplicate. */}
          {SHOW_PLAN_CATALOG && plans.length === 0 && isFree && (
            <View style={layout.section}>
              <Text style={[layout.noteText, { color: c.ink3 }]}>
                {PLAN_MANAGEMENT_NOTE}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}
