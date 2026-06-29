/**
 * Storage & Plan screen — usage breakdown + plan upgrade.
 * Opens Stripe URLs in the system browser (not in-app — App Store policy).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { spacing, type Colors } from '../theme';
import { formatBytes } from '../lib/format';
import {
  getStorageUsage,
  getSubscription,
  getPlans,
  createCheckoutSession,
  createPortalSession,
  ApiError,
  type StorageUsage,
  type Subscription,
  type Plan,
} from '../lib/api';

type C = Colors;
type BillingCycle = 'monthly' | 'yearly';

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

const UPGRADE_CHAIN: Record<string, string> = {
  free: 'basic',
  basic: 'pro',
  pro: 'business',
  // Legacy slug aliases.
  personal: 'pro',
  data_hoarder: 'business',
};

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
  subscription, usage, onManage, managing, c,
}: {
  subscription: Subscription | null;
  usage: StorageUsage | null;
  onManage: () => void;
  managing: boolean;
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

      {!isFree && (
        <TouchableOpacity
          activeOpacity={0.7}
          disabled={managing}
          onPress={() => { Haptics.selectionAsync(); onManage(); }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.paper2,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: c.line,
            paddingVertical: 9,
            gap: 6,
          }}
          accessibilityRole="button"
          accessibilityLabel="Manage subscription"
        >
          {managing
            ? <ActivityIndicator size="small" color={c.amber} />
            : <>
                <Ionicons name="card-outline" size={15} color={c.ink3} />
                <Text style={{ fontSize: 13, fontWeight: '500', color: c.ink }}>
                  Manage subscription
                </Text>
              </>
          }
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Plan upgrade card ─────────────────────────────────────────────────────────

function PlanCard({
  plan, currentPlanSlug, onUpgrade, upgrading, billingUnavailable, c,
}: {
  plan: Plan;
  currentPlanSlug: string;
  onUpgrade: (planId: string, billingCycle: BillingCycle) => void;
  upgrading: string | null;
  billingUnavailable: boolean;
  c: C;
}) {
  const isCurrent = plan.id === currentPlanSlug;
  const monthlyKey = `${plan.id}:monthly`;
  const yearlyKey = `${plan.id}:yearly`;
  const hasYearly = plan.price_yearly_eur > 0;

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

      {/* Upgrade buttons */}
      {!isCurrent && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 2 }}>
          <TouchableOpacity
            activeOpacity={0.8}
            disabled={!!upgrading || billingUnavailable}
            onPress={() => { Haptics.selectionAsync(); onUpgrade(plan.id, 'monthly'); }}
            style={{
              flex: 1,
              backgroundColor: c.paper2,
              borderColor: c.line,
              borderWidth: 1,
              borderRadius: 8,
              paddingVertical: 9,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: 6,
            }}
            accessibilityRole="button"
            accessibilityLabel={`Upgrade to ${plan.name} monthly`}
            accessibilityState={{ disabled: !!upgrading || billingUnavailable }}
          >
            {upgrading === monthlyKey
              ? <ActivityIndicator size="small" color={c.amber} />
              : <Text style={{ fontSize: 13, fontWeight: '700', color: billingUnavailable ? c.ink3 : c.ink }}>Monthly</Text>
            }
          </TouchableOpacity>
          {hasYearly && (
            <TouchableOpacity
              activeOpacity={0.8}
              disabled={!!upgrading || billingUnavailable}
              onPress={() => { Haptics.selectionAsync(); onUpgrade(plan.id, 'yearly'); }}
              style={{
                flex: 1,
                backgroundColor: billingUnavailable ? c.paper2 : c.amber,
                borderColor: billingUnavailable ? c.line : c.amber,
                borderWidth: billingUnavailable ? 1 : 0,
                borderRadius: 8,
                paddingVertical: 9,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                gap: 6,
              }}
              accessibilityRole="button"
              accessibilityLabel={`Upgrade to ${plan.name} yearly`}
              accessibilityState={{ disabled: !!upgrading || billingUnavailable }}
            >
              {upgrading === yearlyKey
                ? <ActivityIndicator size="small" color={c.ink} />
                : <>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: billingUnavailable ? c.ink3 : c.ink }}>Yearly</Text>
                    <Ionicons name="chevron-forward" size={14} color={billingUnavailable ? c.ink3 : c.ink} />
                  </>
              }
            </TouchableOpacity>
          )}
        </View>
      )}

      {!isCurrent && billingUnavailable && (
        <Text style={{ fontSize: 11, color: c.ink3, lineHeight: 15 }}>
          Plan changes are not available in this app environment. Use the web app for billing changes.
        </Text>
      )}

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

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getStorageUsage().catch(() => null),
      getSubscription().catch(() => null),
      getPlans().catch(() => []),
    ]).then(([u, sub, p]) => {
      if (cancelled) return;
      if (u) setUsage(u);
      if (sub) setSubscription(sub);
      // Show plans excluding free + already above current
      setPlans(p.filter(pl => pl.is_active !== false && pl.id !== 'free'));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const currentPlanSlug = subscription?.plan ?? usage?.plan_name ?? 'free';
  const isFree = currentPlanSlug.toLowerCase() === 'free';
  const billingUnavailable = subscription?.stripe_configured === false;

  // Upgrade: open Stripe Checkout in system browser
  const handleUpgrade = useCallback(async (planId: string, billingCycle: BillingCycle) => {
    setUpgrading(`${planId}:${billingCycle}`);
    try {
      const { url } = await createCheckoutSession({
        plan: planId,
        billing_cycle: billingCycle,
        seats: 1,
      });
      await Linking.openURL(url);
    } catch (err) {
      const setupUnavailable =
        err instanceof ApiError &&
        (err.message.toLowerCase().includes('stripe not configured') ||
          err.message.toLowerCase().includes('no live price'));
      Alert.alert(
        setupUnavailable ? 'Billing changes unavailable' : 'Could not start checkout',
        setupUnavailable
          ? 'Your current storage and plan are shown here. Billing changes are handled on the web while payment setup is unavailable in this environment.'
          : 'We could not start checkout from the app. Open the web app to manage billing.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open web app', onPress: () => Linking.openURL('https://app.beebeeb.io/settings/billing').catch(() => {}) },
        ],
      );
    } finally {
      setUpgrading(null);
    }
  }, []);

  // Manage: open Stripe Customer Portal
  const handleManage = useCallback(async () => {
    setManaging(true);
    try {
      const result = await createPortalSession();
      if (result?.url) {
        await Linking.openURL(result.url);
      } else {
        Linking.openURL('https://app.beebeeb.io/settings/billing').catch(() => {});
      }
    } catch {
      Linking.openURL('https://app.beebeeb.io/settings/billing').catch(() => {});
    } finally {
      setManaging(false);
    }
  }, []);

  return (
    <View style={[layout.root, { backgroundColor: c.paper }]}>
      {/* Header */}
      <View style={{
        paddingTop: insets.top + (Platform.OS === 'android' ? 8 : 4),
        paddingHorizontal: 14,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: c.line,
        backgroundColor: c.paper,
      }}>
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
            { paddingTop: spacing.md, paddingBottom: insets.bottom + 40 },
          ]}
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
                onManage={handleManage}
                managing={managing}
                c={c}
              />
            </View>
          </View>

          {/* Upgrade options — shown for free users or when plans are available */}
          {plans.length > 0 && (
            <View style={layout.section}>
              <SectionHeader title={isFree ? 'Upgrade your plan' : 'Available plans'} c={c} />
              <View style={{ gap: 8 }}>
                {plans.map(plan => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    currentPlanSlug={currentPlanSlug}
                    onUpgrade={handleUpgrade}
                    upgrading={upgrading}
                    billingUnavailable={billingUnavailable}
                    c={c}
                  />
                ))}
              </View>
              <Text style={[layout.noteText, { color: c.ink3, marginTop: 8 }]}>
                {billingUnavailable
                  ? 'Prices in EUR. Billing changes are available on the web while payment setup is unavailable here.'
                  : 'Prices in EUR. Annual billing includes a discount. You will be redirected to Stripe Checkout in your browser.'}
              </Text>
            </View>
          )}

          {/* Note when no plans loaded */}
          {plans.length === 0 && isFree && (
            <View style={layout.section}>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => Linking.openURL('https://beebeeb.io/pricing').catch(() => {})}
                style={{
                  backgroundColor: c.amber,
                  borderRadius: 10,
                  padding: 14,
                  alignItems: 'center',
                  gap: 4,
                }}
                accessibilityRole="link"
              >
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.ink }}>View plans</Text>
                <Text style={{ fontSize: 12, color: c.ink, opacity: 0.75 }}>
                  Basic · Pro · Business
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}
