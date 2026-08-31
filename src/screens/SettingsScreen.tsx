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
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, spacing, surfacesFor, typeScale, type Colors } from '../theme';
import { useAuth } from '../lib/auth';
import { useBackup } from '../lib/backup-context';
import { useCrypto } from '../lib/crypto-context';
import { useTheme, type ThemeMode } from '../lib/theme-context';
import { ScrollEdgeBlur } from '../components/glass';
import { useToast } from '../lib/toast-context';
import { useNetworkStatus } from '../lib/useNetworkStatus';
import { recordRuntimeTrace } from '../lib/runtime-trace';
import { formatBytes } from '../lib/format';
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
  getCategorySummaries,
  getStatusCounts,
  getTotalUploadedBytes,
  type BackupAssetStatus,
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

function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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

const REGIONS: ReadonlyArray<{ poolName: string; label: string; subtitle: string; available: boolean }> = [
  { poolName: 'europe', label: 'Europe', subtitle: 'Anywhere in Europe', available: true },
  { poolName: 'falkenstein-de', label: 'Falkenstein', subtitle: 'Preference or force', available: true },
  { poolName: 'helsinki-fi', label: 'Helsinki', subtitle: 'Preference or force', available: false },
  { poolName: 'ede-nl', label: 'Ede', subtitle: 'Preference or force', available: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  scrollContent: { paddingHorizontal: 16 },
  floatingTitle: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  section: { marginBottom: 14 },
  // 1314 — grouped-inset: an opaque cell, not an outlined box.
  card: { borderRadius: 26, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, minHeight: 46 },
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
        recordRuntimeTrace('settings.row.press', { label, value, danger: danger === true });
        Haptics.selectionAsync();
        onPress();
      }
    : undefined;

  // 1104 — stable id for Maestro/E2E (RN testID → iOS accessibilityIdentifier),
  // derived deterministically from the label. Keeps accessibilityLabel for VoiceOver.
  const testID = `settings-row-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

  return (
    <TouchableOpacity
      style={layout.row}
      activeOpacity={onPress ? 0.6 : 1}
      onPress={handlePress}
      disabled={!onPress}
      testID={testID}
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
      {/* 1314 — canvas grouped-inset rows are 17pt, not 14. */}
      <Text style={[typeScale.body, { flex: 1, color: danger ? c.red : c.ink }]}>
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
        <Text style={[typeScale.body, { color: c.ink }]}>{label}</Text>
        {subtitle && (
          <Text style={[typeScale.footnote, { color: c.ink3, marginTop: 2 }]}>
            {subtitle}
          </Text>
        )}
      </View>
      <NativeSwitch
        value={value}
        onValueChange={(v) => {
          recordRuntimeTrace('settings.toggle.change', {
            label,
            nextValue: v,
            previousValue: value,
            disabled: disabled === true,
          });
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
  lastScanAt: string | null;
  syncing: boolean;
  legacyCount: number;
  hasScanned: boolean;
  hasKnownBackupState: boolean;
}

const EMPTY_CATEGORY_STATS: CategoryStats = {
  uploadedCount: 0,
  totalCount: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  lastSyncAt: null,
  lastScanAt: null,
  syncing: false,
  legacyCount: 0,
  hasScanned: false,
  hasKnownBackupState: false,
};

function categoryStatsHasEvidence(stats: CategoryStats): boolean {
  return Boolean(
    stats.lastSyncAt ||
    stats.lastScanAt ||
    stats.hasKnownBackupState ||
    stats.hasScanned ||
    stats.legacyCount > 0 ||
    stats.totalCount > 0 ||
    stats.uploadedCount > 0
  );
}

function mergeCategoryStatsWithNativeStatus(
  stats: CategoryStats,
  nativeStatus: BeebeebCrypto.NativeCategoryBackupStatus | null,
): CategoryStats {
  if (!nativeStatus) return stats;
  const nativeCount = nativeStatus.lastScanCount ?? 0;
  const hasNativeState = Boolean(
    nativeStatus.hasKnownBackupState ||
    nativeStatus.lastScanAt ||
    nativeStatus.lastUploadAt ||
    nativeCount > 0
  );
  if (!hasNativeState) return stats;
  return {
    ...stats,
    uploadedCount: Math.max(stats.uploadedCount, nativeCount),
    totalCount: Math.max(stats.totalCount, nativeCount),
    lastSyncAt: stats.lastSyncAt ?? nativeStatus.lastUploadAt ?? null,
    lastScanAt: stats.lastScanAt ?? nativeStatus.lastScanAt ?? null,
    hasScanned: stats.hasScanned || hasNativeState,
    hasKnownBackupState: stats.hasKnownBackupState || Boolean(nativeStatus.hasKnownBackupState),
  };
}

const EMPTY_NATIVE_CATEGORY_STATUS: BeebeebCrypto.NativeCategoryBackupStatus = {
  lastScanAt: null,
  lastScanCount: 0,
  lastUploadAt: null,
  hasParentFolder: false,
  hasKnownBackupState: false,
};

const EMPTY_BACKUP_STATUS_COUNTS: Record<BackupAssetStatus, number> = {
  pending_upload: 0,
  staging: 0,
  staged_upload: 0,
  uploading: 0,
  uploaded: 0,
  pending_delete: 0,
  pending_reupload: 0,
  orphaned: 0,
  remote_deleted: 0,
  local_missing: 0,
  failed: 0,
};

function BackupCategoryStatus({
  stats,
  paused,
  c,
  label = 'Backup',
  itemSingular = 'item',
  itemPlural = 'items',
  onPress,
  checking = false,
}: {
  stats: CategoryStats;
  paused?: boolean;
  c: C;
  label?: string;
  itemSingular?: string;
  itemPlural?: string;
  onPress?: () => void;
  checking?: boolean;
}) {
  const {
    uploadedCount,
    totalCount,
    uploadedBytes,
    totalBytes,
    lastSyncAt,
    lastScanAt,
    syncing,
    legacyCount,
    hasScanned,
    hasKnownBackupState,
  } = stats;
  const itemNoun = (count: number) => count === 1 ? itemSingular : itemPlural;
  const progressLabel = totalCount > 0
    ? `${uploadedCount.toLocaleString()} of ${totalCount.toLocaleString()} ${itemNoun(totalCount)}`
    : null;
  const uploadedLabel = `${uploadedCount.toLocaleString()} ${itemNoun(uploadedCount)}`;
  const pct = totalCount > 0 ? Math.min(uploadedCount / totalCount, 1) : 0;
  const fillWidth = `${Math.max(pct * 100, 1)}%` as `${number}%`;
  const showBar = totalCount > 0;
  const hasEvidence = categoryStatsHasEvidence(stats);
  const dotColor = paused
    ? c.ink4
    : checking && !hasEvidence
      ? c.amber
      : syncing
        ? c.amber
        : lastSyncAt || lastScanAt || hasKnownBackupState || (hasScanned && totalCount === 0)
          ? c.green
          : c.ink4;
  const barColor = paused ? c.ink4 : syncing ? c.amber : c.green;

  let line: string;
  if (paused && totalCount > uploadedCount) {
    line = `Paused · waiting for Wi-Fi${progressLabel ? ` · ${progressLabel}` : ''}`;
  } else if (syncing && totalCount === 0) {
    line = `Scanning ${label.toLowerCase()}...`;
  } else if (checking && !hasEvidence) {
    line = `Checking ${label.toLowerCase()} backup...`;
  } else if (totalCount === 0 && !lastSyncAt && !lastScanAt && !syncing && legacyCount === 0 && !hasScanned && !hasKnownBackupState) {
    line = `Waiting for first ${label.toLowerCase()} scan`;
  } else if (syncing) {
    const byteLabel = totalBytes > 0 ? ` · ${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}` : '';
    line = `Updating ${label.toLowerCase()} backup · ${progressLabel ?? uploadedLabel}${byteLabel}`;
  } else if (lastSyncAt) {
    line = `Last backup: ${timeAgo(lastSyncAt)} · ${uploadedLabel}${uploadedBytes > 0 ? ` · ${formatBytes(uploadedBytes)}` : ''}`;
  } else if (lastScanAt && totalCount > 0) {
    line = `Last scan: ${timeAgo(lastScanAt)} · ${uploadedLabel}`;
  } else if (lastScanAt || (hasScanned && totalCount === 0)) {
    line = `Last scan found no ${itemPlural} to back up`;
  } else if (hasKnownBackupState) {
    line = `Backup is on · waiting for changes`;
  } else if (legacyCount > 0) {
    line = `${legacyCount.toLocaleString()} legacy ${itemNoun(legacyCount)} migrated from the old backup layout`;
  } else {
    line = `${progressLabel ?? uploadedLabel} backed up`;
  }
  if (legacyCount > 0 && lastSyncAt) {
    line += ` · ${legacyCount.toLocaleString()} legacy ${itemNoun(legacyCount)} migrated`;
  }

  return (
    <TouchableOpacity
      style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2, gap: 6 }}
      activeOpacity={0.6}
      onPress={onPress}
      accessibilityLabel={`View ${label.toLowerCase()} backup details`}
      accessibilityRole="button"
      disabled={!onPress}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} />
        <Text style={{ fontSize: 11, color: c.ink3, flex: 1 }}>
          {line}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={c.ink4} />
      </View>
      {showBar && (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.line2, overflow: 'hidden' }}>
          <View style={{ height: '100%', width: fillWidth, backgroundColor: barColor, borderRadius: 2 }} />
        </View>
      )}
    </TouchableOpacity>
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
  // limitBytes <= 0 = "no fixed cap" sentinel — never show "-1 B" or a bogus 0%.
  const hasCap = limitBytes > 0;
  const pct = hasCap ? Math.min(usedBytes / limitBytes, 1) : 0;
  const pctNum = Math.round(pct * 100);
  const barColor = pct > 0.9 ? c.red : pct > 0.75 ? c.amberDeep : c.amber;
  const fillWidth = `${Math.max(pct * 100, 1)}%` as `${number}%`;
  const barHeight = prominent ? 8 : 6;
  const usedLabel = formatBytes(usedBytes);
  const totalLabel = formatBytes(limitBytes);

  return (
    <View style={{ gap: 6 }}>
      {showPercent && (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: prominent ? 13 : 12, fontWeight: '600' as const, color: c.ink2 }}>
            Storage
          </Text>
          {hasCap ? (
            <Text style={{ fontSize: prominent ? 13 : 12, fontWeight: '600' as const, color: barColor }}>
              {pctNum}% used
            </Text>
          ) : null}
        </View>
      )}
      <View style={{ height: barHeight, borderRadius: barHeight / 2, backgroundColor: c.line, overflow: 'hidden' }}>
        <View style={{ height: '100%', borderRadius: barHeight / 2, width: fillWidth, backgroundColor: barColor }} />
      </View>
      <Text style={{ fontSize: 11, color: c.ink3 }}>
        {hasCap ? `${usedLabel} of ${totalLabel} used` : `${usedLabel} used`}
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
  const [backupStatsLoading, setBackupStatsLoading] = useState(true);
  const backupStatsRefreshInFlightRef = useRef(false);
  const backupStatsRefreshQueuedRef = useRef(false);
  const [photoAlbumsExpanded, setPhotoAlbumsExpanded] = useState(false);
  const [photoAlbumsLoading, setPhotoAlbumsLoading] = useState(false);
  const [photoAlbums, setPhotoAlbums] = useState<BeebeebCrypto.PhotoBackupAlbum[]>([]);
  const [selectedPhotoAlbumIds, setSelectedPhotoAlbumIds] = useState<string[]>([]);

  // Camera roll status (from BackupDatabase getStatusCounts + getTotalUploadedBytes)
  const [cameraRollStatusCounts, setCameraRollStatusCounts] = useState<Record<string, number>>({});
  const [cameraRollTotalBytes, setCameraRollTotalBytes] = useState(0);
  const [cameraRollTotalCount, setCameraRollTotalCount] = useState(0);
  const cameraRollStatusInFlightRef = useRef(false);

  // Advanced backup section toggle
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      recordRuntimeTrace('settings.screen.focus', {
        sections: [
          'Account',
          'Storage & plan',
          'Backup',
          'Devices',
          'Files',
          'Notifications',
          'Appearance',
          'Security',
          'Privacy & data',
          'Data residency',
          'Support',
          'About',
        ],
      });
      return () => {
        recordRuntimeTrace('settings.screen.blur');
      };
    }, []),
  );

  // Deletion preference
  const [deletionBehavior, setDeletionBehaviorState] = useState<'keep' | 'trash'>('keep');

  // Keep vault unlocked for background backup
  const [keepVaultUnlocked, setKeepVaultUnlockedState] = useState(false);

  const [contactsLastSessionAt, setContactsLastSessionAt] = useState<string | null>(null);
  const [calendarLastSessionAt, setCalendarLastSessionAt] = useState<string | null>(null);
  const [contactsLastSessionCount, setContactsLastSessionCount] = useState(0);
  const [calendarLastSessionCount, setCalendarLastSessionCount] = useState(0);
  const [contactsNativeStatus, setContactsNativeStatus] = useState<BeebeebCrypto.NativeCategoryBackupStatus | null>(null);
  const [calendarNativeStatus, setCalendarNativeStatus] = useState<BeebeebCrypto.NativeCategoryBackupStatus | null>(null);

  // Theme — sourced from global ThemeContext
  const { colors: c, resolved, mode: themePreference, setMode: handleThemeChange } = useTheme();
  // 1314 — measured height of the floating title, fed to the scroll inset.
  const [headerHeight, setHeaderHeight] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadNativeContactCalendarBackupStatus = useCallback(async () => {
    const started = Date.now();
    try {
      const [contacts, calendar] = await Promise.all([
        BeebeebCrypto.getContactsBackupStatus(),
        BeebeebCrypto.getCalendarBackupStatus(),
      ]);
      setContactsNativeStatus(contacts);
      setCalendarNativeStatus(calendar);
      recordRuntimeTrace('settings.backup.native_status.loaded', {
        durationMs: Date.now() - started,
        contactsKnown: Boolean(contacts.hasKnownBackupState || contacts.lastScanAt || contacts.lastUploadAt || contacts.lastScanCount > 0),
        calendarKnown: Boolean(calendar.hasKnownBackupState || calendar.lastScanAt || calendar.lastUploadAt || calendar.lastScanCount > 0),
      });
    } catch (err) {
      setContactsNativeStatus(EMPTY_NATIVE_CATEGORY_STATUS);
      setCalendarNativeStatus(EMPTY_NATIVE_CATEGORY_STATUS);
      recordRuntimeTrace('settings.backup.native_status.failed', {
        durationMs: Date.now() - started,
        error: errorMessage(err),
      });
      // Older native builds do not expose these status methods; Settings falls
      // back to legacy SecureStore and manifest data until the app is rebuilt.
    }
  }, []);

  const loadPhotoAlbumSelection = useCallback(async () => {
    if (Platform.OS !== 'ios') return;
    setPhotoAlbumsLoading(true);
    try {
      const [albums, selectedIds] = await Promise.all([
        BeebeebCrypto.listPhotoBackupAlbums(),
        BeebeebCrypto.getPhotoBackupSelectedAlbumIds(),
      ]);
      const filteredIds = selectedIds.filter((id) => albums.some((album) => album.id === id));
      setPhotoAlbums(albums);
      setSelectedPhotoAlbumIds(filteredIds);
      if (filteredIds.length !== selectedIds.length) {
        await BeebeebCrypto.setPhotoBackupSelectedAlbumIds(filteredIds);
      }
    } catch (err) {
      console.warn('[SettingsScreen] failed to load photo backup albums:', err);
    } finally {
      setPhotoAlbumsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadNativeContactCalendarBackupStatus();
      void loadPhotoAlbumSelection();
    }, [loadNativeContactCalendarBackupStatus, loadPhotoAlbumSelection]),
  );

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
      recordRuntimeTrace('settings.biometric_prefs.loaded', {
        supported,
        enrolled,
        enabled: stored === 'true',
        delayMs: delayRaw ? parseInt(delayRaw, 10) : 0,
      });
    } catch {
      // Biometrics unavailable on this device
      recordRuntimeTrace('settings.biometric_prefs.failed');
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
      // Only claim "mounted in Files" when iOS actually presents the location.
      // userVisibleRootError != null means the domain is registered on paper but
      // the user can't see it — treat that as not mounted.
      let mounted =
        (state.mounted ?? state.showInFiles) && !state.userVisibleRootError;
      if (state.supported && state.showInFiles && !mounted) {
        try {
          // The user enabled the trusted mount but it isn't visible. If the
          // domain itself is gone (showInFiles but !registered), force a
          // remove-then-add reset to get it back; otherwise re-register.
          const repaired =
            state.registered === false
              ? await BeebeebCrypto.resetFileProviderDomain()
              : await BeebeebCrypto.registerFileProviderDomain();
          mounted =
            repaired.registered &&
            repaired.cacheDatabaseReady !== false &&
            !repaired.userVisibleRootError;
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
    if (cameraRollStatusInFlightRef.current) return;
    cameraRollStatusInFlightRef.current = true;
    try {
      const [counts, totalBytes] = await Promise.all([
        withTimeout(getStatusCounts(), EMPTY_BACKUP_STATUS_COUNTS, 1_000),
        withTimeout(getTotalUploadedBytes(), 0, 1_000),
      ]);
      setCameraRollStatusCounts((prev) => Object.keys(counts).length > 0 ? counts : prev);
      setCameraRollTotalBytes((prev) => totalBytes > 0 ? totalBytes : prev);

      // Get total count from MediaLibrary. Count videos when video backup is
      // enabled so the "items" label does not show a photo-only total.
      try {
        const [photoAssets, videoAssets] = await Promise.all([
          withTimeout(
            MediaLibrary.getAssetsAsync({
              mediaType: MediaLibrary.MediaType.photo,
              first: 0,
            }),
            { totalCount: 0 },
            1_000,
          ),
          includeVideos
            ? withTimeout(
                MediaLibrary.getAssetsAsync({
                  mediaType: MediaLibrary.MediaType.video,
                  first: 0,
                }),
                { totalCount: 0 },
                1_000,
              )
            : Promise.resolve({ totalCount: 0 }),
        ]);
        const nextTotalCount = (photoAssets?.totalCount ?? 0) + (videoAssets?.totalCount ?? 0);
        setCameraRollTotalCount((prev) => nextTotalCount > 0 ? nextTotalCount : prev);
      } catch {
        // MediaLibrary may not be available
      }
    } catch {
      // Database may not be initialized yet
    } finally {
      cameraRollStatusInFlightRef.current = false;
    }
  }, [includeVideos]);

  useEffect(() => {
    fetchUsage();
    loadBiometricPrefs();
    loadFileProviderPrefs();
    loadAccountData();
    loadStorageRegionPref();
    void loadNativeContactCalendarBackupStatus();
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
  }, [fetchUsage, loadBiometricPrefs, loadFileProviderPrefs, loadAccountData, loadStorageRegionPref, loadNativeContactCalendarBackupStatus, isPhotoBackupEnabled, refreshCameraRollStatus, loadDeletionBehavior, loadKeepVaultUnlocked]);

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
    if (backupStatsRefreshInFlightRef.current) {
      backupStatsRefreshQueuedRef.current = true;
      return;
    }

    backupStatsRefreshInFlightRef.current = true;
    setBackupStatsLoading(true);
    const started = Date.now();
    try {
      do {
        backupStatsRefreshQueuedRef.current = false;
        try {
          await initBackupDb();
        } catch {
          return;
        }

        const [manifest, summaries] = await Promise.all([
          withTimeout(getDeviceManifest().catch(() => null), null as DeviceManifest | null, 1_200),
          withTimeout(getCategorySummaries(), {}, 1_200),
        ]);
        const emptySummary = {
          uploadedCount: 0,
          totalCount: 0,
          uploadedBytes: 0,
          totalBytes: 0,
        };
        const photoSummary = summaries.photo ?? emptySummary;
        const videoSummary = summaries.video ?? emptySummary;
        const contactSummary = summaries.contact ?? emptySummary;
        const calendarSummary = summaries.calendar ?? emptySummary;

        const localPhotoUploaded = photoSummary.uploadedCount + videoSummary.uploadedCount;
        const localPhotoTotal = photoSummary.totalCount + videoSummary.totalCount;
        const photoLastSyncAt = manifest?.backups.camera_roll.last_sync ?? null;
        setPhotoStats({
          uploadedCount: localPhotoUploaded,
          totalCount: localPhotoTotal,
          uploadedBytes: photoSummary.uploadedBytes + videoSummary.uploadedBytes,
          totalBytes: photoSummary.totalBytes + videoSummary.totalBytes,
          lastSyncAt: photoLastSyncAt,
          lastScanAt: photoLastSyncAt,
          syncing,
          legacyCount: manifest?.backups.camera_roll.legacy_items_migrated ?? 0,
          hasScanned: photoLastSyncAt != null || localPhotoUploaded > 0,
          hasKnownBackupState: photoLastSyncAt != null || localPhotoUploaded > 0,
        });
        const contactsNativeScanAt = contactsNativeStatus?.lastScanAt ?? null;
        const calendarNativeScanAt = calendarNativeStatus?.lastScanAt ?? null;
        const contactsNativeCount = contactsNativeStatus?.lastScanCount ?? 0;
        const calendarNativeCount = calendarNativeStatus?.lastScanCount ?? 0;
        const contactsLastScanAt = contactsNativeScanAt ?? contactsLastSessionAt ?? null;
        const calendarLastScanAt = calendarNativeScanAt ?? calendarLastSessionAt ?? null;
        const contactsLastSyncAt = manifest?.backups.contacts.last_sync ?? contactsNativeStatus?.lastUploadAt ?? null;
        const calendarLastSyncAt = manifest?.backups.calendar.last_sync ?? calendarNativeStatus?.lastUploadAt ?? null;
        const contactCount = Math.max(contactSummary.uploadedCount, contactSummary.totalCount, contactsNativeCount, contactsLastSessionCount);
        const calendarCount = Math.max(calendarSummary.uploadedCount, calendarSummary.totalCount, calendarNativeCount, calendarLastSessionCount);
        setContactsStats({
          uploadedCount: Math.max(contactSummary.uploadedCount, contactsNativeCount, contactsLastSessionCount),
          totalCount: contactCount,
          uploadedBytes: contactSummary.uploadedBytes,
          totalBytes: contactSummary.totalBytes,
          lastSyncAt: contactsLastSyncAt,
          lastScanAt: contactsLastScanAt,
          syncing: false,
          legacyCount: manifest?.backups.contacts.legacy_items_migrated ?? 0,
          hasScanned: contactsLastScanAt != null || contactCount > 0 || Boolean(contactsNativeStatus?.hasKnownBackupState),
          hasKnownBackupState: Boolean(contactsNativeStatus?.hasKnownBackupState),
        });
        setCalendarStats({
          uploadedCount: Math.max(calendarSummary.uploadedCount, calendarNativeCount, calendarLastSessionCount),
          totalCount: calendarCount,
          uploadedBytes: calendarSummary.uploadedBytes,
          totalBytes: calendarSummary.totalBytes,
          lastSyncAt: calendarLastSyncAt,
          lastScanAt: calendarLastScanAt,
          syncing: false,
          legacyCount: manifest?.backups.calendar.legacy_items_migrated ?? 0,
          hasScanned: calendarLastScanAt != null || calendarCount > 0 || Boolean(calendarNativeStatus?.hasKnownBackupState),
          hasKnownBackupState: Boolean(calendarNativeStatus?.hasKnownBackupState),
        });
      } while (backupStatsRefreshQueuedRef.current);
      recordRuntimeTrace('settings.backup.stats.loaded', {
        durationMs: Date.now() - started,
        queuedAgain: backupStatsRefreshQueuedRef.current,
      });
    } finally {
      backupStatsRefreshInFlightRef.current = false;
      setBackupStatsLoading(false);
    }
  }, [syncing, contactsLastSessionAt, calendarLastSessionAt, contactsLastSessionCount, calendarLastSessionCount, contactsNativeStatus, calendarNativeStatus]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshBackupStats();
    }, 250);
    return () => clearTimeout(timer);
  }, [
    refreshBackupStats,
    isPhotoBackupEnabled,
    isContactsBackupEnabled,
    isCalendarBackupEnabled,
    backupProgress.completed,
  ]);

  const handleRefresh = useCallback(async () => {
    recordRuntimeTrace('settings.refresh.request', { isPhotoBackupEnabled });
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
    recordRuntimeTrace('settings.biometric_toggle.request', {
      enabled,
      current: biometricEnabled,
    });
    if (!enabled) {
      setBiometricEnabled(false);
      try {
        await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, 'false');
        markUnlocked();
        recordRuntimeTrace('settings.biometric_toggle.pref_disabled');
      } catch {
        setBiometricEnabled(true);
        recordRuntimeTrace('settings.biometric_toggle.pref_disable_failed');
        Alert.alert('Face ID lock could not be disabled', 'Please try again.');
        return;
      }

      try {
        await crypto.setBiometricRequirement(false);
        recordRuntimeTrace('settings.biometric_toggle.keychain_disabled');
      } catch {
        recordRuntimeTrace('settings.biometric_toggle.keychain_disable_deferred');
        showToast({
          type: 'info',
          message: 'Face ID lock is off. Local key protection will update after the next vault unlock.',
        });
      }
      return;
    }

    if (enabled) {
      recordRuntimeTrace('settings.biometric_toggle.local_auth_request');
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm your identity to enable Face ID lock',
        cancelLabel: 'Cancel',
        disableDeviceFallback: true,
      });
      recordRuntimeTrace('settings.biometric_toggle.local_auth_result', {
        success: result.success === true,
        error: result.error,
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
      recordRuntimeTrace('settings.biometric_toggle.keychain_enabled');
    } catch {
      recordRuntimeTrace('settings.biometric_toggle.keychain_enable_failed');
      Alert.alert(
        'Face ID setup failed',
        'Unlock Beebeeb with your recovery phrase and try again. The local vault must be open before changing Face ID protection.',
      );
      return;
    }
    setBiometricEnabled(true);
    await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, 'true');
    recordRuntimeTrace('settings.biometric_toggle.pref_enabled');
  }, [biometricEnabled, crypto, showToast]);

  const handleBiometricDelayPress = useCallback(() => {
    const apply = async (ms: number) => {
      recordRuntimeTrace('settings.biometric_delay.change', { ms });
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
      // Don't claim "mounted in Files" unless iOS actually presents the
      // location: userVisibleRootError != null means it's registered but not
      // user-visible.
      const mounted =
        enabled &&
        result.registered &&
        result.cacheDatabaseReady !== false &&
        !result.userVisibleRootError;
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
    void loadNativeContactCalendarBackupStatus();
    refreshBackupStats();
  }, [loadNativeContactCalendarBackupStatus, refreshBackupStats]);

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

  const persistPhotoAlbumSelection = useCallback(async (nextIds: string[]) => {
    if (Platform.OS !== 'ios') return;
    const uniqueIds = Array.from(new Set(nextIds));
    setSelectedPhotoAlbumIds(uniqueIds);
    try {
      await BeebeebCrypto.setPhotoBackupSelectedAlbumIds(uniqueIds);
      if (isPhotoBackupEnabled) {
        await triggerBackupNow();
        void refreshCameraRollStatus();
        void refreshBackupStats();
      }
    } catch (err) {
      console.warn('[SettingsScreen] failed to save photo album backup selection:', err);
      void loadPhotoAlbumSelection();
    }
  }, [isPhotoBackupEnabled, loadPhotoAlbumSelection, refreshBackupStats, refreshCameraRollStatus, triggerBackupNow]);

  const handleTogglePhotoAlbum = useCallback((albumId: string) => {
    const nextIds = selectedPhotoAlbumIds.includes(albumId)
      ? selectedPhotoAlbumIds.filter((id) => id !== albumId)
      : [...selectedPhotoAlbumIds, albumId];
    void persistPhotoAlbumSelection(nextIds);
  }, [persistPhotoAlbumSelection, selectedPhotoAlbumIds]);

  // (Removed the "Storage breakdown" Alert — it applied a hardcoded 62/21/12%
  // split to total usage and presented invented per-category byte totals as
  // exact facts, violating the honesty brand rule. The storage bar now opens the
  // real StorageScreen, which shows measured totals only.)

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
  const cameraIssueCount = backupProgress.failed ?? 0;
  const cameraBackedUpCount = Math.max(
    backupProgress.completed ?? 0,
    (cameraRollStatusCounts.uploaded ?? 0) + (cameraRollStatusCounts.orphaned ?? 0),
  );
  const cameraTotalCount = Math.max(
    backupProgress.total ?? 0,
    cameraRollTotalCount,
  );
  const cameraItemLabel = includeVideos ? 'items' : 'photos';
  const cameraIssueSuffix = cameraIssueCount > 0
    ? ` · ${cameraIssueCount.toLocaleString()} needs attention`
    : '';
  const displayContactsStats = mergeCategoryStatsWithNativeStatus(contactsStats, contactsNativeStatus);
  const displayCalendarStats = mergeCategoryStatsWithNativeStatus(calendarStats, calendarNativeStatus);
  const contactsBackupChecking =
    (backupStatsLoading || contactsNativeStatus === null) &&
    !categoryStatsHasEvidence(displayContactsStats);
  const calendarBackupChecking =
    (backupStatsLoading || calendarNativeStatus === null) &&
    !categoryStatsHasEvidence(displayCalendarStats);
  const cameraRollSummary = (() => {
    if (backupPaused) {
      return `Paused · waiting for Wi-Fi${cameraTotalCount > 0 ? ` · ${cameraBackedUpCount.toLocaleString()} of ${cameraTotalCount.toLocaleString()} ${cameraItemLabel}` : ''}${cameraIssueSuffix}`;
    }

    if (cameraBackupActive) {
      const progressLabel = cameraTotalCount > 0
        ? ` - ${cameraBackedUpCount.toLocaleString()} of ${cameraTotalCount.toLocaleString()} ${cameraItemLabel}`
        : '';
      return `${backupProgress.reason || 'Uploading camera roll'}${progressLabel}${cameraIssueSuffix}`;
    }

    if (cameraIssueCount > 0) {
      return `${cameraIssueCount.toLocaleString()} item${cameraIssueCount === 1 ? '' : 's'} need attention · open Backup Insights`;
    }

    if (cameraTotalCount > 0 || cameraBackedUpCount > 0) {
      return `${cameraBackedUpCount.toLocaleString()} of ${cameraTotalCount.toLocaleString()} ${cameraItemLabel}${cameraRollTotalBytes > 0 ? ` · ${formatBytes(cameraRollTotalBytes)}` : ''}`;
    }

    if (backupStatsLoading) {
      return 'Checking camera roll backup...';
    }

    return 'Waiting for first scan';
  })();
  const cameraRollSummaryColor = cameraIssueCount > 0 && !cameraBackupActive
    ? c.red
    : c.ink3;
  const cameraRollStatusDotColor = backupPaused
    ? c.ink4
    : cameraIssueCount > 0 && !cameraBackupActive
      ? c.red
      : cameraBackupActive
        ? c.amber
        : c.green;
  const cameraProgressPct = cameraTotalCount > 0 ? Math.min(cameraBackedUpCount / cameraTotalCount, 1) : 0;
  const cameraProgressFillWidth = `${Math.max(cameraProgressPct * 100, 1)}%` as `${number}%`;
  const cameraProgressBarColor = backupPaused
    ? c.ink4
    : cameraIssueCount > 0 && !cameraBackupActive
      ? c.red
      : cameraBackupActive
        ? c.amber
        : c.green;
  const photoAlbumSelectionLabel = selectedPhotoAlbumIds.length === 0
    ? 'All photos'
    : `${selectedPhotoAlbumIds.length} album${selectedPhotoAlbumIds.length === 1 ? '' : 's'} selected`;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const surfaces = surfacesFor(resolved);

  return (
    <View style={[layout.root, { backgroundColor: surfaces.groupedBg }]}>
      {/* 1314 — content runs under the chrome; the title floats with a
          scroll-edge blur behind it, the same pattern Drive uses (1313). */}
      {isScrolled ? <ScrollEdgeBlur height={headerHeight || insets.top + 52} /> : null}
      <View
        style={layout.floatingTitle}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          setHeaderHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
        }}
      >
        <Text style={[typeScale.largeTitle, {
          color: c.ink,
          paddingHorizontal: spacing.lg, paddingTop: insets.top + 6, paddingBottom: 10,
        }]}>
          Settings
        </Text>
      </View>

      <ScrollView
        style={layout.scroll}
        contentContainerStyle={[layout.scrollContent, { paddingTop: headerHeight, paddingBottom: insets.bottom + 120 }]}
        onScroll={(e) => setIsScrolled(e.nativeEvent.contentOffset.y > 0)}
        scrollEventThrottle={100}
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
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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

        {/* ---- Storage & plan ---- */}
        <View style={layout.section}>
          <SectionHeader title="Storage & plan" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
            {loadingUsage ? (
              <View style={layout.loadingRow}>
                <ActivityIndicator size="small" color={c.ink4} />
              </View>
            ) : usage ? (
              <TouchableOpacity
                style={layout.storageRow}
                activeOpacity={0.6}
                onPress={() => navigation.navigate('Storage')}
                accessibilityRole="button"
                accessibilityLabel="Show storage details"
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

        {/* ---- Backup ---- */}
        <View style={layout.section}>
          <SectionHeader title="Backup" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
            <ToggleRow
              label="Back up camera roll"
              value={isPhotoBackupEnabled}
              onValueChange={handleTogglePhotoBackup}
              c={c}
            />
            {isPhotoBackupEnabled && (
              <TouchableOpacity
                style={{
                  paddingHorizontal: 12,
                  paddingBottom: 10,
                  paddingTop: 2,
                  gap: 6,
                }}
                activeOpacity={0.6}
                onPress={() => navigation.navigate('BackupInsights')}
                accessibilityLabel="View camera roll backup details"
                accessibilityRole="button"
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: cameraRollStatusDotColor }} />
                  <Text style={{ fontSize: 11, color: cameraRollSummaryColor, flex: 1 }}>
                    {cameraRollSummary}
                  </Text>
                  <Ionicons name="chevron-forward" size={14} color={c.ink4} />
                </View>
                {cameraTotalCount > 0 && (
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: c.line2, overflow: 'hidden' }}>
                    <View style={{ height: '100%', width: cameraProgressFillWidth, backgroundColor: cameraProgressBarColor, borderRadius: 2 }} />
                  </View>
                )}
              </TouchableOpacity>
            )}
            <RowDivider c={c} />
            <ToggleRow
              label="Back up contacts"
              value={isContactsBackupEnabled}
              onValueChange={handleToggleContactsBackup}
              c={c}
            />
            {isContactsBackupEnabled && (
              <BackupCategoryStatus
                stats={displayContactsStats}
                paused={backupPaused}
                c={c}
                label="Contacts"
                itemSingular="contact"
                itemPlural="contacts"
                checking={contactsBackupChecking}
                onPress={() => navigation.navigate('BackupInsights')}
              />
            )}
            <RowDivider c={c} />
            <ToggleRow
              label="Back up calendar"
              value={isCalendarBackupEnabled}
              onValueChange={handleToggleCalendarBackup}
              c={c}
            />
            {isCalendarBackupEnabled && (
              <BackupCategoryStatus
                stats={displayCalendarStats}
                paused={backupPaused}
                c={c}
                label="Calendar"
                itemSingular="event"
                itemPlural="events"
                checking={calendarBackupChecking}
                onPress={() => navigation.navigate('BackupInsights')}
              />
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
                {Platform.OS === 'ios' && (
                  <>
                    <RowDivider c={c} />
                    <TouchableOpacity
                      style={[layout.row, { paddingLeft: 28 }]}
                      activeOpacity={0.6}
                      onPress={() => {
                        setPhotoAlbumsExpanded((prev) => !prev);
                        if (!photoAlbumsExpanded) void loadPhotoAlbumSelection();
                      }}
                      accessibilityLabel="Choose photo albums to back up"
                      accessibilityRole="button"
                    >
                      <Ionicons
                        name={photoAlbumsExpanded ? 'chevron-down' : 'chevron-forward'}
                        size={14}
                        color={c.ink3}
                        style={{ marginRight: 8 }}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '400' as const, color: c.ink }}>
                          Photo albums
                        </Text>
                        <Text style={{ fontSize: 11, color: c.ink3, marginTop: 2 }}>
                          {photoAlbumsLoading ? 'Loading albums...' : photoAlbumSelectionLabel}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    {photoAlbumsExpanded && (
                      <View style={{ paddingHorizontal: 12, paddingBottom: 8, paddingLeft: 50 }}>
                        <TouchableOpacity
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 }}
                          activeOpacity={0.6}
                          onPress={() => void persistPhotoAlbumSelection([])}
                        >
                          <View style={[layout.regionRadio, { borderColor: selectedPhotoAlbumIds.length === 0 ? c.amber : c.ink4 }]}>
                            {selectedPhotoAlbumIds.length === 0 && <View style={[layout.regionRadioDot, { backgroundColor: c.amber }]} />}
                          </View>
                          <Text style={{ fontSize: 13, color: c.ink, flex: 1 }}>All photos</Text>
                        </TouchableOpacity>
                        {photoAlbums.map((album) => {
                          const selected = selectedPhotoAlbumIds.includes(album.id);
                          return (
                            <TouchableOpacity
                              key={album.id}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 }}
                              activeOpacity={0.6}
                              onPress={() => handleTogglePhotoAlbum(album.id)}
                              accessibilityLabel={`${album.title}${selected ? ', selected' : ''}`}
                              accessibilityState={{ checked: selected }}
                            >
                              <Ionicons
                                name={selected ? 'checkbox' : 'square-outline'}
                                size={18}
                                color={selected ? c.amber : c.ink4}
                              />
                              <Text style={{ fontSize: 13, color: c.ink, flex: 1 }} numberOfLines={1}>
                                {album.title}
                              </Text>
                              <Text style={{ fontSize: 12, color: c.ink3 }}>
                                {album.assetCount.toLocaleString()}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                        {!photoAlbumsLoading && photoAlbums.length === 0 && (
                          <Text style={{ fontSize: 12, color: c.ink3, paddingVertical: 6 }}>
                            No custom iOS albums found. Beebeeb will back up all photos.
                          </Text>
                        )}
                      </View>
                    )}
                  </>
                )}
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
            <RowDivider c={c} />
            <SettingsRow
              label="Folders in Photos"
              icon="images-outline"
              onPress={() => navigation.navigate('PhotoLibrarySettings')}
              c={c}
            />
          </View>
        </View>

        {/* ---- Devices ---- */}
        <View style={layout.section}>
          <SectionHeader title="Devices" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell, marginBottom: 8 }]}>
            <SettingsRow
              label="Add a device"
              icon="phone-portrait-outline"
              onPress={() => navigation.navigate('DevicePairing')}
              c={c}
            />
          </View>
          <DevicesSection c={c} />
          <SectionNote
            text="Devices and their sync/backup sessions. Status updates every 30 seconds."
            c={c}
          />
        </View>

        {/* ---- Files ---- */}
        <View style={layout.section}>
          <SectionHeader title="Files" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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
                <RowDivider c={c} />
              </>
            )}
            <SettingsRow
              label="Trash"
              icon="trash-outline"
              onPress={() => navigation.navigate('Trash')}
              c={c}
            />
          </View>
        </View>

        {/* ---- Notifications ---- */}
        <View style={layout.section}>
          <SectionHeader title="Notifications" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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
                  subtitle="When you reach 75%, 90% or 100% of your quota"
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
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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

        {/* ---- Security ---- */}
        <View style={layout.section}>
          <SectionHeader title="Security" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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
              label="Two-Factor Authentication"
              icon="lock-closed-outline"
              onPress={() => navigation.navigate('TwoFactorSetup')}
              c={c}
            />
            <RowDivider c={c} />
            <SettingsRow
              label="Manage account on the web"
              value="app.beebeeb.io"
              icon="shield-checkmark-outline"
              onPress={handleAccountSecurity}
              c={c}
            />
          </View>
          <SectionNote
            text="Your recovery phrase is shown once during account setup and is not stored on this device. Use the copy you saved offline."
            c={c}
          />
          <SectionNote
            text="Manage your password on the web at app.beebeeb.io."
            c={c}
          />
        </View>

        {/* ---- Privacy & data ---- */}
        <View style={layout.section}>
          <SectionHeader title="Privacy & data" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
            <SettingsRow
              label="Privacy settings"
              icon="shield-outline"
              onPress={() => navigation.navigate('Privacy')}
              c={c}
            />
          </View>
        </View>

        {/* ---- Data residency ---- */}
        <View style={layout.section}>
          <SectionHeader title="Data residency" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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

        {/* ---- Support ---- */}
        <View style={layout.section}>
          <SectionHeader title="Support" c={c} />
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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
              label="Siri & Shortcuts"
              icon="mic-outline"
              onPress={() => { void Linking.openSettings(); }}
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
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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
              value="Initlabs B.V., Wijchen, Netherlands"
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
          <View style={[layout.card, { backgroundColor: surfaces.groupedCell }]}>
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
          <Text style={{ fontSize: 10, color: c.ink4 }}>Operated by Initlabs B.V., Wijchen, Netherlands.</Text>
        </View>
      </ScrollView>
    </View>
  );
}
