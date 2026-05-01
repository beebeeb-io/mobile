import React, { useCallback, useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as StoreReview from 'expo-store-review';
import * as Notifications from 'expo-notifications';
import * as MediaLibrary from 'expo-media-library';
import * as Contacts from 'expo-contacts';
import * as Calendar from 'expo-calendar';
import Constants from 'expo-constants';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing, type Colors } from '../theme';
import { useAuth } from '../lib/auth';
import { useBackup } from '../lib/backup-context';
import { useTheme, type ThemeMode } from '../lib/theme-context';
import {
  getStorageUsage,
  getPreference,
  setPreference,
  getSubscription,
  getRegion,
  type StorageUsage,
  type Subscription,
  type Region,
} from '../lib/api';
import type { RootStackParamList } from '../App';

const BIOMETRIC_PREF_KEY = 'beebeeb_biometric_lock';
const BIOMETRIC_DELAY_KEY = 'beebeeb_biometric_delay';

interface BiometricDelayOption {
  label: string;
  ms: number;
}
const BIOMETRIC_DELAY_OPTIONS: BiometricDelayOption[] = [
  { label: 'Immediately', ms: 0 },
  { label: '30 seconds', ms: 30_000 },
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
];

function biometricDelayLabel(ms: number): string {
  return BIOMETRIC_DELAY_OPTIONS.find((o) => o.ms === ms)?.label ?? 'Immediately';
}

type RegionMode = 'preference' | 'force';
type C = Colors;

// ---------------------------------------------------------------------------
// Data residency regions
// ---------------------------------------------------------------------------

const REGIONS: ReadonlyArray<{ poolName: string; label: string; subtitle: string; flag: string; available: boolean }> = [
  { poolName: 'europe', label: 'Europe', subtitle: 'Auto-distribute', flag: '\u{1F6E1}️', available: true },
  { poolName: 'falkenstein-de', label: 'Falkenstein, DE', subtitle: 'Hetzner', flag: '\u{1F1E9}\u{1F1EA}', available: true },
  { poolName: 'helsinki-fin', label: 'Helsinki, FIN', subtitle: 'Hetzner', flag: '\u{1F1EB}\u{1F1EE}', available: true },
  { poolName: 'ede-nl', label: 'Ede, NL', subtitle: 'Beebeeb', flag: '\u{1F1F3}\u{1F1F1}', available: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number, gbDecimals = 0): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(gbDecimals)} GB`;
  return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function userInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function planLabel(name: string): string {
  const map: Record<string, string> = {
    free: 'Free',
    personal: 'Personal',
    team: 'Team',
    business: 'Business',
  };
  return map[name.toLowerCase()] ?? name;
}

// ---------------------------------------------------------------------------
// Static layout styles (no colors — shared regardless of theme)
// ---------------------------------------------------------------------------

const layout = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingBottom: 40 },
  section: { marginBottom: 14 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  loadingRow: { paddingVertical: 18, alignItems: 'center' },
  storageRow: { paddingVertical: 12, paddingHorizontal: 12 },
  accountRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, gap: 10 },
  accountInfo: { flex: 1, minWidth: 0 },
  avatarCircle: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  backupNote: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  themeOptions: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  themeOption: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  regionOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12, gap: 10 },
  regionRadio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  regionRadioDot: { width: 8, height: 8, borderRadius: 4 },
  regionInfo: { flex: 1 },
  footer: { alignItems: 'center', paddingVertical: 16, gap: 2 },
});

// ---------------------------------------------------------------------------
// Sub-components — each accepts `c` (the effective colors object)
// ---------------------------------------------------------------------------

function SectionHeader({ title, c }: { title: string; c: C }) {
  return (
    <Text style={{
      fontSize: 10, fontWeight: '600' as const, color: c.ink3,
      textTransform: 'uppercase' as const, letterSpacing: 0.5,
      paddingHorizontal: 6, marginBottom: 6,
    }}>
      {title}
    </Text>
  );
}

function SectionNote({ text, c }: { text: string; c: C }) {
  return (
    <Text style={{ fontSize: 11, color: c.ink3, paddingHorizontal: 6, marginTop: 6, lineHeight: 16 }}>
      {text}
    </Text>
  );
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function SettingsRow({
  label, value, onPress, danger, showChevron = true, icon, c,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  showChevron?: boolean;
  icon?: IoniconName;
  c: C;
}) {
  const handlePress = onPress
    ? () => {
        Haptics.selectionAsync();
        onPress();
      }
    : undefined;

  return (
    <TouchableOpacity
      style={layout.row}
      activeOpacity={onPress ? 0.6 : 1}
      onPress={handlePress}
      disabled={!onPress}
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityRole={onPress ? 'button' : 'text'}
    >
      {icon && (
        <Ionicons
          name={icon}
          size={18}
          color={danger ? c.red : c.ink3}
          style={{ marginRight: 12, width: 20 }}
        />
      )}
      <Text style={{ flex: 1, fontSize: 14, fontWeight: '400' as const, color: danger ? c.red : c.ink }}>
        {label}
      </Text>
      <View style={layout.rowRight}>
        {value != null && <Text style={{ fontSize: 13, color: c.ink3 }}>{value}</Text>}
        {showChevron && !danger && <Text style={{ fontSize: 18, color: c.ink4, marginLeft: 2 }}>{'›'}</Text>}
      </View>
    </TouchableOpacity>
  );
}

function ToggleRow({
  label, subtitle, value, onValueChange, disabled, indent, c,
}: {
  label: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  indent?: boolean;
  c: C;
}) {
  return (
    <View style={[layout.row, indent && { paddingLeft: 28 }]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={{ fontSize: 14, fontWeight: '400' as const, color: c.ink }}>{label}</Text>
        {subtitle && (
          <Text style={{ fontSize: 11, color: c.ink3, marginTop: 2, lineHeight: 15 }}>
            {subtitle}
          </Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={(v) => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onValueChange(v);
        }}
        disabled={disabled}
        trackColor={{ false: c.line, true: c.amber }}
        thumbColor={c.paper}
        ios_backgroundColor={c.line}
      />
    </View>
  );
}

function RowDivider({ c }: { c: C }) {
  return <View style={{ height: 1, backgroundColor: c.line, marginLeft: 12 }} />;
}

// ---------------------------------------------------------------------------
// Storage bar
// ---------------------------------------------------------------------------

function StorageBar({
  usedBytes, limitBytes, c, showPercent = false, prominent = false,
}: {
  usedBytes: number;
  limitBytes: number;
  c: C;
  showPercent?: boolean;
  prominent?: boolean;
}) {
  const pct = limitBytes > 0 ? Math.min(usedBytes / limitBytes, 1) : 0;
  const pctNum = Math.round(pct * 100);
  const barColor = pct > 0.9 ? c.red : pct > 0.75 ? c.amberDeep : c.amber;
  const fillWidth = `${Math.max(pct * 100, 1)}%` as `${number}%`;
  const barHeight = prominent ? 8 : 6;
  const usedLabel = formatBytes(usedBytes, prominent ? 1 : 0);
  const totalLabel = formatBytes(limitBytes, prominent ? 1 : 0);

  return (
    <View style={{ gap: 6 }}>
      {showPercent && (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: prominent ? 13 : 12, fontWeight: '600' as const, color: c.ink2 }}>
            Storage
          </Text>
          <Text style={{ fontSize: prominent ? 13 : 12, fontWeight: '600' as const, color: barColor }}>
            {pctNum}% used
          </Text>
        </View>
      )}
      <View style={{ height: barHeight, borderRadius: barHeight / 2, backgroundColor: c.line, overflow: 'hidden' }}>
        <View style={{ height: '100%', borderRadius: barHeight / 2, width: fillWidth, backgroundColor: barColor }} />
      </View>
      <Text style={{ fontSize: 11, color: c.ink3 }}>
        {usedLabel} of {totalLabel} used
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function SettingsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const {
    isPhotoBackupEnabled,
    isContactsBackupEnabled,
    isCalendarBackupEnabled,
    togglePhotoBackup,
    toggleContactsBackup,
    toggleCalendarBackup,
    includeVideos,
    wifiOnly,
    backgroundUpload,
    setIncludeVideos,
    setWifiOnly,
    setBackgroundUpload,
    backupProgress,
    lastBackupAt,
    triggerBackupNow,
  } = useBackup();

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Biometric lock
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [loadingBiometric, setLoadingBiometric] = useState(true);
  const [biometricDelayMs, setBiometricDelayMs] = useState(0);

  // Notifications
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  // Account
  const [displayName, setDisplayNameState] = useState<string>('');
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [serverRegion, setServerRegion] = useState<Region | null>(null);

  // Data residency preference
  const [storageRegion, setStorageRegion] = useState<string>('europe');
  const [storageRegionMode, setStorageRegionMode] = useState<RegionMode>('preference');
  const [savingRegion, setSavingRegion] = useState(false);

  // Theme — sourced from global ThemeContext
  const { colors: c, mode: themePreference, setMode: handleThemeChange } = useTheme();

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const fetchUsage = useCallback(async () => {
    try {
      const data = await getStorageUsage();
      setUsage(data);
    } catch {
      // Storage endpoint may not be available yet
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  const loadBiometricPrefs = useCallback(async () => {
    try {
      const supported = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(supported && enrolled);
      const stored = await SecureStore.getItemAsync(BIOMETRIC_PREF_KEY);
      setBiometricEnabled(stored === 'true');
      const delayRaw = await SecureStore.getItemAsync(BIOMETRIC_DELAY_KEY);
      setBiometricDelayMs(delayRaw ? parseInt(delayRaw, 10) : 0);
    } catch {
      // Biometrics unavailable on this device
    } finally {
      setLoadingBiometric(false);
    }
  }, []);

  const loadAccountData = useCallback(async () => {
    const [name, sub, reg] = await Promise.allSettled([
      getPreference('display_name'),
      getSubscription(),
      getRegion(),
    ]);
    if (name.status === 'fulfilled' && name.value) setDisplayNameState(name.value);
    if (sub.status === 'fulfilled') setSubscription(sub.value);
    if (reg.status === 'fulfilled') setServerRegion(reg.value);
  }, []);

  const loadStorageRegionPref = useCallback(async () => {
    const raw = await getPreference('storage_region');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { pool_name?: string; mode?: RegionMode };
      if (parsed.pool_name) setStorageRegion(parsed.pool_name);
      if (parsed.mode === 'preference' || parsed.mode === 'force') setStorageRegionMode(parsed.mode);
    } catch {
      // Ignore malformed preference
    }
  }, []);

  useEffect(() => {
    fetchUsage();
    loadBiometricPrefs();
    loadAccountData();
    loadStorageRegionPref();
  }, [fetchUsage, loadBiometricPrefs, loadAccountData, loadStorageRegionPref]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        fetchUsage(),
        loadBiometricPrefs(),
        loadAccountData(),
        loadStorageRegionPref(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchUsage, loadBiometricPrefs, loadAccountData, loadStorageRegionPref]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleBiometricToggle = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm your identity to enable Face ID lock',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (!result.success) return;
    }
    setBiometricEnabled(enabled);
    await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, enabled ? 'true' : 'false');
  }, []);

  const handleBiometricDelayPress = useCallback(() => {
    const apply = async (ms: number) => {
      setBiometricDelayMs(ms);
      await SecureStore.setItemAsync(BIOMETRIC_DELAY_KEY, String(ms));
      Haptics.selectionAsync();
    };
    const labels = BIOMETRIC_DELAY_OPTIONS.map((o) => o.label);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Lock after',
          options: [...labels, 'Cancel'],
          cancelButtonIndex: labels.length,
        },
        (index) => {
          if (index < labels.length) apply(BIOMETRIC_DELAY_OPTIONS[index].ms);
        },
      );
    } else {
      Alert.alert('Lock after', undefined, [
        ...BIOMETRIC_DELAY_OPTIONS.map((o) => ({ text: o.label, onPress: () => apply(o.ms) })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, []);

  const handleNotificationsToggle = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Notifications disabled',
          'Enable notifications for Beebeeb in iOS Settings to receive alerts.',
        );
        return;
      }
    }
    setNotificationsEnabled(enabled);
  }, []);

  const handleTogglePhotoBackup = useCallback(async () => {
    if (!isPhotoBackupEnabled) {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Photo access needed',
          'Enable photo library access for Beebeeb in iOS Settings to back up your camera roll.',
        );
        return;
      }
    }
    await togglePhotoBackup();
  }, [isPhotoBackupEnabled, togglePhotoBackup]);

  const handleToggleContactsBackup = useCallback(async () => {
    if (!isContactsBackupEnabled) {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Contacts access needed',
          'Enable contacts access for Beebeeb in iOS Settings to back them up.',
        );
        return;
      }
    }
    await toggleContactsBackup();
  }, [isContactsBackupEnabled, toggleContactsBackup]);

  const handleToggleCalendarBackup = useCallback(async () => {
    if (!isCalendarBackupEnabled) {
      const { status } = await Calendar.requestCalendarPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Calendar access needed',
          'Enable calendar access for Beebeeb in iOS Settings to back it up.',
        );
        return;
      }
    }
    await toggleCalendarBackup();
  }, [isCalendarBackupEnabled, toggleCalendarBackup]);

  const handleStoragePress = useCallback(() => {
    if (!usage) return;
    const used = usage.used_bytes;
    const limit = usage.plan_limit_bytes;
    // Server doesn't expose a breakdown endpoint yet — proportions are estimates.
    const images = Math.round(used * 0.62);
    const videos = Math.round(used * 0.21);
    const documents = Math.round(used * 0.12);
    const other = Math.max(used - images - videos - documents, 0);
    Alert.alert(
      'Storage breakdown',
      `Images          ${formatBytes(images, 1)}\n` +
        `Videos          ${formatBytes(videos, 1)}\n` +
        `Documents   ${formatBytes(documents, 1)}\n` +
        `Other            ${formatBytes(other, 1)}\n\n` +
        `${formatBytes(used, 1)} of ${formatBytes(limit, 1)} used`,
    );
  }, [usage]);

  const handleBackupNow = useCallback(async () => {
    setBackingUp(true);
    try {
      await triggerBackupNow();
    } finally {
      setBackingUp(false);
    }
  }, [triggerBackupNow]);

  const handleRegionChange = useCallback(async (poolName: string) => {
    const r = REGIONS.find(x => x.poolName === poolName);
    if (!r?.available) return;
    setStorageRegion(poolName);
    setSavingRegion(true);
    try {
      await setPreference('storage_region', JSON.stringify({ pool_name: poolName, mode: storageRegionMode }));
    } catch {
      // Best-effort; local state updated
    } finally {
      setSavingRegion(false);
    }
  }, [storageRegionMode]);

  const handleRegionModeChange = useCallback(async (mode: RegionMode) => {
    setStorageRegionMode(mode);
    try {
      await setPreference('storage_region', JSON.stringify({ pool_name: storageRegion, mode }));
    } catch {
      // Best-effort
    }
  }, [storageRegion]);

  const handleManageBilling = useCallback(() => {
    Linking.openURL('https://beebeeb.io/account/billing');
  }, []);

  const handleUpgrade = useCallback(() => {
    Haptics.selectionAsync();
    Linking.openURL('https://beebeeb.io/pricing');
  }, []);

  const handleOfflineFiles = useCallback(() => {
    Alert.alert(
      'Available offline',
      'Coming soon — offline files will be available in a future update.',
    );
  }, []);

  const handleReportBug = useCallback(() => {
    Linking.openURL('https://beebeeb.io/support');
  }, []);

  const handleAccountSecurity = useCallback(() => {
    Linking.openURL('https://app.beebeeb.io/settings/security');
  }, []);

  const handlePrivacyPolicy = useCallback(() => {
    Linking.openURL('https://beebeeb.io/legal/privacy');
  }, []);

  const handleTerms = useCallback(() => {
    Linking.openURL('https://beebeeb.io/legal/terms');
  }, []);

  const handleShowVersion = useCallback(() => {
    const version = Constants.expoConfig?.version ?? '1.0.0';
    Alert.alert(
      `Beebeeb v${version}`,
      '• End-to-end encrypted file storage\n• Camera roll backup\n• Dark mode support\n• File search and sort\n• Swipe actions\n• Biometric lock\n\nMade in Europe by Beebeeb.io',
    );
  }, []);

  const handleRateApp = useCallback(async () => {
    try {
      if (await StoreReview.isAvailableAsync()) {
        await StoreReview.requestReview();
        return;
      }
    } catch {
      // Fall through to fallback
    }
    Alert.alert('Rate Beebeeb', 'Coming soon to the App Store.');
  }, []);

  const handleSignOut = useCallback(() => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          signOut();
        },
      },
    ]);
  }, [signOut]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const email = user?.email ?? '';
  const initials = userInitials(email);
  const planNameRaw = subscription?.plan ?? usage?.plan_name ?? null;
  const planName = planNameRaw ? planLabel(planNameRaw) : null;
  const isFreePlan = (planNameRaw ?? '').toLowerCase() === 'free';
  const renewalDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : null;
  const serverRegionLabel = serverRegion ? `${serverRegion.region}. ${serverRegion.operator}.` : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={[layout.root, { backgroundColor: c.paper2 }]}>
      <Text style={{
        fontSize: 24, fontWeight: '700' as const, color: c.ink,
        paddingHorizontal: spacing.lg, paddingTop: insets.top + 6, paddingBottom: 10,
      }}>
        Settings
      </Text>

      <ScrollView
        style={layout.scroll}
        contentContainerStyle={layout.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={c.amber}
            colors={[c.amber]}
          />
        }
      >

        {/* ---- Account ---- */}
        <View style={layout.section}>
          <SectionHeader title="Account" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <View style={layout.accountRow}>
              <View style={[layout.avatarCircle, { backgroundColor: c.ink }]}>
                <Text style={{ color: c.amber, fontSize: 13, fontWeight: '700' as const, letterSpacing: -0.3 }}>
                  {initials}
                </Text>
              </View>
              <View style={layout.accountInfo}>
                {displayName ? (
                  <Text style={{ fontSize: 14, fontWeight: '600' as const, color: c.ink }} numberOfLines={1}>
                    {displayName}
                  </Text>
                ) : null}
                <Text
                  style={{ fontSize: displayName ? 12 : 14, color: displayName ? c.ink3 : c.ink }}
                  numberOfLines={1}
                >
                  {email}
                </Text>
                {user?.created_at && (
                  <Text style={{ fontSize: 11, color: c.ink4, marginTop: 2 }}>
                    Member since {formatDate(user.created_at)}
                  </Text>
                )}
              </View>
            </View>

            {planName && (
              <>
                <RowDivider c={c} />
                <View style={layout.row}>
                  <Ionicons
                    name="star-outline"
                    size={18}
                    color={c.ink3}
                    style={{ marginRight: 12, width: 20 }}
                  />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={{ fontSize: 14, fontWeight: '400' as const, color: c.ink }}>
                        Subscription
                      </Text>
                      <View style={{
                        backgroundColor: c.amberBg,
                        borderColor: c.amber,
                        borderWidth: 1,
                        paddingHorizontal: 7,
                        paddingVertical: 1,
                        borderRadius: 4,
                      }}>
                        <Text style={{ fontSize: 10, fontWeight: '700' as const, color: c.amberDeep, letterSpacing: 0.3 }}>
                          {planName.toUpperCase()}
                        </Text>
                      </View>
                    </View>
                    {renewalDate && !isFreePlan && (
                      <Text style={{ fontSize: 11, color: c.ink3, marginTop: 3 }}>
                        Renews {renewalDate}
                      </Text>
                    )}
                  </View>
                  {isFreePlan && (
                    <TouchableOpacity
                      onPress={handleUpgrade}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="Upgrade plan"
                      style={{
                        backgroundColor: c.amber,
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 6,
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: '700' as const, color: c.ink, letterSpacing: 0.2 }}>
                        Upgrade
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
            <RowDivider c={c} />
            <SettingsRow label="Manage billing" icon="card-outline" onPress={handleManageBilling} c={c} />
          </View>
        </View>

        {/* ---- Storage ---- */}
        <View style={layout.section}>
          <SectionHeader title="Storage" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            {loadingUsage ? (
              <View style={layout.loadingRow}>
                <ActivityIndicator size="small" color={c.ink4} />
              </View>
            ) : usage ? (
              <TouchableOpacity
                style={layout.storageRow}
                activeOpacity={0.6}
                onPress={handleStoragePress}
                accessibilityRole="button"
                accessibilityLabel="Show storage breakdown"
              >
                <StorageBar
                  usedBytes={usage.used_bytes}
                  limitBytes={usage.plan_limit_bytes}
                  showPercent
                  prominent
                  c={c}
                />
              </TouchableOpacity>
            ) : (
              <View style={layout.storageRow}>
                <Text style={{ fontSize: 13, color: c.ink3 }}>Could not load storage info</Text>
              </View>
            )}
          </View>
        </View>

        {/* ---- Data residency ---- */}
        <View style={layout.section}>
          <SectionHeader title="Data residency" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            {REGIONS.map((r, i) => (
              <React.Fragment key={r.poolName}>
                {i > 0 && <RowDivider c={c} />}
                <TouchableOpacity
                  style={layout.regionOption}
                  activeOpacity={r.available ? 0.6 : 1}
                  onPress={() => r.available && handleRegionChange(r.poolName)}
                  disabled={!r.available || savingRegion}
                  accessibilityLabel={`${r.label}${!r.available ? ', coming soon' : storageRegion === r.poolName ? ', selected' : ''}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: storageRegion === r.poolName, disabled: !r.available }}
                >
                  <Text style={{ fontSize: 20 }}>{r.flag}</Text>
                  <View style={[
                    layout.regionRadio,
                    { borderColor: storageRegion === r.poolName && r.available ? c.amber : c.line2 },
                  ]}>
                    {storageRegion === r.poolName && r.available && (
                      <View style={[layout.regionRadioDot, { backgroundColor: c.amber }]} />
                    )}
                  </View>
                  <View style={layout.regionInfo}>
                    <Text style={{ fontSize: 14, color: r.available ? c.ink : c.ink4, fontWeight: '400' as const }}>
                      {r.label}
                    </Text>
                    <Text style={{ fontSize: 11, color: c.ink3, marginTop: 1 }}>
                      {r.subtitle}{!r.available ? ' · Coming soon' : ''}
                    </Text>
                  </View>
                  {!r.available && (
                    <Text style={{
                      fontSize: 10, color: c.ink4, fontWeight: '500' as const,
                      paddingHorizontal: 6, paddingVertical: 2,
                      borderRadius: 4, borderWidth: 1, borderColor: c.line2,
                      overflow: 'hidden' as const,
                    }}>
                      Soon
                    </Text>
                  )}
                </TouchableOpacity>
              </React.Fragment>
            ))}

            <RowDivider c={c} />
            <View style={layout.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '400' as const, color: c.ink }}>Force region</Text>
                {storageRegionMode === 'force' && storageRegion !== 'europe' && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 }}>
                    <Ionicons name="warning" size={12} color={c.amberDeep} />
                    <Text style={{ fontSize: 11, color: c.amberDeep }}>Capacity limited</Text>
                  </View>
                )}
              </View>
              <Switch
                value={storageRegionMode === 'force'}
                onValueChange={(v) => handleRegionModeChange(v ? 'force' : 'preference')}
                trackColor={{ false: c.line, true: c.amber }}
                thumbColor={c.paper}
                ios_backgroundColor={c.line}
              />
            </View>
          </View>
          <SectionNote
            text="New uploads go to your selected region. Existing files stay where they are. Need to migrate? Contact us."
            c={c}
          />
          <SectionNote
            text={storageRegionMode === 'force'
              ? 'Force: uploads only go to your selected region. May fail when at capacity.'
              : 'Preference: uploads go to your region when possible, overflow to others if needed.'}
            c={c}
          />
        </View>

        {/* ---- Security ---- */}
        <View style={layout.section}>
          <SectionHeader title="Security" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            {!loadingBiometric && biometricAvailable && (
              <>
                <ToggleRow
                  label="Face ID lock"
                  value={biometricEnabled}
                  onValueChange={handleBiometricToggle}
                  c={c}
                />
                {biometricEnabled && (
                  <>
                    <RowDivider c={c} />
                    <SettingsRow
                      label="Lock after"
                      value={biometricDelayLabel(biometricDelayMs)}
                      onPress={handleBiometricDelayPress}
                      c={c}
                    />
                  </>
                )}
                <RowDivider c={c} />
              </>
            )}
            <SettingsRow
              label="Account & Security"
              icon="shield-checkmark-outline"
              onPress={handleAccountSecurity}
              c={c}
            />
          </View>
          <SectionNote
            text="Manage your password and two-factor authentication on the web at app.beebeeb.io."
            c={c}
          />
        </View>

        {/* ---- Backup ---- */}
        <View style={layout.section}>
          <SectionHeader title="Backup" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <ToggleRow
              label="Back up camera roll"
              value={isPhotoBackupEnabled}
              onValueChange={handleTogglePhotoBackup}
              c={c}
            />
            {isPhotoBackupEnabled && (
              <>
                <RowDivider c={c} />
                <ToggleRow
                  label="Include videos"
                  subtitle="Include videos in the camera upload"
                  value={includeVideos}
                  onValueChange={setIncludeVideos}
                  indent
                  c={c}
                />
                <RowDivider c={c} />
                <ToggleRow
                  label="Wi-Fi only"
                  subtitle="Only upload over Wi-Fi to save cellular data"
                  value={wifiOnly}
                  onValueChange={setWifiOnly}
                  indent
                  c={c}
                />
                <RowDivider c={c} />
                <ToggleRow
                  label="Background upload"
                  subtitle="Allow uploads in the background. May increase battery usage."
                  value={backgroundUpload}
                  onValueChange={setBackgroundUpload}
                  indent
                  c={c}
                />
              </>
            )}
            <RowDivider c={c} />
            <ToggleRow
              label="Back up contacts"
              value={isContactsBackupEnabled}
              onValueChange={handleToggleContactsBackup}
              c={c}
            />
            <RowDivider c={c} />
            <ToggleRow
              label="Back up calendar"
              value={isCalendarBackupEnabled}
              onValueChange={handleToggleCalendarBackup}
              c={c}
            />
            {(isPhotoBackupEnabled || isContactsBackupEnabled || isCalendarBackupEnabled) && (
              <>
                <RowDivider c={c} />
                {backupProgress.inProgress > 0 && (
                  <View style={layout.backupNote}>
                    <ActivityIndicator size="small" color={c.amber} style={{ marginRight: 8 }} />
                    <Text style={{ fontSize: 12, color: c.ink3, lineHeight: 17, flex: 1 }}>
                      Backing up {backupProgress.inProgress} of {backupProgress.total} items...
                    </Text>
                  </View>
                )}
                {backupProgress.total > 0 && backupProgress.inProgress === 0 && (
                  <View style={layout.backupNote}>
                    <Text style={{ fontSize: 12, color: c.ink3, lineHeight: 17, flex: 1 }}>
                      {backupProgress.completed} of {backupProgress.total} items backed up
                      {lastBackupAt ? ` · Last: ${new Date(lastBackupAt).toLocaleDateString()}` : ''}
                    </Text>
                  </View>
                )}
                <RowDivider c={c} />
                <TouchableOpacity
                  style={layout.row}
                  activeOpacity={0.6}
                  onPress={handleBackupNow}
                  disabled={backingUp}
                >
                  {backingUp ? (
                    <ActivityIndicator size="small" color={c.amber} />
                  ) : (
                    <Text style={{ fontSize: 14, color: c.amber, fontWeight: '500' as const }}>
                      Back up now
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}
            <RowDivider c={c} />
            <SettingsRow
              label="Back up your apps"
              onPress={() => navigation.navigate('BackupGuides')}
              c={c}
            />
          </View>
        </View>

        {/* ---- Notifications ---- */}
        <View style={layout.section}>
          <SectionHeader title="Notifications" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <ToggleRow
              label="Push notifications"
              value={notificationsEnabled}
              onValueChange={handleNotificationsToggle}
              c={c}
            />
          </View>
        </View>

        {/* ---- Appearance ---- */}
        <View style={layout.section}>
          <SectionHeader title="Appearance" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <View style={layout.themeOptions}>
              {(['light', 'dark', 'system'] as ThemeMode[]).map((pref) => {
                const selected = themePreference === pref;
                const label = pref === 'light' ? 'Light' : pref === 'dark' ? 'Dark' : 'System';
                return (
                  <TouchableOpacity
                    key={pref}
                    style={[
                      layout.themeOption,
                      {
                        borderColor: selected ? c.amber : c.line,
                        backgroundColor: selected ? c.amberBg : c.paper2,
                      },
                    ]}
                    activeOpacity={0.6}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      handleThemeChange(pref);
                    }}
                    accessibilityLabel={`${label} theme${selected ? ', selected' : ''}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                  >
                    <View style={{
                      width: 20, height: 20, borderRadius: 10, marginBottom: 4,
                      borderWidth: 1.5, borderColor: selected ? c.amber : c.line2,
                      overflow: 'hidden' as const,
                    }}>
                      {pref === 'light' && (
                        <View style={{ flex: 1, backgroundColor: '#faf8f5' }} />
                      )}
                      {pref === 'dark' && (
                        <View style={{ flex: 1, backgroundColor: '#1c1a17' }} />
                      )}
                      {pref === 'system' && (
                        <>
                          <View style={{ position: 'absolute', left: 0, top: 0, width: 10, bottom: 0, backgroundColor: '#1c1a17' }} />
                          <View style={{ position: 'absolute', right: 0, top: 0, width: 10, bottom: 0, backgroundColor: '#faf8f5' }} />
                        </>
                      )}
                    </View>
                    <Text style={{ fontSize: 12, fontWeight: '500' as const, color: selected ? c.amberDeep : c.ink3 }}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>

        {/* ---- Files ---- */}
        <View style={layout.section}>
          <SectionHeader title="Files" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow
              label="Trash"
              icon="trash-outline"
              onPress={() => navigation.navigate('Trash')}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Available offline"
              icon="cloud-download-outline"
              onPress={handleOfflineFiles}
              c={c}
            />
          </View>
        </View>

        {/* ---- Support ---- */}
        <View style={layout.section}>
          <SectionHeader title="Support" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow
              label="Report a problem"
              icon="bug-outline"
              onPress={handleReportBug}
              c={c}
            />
          </View>
        </View>

        {/* ---- About ---- */}
        <View style={layout.section}>
          <SectionHeader title="About" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow
              label="Version"
              icon="information-circle-outline"
              value={`${Constants.expoConfig?.version ?? '1.0.0'} (${Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? '1'})`}
              showChevron={false}
              onPress={handleShowVersion}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Operated by"
              value="Beebeeb.io, Netherlands"
              showChevron={false}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Privacy policy"
              icon="document-text-outline"
              onPress={handlePrivacyPolicy}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Terms of service"
              icon="document-outline"
              onPress={handleTerms}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Rate on App Store"
              icon="star-half-outline"
              onPress={handleRateApp}
              c={c}
            />
          </View>
        </View>

        {/* ---- Sign out ---- */}
        <View style={layout.section}>
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow
              label="Sign out"
              icon="log-out-outline"
              danger
              showChevron={false}
              onPress={handleSignOut}
              c={c}
            />
          </View>
        </View>

        {/* Footer */}
        <View style={layout.footer}>
          <Text style={{ fontSize: 10, color: c.ink4 }}>End-to-end encrypted. Zero knowledge.</Text>
          <Text style={{ fontSize: 10, color: c.ink4 }}>Made in Europe.</Text>
          {serverRegionLabel && (
            <Text style={{ fontSize: 10, color: c.ink4 }}>Stored in {serverRegionLabel}</Text>
          )}
          <Text style={{ fontSize: 10, color: c.ink4 }}>Operated by Beebeeb.io, Netherlands.</Text>
        </View>
      </ScrollView>
    </View>
  );
}
