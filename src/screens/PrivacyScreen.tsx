/**
 * Privacy settings screen — spec 025 mobile parity.
 *
 * Sections:
 *   1. Activity tracking toggle (GET/PUT /api/v1/me/tracking)
 *   2. Download my data (POST /api/v1/me/data-export + status poll)
 *   3. Freeze account (POST /api/v1/me/freeze / /me/unfreeze)
 *   4. Delete account (directs to web)
 *   5. Your rights (static + privacy policy link)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { fonts, spacing, type Colors } from '../theme';
import { NativeSwitch } from '../components/NativeSwitch';
import {
  getTrackingPreference,
  setTrackingPreference,
  requestDataExport,
  getDataExportStatus,
  freezeAccount,
  unfreezeAccount,
  type DataExportStatus,
} from '../lib/api';

type C = Colors;

// ── Layout styles ─────────────────────────────────────────────────────────────

const layout = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingBottom: 48 },
  section: { marginBottom: 14 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12 },
  divider: { height: 1, marginLeft: 12 },
  noteText: { fontSize: 11, paddingHorizontal: 6, marginTop: 6, lineHeight: 16 },
  sectionHeader: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    marginBottom: 6,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
});

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, c }: { title: string; c: C }) {
  return <Text style={[layout.sectionHeader, { color: c.ink3 }]}>{title}</Text>;
}

function Divider({ c }: { c: C }) {
  return <View style={[layout.divider, { backgroundColor: c.line }]} />;
}

function SectionNote({ text, c }: { text: string; c: C }) {
  return <Text style={[layout.noteText, { color: c.ink3 }]}>{text}</Text>;
}

// A row with a right-side chevron (navigation row or action)
function ActionRow({
  label,
  subtitle,
  icon,
  danger,
  disabled,
  onPress,
  c,
}: {
  label: string;
  subtitle?: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
  c: C;
}) {
  return (
    <TouchableOpacity
      style={layout.row}
      activeOpacity={0.6}
      disabled={disabled}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons
        name={icon}
        size={18}
        color={danger ? c.red : c.ink3}
        style={{ marginRight: 12, width: 20 }}
      />
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={{ fontSize: 14, color: danger ? c.red : c.ink }}>{label}</Text>
        {subtitle != null && (
          <Text style={{ fontSize: 11, color: c.ink3, marginTop: 2, lineHeight: 15 }}>
            {subtitle}
          </Text>
        )}
      </View>
      {disabled ? (
        <ActivityIndicator size="small" color={c.amber} />
      ) : (
        <Text style={{ fontSize: 18, color: c.ink4 }}>{'›'}</Text>
      )}
    </TouchableOpacity>
  );
}

// ── Section 1: Activity tracking ─────────────────────────────────────────────

function ActivityTrackingRow({ c }: { c: C }) {
  const [optedIn, setOptedIn] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTrackingPreference()
      .then(p => setOptedIn(p.tracking_opted_in))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = useCallback(async (value: boolean) => {
    if (!value) {
      // Confirm before disabling — data will be deleted
      Alert.alert(
        'Disable activity tracking?',
        'This will delete all your activity data within 30 days. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disable',
            style: 'destructive',
            onPress: async () => {
              try {
                const res = await setTrackingPreference(false);
                setOptedIn(res.tracking_opted_in);
              } catch { /* ignore */ }
            },
          },
        ],
      );
    } else {
      try {
        const res = await setTrackingPreference(true);
        setOptedIn(res.tracking_opted_in);
      } catch { /* ignore */ }
    }
  }, []);

  return (
    <View style={layout.row}>
      <Ionicons
        name="eye-outline"
        size={18}
        color={c.ink3}
        style={{ marginRight: 12, width: 20 }}
      />
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={{ fontSize: 14, color: c.ink }}>Activity tracking</Text>
        <Text style={{ fontSize: 11, color: c.ink3, marginTop: 2, lineHeight: 15 }}>
          Log sign-ins and file activity for security
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={c.amber} />
      ) : (
        <NativeSwitch
          value={optedIn}
          onValueChange={handleToggle}
          colors={c}
        />
      )}
    </View>
  );
}

// ── Section 2: Data export ────────────────────────────────────────────────────

function DataExportRow({ c }: { c: C }) {
  const [exportStatus, setExportStatus] = useState<DataExportStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const startPoll = useCallback((exportId: string) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const s = await getDataExportStatus(exportId);
        setExportStatus(s);
        if (s.status === 'ready' || s.status === 'failed') stopPoll();
      } catch { stopPoll(); }
    }, 5000);
  }, [stopPoll]);

  const handleRequest = useCallback(async () => {
    setRequesting(true);
    try {
      const res = await requestDataExport();
      setExportStatus({ export_id: res.export_id, status: res.status });
      if (res.status !== 'ready' && res.status !== 'failed') {
        startPoll(res.export_id);
      }
    } catch (err) {
      Alert.alert(
        'Export unavailable',
        'Data export is not yet available. Contact privacy@beebeeb.io.',
      );
    } finally {
      setRequesting(false);
    }
  }, [startPoll]);

  const handleDownload = useCallback(() => {
    if (exportStatus?.download_url) {
      Linking.openURL(exportStatus.download_url).catch(() => {});
    }
  }, [exportStatus]);

  const status = exportStatus?.status;
  const isPolling = (status === 'pending' || status === 'processing') && !requesting;

  return (
    <View>
      <ActionRow
        label="Download my data"
        subtitle={
          status === 'ready'
            ? 'Your export is ready — tap to download'
            : status === 'failed'
              ? 'Export failed — tap to retry'
              : isPolling
                ? 'Building your export...'
                : 'Files are exported encrypted'
        }
        icon="cloud-download-outline"
        disabled={requesting || isPolling}
        onPress={status === 'ready' ? handleDownload : handleRequest}
        c={c}
      />
      {(requesting || isPolling) && (
        <View style={{ paddingHorizontal: 44, paddingBottom: 10 }}>
          <ActivityIndicator size="small" color={c.amber} />
        </View>
      )}
    </View>
  );
}

// ── Section 3: Freeze account ─────────────────────────────────────────────────

function FreezeRow({ c }: { c: C }) {
  const [frozen, setFrozen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleFreeze = useCallback(() => {
    Alert.alert(
      'Freeze account?',
      'All file operations will be suspended until you unfreeze. Your data stays stored.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Freeze',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              const res = await freezeAccount();
              setFrozen(res.frozen);
            } catch {
              Alert.alert('Error', 'Could not freeze account. Try again.');
            } finally { setLoading(false); }
          },
        },
      ],
    );
  }, []);

  const handleUnfreeze = useCallback(async () => {
    setLoading(true);
    try {
      const res = await unfreezeAccount();
      setFrozen(res.frozen);
    } catch {
      Alert.alert('Error', 'Could not unfreeze account. Try again.');
    } finally { setLoading(false); }
  }, []);

  return (
    <ActionRow
      label={frozen ? 'Unfreeze account' : 'Freeze my account'}
      subtitle="Temporarily suspends all file operations"
      icon={frozen ? 'lock-open-outline' : 'lock-closed-outline'}
      danger={!frozen}
      disabled={loading}
      onPress={frozen ? handleUnfreeze : handleFreeze}
      c={c}
    />
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function PrivacyScreen() {
  const { colors: c } = useTheme();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View style={[layout.root, { backgroundColor: c.paper }]}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + (Platform.OS === 'android' ? 8 : 4),
          paddingHorizontal: 14,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          backgroundColor: c.paper,
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
          Privacy
        </Text>
      </View>

      <ScrollView
        style={layout.scroll}
        contentContainerStyle={[
          layout.scrollContent,
          { paddingTop: spacing.md, paddingBottom: insets.bottom + 40 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── 1. Activity tracking ── */}
        <View style={layout.section}>
          <SectionHeader title="Activity tracking" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <ActivityTrackingRow c={c} />
          </View>
          <SectionNote
            text="When enabled: sign-ins and file actions are logged for security. Disabling deletes all data within 30 days. GDPR Article 17."
            c={c}
          />
        </View>

        {/* ── 2. Data export ── */}
        <View style={layout.section}>
          <SectionHeader title="Your data" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <DataExportRow c={c} />
          </View>
          <SectionNote
            text="Files are exported encrypted. Use your recovery phrase to decrypt them. One export per day. GDPR Article 15."
            c={c}
          />
        </View>

        {/* ── 3. Freeze account ── */}
        <View style={layout.section}>
          <SectionHeader title="Restrict processing" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <FreezeRow c={c} />
          </View>
          <SectionNote text="GDPR Article 18." c={c} />
        </View>

        {/* ── 4. Delete account ── */}
        <View style={layout.section}>
          <SectionHeader title="Delete account" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <ActionRow
              label="Delete my account"
              subtitle="Permanent — all data destroyed"
              icon="trash-outline"
              danger
              onPress={() => {
                Alert.alert(
                  'Delete on web',
                  'For security, account deletion must be done on the web app. Visit app.beebeeb.io/settings/account.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Open web app',
                      onPress: () => Linking.openURL('https://app.beebeeb.io/settings/account').catch(() => {}),
                    },
                  ],
                );
              }}
              c={c}
            />
          </View>
          <SectionNote
            text="Permanently destroys your encryption keys. We cannot recover your data — we do not have your keys. GDPR Article 17."
            c={c}
          />
        </View>

        {/* ── 5. Your rights ── */}
        <View style={layout.section}>
          <SectionHeader title="Your rights" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <View style={{ padding: 14, gap: 10 }}>
              <Text style={{ fontSize: 13, color: c.ink2, lineHeight: 20 }}>
                You can access, export, or delete your data at any time. We do not use your data for marketing or automated decisions.
              </Text>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://beebeeb.io/privacy').catch(() => {})}
                accessibilityRole="link"
                accessibilityLabel="Privacy policy"
              >
                <Text style={{ fontSize: 13, color: c.amber }}>
                  Read our full privacy policy {'›'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          <SectionNote
            text="Questions? privacy@beebeeb.io — we respond within 72 hours. Operated by Initlabs B.V., Wijchen, Netherlands."
            c={c}
          />
        </View>
      </ScrollView>
    </View>
  );
}
