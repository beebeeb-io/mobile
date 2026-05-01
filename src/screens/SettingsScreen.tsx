import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Appearance,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, darkColors, spacing } from '../theme';
import { useAuth } from '../lib/auth';
import { useBackup } from '../lib/backup-context';
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
const THEME_PREF_KEY = 'beebeeb_theme_pref';

type ThemePreference = 'light' | 'dark' | 'system';
type RegionMode = 'preference' | 'force';
type C = typeof colors;

// ---------------------------------------------------------------------------
// Data residency regions
// ---------------------------------------------------------------------------

const REGIONS: ReadonlyArray<{ poolName: string; label: string; subtitle: string; available: boolean }> = [
  { poolName: 'europe', label: 'Europe', subtitle: 'Auto-distribute', available: true },
  { poolName: 'falkenstein-de', label: 'Falkenstein, DE', subtitle: 'Hetzner', available: true },
  { poolName: 'helsinki-fin', label: 'Helsinki, FIN', subtitle: 'Hetzner', available: true },
  { poolName: 'ede-nl', label: 'Ede, NL', subtitle: 'Beebeeb', available: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(0)} GB`;
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

function SettingsRow({
  label, value, onPress, danger, showChevron = true, c,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  showChevron?: boolean;
  c: C;
}) {
  return (
    <TouchableOpacity
      style={layout.row}
      activeOpacity={onPress ? 0.6 : 1}
      onPress={onPress}
      disabled={!onPress}
    >
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
  label, value, onValueChange, disabled, c,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  c: C;
}) {
  return (
    <View style={layout.row}>
      <Text style={{ flex: 1, fontSize: 14, fontWeight: '400' as const, color: c.ink }}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
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

function StorageBar({ usedBytes, limitBytes, c }: { usedBytes: number; limitBytes: number; c: C }) {
  const pct = limitBytes > 0 ? Math.min(usedBytes / limitBytes, 1) : 0;
  const barColor = pct > 0.9 ? c.red : pct > 0.75 ? c.amberDeep : c.amber;
  const fillWidth = `${Math.max(pct * 100, 1)}%` as `${number}%`;

  return (
    <View style={{ gap: 6 }}>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden' }}>
        <View style={{ height: '100%', borderRadius: 3, width: fillWidth, backgroundColor: barColor }} />
      </View>
      <Text style={{ fontSize: 11, color: c.ink3 }}>
        {formatBytes(usedBytes)} of {formatBytes(limitBytes)} used
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
  const { user, signOut } = useAuth();
  const {
    isPhotoBackupEnabled,
    isContactsBackupEnabled,
    isCalendarBackupEnabled,
    togglePhotoBackup,
    toggleContactsBackup,
    toggleCalendarBackup,
    backupProgress,
    lastBackupAt,
    triggerBackupNow,
  } = useBackup();

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [backingUp, setBackingUp] = useState(false);

  // Biometric lock
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [loadingBiometric, setLoadingBiometric] = useState(true);

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

  // Theme
  const systemScheme = useColorScheme();
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');
  const effectiveScheme = themePreference === 'system' ? (systemScheme ?? 'light') : themePreference;
  const isDark = effectiveScheme === 'dark';
  const c = useMemo<C>(() => (isDark ? darkColors : colors), [isDark]);

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

  const loadThemePreference = useCallback(async () => {
    const stored = await SecureStore.getItemAsync(THEME_PREF_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setThemePreference(stored);
      if (Appearance.setColorScheme) {
        Appearance.setColorScheme(stored === 'system' ? null : stored);
      }
    }
  }, []);

  useEffect(() => {
    fetchUsage();
    loadBiometricPrefs();
    loadAccountData();
    loadStorageRegionPref();
    loadThemePreference();
  }, [fetchUsage, loadBiometricPrefs, loadAccountData, loadStorageRegionPref, loadThemePreference]);

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

  const handleNotificationsToggle = useCallback((enabled: boolean) => {
    setNotificationsEnabled(enabled);
  }, []);

  const handleBackupNow = useCallback(async () => {
    setBackingUp(true);
    try {
      await triggerBackupNow();
    } finally {
      setBackingUp(false);
    }
  }, [triggerBackupNow]);

  const handleEditDisplayName = useCallback(() => {
    Alert.prompt(
      'Display name',
      'This name is visible to people you share files with.',
      async (name) => {
        const trimmed = name?.trim();
        if (trimmed === undefined) return;
        setDisplayNameState(trimmed);
        try {
          await setPreference('display_name', trimmed);
        } catch {
          Alert.alert('Error', 'Could not save display name.');
        }
      },
      'plain-text',
      displayName,
    );
  }, [displayName]);

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

  const handleThemeChange = useCallback(async (pref: ThemePreference) => {
    setThemePreference(pref);
    if (Appearance.setColorScheme) {
      Appearance.setColorScheme(pref === 'system' ? null : pref);
    }
    await SecureStore.setItemAsync(THEME_PREF_KEY, pref);
  }, []);

  const handleManageBilling = useCallback(() => {
    Linking.openURL('https://beebeeb.io/account/billing');
  }, []);

  const handlePrivacyPolicy = useCallback(() => {
    Linking.openURL('https://beebeeb.io/legal/privacy');
  }, []);

  const handleTerms = useCallback(() => {
    Linking.openURL('https://beebeeb.io/legal/terms');
  }, []);

  const handleSignOut = useCallback(() => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ]);
  }, [signOut]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const email = user?.email ?? '';
  const initials = userInitials(email);
  const planName = subscription
    ? planLabel(subscription.plan)
    : usage ? planLabel(usage.plan_name) : null;
  const serverRegionLabel = serverRegion ? `${serverRegion.region}. ${serverRegion.operator}.` : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={[layout.root, { backgroundColor: c.paper2 }]}>
      <Text style={{
        fontSize: 24, fontWeight: '700' as const, color: c.ink,
        paddingHorizontal: spacing.lg, paddingTop: 6, paddingBottom: 10,
      }}>
        Settings
      </Text>

      <ScrollView style={layout.scroll} contentContainerStyle={layout.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ---- Account ---- */}
        <View style={layout.section}>
          <SectionHeader title="Account" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <TouchableOpacity style={layout.accountRow} activeOpacity={0.6} onPress={handleEditDisplayName}>
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
              <Text style={{ fontSize: 18, color: c.ink4, marginLeft: 2 }}>{'›'}</Text>
            </TouchableOpacity>

            {planName && (
              <>
                <RowDivider c={c} />
                <SettingsRow label="Plan" value={planName} showChevron={false} c={c} />
              </>
            )}
            <RowDivider c={c} />
            <SettingsRow label="Manage billing" onPress={handleManageBilling} c={c} />
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
              <View style={layout.storageRow}>
                <StorageBar usedBytes={usage.used_bytes} limitBytes={usage.plan_limit_bytes} c={c} />
              </View>
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
                >
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
            <ToggleRow
              label="Force region"
              value={storageRegionMode === 'force'}
              onValueChange={(v) => handleRegionModeChange(v ? 'force' : 'preference')}
              c={c}
            />
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
                <RowDivider c={c} />
              </>
            )}
            <SettingsRow label="Change password" c={c} />
            <RowDivider c={c} />
            <SettingsRow label="Two-factor authentication" c={c} />
          </View>
        </View>

        {/* ---- Backup ---- */}
        <View style={layout.section}>
          <SectionHeader title="Backup" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <ToggleRow
              label="Back up camera roll"
              value={isPhotoBackupEnabled}
              onValueChange={() => togglePhotoBackup()}
              c={c}
            />
            <RowDivider c={c} />
            <ToggleRow
              label="Back up contacts"
              value={isContactsBackupEnabled}
              onValueChange={() => toggleContactsBackup()}
              c={c}
            />
            <RowDivider c={c} />
            <ToggleRow
              label="Back up calendar"
              value={isCalendarBackupEnabled}
              onValueChange={() => toggleCalendarBackup()}
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
              {(['light', 'dark', 'system'] as ThemePreference[]).map((pref) => {
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
                    onPress={() => handleThemeChange(pref)}
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
            <SettingsRow label="Trash" onPress={() => navigation.navigate('Trash')} c={c} />
          </View>
        </View>

        {/* ---- About ---- */}
        <View style={layout.section}>
          <SectionHeader title="About" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow
              label="Version"
              value={`${Constants.expoConfig?.version ?? '1.0.0'} (${Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? '1'})`}
              showChevron={false}
              c={c}
            />
            <RowDivider c={c} />
            {serverRegionLabel && (
              <>
                <SettingsRow label="Stored in" value={serverRegionLabel} showChevron={false} c={c} />
                <RowDivider c={c} />
              </>
            )}
            <SettingsRow
              label="Operated by"
              value="Initlabs B.V., Wijchen, Netherlands"
              showChevron={false}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow label="Privacy policy" onPress={handlePrivacyPolicy} c={c} />
            <RowDivider c={c} />
            <SettingsRow label="Terms of service" onPress={handleTerms} c={c} />
          </View>
        </View>

        {/* ---- Sign out ---- */}
        <View style={layout.section}>
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow label="Sign out" danger showChevron={false} onPress={handleSignOut} c={c} />
          </View>
        </View>

        {/* Footer */}
        <View style={layout.footer}>
          <Text style={{ fontSize: 10, color: c.ink4 }}>End-to-end encrypted. Zero knowledge.</Text>
          <Text style={{ fontSize: 10, color: c.ink4 }}>Made in Europe.</Text>
          {serverRegionLabel && (
            <Text style={{ fontSize: 10, color: c.ink4 }}>Stored in {serverRegionLabel}</Text>
          )}
          <Text style={{ fontSize: 10, color: c.ink4 }}>Operated by Initlabs B.V., Wijchen, Netherlands.</Text>
        </View>
      </ScrollView>
    </View>
  );
}
