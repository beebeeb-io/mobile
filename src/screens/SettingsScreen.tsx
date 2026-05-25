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
import {
  DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
  type BackupNotificationSettings,
} from '../lib/backup-notification-policy';
import {
  getBackupNotificationSettings,
  setBackupNotificationSetting,
} from '../lib/backup-notification-settings';
import { writeWidgetData } from '../utils/widgetData';
import {
  getStorageUsage,
  getPreference,
  setPreference,
  getSubscription,
  getRegion,
  getNotificationPreferences,
  setNotificationPreferences,
  getToken,
  getUserRegion,
  setUserRegion,
  getApiEnvironment,
  type StorageUsage,
  type Subscription,
  type Region,
  type MobileNotificationPreferences,
  type AvailableRegion,
} from '../lib/api';
import {
  initDatabase as initBackupDb,
  getUploadedCount,
  getTotalCount,
  getUploadedBytes,
  getTotalBytes,
  getStatusCounts,
  getTotalUploadedBytes,
} from '../services/BackupDatabase';
import {
  initializeBackup,
  disableBackup,
  ensureBackupFolders,
  getDeviceManifest,
  updateBackupCategoryState,
  getDeletionBehavior,
  setDeletionBehavior,
  getKeepVaultUnlocked,
  setKeepVaultUnlocked,
  type BackupCategory,
  type DeviceManifest,
} from '../services/BackupService';
import type { RootStackParamList } from '../App';
import { NativeSwitch } from '../components/NativeSwitch';
import DevicesSection from '../components/settings/DevicesSection';
import { markUnlocked } from '../lib/lock-state';
import { mountTrustedFileProvider, populateFileProviderCache, removeTrustedFileProvider } from '../lib/file-provider-mount';
import { NOTIFICATIONS_OPT_OUT_KEY, registerForPushNotifications, unregisterPushToken } from '../lib/push-notifications';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';

const BIOMETRIC_PREF_KEY = 'beebeeb_biometric_lock';
const BIOMETRIC_DELAY_KEY = 'beebeeb_biometric_delay';
const CONTACTS_LAST_SCAN_KEY = 'beebeeb_contacts_last_scan_at';
const CALENDAR_LAST_SCAN_KEY = 'beebeeb_calendar_last_scan_at';
const CONTACTS_LAST_SCAN_COUNT_KEY = 'beebeeb_contacts_last_scan_count';
const CALENDAR_LAST_SCAN_COUNT_KEY = 'beebeeb_calendar_last_scan_count';
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
  label, value, badge, onPress, danger, showChevron = true, icon, c,
}: {
  label: string;
  value?: string;
  badge?: string;
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
        {badge != null && (
          <View style={{
            borderRadius: 5,
            backgroundColor: c.paper2,
            borderWidth: 1,
            borderColor: c.line,
            paddingHorizontal: 6,
            paddingVertical: 2,
          }}>
            <Text style={{ fontSize: 10, fontWeight: '600' as const, color: c.ink3 }}>
              {badge}
            </Text>
          </View>
        )}
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
  hasScanned: boolean;
}

const EMPTY_CATEGORY_STATS: CategoryStats = {
  uploadedCount: 0,
  totalCount: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  lastSyncAt: null,
  syncing: false,
  legacyCount: 0,
  hasScanned: false,
};

function BackupCategoryStatus({ stats, paused, c }: { stats: CategoryStats; paused?: boolean; c: C }) {
  const { uploadedCount, totalCount, uploadedBytes, totalBytes, lastSyncAt, syncing, legacyCount, hasScanned } = stats;

  if (paused && totalCount > uploadedCount) {
    return (
      <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.ink4 }} />
        <Text style={{ fontSize: 11, color: c.ink3, flex: 1 }}>
          Paused · waiting for Wi-Fi · {uploadedCount} of {totalCount} items backed up
        </Text>
      </View>
    );
  }

  if (syncing && totalCount === 0) {
    return (
      <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2 }}>
        <Text style={{ fontSize: 11, color: c.ink3 }}>Scanning...</Text>
      </View>
    );
  }

  if (totalCount === 0 && !lastSyncAt && !syncing && legacyCount === 0 && !hasScanned) {
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
    line = `${uploadedCount} of ${totalCount} items backed up · ${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`;
  } else if (lastSyncAt) {
    line = `Last backup: ${timeAgo(lastSyncAt)} · ${uploadedCount} items · ${formatBytes(uploadedBytes)}`;
  } else if (hasScanned && totalCount === 0) {
    line = 'Last scan found no items to back up';
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
  const [fileProviderMounted, setFileProviderMounted] = useState(false);
  const [loadingFileProvider, setLoadingFileProvider] = useState(Platform.OS === 'ios');
  const [updatingFileProviderMount, setUpdatingFileProviderMount] = useState(false);

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
  const [backupNotifPrefs, setBackupNotifPrefs] = useState<BackupNotificationSettings>(
    DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
  );
  const [backupNotifPrefsLoading, setBackupNotifPrefsLoading] = useState(false);

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

  // Camera roll status (from BackupDatabase getStatusCounts + getTotalUploadedBytes)
  const [cameraRollStatusCounts, setCameraRollStatusCounts] = useState<Record<string, number>>({});
  const [cameraRollTotalBytes, setCameraRollTotalBytes] = useState(0);
  const [cameraRollTotalCount, setCameraRollTotalCount] = useState(0);

  // Advanced backup section toggle
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  // Deletion preference
  const [deletionBehavior, setDeletionBehaviorState] = useState<'keep' | 'trash'>('keep');

  // Keep vault unlocked for background backup
  const [keepVaultUnlocked, setKeepVaultUnlockedState] = useState(false);

  const [contactsLastSessionAt, setContactsLastSessionAt] = useState<string | null>(null);
  const [calendarLastSessionAt, setCalendarLastSessionAt] = useState<string | null>(null);
  const [contactsLastSessionCount, setContactsLastSessionCount] = useState(0);
  const [calendarLastSessionCount, setCalendarLastSessionCount] = useState(0);

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
      let mounted = state.mounted ?? state.showInFiles;
      if (state.supported && state.showInFiles && !mounted) {
        try {
          const repaired = await BeebeebCrypto.registerFileProviderDomain();
          mounted = repaired.registered && repaired.cacheDatabaseReady !== false;
        } catch {
          mounted = false;
        }
      }
      setFileProviderMounted(mounted);
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

  // Load deletion behavior preference
  const loadDeletionBehavior = useCallback(async () => {
    try {
      const behavior = await getDeletionBehavior();
      setDeletionBehaviorState(behavior);
    } catch {
      // Default to 'keep'
    }
  }, []);

  // Load keep-vault-unlocked preference
  const loadKeepVaultUnlocked = useCallback(async () => {
    try {
      const enabled = await getKeepVaultUnlocked();
      setKeepVaultUnlockedState(enabled);
    } catch {
      // Default to false
    }
  }, []);

  // Refresh camera roll status from BackupDatabase + MediaLibrary
  const refreshCameraRollStatus = useCallback(async () => {
    try {
      const [counts, totalBytes] = await Promise.all([
        getStatusCounts(),
        getTotalUploadedBytes(),
      ]);
      setCameraRollStatusCounts(counts);
      setCameraRollTotalBytes(totalBytes);

      // Get total count from MediaLibrary. Count videos when video backup is
      // enabled so the "items" label does not show a photo-only total.
      try {
        const [photoAssets, videoAssets] = await Promise.all([
          MediaLibrary.getAssetsAsync({
            mediaType: MediaLibrary.MediaType.photo,
            first: 0,
          }),
          includeVideos
            ? MediaLibrary.getAssetsAsync({
                mediaType: MediaLibrary.MediaType.video,
                first: 0,
              })
            : Promise.resolve({ totalCount: 0 }),
        ]);
        setCameraRollTotalCount((photoAssets?.totalCount ?? 0) + (videoAssets?.totalCount ?? 0));
      } catch {
        // MediaLibrary may not be available
      }
    } catch {
      // Database may not be initialized yet
    }
  }, [includeVideos]);

  useEffect(() => {
    fetchUsage();
    loadBiometricPrefs();
    loadFileProviderPrefs();
    loadAccountData();
    loadStorageRegionPref();
    if (isPhotoBackupEnabled) {
      void refreshCameraRollStatus();
      void loadDeletionBehavior();
      void loadKeepVaultUnlocked();
    }
    SecureStore.getItemAsync(CONTACTS_LAST_SCAN_KEY).then(setContactsLastSessionAt).catch(() => {});
    SecureStore.getItemAsync(CALENDAR_LAST_SCAN_KEY).then(setCalendarLastSessionAt).catch(() => {});
    SecureStore.getItemAsync(CONTACTS_LAST_SCAN_COUNT_KEY)
      .then((value) => { setContactsLastSessionCount(value ? parseInt(value, 10) || 0 : 0); })
      .catch(() => {});
    SecureStore.getItemAsync(CALENDAR_LAST_SCAN_COUNT_KEY)
      .then((value) => { setCalendarLastSessionCount(value ? parseInt(value, 10) || 0 : 0); })
      .catch(() => {});
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
    getBackupNotificationSettings().then(setBackupNotifPrefs).catch(() => {});
  }, [fetchUsage, loadBiometricPrefs, loadFileProviderPrefs, loadAccountData, loadStorageRegionPref, isPhotoBackupEnabled, refreshCameraRollStatus, loadDeletionBehavior, loadKeepVaultUnlocked]);

  // Refresh camera roll status whenever native backup work settles.
  useEffect(() => {
    if (
      isPhotoBackupEnabled &&
      backupProgress.inProgress === 0 &&
      !['preparing', 'encrypting', 'uploading'].includes(backupProgress.state)
    ) {
      void refreshCameraRollStatus();
    }
  }, [backupProgress.inProgress, backupProgress.state, isPhotoBackupEnabled, refreshCameraRollStatus]);

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

    const localPhotoUploaded = photoUploaded + videoUploaded;
    const localPhotoTotal = photoTotal + videoTotal;
    const photoLastSyncAt = manifest?.backups.camera_roll.last_sync ?? null;
    setPhotoStats({
      uploadedCount: localPhotoUploaded,
      totalCount: localPhotoTotal,
      uploadedBytes: photoUpBytes + videoUpBytes,
      totalBytes: photoTotalBytes + videoTotalBytes,
      lastSyncAt: photoLastSyncAt,
      syncing,
      legacyCount: manifest?.backups.camera_roll.legacy_items_migrated ?? 0,
      hasScanned: photoLastSyncAt != null || localPhotoUploaded > 0,
    });
    const contactsLastSyncAt = manifest?.backups.contacts.last_sync ?? contactsLastSessionAt ?? null;
    const calendarLastSyncAt = manifest?.backups.calendar.last_sync ?? calendarLastSessionAt ?? null;
    setContactsStats({
      uploadedCount: Math.max(contactUploaded, contactsLastSessionCount),
      totalCount: Math.max(contactTotal, contactsLastSessionCount),
      uploadedBytes: contactUpBytes,
      totalBytes: contactTotalBytes,
      lastSyncAt: contactsLastSyncAt,
      syncing,
      legacyCount: manifest?.backups.contacts.legacy_items_migrated ?? 0,
      hasScanned: contactsLastSyncAt != null,
    });
    setCalendarStats({
      uploadedCount: Math.max(calUploaded, calendarLastSessionCount),
      totalCount: Math.max(calTotal, calendarLastSessionCount),
      uploadedBytes: calUpBytes,
      totalBytes: calTotalBytes,
      lastSyncAt: calendarLastSyncAt,
      syncing,
      legacyCount: manifest?.backups.calendar.legacy_items_migrated ?? 0,
      hasScanned: calendarLastSyncAt != null,
    });
  }, [syncing, contactsLastSessionAt, calendarLastSessionAt, contactsLastSessionCount, calendarLastSessionCount]);

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
        isPhotoBackupEnabled ? refreshCameraRollStatus() : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchUsage, loadBiometricPrefs, loadFileProviderPrefs, loadAccountData, loadStorageRegionPref, isPhotoBackupEnabled, refreshCameraRollStatus]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleBiometricToggle = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      setBiometricEnabled(false);
      try {
        await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, 'false');
        markUnlocked();
      } catch {
        setBiometricEnabled(true);
        Alert.alert('Face ID lock could not be disabled', 'Please try again.');
        return;
      }

      try {
        await crypto.setBiometricRequirement(false);
      } catch {
        showToast({
          type: 'info',
          message: 'Face ID lock is off. Local key protection will update after the next vault unlock.',
        });
      }
      return;
    }

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
      await crypto.setBiometricRequirement(true);
    } catch {
      Alert.alert(
        'Face ID setup failed',
        'Unlock Beebeeb with your recovery phrase and try again. The local vault must be open before changing Face ID protection.',
      );
      return;
    }
    setBiometricEnabled(true);
    await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, 'true');
  }, [crypto, showToast]);

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

  const handleFileProviderMountToggle = useCallback(async (enabled: boolean) => {
    const previous = fileProviderMounted;
    setFileProviderMounted(enabled);
    setUpdatingFileProviderMount(true);
    try {
      const result = enabled
        ? await mountTrustedFileProvider({ vaultUnlocked: crypto.isUnlocked })
        : await removeTrustedFileProvider();
      const mounted = enabled && result.registered && result.cacheDatabaseReady !== false;
      setFileProviderSupported(result.supported);
      setFileProviderMounted(mounted);
      if (mounted && crypto.isUnlocked) {
        void populateFileProviderCache(crypto.decryptMetadata).catch(() => {});
      }
      showToast({
        type: mounted || !enabled ? 'success' : 'info',
        message: mounted
          ? 'Beebeeb is mounted in Files'
          : enabled
            ? 'Files integration is unavailable on this device'
            : 'Beebeeb was removed from Files',
      });
    } catch (err) {
      setFileProviderMounted(previous);
      Alert.alert(enabled ? 'Files mount failed' : 'Files removal failed', errorMessage(err));
    } finally {
      setUpdatingFileProviderMount(false);
    }
  }, [crypto.decryptMetadata, crypto.isUnlocked, fileProviderMounted, showToast]);

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

  const handleBackupNotifPrefToggle = useCallback(
    async (key: keyof BackupNotificationSettings, value: boolean) => {
      const previous = backupNotifPrefs;
      const next = { ...backupNotifPrefs, [key]: value };
      setBackupNotifPrefs(next);
      setBackupNotifPrefsLoading(true);
      try {
        const saved = await setBackupNotificationSetting(key, value);
        setBackupNotifPrefs(saved);
      } catch {
        setBackupNotifPrefs(previous);
      } finally {
        setBackupNotifPrefsLoading(false);
      }
    },
    [backupNotifPrefs],
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
      void refreshCameraRollStatus();
    }
  }, [triggerBackupNow, refreshCameraRollStatus]);

  const handleDeletionBehaviorChange = useCallback(async (behavior: 'keep' | 'trash') => {
    setDeletionBehaviorState(behavior);
    try {
      await setDeletionBehavior(behavior);
    } catch (err) {
      console.warn('[SettingsScreen] failed to save deletion preference:', err);
    }
  }, []);

  const handleKeepVaultUnlockedChange = useCallback(async (value: boolean) => {
    setKeepVaultUnlockedState(value);
    try {
      await setKeepVaultUnlocked(value);
    } catch (err) {
      console.warn('[SettingsScreen] failed to save keep-vault-unlocked preference:', err);
    }
  }, []);

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
    setContactsStats((prev) => ({ ...prev, syncing: true }));
    try {
      await initializeBackup('contacts');
      const token = await getToken();
      if (!token) throw new Error('Session expired');

      // Contact count is now best-effort from expo-contacts purely for the UI;
      // Swift `ContactsBackupManager` re-enumerates via CNContactStore for the
      // actual vCard serialization (richer field coverage than the old TS path).
      const probe = await Contacts.getContactsAsync({ fields: [] }).catch(() => null);
      const contactCount = probe?.data?.length ?? 0;

      // Trigger the native backup. Swift handles enumeration, hashing,
      // RFC 6350 serialization (CNContactVCardSerialization), encryption, and
      // upload off the JS thread. Fire-and-forget — completion is observable
      // later via the bridge surface task 0437 lands.
      await BeebeebCrypto.enableContactsBackup(token);

      const timestamp = new Date().toISOString();
      await updateBackupCategoryState('contacts', {
        enabled: true,
        last_sync: timestamp,
        items_synced: contactCount,
        contact_count: contactCount,
      });
      setContactsLastSessionAt(timestamp);
      setContactsLastSessionCount(contactCount);
      await SecureStore.setItemAsync(CONTACTS_LAST_SCAN_KEY, timestamp).catch(() => {});
      await SecureStore.setItemAsync(CONTACTS_LAST_SCAN_COUNT_KEY, String(contactCount)).catch(() => {});
      await refreshBackupStats();
      setContactsStats((prev) => ({
        ...prev,
        uploadedCount: contactCount,
        totalCount: Math.max(prev.totalCount, contactCount),
        lastSyncAt: timestamp,
        syncing: false,
        hasScanned: true,
      }));
      showToast({
        type: 'success',
        message: `Contacts backup queued · ${contactCount} contact${contactCount === 1 ? '' : 's'}`,
      });
    } catch (err) {
      console.warn('[SettingsScreen] contacts backup failed:', err);
      Alert.alert('Contacts backup failed', errorMessage(err));
    } finally {
      setBackingUpContacts(false);
      setContactsStats((prev) => ({ ...prev, syncing: false }));
    }
  }, [refreshBackupStats, showToast]);

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
    setCalendarStats((prev) => ({ ...prev, syncing: true }));
    try {
      await initializeBackup('calendar');
      const token = await getToken();
      if (!token) throw new Error('Session expired');

      // Counts for UI display only — Swift `CalendarBackupManager` re-enumerates
      // via EventKit when it builds the per-calendar .ics files (now RFC 5545
      // compliant + per-calendar split after 0439's Swift fixes).
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT).catch(() => []);
      const calendarCount = Array.isArray(calendars) ? calendars.length : 0;
      const now = new Date();
      const windowStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      const windowEnd = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
      let eventCount = 0;
      if (calendarCount > 0) {
        const calIds = calendars.map((c: { id: string }) => c.id);
        const events = await Calendar.getEventsAsync(calIds, windowStart, windowEnd).catch(() => []);
        eventCount = Array.isArray(events) ? events.length : 0;
      }

      // Trigger the native backup. Swift handles enumeration, RFC 5545
      // serialization, encryption, and upload off the JS thread.
      await BeebeebCrypto.enableCalendarBackup(token);

      const timestamp = new Date().toISOString();
      await updateBackupCategoryState('calendar', {
        enabled: true,
        last_sync: timestamp,
        items_synced: eventCount,
        calendar_count: calendarCount,
      });
      setCalendarLastSessionAt(timestamp);
      setCalendarLastSessionCount(eventCount);
      await SecureStore.setItemAsync(CALENDAR_LAST_SCAN_KEY, timestamp).catch(() => {});
      await SecureStore.setItemAsync(CALENDAR_LAST_SCAN_COUNT_KEY, String(eventCount)).catch(() => {});
      await refreshBackupStats();
      setCalendarStats((prev) => ({
        ...prev,
        uploadedCount: eventCount,
        totalCount: Math.max(prev.totalCount, eventCount),
        lastSyncAt: timestamp,
        syncing: false,
        hasScanned: true,
      }));
      showToast({
        type: 'success',
        message: `Calendar backup queued · ${eventCount} event${eventCount === 1 ? '' : 's'} across ${calendarCount} calendar${calendarCount === 1 ? '' : 's'}`,
      });
    } catch (err) {
      console.warn('[SettingsScreen] calendar backup failed:', err);
      Alert.alert('Calendar backup failed', errorMessage(err));
    } finally {
      setBackingUpCalendar(false);
      setCalendarStats((prev) => ({ ...prev, syncing: false }));
    }
  }, [refreshBackupStats, showToast]);

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
  const cameraBackupActive =
    ['preparing', 'encrypting', 'uploading'].includes(backupProgress.state) ||
    backupProgress.inProgress > 0;

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
                  label="Mount Beebeeb in Files"
                  subtitle="Anyone who can unlock this iPhone can access the mounted Files location."
                  value={fileProviderMounted}
                  onValueChange={handleFileProviderMountToggle}
                  disabled={loadingFileProvider || updatingFileProviderMount}
                  c={c}
                />
                {fileProviderMounted && (
                  <>
                    <RowDivider c={c} />
                    <SettingsRow
                      label="Remove Files access"
                      value={updatingFileProviderMount ? 'Removing...' : 'Mounted'}
                      icon="folder-open-outline"
                      onPress={updatingFileProviderMount ? undefined : () => handleFileProviderMountToggle(false)}
                      c={c}
                    />
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
            {/* ── Camera roll status line ── */}
            {isPhotoBackupEnabled && (() => {
              const backedUp = (cameraRollStatusCounts['uploaded'] ?? 0) + (cameraRollStatusCounts['orphaned'] ?? 0);
              const totalPhotos = cameraRollTotalCount;

              if (backupPaused) {
                return (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.ink4 }} />
                    <Text style={{ fontSize: 11, color: c.ink3, flex: 1 }}>
                      Paused -- waiting for Wi-Fi
                    </Text>
                  </View>
                );
              }

              if (cameraBackupActive) {
                return (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <ActivityIndicator size="small" color={c.amber} />
                    <Text style={{ fontSize: 11, color: c.ink3, flex: 1 }}>
                      {backupProgress.reason || `${backupProgress.completed} of ${backupProgress.total} ${includeVideos ? 'items' : 'photos'} backed up`}
                    </Text>
                  </View>
                );
              }

              if (totalPhotos > 0 || backedUp > 0) {
                const itemLabel = includeVideos ? 'items' : 'photos';
                return (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2 }}>
                    <Text style={{ fontSize: 11, color: c.ink3 }}>
                      {backedUp.toLocaleString()} of {totalPhotos.toLocaleString()} {itemLabel}{' '}
                      {cameraRollTotalBytes > 0 ? `· ${formatBytes(cameraRollTotalBytes)}` : ''}
                    </Text>
                  </View>
                );
              }

              return (
                <View style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2 }}>
                  <Text style={{ fontSize: 11, color: c.ink3 }}>Waiting for first scan...</Text>
                </View>
              );
            })()}
            {isPhotoBackupEnabled && backupProgress.failed > 0 && (
              <TouchableOpacity
                style={{
                  paddingHorizontal: 12,
                  paddingBottom: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
                activeOpacity={0.6}
                onPress={() => navigation.navigate('BackupInsights')}
                accessibilityLabel={`${backupProgress.failed} backup item${backupProgress.failed === 1 ? '' : 's'} need attention`}
                accessibilityRole="button"
              >
                <Ionicons name="alert-circle-outline" size={15} color={c.red} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: '600' as const, color: c.red }}>
                    {backupProgress.failed.toLocaleString()} backup item{backupProgress.failed === 1 ? '' : 's'} need attention
                  </Text>
                  <Text style={{ fontSize: 10, color: c.ink3, marginTop: 1 }}>
                    Inspect details below; retry from this Backup section.
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            {isPhotoBackupEnabled && (
              <>
                <RowDivider c={c} />
                <TouchableOpacity
                  style={layout.row}
                  activeOpacity={0.6}
                  onPress={handleBackupNow}
                  disabled={backingUp || cameraBackupActive}
                  accessibilityLabel="Back up camera roll now"
                  accessibilityRole="button"
                >
                  {backingUp || cameraBackupActive ? (
                    <ActivityIndicator size="small" color={c.amber} style={{ marginRight: 10 }} />
                  ) : (
                    <Ionicons name="cloud-upload-outline" size={18} color={c.amber} style={{ marginRight: 10 }} />
                  )}
                  <Text style={{ flex: 1, fontSize: 14, color: c.amber, fontWeight: '500' as const }}>
                    {backupProgress.failed > 0 ? 'Retry camera roll backup' : 'Back up camera roll now'}
                  </Text>
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
                    <ActivityIndicator size="small" color={c.amber} style={{ marginRight: 10 }} />
                  ) : (
                    <Ionicons name="people-outline" size={18} color={c.amber} style={{ marginRight: 10 }} />
                  )}
                  <Text style={{ flex: 1, fontSize: 14, color: c.amber, fontWeight: '500' as const }}>
                    Back up contacts now
                  </Text>
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
                    <ActivityIndicator size="small" color={c.amber} style={{ marginRight: 10 }} />
                  ) : (
                    <Ionicons name="calendar-outline" size={18} color={c.amber} style={{ marginRight: 10 }} />
                  )}
                  <Text style={{ flex: 1, fontSize: 14, color: c.amber, fontWeight: '500' as const }}>
                    Back up calendar now
                  </Text>
                </TouchableOpacity>
              </>
            )}
            <RowDivider c={c} />
            <TouchableOpacity
              style={layout.row}
              activeOpacity={0.6}
              onPress={() => setAdvancedExpanded((prev) => !prev)}
              accessibilityLabel={advancedExpanded ? 'Collapse advanced backup options' : 'Expand advanced backup options'}
              accessibilityRole="button"
            >
              <Ionicons
                name={advancedExpanded ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={c.ink3}
                style={{ marginRight: 8 }}
              />
              <Text style={{ flex: 1, fontSize: 14, fontWeight: '400' as const, color: c.ink }}>
                Advanced
              </Text>
            </TouchableOpacity>
            {advancedExpanded && (
              <>
                <RowDivider c={c} />
                <ToggleRow
                  label="Photos and videos"
                  subtitle="Back up videos in addition to photos. Videos can be large -- backed up over Wi-Fi only."
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
                <RowDivider c={c} />
                <ToggleRow
                  label="Keep vault unlocked for backup"
                  subtitle="Your encryption key stays securely on this device so backups continue in the background."
                  value={keepVaultUnlocked}
                  onValueChange={handleKeepVaultUnlockedChange}
                  indent
                  c={c}
                />
                <RowDivider c={c} />
                <View style={{ paddingHorizontal: 12, paddingVertical: 10, paddingLeft: 28 }}>
                  <Text style={{ fontSize: 13, fontWeight: '400' as const, color: c.ink, marginBottom: 8 }}>
                    When removed from device
                  </Text>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}
                    activeOpacity={0.6}
                    onPress={() => void handleDeletionBehaviorChange('keep')}
                  >
                    <View style={[layout.regionRadio, { borderColor: deletionBehavior === 'keep' ? c.amber : c.ink4 }]}>
                      {deletionBehavior === 'keep' && <View style={[layout.regionRadioDot, { backgroundColor: c.amber }]} />}
                    </View>
                    <Text style={{ fontSize: 13, color: c.ink }}>Keep in cloud</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, marginTop: 4 }}
                    activeOpacity={0.6}
                    onPress={() => void handleDeletionBehaviorChange('trash')}
                  >
                    <View style={[layout.regionRadio, { borderColor: deletionBehavior === 'trash' ? c.amber : c.ink4 }]}>
                      {deletionBehavior === 'trash' && <View style={[layout.regionRadioDot, { backgroundColor: c.amber }]} />}
                    </View>
                    <Text style={{ fontSize: 13, color: c.ink }}>Move to Beebeeb trash</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
            <RowDivider c={c} />
            <SettingsRow
              label="Backup insights"
              onPress={() => navigation.navigate('BackupInsights')}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Backup guides"
              onPress={() => navigation.navigate('BackupGuides')}
              c={c}
            />
          </View>
        </View>

        {/* ---- Devices & Backups ---- */}
        <View style={layout.section}>
          <SectionHeader title="Devices & Backups" c={c} />
          <DevicesSection c={c} />
          <SectionNote
            text="Devices and their sync/backup sessions. Status updates every 30 seconds."
            c={c}
          />
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
                <View style={{ height: 1, backgroundColor: c.line }} />
                <ToggleRow
                  label="Photo backup summaries"
                  subtitle="Example: Beebeeb backed up 12 new photos in the last 24 hours"
                  value={backupNotifPrefs.backupSummaries}
                  onValueChange={(v) => void handleBackupNotifPrefToggle('backupSummaries', v)}
                  disabled={backupNotifPrefsLoading}
                  c={c}
                />
                <ToggleRow
                  label="No-change check-ins"
                  subtitle="Example: Beebeeb checked your camera roll. Nothing new to back up."
                  value={backupNotifPrefs.noChangeCheckins}
                  onValueChange={(v) => void handleBackupNotifPrefToggle('noChangeCheckins', v)}
                  disabled={backupNotifPrefsLoading}
                  c={c}
                />
                <ToggleRow
                  label="Backup needs attention"
                  subtitle="Example: Open Beebeeb to unlock photo backup"
                  value={backupNotifPrefs.actionNeeded}
                  onValueChange={(v) => void handleBackupNotifPrefToggle('actionNeeded', v)}
                  disabled={backupNotifPrefsLoading}
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
              badge="Coming soon"
              showChevron={false}
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
              badge="Coming soon"
              showChevron={false}
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
            <RowDivider c={c} />
            <SettingsRow
              label="Speed test"
              icon="speedometer-outline"
              onPress={() => navigation.navigate('Speedtest')}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Advanced"
              icon="options-outline"
              onPress={() => navigation.navigate('AdvancedSettings')}
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
