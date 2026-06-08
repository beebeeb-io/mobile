/**
 * Backup Insights screen — detailed backup status, progress, activity, and
 * issue management. Navigated from the Settings backup section.
 *
 * Four card sections:
 *   1. STATUS  — sync state, last scan, next scheduled
 *   2. PROGRESS — photos/videos backed up, storage used, progress bar
 *   3. ACTIVITY — recent daily upload activity
 *   4. ISSUES  — failed assets with retry (conditional)
 *   5. ACTIONS — full resync, clear failed, export log
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  Share,
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
import {
  getStatusCounts,
  getTotalUploadedBytes,
  getFailedAssets,
  getLocalMissingAssets,
  getRecentActivity,
  getLastVerification,
  type BackupAsset,
  type BackupAssetStatus,
  type VerificationRecord,
} from '../services/BackupDatabase';
import {
  getDeviceManifest,
  type BackupCategoryState,
  type DeviceManifest,
} from '../services/BackupService';
import { useBackup } from '../lib/backup-context';
import NetInfo from '@react-native-community/netinfo';
import { recordRuntimeTrace } from '../lib/runtime-trace';

let MediaLibrary: { getAssetsAsync: (opts: { first: number; mediaType?: string[] }) => Promise<{ totalCount: number }>; MediaType?: { photo: string; video: string } } = {
  getAssetsAsync: async () => ({ totalCount: 0 }),
};
try { MediaLibrary = require('expo-media-library'); } catch {}

type C = Colors;

const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
}

function timeAgo(ms: number): string {
  const elapsed = Date.now() - ms;
  if (elapsed < 0) return 'just now';
  const sec = Math.floor(elapsed / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'now';
  const hr = Math.floor(ms / 3_600_000);
  const min = Math.floor((ms % 3_600_000) / 60_000);
  if (hr > 0) return `${hr}h ${min}m`;
  return `${min}m`;
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);

  if (d.getTime() >= today.getTime()) return 'Today';
  if (d.getTime() >= yesterday.getTime()) return 'Yesterday';

  // Within this week
  const daysSince = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
  if (daysSince < 7) {
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  }

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCategoryBackupState(state: BackupCategoryState | undefined, itemLabel: string): string {
  if (!state?.enabled) return 'Off';
  if (state.last_sync) {
    const synced = state.items_synced ?? 0;
    const countLabel = synced > 0
      ? ` · ${synced.toLocaleString()} ${itemLabel}${synced === 1 ? '' : 's'}`
      : '';
    return `${timeAgo(new Date(state.last_sync).getTime())}${countLabel}`;
  }
  return 'On · waiting for first run';
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

function emptyStatusCounts(): Record<BackupAssetStatus, number> {
  return {
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
}

// ── Layout ───────────────────────────────────────────────────────────────────

const layout = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingBottom: 48 },
  section: { marginBottom: 14 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  divider: { height: 1, marginLeft: 12 },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  sectionHeader: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    marginBottom: 6,
  },
});

// ── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, c }: { title: string; c: C }) {
  return <Text style={[layout.sectionHeader, { color: c.ink3 }]}>{title}</Text>;
}

function Divider({ c }: { c: C }) {
  return <View style={[layout.divider, { backgroundColor: c.line }]} />;
}

function StatRow({
  label,
  value,
  mono,
  c,
}: {
  label: string;
  value: string;
  mono?: boolean;
  c: C;
}) {
  return (
    <View style={layout.row}>
      <Text style={{ flex: 1, fontSize: 14, color: c.ink }}>{label}</Text>
      <Text
        style={{
          fontSize: 13,
          color: c.ink2,
          fontFamily: mono ? fonts.mono : fonts.sans,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  label,
  icon,
  onPress,
  loading,
  danger,
  c,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  loading?: boolean;
  danger?: boolean;
  c: C;
}) {
  return (
    <TouchableOpacity
      style={layout.row}
      activeOpacity={0.6}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      disabled={loading}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={danger ? c.red : c.amber}
          style={{ marginRight: 10 }}
        />
      ) : (
        <Ionicons
          name={icon}
          size={18}
          color={danger ? c.red : c.amber}
          style={{ marginRight: 10 }}
        />
      )}
      <Text
        style={{
          flex: 1,
          fontSize: 14,
          fontWeight: '500',
          color: danger ? c.red : c.amber,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── Status indicator dot ─────────────────────────────────────────────────────

function StatusDot({
  status,
  c,
}: {
  status: 'syncing' | 'idle' | 'paused' | 'waiting_wifi';
  c: C;
}) {
  const dotColor =
    status === 'syncing' ? c.amber :
    status === 'waiting_wifi' ? c.ink3 :
    status === 'idle' ? c.green : c.ink4;
  const label =
    status === 'syncing' ? 'Syncing' :
    status === 'waiting_wifi' ? 'Waiting for Wi-Fi' :
    status === 'idle' ? 'Idle' : 'Paused';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: dotColor,
        }}
      />
      <Text style={{ fontSize: 15, fontWeight: '600', color: c.ink }}>
        {label}
      </Text>
    </View>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

interface InsightsData {
  counts: Record<BackupAssetStatus, number>;
  totalBytes: number;
  lastScanAt: number | null;
  failedAssets: BackupAsset[];
  localMissingAssets: BackupAsset[];
  recentActivity: { date: string; count: number; bytes: number }[];
  totalCameraRoll: number;
  lastVerification: VerificationRecord | null;
  manifest: DeviceManifest | null;
}

export default function BackupInsightsScreen() {
  const { colors: c } = useTheme();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const backup = useBackup();
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const dataRef = useRef<InsightsData | null>(null);
  const loadInFlightRef = useRef<Promise<void> | null>(null);
  const lastSlowLoadAtRef = useRef(0);
  const lastProgressRefreshAtRef = useRef(0);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const loadData = useCallback(async (showSpinner = false) => {
    if (loadInFlightRef.current) {
      await loadInFlightRef.current;
      return;
    }

    const task = (async () => {
      const started = Date.now();
      const previousData = dataRef.current;
      const includeSlow =
        showSpinner ||
        previousData === null ||
        Date.now() - lastSlowLoadAtRef.current > 30_000;

      if (showSpinner) setRefreshing(true);
      try {
        const [counts, totalBytes, failedAssets, localMissingAssets, recentActivity, lastVerification] =
          await Promise.all([
            withTimeout(getStatusCounts(), previousData?.counts ?? emptyStatusCounts(), 1_000),
            withTimeout(getTotalUploadedBytes(), previousData?.totalBytes ?? 0, 1_000),
            withTimeout(getFailedAssets(10), previousData?.failedAssets ?? [], 1_000),
            withTimeout(getLocalMissingAssets(10), previousData?.localMissingAssets ?? [], 1_000),
            withTimeout(getRecentActivity(7), previousData?.recentActivity ?? [], 1_000),
            withTimeout(getLastVerification(), previousData?.lastVerification ?? null, 1_000),
          ]);

        let manifest = previousData?.manifest ?? null;
        let totalCameraRoll = previousData?.totalCameraRoll ?? 0;
        if (includeSlow) {
          [manifest, totalCameraRoll] = await Promise.all([
            withTimeout(getDeviceManifest().catch(() => null), manifest, 1_000),
            withTimeout((async () => {
              const mediaTypes: string[] = [];
              if (MediaLibrary.MediaType) {
                mediaTypes.push(
                  MediaLibrary.MediaType.photo,
                  MediaLibrary.MediaType.video,
                );
              }
              const result = await MediaLibrary.getAssetsAsync({
                first: 1,
                ...(mediaTypes.length > 0 ? { mediaType: mediaTypes } : {}),
              });
              return result.totalCount;
            })().catch(() => totalCameraRoll), totalCameraRoll, 1_000),
          ]);
          lastSlowLoadAtRef.current = Date.now();
        }

        const nextData = {
          counts,
          totalBytes,
          lastScanAt: null,
          failedAssets,
          localMissingAssets,
          recentActivity,
          totalCameraRoll,
          lastVerification,
          manifest,
        };
        dataRef.current = nextData;
        setData(nextData);
        recordRuntimeTrace('backup_insights.load.complete', {
          durationMs: Date.now() - started,
          includeSlow,
          failedPreviewCount: failedAssets.length,
        });
      } catch (err) {
        console.warn('BackupInsights: failed to load data', err);
        recordRuntimeTrace('backup_insights.load.failed', {
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      } finally {
        setLoading(false);
        if (showSpinner) setRefreshing(false);
      }
    })();

    loadInFlightRef.current = task;
    try {
      await task;
    } finally {
      loadInFlightRef.current = null;
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void loadData(true);
  }, [loadData]);

  // Poll data refresh while backup is running so SQLite-backed counts and
  // activity rows catch up without forcing the user to leave this screen.
  useEffect(() => {
    const isActive =
      backup.backupProgress.state === 'preparing' ||
      backup.backupProgress.state === 'encrypting' ||
      backup.backupProgress.state === 'uploading' ||
      backup.backupProgress.inProgress > 0 ||
      (backup.backupProgress.pending ?? 0) > 0;
    if (!isActive) return;
    const interval = setInterval(() => void loadData(), 5_000);
    return () => clearInterval(interval);
  }, [
    backup.backupProgress.inProgress,
    backup.backupProgress.pending,
    backup.backupProgress.state,
    loadData,
  ]);

  useEffect(() => {
    if (!backup.isPhotoBackupEnabled) return;
    if (Date.now() - lastProgressRefreshAtRef.current < 5_000) return;
    lastProgressRefreshAtRef.current = Date.now();
    void loadData();
  }, [
    backup.backupProgress.completed,
    backup.backupProgress.total,
    backup.isPhotoBackupEnabled,
    loadData,
  ]);

  // ── Determine sync state ───────────────────────────────────────────────────

  const pendingCount =
    (data?.counts.pending_upload ?? 0) +
    (data?.counts.uploading ?? 0) +
    (data?.counts.pending_reupload ?? 0);
  const uploadedCount =
    (data?.counts.uploaded ?? 0) + (data?.counts.orphaned ?? 0);
  const failedCount = Math.max(
    data?.counts.failed ?? 0,
    data?.failedAssets.length ?? 0,
    backup.backupProgress.failed ?? 0,
  );
  const localMissingCount = data?.counts.local_missing ?? 0;
  const displayUploadedCount = Math.max(uploadedCount, backup.backupProgress.completed);
  const displayTotalCameraRoll = Math.max(data?.totalCameraRoll ?? 0, backup.backupProgress.total);
  const activeWaitingToEncrypt = backup.backupProgress.waitingToEncrypt ?? 0;
  const activeReadyToUpload = backup.backupProgress.encryptedPendingUpload ?? 0;
  const activeUploading = backup.backupProgress.uploading ?? backup.backupProgress.inProgress;
  const activeProgressLine = displayTotalCameraRoll > 0
    ? `${displayUploadedCount.toLocaleString()} of ${displayTotalCameraRoll.toLocaleString()} backed up`
    : `${displayUploadedCount.toLocaleString()} backed up`;
  const activeQueueLine = [
    `${activeWaitingToEncrypt.toLocaleString()} waiting to encrypt`,
    `${activeReadyToUpload.toLocaleString()} ready to upload`,
    `${activeUploading.toLocaleString()} uploading`,
  ].join(' · ');

  const [networkType, setNetworkType] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    NetInfo.fetch().then(state => { if (mounted) setNetworkType(state.type); });
    const unsub = NetInfo.addEventListener(state => { if (mounted) setNetworkType(state.type); });
    return () => { mounted = false; unsub(); };
  }, []);

  const waitingForWifi = backup.wifiOnly && networkType !== 'wifi' && pendingCount > 0;

  const syncStatus: 'syncing' | 'idle' | 'paused' | 'waiting_wifi' =
    waitingForWifi ? 'waiting_wifi' : pendingCount > 0 ? 'syncing' : 'idle';

  // Next scheduled scan
  const nextScanMs = data?.lastScanAt
    ? FULL_SCAN_INTERVAL_MS - (Date.now() - data.lastScanAt)
    : 0;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleExportLog = useCallback(async () => {
    setExporting(true);
    try {
      const [counts, totalBytes, failedAssets, localMissingAssets, activity] =
        await Promise.all([
          getStatusCounts(),
          getTotalUploadedBytes(),
          getFailedAssets(),
          getLocalMissingAssets(25),
          getRecentActivity(30),
        ]);

      const lines: string[] = [
        'Beebeeb Backup Log',
        `Generated: ${new Date().toISOString()}`,
        '',
        '--- Status ---',
        `Pending upload: ${counts.pending_upload ?? 0}`,
        `Uploading: ${counts.uploading ?? 0}`,
        `Uploaded: ${counts.uploaded ?? 0}`,
        `Pending delete: ${counts.pending_delete ?? 0}`,
        `Pending reupload: ${counts.pending_reupload ?? 0}`,
        `Removed from iPhone: ${counts.local_missing ?? 0}`,
        `Orphaned: ${counts.orphaned ?? 0}`,
        `Failed: ${Math.max(counts.failed ?? 0, failedAssets.length)}`,
        '',
        `Total uploaded: ${formatBytes(totalBytes)}`,
        `Native state: ${backup.backupProgress.reason || backup.backupProgress.state}`,
        '',
        '--- Recent Activity (30 days) ---',
        ...activity.map(
          (a) =>
            `${a.date}: ${a.count} item${a.count !== 1 ? 's' : ''}, ${formatBytes(a.bytes ?? 0)}`,
        ),
      ];

      if (failedAssets.length > 0) {
        lines.push('', '--- Failed Assets ---');
        for (const asset of failedAssets) {
          lines.push(
            `${asset.local_asset_id}: ${asset.error_message ?? 'Unknown error'} (retries: ${asset.retry_count})`,
          );
        }
      }

      if (localMissingAssets.length > 0) {
        lines.push('', '--- Skipped Local Photos ---');
        for (const asset of localMissingAssets) {
          lines.push(
            `${asset.local_asset_id}: ${asset.error_message ?? 'Photo no longer available locally'}`,
          );
        }
      }

      await Share.share({
        message: lines.join('\n'),
        title: 'Beebeeb Backup Log',
      });
    } catch {
      // User may have cancelled the share sheet
    } finally {
      setExporting(false);
    }
  }, []);

  // Manually revive the backup queue: triggerBackupNow resets retry-exhausted
  // assets (retry_count>=10), rescans, and wakes the native drain. This is the
  // only path that un-sticks a backup stalled on retry-exhausted items.
  const handleBackupNow = useCallback(async () => {
    setActionError(null);
    setRetrying(true);
    try {
      await backup.triggerBackupNow();
      await loadData(true);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Could not start backup. Try again.',
      );
    } finally {
      setRetrying(false);
    }
  }, [backup, loadData]);

  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    // Live Activity and notification taps can cold-open this screen without a
    // Settings route underneath it. In that case, make the visible Back affordance
    // deterministic instead of leaving the user on a dead end.
    (navigation.navigate as (name: string, params?: unknown) => void)('Tabs', {
      screen: 'Settings',
    });
  }, [navigation]);

  // ── Render ─────────────────────────────────────────────────────────────────

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
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={c.amber} />
          <Text style={{ fontSize: 16, color: c.amber, marginLeft: 2 }}>
            Settings
          </Text>
        </TouchableOpacity>
        <Text
          style={{
            fontSize: 22,
            fontWeight: '700',
            color: c.ink,
            marginTop: 4,
          }}
        >
          Backup Insights
        </Text>
      </View>

      {loading ? (
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
        >
          <ActivityIndicator size="large" color={c.amber} />
        </View>
      ) : (
        <ScrollView
          style={layout.scroll}
          contentContainerStyle={layout.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={c.amber}
              colors={[c.amber]}
            />
          }
        >
          <View style={{ height: 16 }} />

          {/* ── ACTIVE native engine card ─────────────────────────────── */}
          {((['preparing', 'encrypting', 'uploading'] as string[]).includes(backup.backupProgress.state) || backup.backupProgress.inProgress > 0) && (
            <View style={layout.section}>
              <SectionHeader title="Active" c={c} />
              <View
                style={[
                  layout.card,
                  { backgroundColor: c.paper2, borderColor: c.line },
                ]}
              >
                <View style={{ padding: 14, gap: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <ActivityIndicator size="small" color={c.amber} />
                    <Text style={{ flex: 1, color: c.ink, fontSize: 14, fontWeight: '700' }}>
                      {backup.backupProgress.reason || 'Backing up camera roll'}
                    </Text>
                  </View>
                  <Text style={{ color: c.ink3, fontSize: 12, lineHeight: 17 }}>
                    {activeProgressLine}
                    {failedCount > 0 ? ` · ${failedCount.toLocaleString()} need attention` : ''}
                  </Text>
                  <Text style={{ color: c.ink3, fontSize: 12, lineHeight: 17 }}>
                    {activeQueueLine}
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* ── STATUS card ────────────────────────────────────────────── */}
          <View style={layout.section}>
            <SectionHeader title="Status" c={c} />
            <View
              style={[
                layout.card,
                { backgroundColor: c.paper2, borderColor: c.line },
              ]}
            >
              <View style={{ padding: 14, gap: 12 }}>
                <StatusDot status={syncStatus} c={c} />

                <View style={{ gap: 4 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: c.ink3 }}>
                      Last full scan
                    </Text>
                    <Text
                      style={{
                        fontSize: 12,
                        color: c.ink2,
                        fontFamily: fonts.mono,
                      }}
                    >
                      {data?.lastScanAt ? timeAgo(data.lastScanAt) : 'Never'}
                    </Text>
                  </View>

                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: c.ink3 }}>
                      Next scheduled
                    </Text>
                    <Text
                      style={{
                        fontSize: 12,
                        color: c.ink2,
                        fontFamily: fonts.mono,
                      }}
                    >
                      {nextScanMs > 0
                        ? `in ${formatTimeRemaining(nextScanMs)}`
                        : 'due now'}
                    </Text>
                  </View>

                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: c.ink3 }}>
                      Last verified
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {data?.lastVerification && (
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: data.lastVerification.success ? c.green : c.red,
                          }}
                        />
                      )}
                      <Text
                        style={{
                          fontSize: 12,
                          color: c.ink2,
                          fontFamily: fonts.mono,
                        }}
                      >
                        {data?.lastVerification
                          ? timeAgo(new Date(data.lastVerification.verified_at).getTime())
                          : 'Not yet'}
                      </Text>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          </View>

          {pendingCount > 0 && (
            <View style={layout.section}>
              <View
                style={[
                  layout.card,
                  { backgroundColor: c.amberBg, borderColor: c.amber },
                ]}
              >
                <View style={{ padding: 14, gap: 6 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.ink }}>
                    Keep Beebeeb open to finish faster
                  </Text>
                  <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink2 }}>
                    iOS lets Beebeeb upload encrypted files for a while after you leave. New encryption needs the app open again, and the Live Activity will say when that happens.
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* ── PROGRESS card ──────────────────────────────────────────── */}
          <View style={layout.section}>
            <SectionHeader title="Progress" c={c} />
            <View
              style={[
                layout.card,
                { backgroundColor: c.paper2, borderColor: c.line },
              ]}
            >
              <StatRow
                label="Photos backed up"
                value={`${displayUploadedCount} / ${displayTotalCameraRoll || '?'}`}
                mono
                c={c}
              />
              <Divider c={c} />
              <StatRow
                label="Storage used"
                value={formatBytes(data?.totalBytes ?? 0)}
                mono
                c={c}
              />
              <Divider c={c} />

              {/* Progress bar */}
              <View style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 6 }}>
                {(() => {
                  const total = displayTotalCameraRoll;
                  const pct = total > 0 ? Math.min(displayUploadedCount / total, 1) : 0;
                  const pctNum = Math.round(pct * 100);
                  const fillWidth = `${Math.max(pct * 100, 1)}%` as `${number}%`;

                  return (
                    <>
                      <View
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                        }}
                      >
                        <Text style={{ fontSize: 12, color: c.ink3 }}>
                          Progress
                        </Text>
                        <Text
                          style={{
                            fontSize: 12,
                            color: c.ink2,
                            fontFamily: fonts.mono,
                          }}
                        >
                          {pctNum}%
                        </Text>
                      </View>
                      <View
                        style={{
                          height: 6,
                          backgroundColor: c.line,
                          borderRadius: 3,
                          overflow: 'hidden',
                        }}
                      >
                        <View
                          style={{
                            height: '100%',
                            width: fillWidth,
                            backgroundColor: c.amber,
                            borderRadius: 3,
                          }}
                        />
                      </View>
                    </>
                  );
                })()}
              </View>

              {pendingCount > 0 && (
                <>
                  <Divider c={c} />
                  <StatRow
                    label="Pending"
                    value={`${pendingCount} item${pendingCount !== 1 ? 's' : ''}`}
                    mono
                    c={c}
                  />
                </>
              )}
              {localMissingCount > 0 && (
                <>
                  <Divider c={c} />
                  <StatRow
                    label="Removed from iPhone"
                    value={`${localMissingCount} skipped`}
                    mono
                    c={c}
                  />
                </>
              )}
            </View>
          </View>

          {/* ── OTHER BACKUPS card ─────────────────────────────────────── */}
          <View style={layout.section}>
            <SectionHeader title="Contacts & Calendar" c={c} />
            <View
              style={[
                layout.card,
                { backgroundColor: c.paper2, borderColor: c.line },
              ]}
            >
              <StatRow
                label="Contacts"
                value={formatCategoryBackupState(data?.manifest?.backups.contacts, 'contact')}
                c={c}
              />
              <Divider c={c} />
              <StatRow
                label="Calendar"
                value={formatCategoryBackupState(data?.manifest?.backups.calendar, 'event')}
                c={c}
              />
            </View>
          </View>

          {/* ── ACTIVITY card ──────────────────────────────────────────── */}
          <View style={layout.section}>
            <SectionHeader title="Recent Activity" c={c} />
            <View
              style={[
                layout.card,
                { backgroundColor: c.paper2, borderColor: c.line },
              ]}
            >
              {data?.recentActivity && data.recentActivity.length > 0 ? (
                data.recentActivity.map((entry, i) => (
                  <React.Fragment key={entry.date}>
                    {i > 0 && <Divider c={c} />}
                    <View style={layout.row}>
                      <Text
                        style={{
                          flex: 1,
                          fontSize: 14,
                          color: c.ink,
                        }}
                      >
                        {formatDateLabel(entry.date)}
                      </Text>
                      <Text
                        style={{
                          fontSize: 13,
                          color: c.ink2,
                          fontFamily: fonts.mono,
                        }}
                      >
                        +{entry.count} item{entry.count !== 1 ? 's' : ''}
                        {entry.bytes > 0 ? `, ${formatBytes(entry.bytes)}` : ''}
                      </Text>
                    </View>
                  </React.Fragment>
                ))
              ) : (
                <View
                  style={{
                    padding: 14,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 13, color: c.ink3 }}>
                    No recent backup activity
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* ── ISSUES card (conditional) ──────────────────────────────── */}
          {failedCount > 0 && (
            <View style={layout.section}>
              <SectionHeader title={`Issues (${failedCount})`} c={c} />
              <View
                style={[
                  layout.card,
                  { backgroundColor: c.paper2, borderColor: c.line },
                ]}
              >
                {data?.failedAssets.slice(0, 10).map((asset, i) => (
                  <React.Fragment key={asset.local_asset_id}>
                    {i > 0 && <Divider c={c} />}
                    <View
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        gap: 2,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          color: c.ink,
                          fontFamily: fonts.mono,
                        }}
                        numberOfLines={1}
                      >
                        {asset.local_asset_id}
                      </Text>
                      <Text
                        style={{ fontSize: 11, color: c.red }}
                        numberOfLines={2}
                      >
                        {asset.error_message ?? 'Unknown error'}
                      </Text>
                      {asset.retry_count > 0 && (
                        <Text style={{ fontSize: 10, color: c.ink4 }}>
                          {asset.retry_count} attempt
                          {asset.retry_count !== 1 ? 's' : ''}
                        </Text>
                      )}
                    </View>
                  </React.Fragment>
                ))}

                {failedCount > 10 && (
                  <>
                    <Divider c={c} />
                    <View
                      style={{
                        padding: 10,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 12, color: c.ink3 }}>
                        and {failedCount - 10} more...
                      </Text>
                    </View>
                  </>
                )}

                <Divider c={c} />
                <ActionButton
                  label={retrying ? 'Starting…' : 'Retry failed uploads'}
                  icon="refresh"
                  onPress={handleBackupNow}
                  loading={retrying}
                  c={c}
                />
              </View>
            </View>
          )}

          {localMissingCount > 0 && (
            <View style={layout.section}>
              <SectionHeader title="Skipped local photos" c={c} />
              <View
                style={[
                  layout.card,
                  { backgroundColor: c.paper2, borderColor: c.line },
                ]}
              >
                <View style={{ paddingHorizontal: 12, paddingVertical: 11, gap: 6 }}>
                  <Text style={{ fontSize: 14, color: c.ink, fontWeight: '600' }}>
                    {localMissingCount} photo{localMissingCount !== 1 ? 's' : ''} no longer on this iPhone
                  </Text>
                  <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink3 }}>
                    Usually this means the photo was deleted locally, iOS changed photo-library access, or the asset id became stale.
                  </Text>
                </View>
                {data?.localMissingAssets.slice(0, 3).map((asset) => (
                  <React.Fragment key={asset.local_asset_id}>
                    <Divider c={c} />
                    <View style={{ paddingHorizontal: 12, paddingVertical: 9, gap: 2 }}>
                      <Text
                        style={{ fontSize: 12, color: c.ink2, fontFamily: fonts.mono }}
                        numberOfLines={1}
                      >
                        {asset.local_asset_id}
                      </Text>
                      <Text style={{ fontSize: 11, color: c.ink4 }} numberOfLines={1}>
                        {asset.error_message ?? 'Photo no longer available locally'}
                      </Text>
                    </View>
                  </React.Fragment>
                ))}
                {localMissingCount > 3 && (
                  <>
                    <Divider c={c} />
                    <View style={{ padding: 10, alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, color: c.ink3 }}>
                        and {localMissingCount - 3} more skipped locally
                      </Text>
                    </View>
                  </>
                )}
                <Divider c={c} />
                <StatRow
                  label="Repair"
                  value="Run from Settings"
                  c={c}
                />
              </View>
            </View>
          )}

          {/* ── DIAGNOSTICS card ───────────────────────────────────────── */}
          <View style={layout.section}>
            <SectionHeader title="Diagnostics" c={c} />
            <View
              style={[
                layout.card,
                { backgroundColor: c.paper2, borderColor: c.line },
              ]}
            >
              <ActionButton
                label={retrying ? 'Starting…' : 'Back up now'}
                icon="cloud-upload-outline"
                onPress={handleBackupNow}
                loading={retrying}
                c={c}
              />
              <Divider c={c} />
              <ActionButton
                label="Export backup log"
                icon="document-text-outline"
                onPress={handleExportLog}
                loading={exporting}
                c={c}
              />
            </View>
            {actionError && (
              <Text
                style={{
                  fontSize: 12,
                  color: c.red,
                  marginTop: 8,
                  paddingHorizontal: 4,
                }}
              >
                {actionError}
              </Text>
            )}
          </View>

          <View style={{ height: 20 }} />
        </ScrollView>
      )}
    </View>
  );
}
