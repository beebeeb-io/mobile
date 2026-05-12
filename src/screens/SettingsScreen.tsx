import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';

let LocalAuthentication: any = { hasHardwareAsync: async () => false, authenticateAsync: async () => ({ success: false }), isEnrolledAsync: async () => false };
let StoreReview: any = { requestReview: async () => {} };
let Notifications: any = { getPermissionsAsync: async () => ({ status: 'undetermined' }), requestPermissionsAsync: async () => ({ status: 'undetermined' }) };
let MediaLibrary: any = { requestPermissionsAsync: async () => ({ status: 'undetermined' }) };
let Contacts: any = {
  getPermissionsAsync: async () => ({ status: 'undetermined', granted: false }),
  requestPermissionsAsync: async () => ({ status: 'undetermined', granted: false }),
};
let Calendar: any = {
  getCalendarPermissionsAsync: async () => ({ status: 'undetermined', granted: false }),
  requestCalendarPermissionsAsync: async () => ({ status: 'undetermined', granted: false }),
};
let Constants: any = { expoConfig: null };

try { LocalAuthentication = require('expo-local-authentication'); } catch {}
try { StoreReview = require('expo-store-review'); } catch {}
try { Notifications = require('expo-notifications'); } catch {}
try { MediaLibrary = require('expo-media-library'); } catch {}
try { Contacts = require('expo-contacts'); } catch {}
try { Calendar = require('expo-calendar'); } catch {}
try { Constants = require('expo-constants'); } catch {}
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, spacing, type Colors } from '../theme';
import { useAuth } from '../lib/auth';
import { useBackup } from '../lib/backup-context';
import { useCrypto } from '../lib/crypto-context';
import { useTheme, type ThemeMode } from '../lib/theme-context';
import { useToast } from '../lib/toast-context';
import { useNetworkStatus } from '../lib/useNetworkStatus';
import { writeWidgetData } from '../utils/widgetData';
import {
  getStorageUsage,
  getPreference,
  setPreference,
  getSubscription,
  getRegion,
  photoBackupStats,
  getNotificationPreferences,
  setNotificationPreferences,
  getToken,
  getApiUrl,
  getUserRegion,
  setUserRegion,
  requestDataExport,
  getApiEnvironment,
  type StorageUsage,
  type Subscription,
  type Region,
  type PhotoBackupStats,
  type MobileNotificationPreferences,
  type AvailableRegion,
} from '../lib/api';
import { readLastSessionAt } from '../services/PhotoBackupCheckpoint';
import { formatEtaSeconds } from '../services/PhotoBackupRunner';
import { exportContacts } from '../services/ContactsExporter';
import { exportCalendars } from '../services/CalendarExporter';
import {
  initDatabase as initBackupDb,
  getUploadedCount,
  getTotalCount,
  getUploadedBytes,
  getTotalBytes,
} from '../services/BackupDatabase';
import {
  initializeBackup,
  disableBackup,
  ensureBackupFolders,
  getDeviceManifest,
  updateBackupCategoryState,
  type BackupCategory,
  type DeviceManifest,
} from '../services/BackupService';
import type { RootStackParamList } from '../App';
import { NativeSwitch } from '../components/NativeSwitch';
import { markUnlocked } from '../lib/lock-state';
import { requestDeviceOwnerAuth } from '../lib/device-owner-auth';
import { NOTIFICATIONS_OPT_OUT_KEY, registerForPushNotifications, unregisterPushToken } from '../lib/push-notifications';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';

const BIOMETRIC_PREF_KEY = 'beebeeb_biometric_lock';
const BIOMETRIC_DELAY_KEY = 'beebeeb_biometric_delay';
// User-level override on top of the OS permission. If the user explicitly
// toggles notifications OFF in our settings, we honour that even when iOS
// still has permission granted — the OS permission is the *ceiling*, this
// pref is the user's current intent within that ceiling.
interface BiometricDelayOption {
  label: string;
  ms: number;
}
const BIOMETRIC_DELAY_OPTIONS: BiometricDelayOption[] = [
  { label: 'Immediately', ms: 0 },
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '1 hour', ms: 3_600_000 },
];

function biometricDelayLabel(ms: number): string {
  return BIOMETRIC_DELAY_OPTIONS.find((o) => o.ms === ms)?.label ?? 'Immediately';
}

function regionDisplayName(region: string): string {
  if (region.toLowerCase() === 'europe') return 'Europe';
  return region;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Please try again.';
}

type RegionMode = 'preference' | 'force';
type C = Colors;

interface NativePermissionResponse {
  status?: string;
  granted?: boolean;
}

// ---------------------------------------------------------------------------
// Data residency regions
// ---------------------------------------------------------------------------

const REGIONS: ReadonlyArray<{ poolName: string; label: string; subtitle: string; flag: string; available: boolean }> = [
  { poolName: 'europe', label: 'Europe', subtitle: 'Anywhere in Europe', flag: '\u{1F6E1}️', available: true },
  { poolName: 'falkenstein-de', label: 'Falkenstein', subtitle: 'Preference or force', flag: '\u{1F1E9}\u{1F1EA}', available: true },
  { poolName: 'helsinki-fi', label: 'Helsinki', subtitle: 'Preference or force', flag: '\u{1F1EB}\u{1F1EE}', available: false },
  { poolName: 'ede-nl', label: 'Ede', subtitle: 'Preference or force', flag: '\u{1F1F3}\u{1F1F1}', available: false },
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

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function planLabel(name: string): string {
  // Server is migrating personal -> basic and data_hoarder -> business; the
  // legacy keys are aliased to the new labels for the duration of the rename.
  const map: Record<string, string> = {
    free: 'Free',
    basic: 'Basic',
    personal: 'Basic',
    pro: 'Pro',
    business: 'Business',
    data_hoarder: 'Business',
    team: 'Team',
  };
  return map[name.toLowerCase()] ?? name;
}

function permissionGranted(permission: NativePermissionResponse | null | undefined): boolean {
  return permission?.granted === true || permission?.status === 'granted';
}

async function ensureContactsPermission(): Promise<boolean> {
  const current = typeof Contacts.getPermissionsAsync === 'function'
    ? await Contacts.getPermissionsAsync()
    : null;
  if (permissionGranted(current)) return true;

  const requested = typeof Contacts.requestPermissionsAsync === 'function'
    ? await Contacts.requestPermissionsAsync()
    : null;
  return permissionGranted(requested);
}

async function ensureCalendarPermission(): Promise<boolean> {
  const getPermission = Calendar.getCalendarPermissionsAsync ?? Calendar.getPermissionsAsync;
  const requestPermission = Calendar.requestCalendarPermissionsAsync ?? Calendar.requestPermissionsAsync;

  const current = typeof getPermission === 'function'
    ? await getPermission()
    : null;
  if (permissionGranted(current)) return true;

  const requested = typeof requestPermission === 'function'
    ? await requestPermission()
    : null;
  return permissionGranted(requested);
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
      <NativeSwitch
        value={value}
        onValueChange={(v) => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onValueChange(v);
        }}
        disabled={disabled}
        colors={c}
      />
    </View>
  );
}

function RowDivider({ c }: { c: C }) {
  return <View style={{ height: 1, backgroundColor: c.line, marginLeft: 12 }} />;
}

interface CategoryStats {
  uploadedCount: number;
  totalCount: number;
  uploadedBytes: number;
  totalBytes: number;
  lastSyncAt: string | null;
  syncing: boolean;
  legacyCount: number;
}

const EMPTY_CATEGORY_STATS: CategoryStats = {
  uploadedCount: 0,
  totalCount: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  lastSyncAt: null,
  syncing: false,
  legacyCount: 0,
};

function BackupCategoryStatus({ stats, paused, c }: { stats: CategoryStats; paused?: boolean; c: C }) {
  const { uploadedCount, totalCount, uploadedBytes, totalBytes, lastSyncAt, syncing, legacyCount } = stats;

  if (paused && totalCount > uploadedCount) {
    return (
      <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.ink4 }} />
        <Text style={{ fontSize: 11, color: c.ink3, flex: 1 }}>
          Paused · waiting for Wi-Fi · {totalCount - uploadedCount} remaining
        </Text>
      </View>
    );
  }

  if (totalCount === 0 && !lastSyncAt && !syncing && legacyCount === 0) {
    return (
      <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2 }}>
        <Text style={{ fontSize: 11, color: c.ink3 }}>Waiting for first scan…</Text>
      </View>
    );
  }

  const pct = totalCount > 0 ? Math.min(uploadedCount / totalCount, 1) : 0;
  const fillWidth = `${Math.max(pct * 100, 1)}%` as `${number}%`;
  const showBar = syncing && totalCount > 0;

  let line: string;
  if (syncing) {
    line = `${uploadedCount} / ${totalCount} items · ${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`;
  } else if (lastSyncAt) {
    line = `Last backup: ${timeAgo(lastSyncAt)} · ${uploadedCount} items · ${formatBytes(uploadedBytes)}`;
  } else if (legacyCount > 0) {
    line = `${legacyCount} legacy item${legacyCount === 1 ? '' : 's'} migrated from the old backup layout`;
  } else {
    line = `${uploadedCount} of ${totalCount} items backed up`;
  }
  if (legacyCount > 0 && lastSyncAt) {
    line += ` · ${legacyCount} legacy item${legacyCount === 1 ? '' : 's'} migrated`;
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2, gap: 6 }}>
      {showBar && (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.line2, overflow: 'hidden' }}>
          <View style={{ height: '100%', width: fillWidth, backgroundColor: c.amber, borderRadius: 2 }} />
        </View>
      )}
      <Text style={{ fontSize: 11, color: c.ink3 }}>{line}</Text>
    </View>
  );
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
  const crypto = useCrypto();
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
    photoSessionProgress,
    lastPhotoSession,
  } = useBackup();
  const { showToast } = useToast();
  const isOnline = useNetworkStatus();
  const apiEnvironment = getApiEnvironment();
  // "Paused — waiting for Wi-Fi" only kicks in when the user explicitly opted
  // to gate uploads on Wi-Fi *and* we're offline (or on cellular, once the
  // hook differentiates). useNetworkStatus currently reports a binary
  // online/offline; treat offline as paused for now.
  const backupPaused = wifiOnly && !isOnline;

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [backingUpContacts, setBackingUpContacts] = useState(false);
  const [backingUpCalendar, setBackingUpCalendar] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Track which storage thresholds we've already alerted on this session, so
  // refreshing the screen doesn't re-toast the same warning every time.
  const lastQuotaAlertRef = useRef<number>(0);

  // Biometric lock
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [loadingBiometric, setLoadingBiometric] = useState(true);
  const [biometricDelayMs, setBiometricDelayMs] = useState(0);

  // iOS Files.app integration
  const [fileProviderSupported, setFileProviderSupported] = useState(Platform.OS === 'ios');
  const [fileProviderShowInFiles, setFileProviderShowInFiles] = useState(Platform.OS === 'ios');
  const [fileProviderRequireAuth, setFileProviderRequireAuth] = useState(true);
  const [fileProviderLocked, setFileProviderLocked] = useState(true);
  const [fileProviderUnlockWindowSeconds, setFileProviderUnlockWindowSeconds] = useState(300);
  const [loadingFileProvider, setLoadingFileProvider] = useState(Platform.OS === 'ios');
  const [unlockingFileProvider, setUnlockingFileProvider] = useState(false);

  // Notifications
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<MobileNotificationPreferences>({
    file_updated: true,
    share_received: true,
    storage_warning: true,
    new_device_login: true,
    backup_complete: false,
  });
  const [notifPrefsLoading, setNotifPrefsLoading] = useState(false);

  // Account
  const [displayName, setDisplayNameState] = useState<string>('');
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [serverRegion, setServerRegion] = useState<Region | null>(null);

  // Data residency preference
  const [storageRegion, setStorageRegion] = useState<string>('europe');
  const [storageRegionMode, setStorageRegionMode] = useState<RegionMode>('preference');
  const [savingRegion, setSavingRegion] = useState(false);
  /** Dynamic regions from /api/v1/me/region — replaces hardcoded REGIONS when available */
  const [apiRegions, setApiRegions] = useState<AvailableRegion[] | null>(null);

  // Backup per-category stats (sourced from BackupDatabase + .device.json manifest)
  const [photoStats, setPhotoStats] = useState<CategoryStats>(EMPTY_CATEGORY_STATS);
  const [contactsStats, setContactsStats] = useState<CategoryStats>(EMPTY_CATEGORY_STATS);
  const [calendarStats, setCalendarStats] = useState<CategoryStats>(EMPTY_CATEGORY_STATS);

  // Server-side all-time photo backup stats + last-session timestamp
  const [serverPhotoStats, setServerPhotoStats] = useState<PhotoBackupStats | null>(null);
  const [lastSessionAt, setLastSessionAt] = useState<string | null>(null);

  // Theme — sourced from global ThemeContext
  const { colors: c, mode: themePreference, setMode: handleThemeChange } = useTheme();

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const fetchUsage = useCallback(async () => {
    try {
      const data = await getStorageUsage();
      setUsage(data);
      void writeWidgetData({ storageUsed: data.used_bytes, storageTotal: data.plan_limit_bytes, recentFiles: [] });

      // Quota warning: toast once per session as the user crosses 75 / 90 / 100%.
      // We only step *up*; recovering below a threshold doesn't reset (a single
      // session reload is enough to re-arm). Plans with no limit are skipped.
      const limit = data.plan_limit_bytes;
      if (limit > 0) {
        const ratio = data.used_bytes / limit;
        const tier = ratio >= 1 ? 100 : ratio >= 0.9 ? 90 : ratio >= 0.75 ? 75 : 0;
        if (tier > lastQuotaAlertRef.current) {
          lastQuotaAlertRef.current = tier;
          if (tier === 100) {
            showToast({ type: 'error', message: 'Storage full — uploads will fail until you free space or upgrade.' });
          } else if (tier === 90) {
            showToast({ type: 'error', message: 'Storage 90% full — consider upgrading or clearing the trash.' });
          } else if (tier === 75) {
            showToast({ type: 'info', message: 'Storage 75% full.' });
          }
        }
      }
    } catch {
      // Storage endpoint may not be available yet
    } finally {
      setLoadingUsage(false);
    }
  }, [showToast]);

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

  const loadFileProviderPrefs = useCallback(async () => {
    if (Platform.OS !== 'ios') {
      setFileProviderSupported(false);
      setLoadingFileProvider(false);
      return;
    }
    try {
      const state = await BeebeebCrypto.getFileProviderPrivacyState();
      setFileProviderSupported(state.supported);
      setFileProviderShowInFiles(state.showInFiles);
      setFileProviderRequireAuth(state.requireDeviceAuth);
      setFileProviderLocked(state.locked);
      setFileProviderUnlockWindowSeconds(state.unlockWindowSeconds);
    } catch {
      setFileProviderSupported(false);
    } finally {
      setLoadingFileProvider(false);
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
    // Try the new /api/v1/me/region endpoint first; fall back to stored preference
    try {
      const data = await getUserRegion();
      setApiRegions(null);
      if (data.preferred_region) setStorageRegion(data.preferred_region);
      return;
    } catch {
      // Endpoint not deployed yet — fall through to stored preference
    }
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

  // Fetch server-side photo backup stats + last-session checkpoint
  const fetchPhotoBackupStats = useCallback(async () => {
    try {
      const [stats, sessionAt] = await Promise.all([
        photoBackupStats(),
        readLastSessionAt(),
      ]);
      setServerPhotoStats(stats);
      setLastSessionAt(sessionAt);
    } catch {
      // Endpoint may not be deployed yet — ignore
    }
  }, []);

  useEffect(() => {
    fetchUsage();
    loadBiometricPrefs();
    loadFileProviderPrefs();
    loadAccountData();
    loadStorageRegionPref();
    if (isPhotoBackupEnabled) fetchPhotoBackupStats();
    // Seed the push toggle from OS permission AND a user opt-out flag —
    // OS permission alone overestimates ("granted" but user wants quiet),
    // SecureStore alone underestimates (user toggled off in a past
    // install but never re-evaluated against the OS state).
    (async () => {
      try {
        const [{ status }, optOutRaw] = await Promise.all([
          Notifications.getPermissionsAsync(),
          SecureStore.getItemAsync(NOTIFICATIONS_OPT_OUT_KEY),
        ]);
        const granted = status === 'granted';
        const optedOut = optOutRaw === 'true';
        const enabled = granted && !optedOut;
        setNotificationsEnabled(enabled);
        // Load per-category preferences from server when notifications are on.
        if (enabled) {
          setNotifPrefsLoading(true);
          getNotificationPreferences()
            .then(setNotifPrefs)
            .catch(() => {/* use defaults */})
            .finally(() => setNotifPrefsLoading(false));
        }
      } catch {
        setNotificationsEnabled(false);
      }
    })();
  }, [fetchUsage, loadBiometricPrefs, loadFileProviderPrefs, loadAccountData, loadStorageRegionPref, isPhotoBackupEnabled, fetchPhotoBackupStats]);

  // Refresh server stats whenever a JS session completes
  useEffect(() => {
    if (isPhotoBackupEnabled && !photoSessionProgress.running) {
      void fetchPhotoBackupStats();
    }
  }, [isPhotoBackupEnabled, photoSessionProgress.running, fetchPhotoBackupStats]);

  // -- Backup status: refresh whenever toggles flip or the worker reports progress
  const syncing = backupProgress.inProgress > 0;

  const refreshBackupStats = useCallback(async () => {
    try {
      await initBackupDb();
    } catch {
      return;
    }

    let manifest: DeviceManifest | null = null;
    try {
      manifest = await getDeviceManifest();
    } catch {
      // Manifest may be unreachable (no network, never initialized); fall back to local-only stats
    }

    const [
      photoUploaded, videoUploaded, photoTotal, videoTotal,
      photoUpBytes, videoUpBytes, photoTotalBytes, videoTotalBytes,
      contactUploaded, contactTotal, contactUpBytes, contactTotalBytes,
      calUploaded, calTotal, calUpBytes, calTotalBytes,
    ] = await Promise.all([
      getUploadedCount('photo'), getUploadedCount('video'),
      getTotalCount('photo'), getTotalCount('video'),
      getUploadedBytes('photo'), getUploadedBytes('video'),
      getTotalBytes('photo'), getTotalBytes('video'),
      getUploadedCount('contact'), getTotalCount('contact'),
      getUploadedBytes('contact'), getTotalBytes('contact'),
      getUploadedCount('calendar'), getTotalCount('calendar'),
      getUploadedBytes('calendar'), getTotalBytes('calendar'),
    ]);

    setPhotoStats({
      uploadedCount: photoUploaded + videoUploaded,
      totalCount: photoTotal + videoTotal,
      uploadedBytes: photoUpBytes + videoUpBytes,
      totalBytes: photoTotalBytes + videoTotalBytes,
      lastSyncAt: manifest?.backups.camera_roll.last_sync ?? null,
      syncing,
      legacyCount: manifest?.backups.camera_roll.legacy_items_migrated ?? 0,
    });
    setContactsStats({
      uploadedCount: contactUploaded,
      totalCount: contactTotal,
      uploadedBytes: contactUpBytes,
      totalBytes: contactTotalBytes,
      lastSyncAt: manifest?.backups.contacts.last_sync ?? null,
      syncing,
      legacyCount: manifest?.backups.contacts.legacy_items_migrated ?? 0,
    });
    setCalendarStats({
      uploadedCount: calUploaded,
      totalCount: calTotal,
      uploadedBytes: calUpBytes,
      totalBytes: calTotalBytes,
      lastSyncAt: manifest?.backups.calendar.last_sync ?? null,
      syncing,
      legacyCount: manifest?.backups.calendar.legacy_items_migrated ?? 0,
    });
  }, [syncing]);

  useEffect(() => {
    refreshBackupStats();
  }, [
    refreshBackupStats,
    isPhotoBackupEnabled,
    isContactsBackupEnabled,
    isCalendarBackupEnabled,
    backupProgress.completed,
  ]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        fetchUsage(),
        loadBiometricPrefs(),
        loadFileProviderPrefs(),
        loadAccountData(),
        loadStorageRegionPref(),
        isPhotoBackupEnabled ? fetchPhotoBackupStats() : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchUsage, loadBiometricPrefs, loadFileProviderPrefs, loadAccountData, loadStorageRegionPref, isPhotoBackupEnabled, fetchPhotoBackupStats]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleBiometricToggle = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm your identity to enable Face ID lock',
        cancelLabel: 'Cancel',
        disableDeviceFallback: true,
      });
      if (!result.success) return;
      // The system biometric sheet briefly backgrounds Beebeeb. Without this
      // grace stamp the AppState listener would interpret the resume as a
      // background→active transition and immediately push the lock screen,
      // even though the user just authenticated.
      markUnlocked();
    }
    try {
      await crypto.setBiometricRequirement(enabled);
    } catch {
      Alert.alert(
        'Face ID setup failed',
        'Unlock Beebeeb with your recovery phrase and try again. The local vault must be open before changing Face ID protection.',
      );
      return;
    }
    setBiometricEnabled(enabled);
    await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, enabled ? 'true' : 'false');
  }, [crypto]);

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

  const handleFileProviderShowToggle = useCallback(async (enabled: boolean) => {
    const previous = fileProviderShowInFiles;
    setFileProviderShowInFiles(enabled);
    setLoadingFileProvider(true);
    try {
      if (enabled) {
        const token = await getToken();
        if (token) {
          await BeebeebCrypto.mirrorSessionToAppGroup(token, getApiUrl()).catch(() => false);
        }
      }
      const result = await BeebeebCrypto.setFileProviderEnabled(enabled);
      setFileProviderSupported(result.supported);
      setFileProviderShowInFiles(enabled && result.registered);
      if (!enabled) {
        setFileProviderLocked(true);
      }
      showToast({
        type: result.registered || !enabled ? 'success' : 'info',
        message: enabled && result.registered
          ? 'Beebeeb is visible in Files'
          : enabled
            ? 'Files integration is unavailable on this device'
            : 'Beebeeb is hidden from Files',
      });
    } catch (err) {
      setFileProviderShowInFiles(previous);
      Alert.alert('Files setting failed', errorMessage(err));
    } finally {
      setLoadingFileProvider(false);
    }
  }, [fileProviderShowInFiles, showToast]);

  const handleFileProviderAuthToggle = useCallback(async (required: boolean) => {
    const previous = fileProviderRequireAuth;
    setFileProviderRequireAuth(required);
    try {
      const state = await BeebeebCrypto.setFileProviderAuthRequired(required);
      setFileProviderRequireAuth(state.requireDeviceAuth);
      setFileProviderLocked(state.locked);
      setFileProviderUnlockWindowSeconds(state.unlockWindowSeconds);
    } catch (err) {
      setFileProviderRequireAuth(previous);
      Alert.alert('Files lock setting failed', errorMessage(err));
    }
  }, [fileProviderRequireAuth]);

  const handleUnlockFileProviderAccess = useCallback(async () => {
    setUnlockingFileProvider(true);
    try {
      const auth = await requestDeviceOwnerAuth('Unlock Beebeeb in Files', {
        unavailable: 'Set up Face ID or an iPhone passcode before unlocking Beebeeb in Files.',
        cancelled: 'Authentication cancelled. Beebeeb stays locked in Files.',
        failed: 'Authentication failed. Beebeeb stays locked in Files.',
      });
      if (!auth.ok) {
        if (auth.reason !== 'cancelled') {
          Alert.alert('Files access locked', auth.message);
        }
        return;
      }
      const token = await getToken();
      if (token) {
        await BeebeebCrypto.mirrorSessionToAppGroup(token, getApiUrl()).catch(() => false);
      }
      const state = await BeebeebCrypto.unlockFileProviderAccess();
      setFileProviderLocked(state.locked);
      setFileProviderUnlockWindowSeconds(state.unlockWindowSeconds);
      showToast({ type: 'success', message: `Files access unlocked for ${Math.round(state.unlockWindowSeconds / 60)} minutes` });
    } catch (err) {
      Alert.alert('Files unlock failed', errorMessage(err));
    } finally {
      setUnlockingFileProvider(false);
    }
  }, [showToast]);

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
    // Persist the user's intent so a fresh launch (or another tab focus)
    // doesn't bounce the toggle back to "OS permission says yes" — we keep
    // their explicit opt-out until they flip it on again here.
    try {
      await SecureStore.setItemAsync(NOTIFICATIONS_OPT_OUT_KEY, enabled ? 'false' : 'true');
    } catch {
      // SecureStore unavailable (web) — toggle remains in-memory only.
    }
    if (enabled) {
      void registerForPushNotifications();
      setNotifPrefsLoading(true);
      getNotificationPreferences()
        .then(setNotifPrefs)
        .catch(() => {/* keep defaults */})
        .finally(() => setNotifPrefsLoading(false));
    } else {
      void unregisterPushToken();
    }
  }, []);

  const handleNotifPrefToggle = useCallback(
    async (key: keyof MobileNotificationPreferences, value: boolean) => {
      const next = { ...notifPrefs, [key]: value };
      setNotifPrefs(next);
      try {
        const saved = await setNotificationPreferences(next);
        setNotifPrefs(saved);
      } catch {
        // Roll back on failure
        setNotifPrefs(notifPrefs);
      }
    },
    [notifPrefs],
  );

  const syncBackupCategory = useCallback(async (category: BackupCategory, enabling: boolean) => {
    try {
      if (enabling) {
        await initializeBackup(category);
      } else {
        await disableBackup(category);
      }
    } catch (err) {
      // Folder/manifest write failed (offline, permission, etc.). Local toggle stays;
      // the manifest will reconverge on the next successful run.
      console.warn(`Failed to ${enabling ? 'initialize' : 'disable'} backup for ${category}:`, err);
    }
    refreshBackupStats();
  }, [refreshBackupStats]);

  const handleTogglePhotoBackup = useCallback(async () => {
    const enabling = !isPhotoBackupEnabled;
    if (enabling) {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Photo access needed',
          'Beebeeb needs access to your photo library to back up your camera roll. Open Settings and enable "Photos" access.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open Settings',
              onPress: () => { void Linking.openSettings(); },
            },
          ],
        );
        return;
      }
    }
    await togglePhotoBackup();
    await syncBackupCategory('camera_roll', enabling);
  }, [isPhotoBackupEnabled, togglePhotoBackup, syncBackupCategory]);

  const handleToggleContactsBackup = useCallback(async () => {
    const enabling = !isContactsBackupEnabled;
    if (enabling) {
      const granted = await ensureContactsPermission();
      if (!granted) {
        Alert.alert(
          'Contacts access needed',
          'Enable contacts access for Beebeeb in iOS Settings to back them up.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open Settings',
              onPress: () => { void Linking.openSettings(); },
            },
          ],
        );
        return;
      }
    }
    await toggleContactsBackup();
    await syncBackupCategory('contacts', enabling);
  }, [isContactsBackupEnabled, toggleContactsBackup, syncBackupCategory]);

  const handleToggleCalendarBackup = useCallback(async () => {
    const enabling = !isCalendarBackupEnabled;
    if (enabling) {
      const granted = await ensureCalendarPermission();
      if (!granted) {
        Alert.alert(
          'Calendar access needed',
          'Enable calendar access for Beebeeb in iOS Settings to back it up.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open Settings',
              onPress: () => { void Linking.openSettings(); },
            },
          ],
        );
        return;
      }
    }
    await toggleCalendarBackup();
    await syncBackupCategory('calendar', enabling);
  }, [isCalendarBackupEnabled, toggleCalendarBackup, syncBackupCategory]);

  const handleIncludeVideosChange = useCallback(async (value: boolean) => {
    await setIncludeVideos(value);
    void updateBackupCategoryState('camera_roll', {
      enabled: isPhotoBackupEnabled,
      include_videos: value,
      wifi_only: wifiOnly,
      background_enabled: backgroundUpload,
    }).then(refreshBackupStats).catch((err) => {
      console.warn('[SettingsScreen] camera-roll option sync failed:', err);
    });
  }, [backgroundUpload, isPhotoBackupEnabled, refreshBackupStats, setIncludeVideos, wifiOnly]);

  const handleWifiOnlyChange = useCallback(async (value: boolean) => {
    await setWifiOnly(value);
    void updateBackupCategoryState('camera_roll', {
      enabled: isPhotoBackupEnabled,
      include_videos: includeVideos,
      wifi_only: value,
      background_enabled: backgroundUpload,
    }).then(refreshBackupStats).catch((err) => {
      console.warn('[SettingsScreen] camera-roll option sync failed:', err);
    });
  }, [backgroundUpload, includeVideos, isPhotoBackupEnabled, refreshBackupStats, setWifiOnly]);

  const handleBackgroundUploadChange = useCallback(async (value: boolean) => {
    await setBackgroundUpload(value);
    void updateBackupCategoryState('camera_roll', {
      enabled: isPhotoBackupEnabled,
      include_videos: includeVideos,
      wifi_only: wifiOnly,
      background_enabled: value,
    }).then(refreshBackupStats).catch((err) => {
      console.warn('[SettingsScreen] camera-roll option sync failed:', err);
    });
  }, [includeVideos, isPhotoBackupEnabled, refreshBackupStats, setBackgroundUpload, wifiOnly]);

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

  const handleBackupContactsNow = useCallback(async () => {
    const granted = await ensureContactsPermission();
    if (!granted) {
      Alert.alert(
        'Contacts access needed',
        'Enable contacts access for Beebeeb in iOS Settings to back them up.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () => { void Linking.openSettings(); },
          },
        ],
      );
      return;
    }
    setBackingUpContacts(true);
    try {
      await initializeBackup('contacts');
      const token = await getToken();
      if (!token) throw new Error('Session expired');
      const result = await exportContacts({
        encryptChunkFn: crypto.encryptChunk,
        encryptMetadataFn: crypto.encryptMetadata,
      });
      const timestamp = new Date().toISOString();
      await updateBackupCategoryState('contacts', {
        enabled: true,
        last_sync: timestamp,
        items_synced: result.contactCount,
        contact_count: result.contactCount,
      });
      await refreshBackupStats();
      const message = result.exported
        ? `Contacts backed up · ${result.contactCount} contact${result.contactCount === 1 ? '' : 's'}`
        : `Contacts checked · ${result.contactCount} contact${result.contactCount === 1 ? '' : 's'} unchanged`;
      showToast({ type: 'success', message });
    } catch (err) {
      console.warn('[SettingsScreen] contacts backup failed:', err);
      Alert.alert('Contacts backup failed', errorMessage(err));
    } finally {
      setBackingUpContacts(false);
    }
  }, [crypto.encryptChunk, crypto.encryptMetadata, refreshBackupStats, showToast]);

  const handleBackupCalendarNow = useCallback(async () => {
    const granted = await ensureCalendarPermission();
    if (!granted) {
      Alert.alert(
        'Calendar access needed',
        'Enable calendar access for Beebeeb in iOS Settings to back it up.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () => { void Linking.openSettings(); },
          },
        ],
      );
      return;
    }
    setBackingUpCalendar(true);
    try {
      await initializeBackup('calendar');
      const token = await getToken();
      if (!token) throw new Error('Session expired');
      const result = await exportCalendars({
        encryptChunkFn: crypto.encryptChunk,
        encryptMetadataFn: crypto.encryptMetadata,
      });
      const timestamp = new Date().toISOString();
      await updateBackupCategoryState('calendar', {
        enabled: true,
        last_sync: timestamp,
        items_synced: result.eventCount,
        calendar_count: result.calendarCount,
      });
      await refreshBackupStats();
      const message = result.exported
        ? `Calendar backed up · ${result.eventCount} event${result.eventCount === 1 ? '' : 's'}`
        : `Calendar checked · ${result.calendarCount} calendar${result.calendarCount === 1 ? '' : 's'}`;
      showToast({ type: 'success', message });
    } catch (err) {
      console.warn('[SettingsScreen] calendar backup failed:', err);
      Alert.alert('Calendar backup failed', errorMessage(err));
    } finally {
      setBackingUpCalendar(false);
    }
  }, [crypto.encryptChunk, crypto.encryptMetadata, refreshBackupStats, showToast]);

  const handleRegionChange = useCallback(async (poolName: string) => {
    const r = REGIONS.find(x => x.poolName === poolName);
    if (!r?.available) return;
    setStorageRegion(poolName);
    setSavingRegion(true);
    try {
      await setUserRegion(poolName);
      await setPreference('storage_region', JSON.stringify({ pool_name: poolName, mode: storageRegionMode }));
    } catch {
      await setPreference('storage_region', JSON.stringify({ pool_name: poolName, mode: storageRegionMode })).catch(() => {});
    } finally {
      setSavingRegion(false);
    }
  }, [storageRegionMode, apiRegions]);

  const handleRegionModeChange = useCallback(async (mode: RegionMode) => {
    setStorageRegionMode(mode);
    try {
      await setPreference('storage_region', JSON.stringify({ pool_name: storageRegion, mode }));
    } catch {
      // Best-effort
    }
  }, [storageRegion]);

  const handleUpgrade = useCallback(() => {
    Haptics.selectionAsync();
    navigation.navigate('Storage');
  }, [navigation]);

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

  const handleDownloadRecoveryKit = useCallback(async () => {
    Alert.alert(
      'Recovery kit unavailable',
      'Your recovery phrase is shown once during account setup and is not stored on this device. Use the copy you saved offline.',
    );
  }, []);

  const handlePrivacyPolicy = useCallback(() => {
    Linking.openURL('https://beebeeb.io/privacy');
  }, []);

  const handleDownloadMyData = useCallback(async () => {
    try {
      await requestDataExport();
      Alert.alert(
        'Export requested',
        "We'll prepare your data export and send a download link to your email address.",
      );
    } catch {
      Alert.alert(
        'Not available',
        'Data export is not available right now. Try again later.',
      );
    }
  }, []);

  const handleTerms = useCallback(() => {
    Linking.openURL('https://beebeeb.io/terms');
  }, []);

  const handleAcceptableUse = useCallback(() => {
    Linking.openURL('https://beebeeb.io/aup');
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
  const serverRegionLabel = serverRegion?.region ? regionDisplayName(serverRegion.region) : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={[layout.root, { backgroundColor: c.paper2 }]}>
      <Text style={{
        fontSize: 28, fontWeight: '700' as const, color: c.ink,
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

        {/* ---- Storage & Plan ---- */}
        <View style={layout.section}>
          <SectionHeader title="Storage & Plan" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow
              label="Storage & Plan"
              icon="cloud-outline"
              onPress={() => navigation.navigate('Storage')}
              c={c}
            />
          </View>
        </View>

        {/* ---- Data residency ---- */}
        <View style={layout.section}>
          <SectionHeader title="Data residency" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            {/* API regions when loaded — dynamic from /api/v1/me/region */}
            {apiRegions !== null
              ? apiRegions.map((r, i) => {
                  const isSelected = storageRegion === r.continent;
                  return (
                    <React.Fragment key={r.continent}>
                      {i > 0 && <RowDivider c={c} />}
                      <TouchableOpacity
                        style={layout.regionOption}
                        activeOpacity={0.6}
                        onPress={() => void handleRegionChange(r.continent)}
                        disabled={savingRegion || apiRegions.length <= 1}
                        accessibilityLabel={`${r.display_name}${isSelected ? ', selected' : ''}`}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: isSelected }}
                      >
                        <View style={[
                          layout.regionRadio,
                          { borderColor: isSelected ? c.amber : c.line2 },
                        ]}>
                          {isSelected && (
                            <View style={[layout.regionRadioDot, { backgroundColor: c.amber }]} />
                          )}
                        </View>
                        <View style={layout.regionInfo}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={{ fontSize: 14, color: c.ink, fontWeight: '400' as const }}>
                              {r.display_name}
                            </Text>
                            {r.is_default && (
                              <Text style={{
                                fontSize: 10, color: c.ink4, fontWeight: '500' as const,
                                paddingHorizontal: 5, paddingVertical: 1,
                                borderRadius: 4, borderWidth: 1, borderColor: c.line2,
                                overflow: 'hidden' as const,
                              }}>
                                Default
                              </Text>
                            )}
                          </View>
                          <Text style={{ fontSize: 11, color: c.ink3, marginTop: 1 }}>
                            {r.continent === 'europe'
                              ? 'Anywhere in Europe'
                              : (r.example_city ?? r.city ?? 'Preference or force')}
                          </Text>
                        </View>
                        {isSelected && (
                          <Ionicons name="checkmark" size={16} color={c.amber} />
                        )}
                      </TouchableOpacity>
                    </React.Fragment>
                  );
                })
              /* Fallback: hardcoded REGIONS while API endpoint isn't deployed */
              : REGIONS.map((r, i) => (
                <React.Fragment key={r.poolName}>
                  {i > 0 && <RowDivider c={c} />}
                  <TouchableOpacity
                    style={layout.regionOption}
                    activeOpacity={r.available ? 0.6 : 1}
                    onPress={() => r.available && void handleRegionChange(r.poolName)}
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
              ))
            }

            {storageRegion !== 'europe' && (
              <>
                <RowDivider c={c} />
                <View style={layout.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '400' as const, color: c.ink }}>Force region</Text>
                    {storageRegionMode === 'force' && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 }}>
                        <Ionicons name="warning" size={12} color={c.amberDeep} />
                        <Text style={{ fontSize: 11, color: c.amberDeep }}>Capacity limited</Text>
                      </View>
                    )}
                  </View>
                  <NativeSwitch
                    value={storageRegionMode === 'force'}
                    onValueChange={(v) => handleRegionModeChange(v ? 'force' : 'preference')}
                    colors={c}
                  />
                </View>
              </>
            )}
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
            {fileProviderSupported && (
              <>
                <ToggleRow
                  label="Show Beebeeb in Files"
                  subtitle="Adds Beebeeb to iOS Files locations."
                  value={fileProviderShowInFiles}
                  onValueChange={handleFileProviderShowToggle}
                  disabled={loadingFileProvider}
                  c={c}
                />
                {fileProviderShowInFiles && (
                  <>
                    <RowDivider c={c} />
                    <ToggleRow
                      label="Require Face ID or passcode"
                      subtitle="Files stays locked until Beebeeb grants a short access window."
                      value={fileProviderRequireAuth}
                      onValueChange={handleFileProviderAuthToggle}
                      disabled={loadingFileProvider}
                      c={c}
                    />
                    {fileProviderRequireAuth && (
                      <>
                        <RowDivider c={c} />
                        <SettingsRow
                          label="Unlock Files access"
                          value={unlockingFileProvider
                            ? 'Unlocking...'
                            : fileProviderLocked
                              ? `${Math.round(fileProviderUnlockWindowSeconds / 60)} min`
                              : 'Unlocked'}
                          icon="folder-open-outline"
                          onPress={unlockingFileProvider ? undefined : handleUnlockFileProviderAccess}
                          c={c}
                        />
                      </>
                    )}
                  </>
                )}
                <RowDivider c={c} />
              </>
            )}
            <SettingsRow
              label="Two-Factor Authentication"
              icon="lock-closed-outline"
              onPress={() => navigation.navigate('TwoFactorSetup')}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Account & Security"
              icon="shield-checkmark-outline"
              onPress={handleAccountSecurity}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Recovery phrase"
              icon="document-text-outline"
              onPress={() => { void handleDownloadRecoveryKit(); }}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Add a device"
              icon="phone-portrait-outline"
              onPress={() => navigation.navigate('DevicePairing')}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Siri & Shortcuts"
              icon="mic-outline"
              onPress={() => { void Linking.openSettings(); }}
              c={c}
            />
          </View>
          <SectionNote
            text="Manage your password on the web at app.beebeeb.io."
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
            {isPhotoBackupEnabled && <BackupCategoryStatus stats={photoStats} paused={backupPaused} c={c} />}
            {isPhotoBackupEnabled && (
              <>
                <RowDivider c={c} />
                <ToggleRow
                  label="Photos and videos"
                  subtitle="Back up videos in addition to photos. Videos can be large — backed up over Wi-Fi only."
                  value={includeVideos}
                  onValueChange={handleIncludeVideosChange}
                  indent
                  c={c}
                />
                <RowDivider c={c} />
                <ToggleRow
                  label="Wi-Fi only"
                  subtitle="Only upload over Wi-Fi to save cellular data"
                  value={wifiOnly}
                  onValueChange={handleWifiOnlyChange}
                  indent
                  c={c}
                />
                <RowDivider c={c} />
                <ToggleRow
                  label="Background upload"
                  subtitle="Allow uploads in the background. May increase battery usage."
                  value={backgroundUpload}
                  onValueChange={handleBackgroundUploadChange}
                  indent
                  c={c}
                />
              </>
            )}
            {/* ── Camera roll: "Backup now" + live progress ── */}
            {isPhotoBackupEnabled && (
              <>
                {/* JS-side live session progress */}
                {photoSessionProgress.running && photoSessionProgress.total > 0 && (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2, gap: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <ActivityIndicator size="small" color={c.amber} />
                      <Text style={{ fontSize: 12, color: c.ink3, lineHeight: 17, flex: 1 }}>
                        {'Backing up... '}
                        {photoSessionProgress.uploaded}/{photoSessionProgress.total}
                        {photoSessionProgress.etaSeconds != null
                          ? ` · ${formatEtaSeconds(photoSessionProgress.etaSeconds)} remaining`
                          : ''}
                      </Text>
                    </View>
                    {photoSessionProgress.currentFileName ? (
                      <Text style={{ fontSize: 11, color: c.ink4, fontFamily: fonts.mono }} numberOfLines={1} ellipsizeMode="middle">
                        {photoSessionProgress.currentFileName}
                        {photoSessionProgress.currentFileSizeBytes > 0
                          ? ` · ${formatBytes(photoSessionProgress.currentFileSizeBytes)}`
                          : ''}
                      </Text>
                    ) : null}
                  </View>
                )}
                {photoSessionProgress.running && photoSessionProgress.total === 0 && (
                  <View style={layout.backupNote}>
                    <ActivityIndicator size="small" color={c.amber} style={{ marginRight: 8 }} />
                    <Text style={{ fontSize: 12, color: c.ink3, lineHeight: 17, flex: 1 }}>
                      Scanning for new photos...
                    </Text>
                  </View>
                )}
                {/* Native backup progress (fallback when JS session not running) */}
                {!photoSessionProgress.running && backupProgress.inProgress > 0 && (
                  <View style={layout.backupNote}>
                    <ActivityIndicator size="small" color={c.amber} style={{ marginRight: 8 }} />
                    <Text style={{ fontSize: 12, color: c.ink3, lineHeight: 17, flex: 1 }}>
                      Backing up {backupProgress.inProgress} of {backupProgress.total} items...
                    </Text>
                  </View>
                )}
                {/* End-of-session result with retry */}
                {!photoSessionProgress.running && lastPhotoSession && (
                  <View style={[layout.backupNote, { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }]}>
                    <Text style={{ fontSize: 12, color: c.ink3, lineHeight: 17 }}>
                      {lastPhotoSession.uploaded} backed up
                      {lastPhotoSession.failed > 0 ? `, ${lastPhotoSession.failed} failed` : ''}
                      {lastSessionAt ? ` · ${timeAgo(lastSessionAt)}` : ''}
                    </Text>
                    {lastPhotoSession.failed > 0 && (
                      <TouchableOpacity
                        activeOpacity={0.6}
                        onPress={handleBackupNow}
                        disabled={backingUp}
                      >
                        <Text style={{ fontSize: 12, color: c.amber, fontWeight: '500' as const }}>
                          {backingUp ? 'Retrying…' : 'Retry camera roll backup'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
                {/* Server all-time stats when idle */}
                {!photoSessionProgress.running && !lastPhotoSession && serverPhotoStats && (
                  <View style={layout.backupNote}>
                    <Text style={{ fontSize: 12, color: c.ink3, lineHeight: 17, flex: 1 }}>
                      {(serverPhotoStats.backed_up ?? 0).toLocaleString()} photo{serverPhotoStats.backed_up !== 1 ? 's' : ''} backed up
                      {lastSessionAt ? ` · Last: ${timeAgo(lastSessionAt)}` : ''}
                    </Text>
                  </View>
                )}
                <RowDivider c={c} />
                <TouchableOpacity
                  style={layout.row}
                  activeOpacity={0.6}
                  onPress={handleBackupNow}
                  disabled={backingUp || photoSessionProgress.running}
                  accessibilityLabel="Back up camera roll now"
                  accessibilityRole="button"
                >
                  {backingUp || photoSessionProgress.running ? (
                    <ActivityIndicator size="small" color={c.amber} />
                  ) : (
                    <Text style={{ fontSize: 14, color: c.amber, fontWeight: '500' as const }}>
                      Back up camera roll now
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}
            <RowDivider c={c} />
            <ToggleRow
              label="Back up contacts"
              value={isContactsBackupEnabled}
              onValueChange={handleToggleContactsBackup}
              c={c}
            />
            {isContactsBackupEnabled && <BackupCategoryStatus stats={contactsStats} paused={backupPaused} c={c} />}
            {isContactsBackupEnabled && (
              <>
                <RowDivider c={c} />
                <TouchableOpacity
                  style={layout.row}
                  activeOpacity={0.6}
                  onPress={handleBackupContactsNow}
                  disabled={backingUpContacts}
                  accessibilityLabel="Back up contacts now"
                  accessibilityRole="button"
                >
                  {backingUpContacts ? (
                    <ActivityIndicator size="small" color={c.amber} />
                  ) : (
                    <Text style={{ fontSize: 14, color: c.amber, fontWeight: '500' as const }}>
                      Back up contacts now
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}
            <RowDivider c={c} />
            <ToggleRow
              label="Back up calendar"
              value={isCalendarBackupEnabled}
              onValueChange={handleToggleCalendarBackup}
              c={c}
            />
            {isCalendarBackupEnabled && <BackupCategoryStatus stats={calendarStats} paused={backupPaused} c={c} />}
            {isCalendarBackupEnabled && (
              <>
                <RowDivider c={c} />
                <TouchableOpacity
                  style={layout.row}
                  activeOpacity={0.6}
                  onPress={handleBackupCalendarNow}
                  disabled={backingUpCalendar}
                  accessibilityLabel="Back up calendar now"
                  accessibilityRole="button"
                >
                  {backingUpCalendar ? (
                    <ActivityIndicator size="small" color={c.amber} />
                  ) : (
                    <Text style={{ fontSize: 14, color: c.amber, fontWeight: '500' as const }}>
                      Back up calendar now
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
            {/* Master OS permission toggle */}
            <ToggleRow
              label="Push notifications"
              value={notificationsEnabled}
              onValueChange={handleNotificationsToggle}
              c={c}
            />
            {/* Per-category preferences — only shown when push is enabled */}
            {notificationsEnabled && (
              <>
                <View style={{ height: 1, backgroundColor: c.line }} />
                <ToggleRow
                  label="File updates"
                  subtitle="When a file changes from another device"
                  value={notifPrefs.file_updated}
                  onValueChange={(v) => void handleNotifPrefToggle('file_updated', v)}
                  disabled={notifPrefsLoading}
                  c={c}
                />
                <ToggleRow
                  label="Share received"
                  subtitle="When someone shares a file with you"
                  value={notifPrefs.share_received}
                  onValueChange={(v) => void handleNotifPrefToggle('share_received', v)}
                  disabled={notifPrefsLoading}
                  c={c}
                />
                <ToggleRow
                  label="Storage warnings"
                  subtitle="When you reach 80% or 100% of your quota"
                  value={notifPrefs.storage_warning}
                  onValueChange={(v) => void handleNotifPrefToggle('storage_warning', v)}
                  disabled={notifPrefsLoading}
                  c={c}
                />
                <ToggleRow
                  label="New device sign-in"
                  subtitle="Security alert when a new device accesses your account"
                  value={notifPrefs.new_device_login}
                  onValueChange={(v) => void handleNotifPrefToggle('new_device_login', v)}
                  disabled={notifPrefsLoading}
                  c={c}
                />
                <ToggleRow
                  label="Backup complete"
                  subtitle="When photo backup finishes"
                  value={notifPrefs.backup_complete}
                  onValueChange={(v) => void handleNotifPrefToggle('backup_complete', v)}
                  disabled={notifPrefsLoading}
                  c={c}
                />
              </>
            )}
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

        {/* ---- Privacy ---- */}
        <View style={layout.section}>
          <SectionHeader title="Privacy" c={c} />
          <View style={[layout.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <SettingsRow
              label="Privacy settings"
              icon="shield-outline"
              onPress={() => navigation.navigate('Privacy')}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Download my data"
              icon="download-outline"
              onPress={() => { void handleDownloadMyData(); }}
              c={c}
            />
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
              label="API environment"
              icon="server-outline"
              value={apiEnvironment.label}
              showChevron={false}
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
              label="Source code"
              value="GitHub"
              icon="code-slash-outline"
              onPress={() => { void Linking.openURL('https://github.com/beebeeb-io/mobile'); }}
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
              label="Acceptable use policy"
              icon="document-outline"
              onPress={handleAcceptableUse}
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
          <SectionNote text={`API target: ${apiEnvironment.baseUrl}`} c={c} />
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
          <Text style={{ fontSize: 10, color: c.ink4 }}>Open-source client.</Text>
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
