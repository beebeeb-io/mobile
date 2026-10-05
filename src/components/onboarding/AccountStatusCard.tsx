/**
 * The account status as text (task 1746, spec 4.5, 4b.7, 5.4 B, D, E): headline,
 * the server's sentences, usage against the allowance, what the account may do.
 *
 * STATUS ONLY, by construction: nothing in this file is tappable. No button, no
 * link, no price, no plan to buy (App Store 3.1.3, task 1400). The one sentence
 * about plans is the server's "Plans are managed from your account on the web.",
 * rendered as plain text. Asserted for every account fixture in
 * `src/lib/onboarding/account-summary.test.ts` and by the Maestro rung that checks
 * the allowance, trial and trial-ended screens for tappable purchase elements.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fonts, radii, spacing } from '../../theme';
import { useTheme } from '../../lib/theme-context';
import { formatSize, summarizeAccount, type AccountSummary } from '../../lib/onboarding/account-summary';
import type { OnboardingDocument } from '../../lib/onboarding/types';

export function AccountStatusCard({ doc }: { doc: OnboardingDocument }) {
  const { colors: c } = useTheme();
  const summary: AccountSummary | null = useMemo(() => {
    try {
      return summarizeAccount(doc);
    } catch {
      return null;
    }
  }, [doc]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: { borderWidth: 1, borderColor: c.line, borderRadius: radii.lg, backgroundColor: c.paper, padding: spacing.lg, gap: spacing.sm },
        attention: { borderColor: c.amber, backgroundColor: c.amberBg },
        restricted: { backgroundColor: c.paper2 },
        headline: { fontSize: 16, fontWeight: '700', color: c.ink },
        line: { fontSize: 13, color: c.ink2, lineHeight: 19 },
        barTrack: { height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden' },
        barFill: { height: 6, borderRadius: 3, backgroundColor: c.amber },
        usageRow: { flexDirection: 'row', justifyContent: 'space-between' },
        mono: { fontSize: 11, color: c.ink3, fontFamily: fonts.mono },
        note: { fontSize: 12, color: c.ink3, lineHeight: 17 },
        rows: { borderTopWidth: 1, borderTopColor: c.line, marginTop: spacing.xs, paddingTop: spacing.sm, gap: 6 },
        row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
        rowLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
        rowLabelText: { fontSize: 13, color: c.ink },
        rowDetail: { fontSize: 12, color: c.ink3 },
      }),
    [c],
  );
  if (!summary) return null;

  return (
    <View
      style={[styles.card, summary.tone === 'attention' && styles.attention, summary.tone === 'restricted' && styles.restricted]}
      testID="account-status-card"
      accessible={false}
    >
      <Text style={styles.headline} accessibilityRole="header" testID="account-status-headline">
        {summary.headline}
      </Text>
      {summary.lines.map((l, i) => (
        <Text key={i} style={styles.line} testID="account-status-line">
          {l}
        </Text>
      ))}
      {summary.usage ? (
        <View testID="account-status-usage">
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.round(summary.usage.fraction * 100)}%` }]} />
          </View>
          <View style={[styles.usageRow, { marginTop: 4 }]}>
            <Text style={styles.mono}>{formatSize(summary.usage.usedBytes)} used</Text>
            <Text style={styles.mono}>of {formatSize(summary.usage.quotaBytes)}</Text>
          </View>
          {summary.usage.overAllowanceNote ? <Text style={[styles.note, { marginTop: 4 }]}>{summary.usage.overAllowanceNote}</Text> : null}
        </View>
      ) : null}
      <View style={styles.rows} testID="account-status-capabilities">
        {summary.rows.map((r) => (
          <View key={r.name} style={styles.row}>
            <View style={styles.rowLabel}>
              <Ionicons name={r.allowed ? 'checkmark-circle-outline' : 'lock-closed-outline'} size={15} color={r.allowed ? c.amberDeep : c.ink4} />
              <Text style={styles.rowLabelText}>{r.label}</Text>
            </View>
            <Text style={styles.rowDetail}>{r.detail}</Text>
          </View>
        ))}
      </View>
      {summary.plansManagedNote ? (
        <Text style={styles.note} testID="account-status-plans-note">
          {summary.plansManagedNote}
        </Text>
      ) : null}
    </View>
  );
}
