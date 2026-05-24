import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { getNativeBackupDiagnostics } from '../../modules/beebeeb-crypto';
import { useCrypto } from '../lib/crypto-context';
import { useTheme } from '../lib/theme-context';
import { NativeSwitch } from '../components/NativeSwitch';
import { getFileIndex } from '../lib/api';
import { loadCachedFileIndex, saveCachedFileIndex } from '../lib/file-index-cache';
import {
  estimatePerformanceStorage,
  getPerformanceStorageSettings,
  setPerformanceStorageSettings,
  PROFILE_LABELS,
  type PerformanceStorageProfile,
} from '../lib/performance-storage-settings';
import {
  DEFAULT_THUMBNAIL_IMPROVE_QUALITY,
  getThumbnailRepairSettings,
  getThumbnailRepairStatus,
  pauseThumbnailRepair,
  requestThumbnailRepair,
  setThumbnailRepairSettings,
  type ThumbnailRepairSettings,
  type ThumbnailRepairStatus,
} from '../lib/thumbnail-repair-settings';
import { isDegradedThumbnail } from '../lib/thumbnail-repair-predicate';
import { getRemoteToLocalMap } from '../services/BackupDatabase';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PROFILES: PerformanceStorageProfile[] = ['light', 'balanced', 'smooth'];

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function profileCopy(profile: PerformanceStorageProfile): string {
  if (profile === 'light') return 'Smallest cache, less preloading.';
  if (profile === 'smooth') return 'Medium server thumbnails plus a larger local preview tier for smoother browsing.';
  return 'Medium thumbnails and recent previews.';
}

function repairPhaseLabel(status: ThumbnailRepairStatus | null): string {
  if (!status) return 'Idle';
  if (status.phase === 'queued') return 'Queued';
  if (status.phase === 'scanning') return 'Scanning';
  if (status.phase === 'repairing') return 'Repairing';
  if (status.phase === 'paused') return 'Paused';
  if (status.phase === 'completed') return 'Completed';
  if (status.phase === 'failed') return 'Needs attention';
  return 'Idle';
}

function formatTime(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Rough estimate of original-photo download per degraded backfill (bytes). */
const DEGRADED_ESTIMATED_BYTES_PER_FILE = 3_500_000;

async function loadFileCountAndMissingLocal(): Promise<{
  fileCount: number;
  missingLocalThumbnails: number;
  degradedThumbnails: number;
  degradedThumbnailsNonPhotoKit: number;
}> {
  const cached = await loadCachedFileIndex();
  const index = await getFileIndex(cached?.hash);
  const files = !index.changed && cached
    ? cached.files
    : index.files ?? cached?.files ?? [];
  if (index.changed && index.files) await saveCachedFileIndex(index.hash, index.files);

  const localMap = await getRemoteToLocalMap();
  const mediaFiles = files.filter((file) => !file.is_folder && !file.is_uploading);

  // Reuse the same predicate the worker uses, so UI count and worker queue agree.
  const degradedAll = mediaFiles.filter(isDegradedThumbnail);
  const degradedNonPhotoKit = degradedAll.filter((f) => !localMap.has(f.id));

  return {
    fileCount: mediaFiles.length,
    missingLocalThumbnails: mediaFiles.filter((file) => !file.has_thumbnail && localMap.has(file.id)).length,
    degradedThumbnails: degradedAll.length,
    degradedThumbnailsNonPhotoKit: degradedNonPhotoKit.length,
  };
}

function formatBandwidthEstimate(fileCount: number): string {
  const bytes = fileCount * DEGRADED_ESTIMATED_BYTES_PER_FILE;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export default function AdvancedSettingsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { getUnlockDiagnostics } = useCrypto();
  const [profile, setProfile] = useState<PerformanceStorageProfile>('balanced');
  const [repairSettings, setRepairSettingsState] = useState<ThumbnailRepairSettings>({
    autoRepairWhileIdle: false,
    improveQuality: DEFAULT_THUMBNAIL_IMPROVE_QUALITY,
  });
  const [repairStatus, setRepairStatus] = useState<ThumbnailRepairStatus | null>(null);
  const [fileCount, setFileCount] = useState(0);
  const [missingLocalThumbnails, setMissingLocalThumbnails] = useState(0);
  const [degradedNonPhotoKit, setDegradedNonPhotoKit] = useState(0);
  const [degradedThorough, setDegradedThorough] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [startingRepair, setStartingRepair] = useState(false);
  const [pausingRepair, setPausingRepair] = useState(false);
  const [startingImprove, setStartingImprove] = useState(false);
  const [pausingImprove, setPausingImprove] = useState(false);
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);
  const lastRepairCountRefreshRef = useRef(0);

  const estimate = useMemo(() => estimatePerformanceStorage(fileCount, profile), [fileCount, profile]);
  const repairTotal = Math.max(repairStatus?.totalMissing ?? 0, missingLocalThumbnails);
  const repairChecked = repairStatus?.checked ?? 0;
  const repairProgress = repairTotal > 0 ? Math.min(1, repairChecked / repairTotal) : 0;
  const lastRepairUpdate = formatTime(repairStatus?.updatedAt ?? repairStatus?.lastRunAt);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [perf, repair, status, counts] = await Promise.all([
        getPerformanceStorageSettings(),
        getThumbnailRepairSettings(),
        getThumbnailRepairStatus(),
        loadFileCountAndMissingLocal().catch(() => ({
          fileCount: 0,
          missingLocalThumbnails: 0,
          degradedThumbnails: 0,
          degradedThumbnailsNonPhotoKit: 0,
        })),
      ]);
      setProfile(perf.profile);
      setRepairSettingsState(repair);
      setRepairStatus(status);
      setFileCount(counts.fileCount);
      setMissingLocalThumbnails(counts.missingLocalThumbnails);
      setDegradedNonPhotoKit(counts.degradedThumbnailsNonPhotoKit);
      setDegradedThorough(counts.degradedThumbnails);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void (async () => {
        const status = await getThumbnailRepairStatus();
        setRepairStatus(status);

        const now = Date.now();
        const terminal = !status.running && (
          status.phase === 'completed' ||
          status.phase === 'failed' ||
          status.phase === 'paused'
        );
        const refreshCounts = terminal || now - lastRepairCountRefreshRef.current > 15_000;
        if (refreshCounts) {
          lastRepairCountRefreshRef.current = now;
          const counts = await loadFileCountAndMissingLocal().catch(() => null);
          if (counts) {
            setFileCount(counts.fileCount);
            setMissingLocalThumbnails(counts.missingLocalThumbnails);
            setDegradedNonPhotoKit(counts.degradedThumbnailsNonPhotoKit);
            setDegradedThorough(counts.degradedThumbnails);
          }
        }
      })().catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  const updateProfile = useCallback(async (next: PerformanceStorageProfile) => {
    setProfile(next);
    await setPerformanceStorageSettings({ profile: next });
  }, []);

  const toggleIdleRepair = useCallback(async (value: boolean) => {
    const next = await setThumbnailRepairSettings({
      ...repairSettings,
      autoRepairWhileIdle: value,
    });
    setRepairSettingsState(next);
  }, [repairSettings]);

  const toggleImproveWifiOnly = useCallback(async (value: boolean) => {
    const next = await setThumbnailRepairSettings({
      ...repairSettings,
      improveQuality: { ...repairSettings.improveQuality, wifiOnly: value },
    });
    setRepairSettingsState(next);
  }, [repairSettings]);

  const toggleImproveThorough = useCallback(async (value: boolean) => {
    const next = await setThumbnailRepairSettings({
      ...repairSettings,
      improveQuality: { ...repairSettings.improveQuality, thoroughMode: value },
    });
    setRepairSettingsState(next);
  }, [repairSettings]);

  const startRepair = useCallback(async () => {
    setStartingRepair(true);
    try {
      const next = await requestThumbnailRepair('missing');
      setRepairStatus(next);
    } finally {
      setStartingRepair(false);
    }
  }, []);

  const pauseRepair = useCallback(async () => {
    setPausingRepair(true);
    try {
      const next = await pauseThumbnailRepair();
      setRepairStatus(next);
    } finally {
      setPausingRepair(false);
    }
  }, []);

  const startImprove = useCallback(async () => {
    setStartingImprove(true);
    try {
      const next = await requestThumbnailRepair('degraded');
      setRepairStatus(next);
    } finally {
      setStartingImprove(false);
    }
  }, []);

  const pauseImprove = useCallback(async () => {
    setPausingImprove(true);
    try {
      const next = await pauseThumbnailRepair();
      setRepairStatus(next);
    } finally {
      setPausingImprove(false);
    }
  }, []);

  const copyDiagnostics = useCallback(async () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      platform: Platform.OS,
      vault: getUnlockDiagnostics(),
      backup: await getNativeBackupDiagnostics().catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    };
    await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
    setCopiedDiagnostics(true);
    setTimeout(() => setCopiedDiagnostics(false), 1800);
  }, [getUnlockDiagnostics]);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Advanced</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.amber} />}
      >
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Performance & Storage</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <View style={styles.segment}>
            {PROFILES.map((item) => {
              const selected = profile === item;
              return (
                <TouchableOpacity
                  key={item}
                  onPress={() => void updateProfile(item)}
                  style={[
                    styles.segmentItem,
                    { backgroundColor: selected ? c.amber : 'transparent' },
                  ]}
                >
                  <Text style={[styles.segmentText, { color: selected ? '#16110a' : c.ink2 }]}>
                    {PROFILE_LABELS[item]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[styles.body, { color: c.ink2 }]}>{profileCopy(profile)}</Text>
          <View style={[styles.estimateBox, { backgroundColor: c.paper, borderColor: c.line }]}>
            <Text style={[styles.estimateLabel, { color: c.ink3 }]}>Estimated local cache</Text>
            <Text style={[styles.estimateValue, { color: c.ink }]}>{formatBytes(estimate.estimatedBytes)}</Text>
            <Text style={[styles.caption, { color: c.ink4 }]}>
              Based on {fileCount.toLocaleString()} files. Smooth uses two tiers: medium thumbnails plus larger local previews.
            </Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Repair</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: c.ink }]}>Repair automatically while idle</Text>
              <Text style={[styles.rowSub, { color: c.ink3 }]}>
                Slowly uploads missing thumbnails when Beebeeb is open and unlocked.
              </Text>
            </View>
            <NativeSwitch colors={c} value={repairSettings.autoRepairWhileIdle} onValueChange={toggleIdleRepair} />
          </View>
          <View style={[styles.divider, { backgroundColor: c.line }]} />
          <View style={styles.repairBlock}>
            <View style={styles.repairHeader}>
              <View>
                <Text style={[styles.rowTitle, { color: c.ink }]}>Thumbnail repair</Text>
                <Text style={[styles.caption, { color: c.ink3 }]}>
                  {repairPhaseLabel(repairStatus)}{lastRepairUpdate ? ` · updated ${lastRepairUpdate}` : ''}
                </Text>
              </View>
              {repairStatus?.running ? <ActivityIndicator color={c.amber} /> : null}
            </View>

            <View style={[styles.progressTrack, { backgroundColor: c.line }]}>
              <View style={[styles.progressFill, { backgroundColor: c.amber, width: `${repairProgress * 100}%` }]} />
            </View>

            <View style={styles.statGrid}>
              <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                <Text style={[styles.statValue, { color: c.ink }]}>{missingLocalThumbnails.toLocaleString()}</Text>
                <Text style={[styles.statLabel, { color: c.ink3 }]}>missing</Text>
              </View>
              <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                <Text style={[styles.statValue, { color: c.ink }]}>{(repairStatus?.repaired ?? 0).toLocaleString()}</Text>
                <Text style={[styles.statLabel, { color: c.ink3 }]}>repaired</Text>
              </View>
              <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                <Text style={[styles.statValue, { color: c.ink }]}>{(repairStatus?.failed ?? 0).toLocaleString()}</Text>
                <Text style={[styles.statLabel, { color: c.ink3 }]}>failed</Text>
              </View>
            </View>

            <View style={[styles.activityBox, { backgroundColor: c.paper, borderColor: c.line }]}>
              <Text style={[styles.activityTitle, { color: c.ink }]}>
                {repairStatus?.currentAction ?? repairStatus?.lastMessage ?? 'No repair running'}
              </Text>
              {repairStatus?.currentFileName ? (
                <Text style={[styles.caption, { color: c.ink3 }]} numberOfLines={1}>
                  {repairStatus.currentFileName}
                </Text>
              ) : null}
              <Text style={[styles.caption, { color: c.ink4 }]}>
                {repairTotal > 0
                  ? `${repairChecked.toLocaleString()} of ${repairTotal.toLocaleString()} checked`
                  : 'Start repair to scan for missing thumbnails.'}
              </Text>
            </View>

            {repairStatus?.activity?.length ? (
              <View style={styles.activityList}>
                {repairStatus.activity.slice(0, 4).map((item) => (
                  <View key={`${item.at}-${item.message}`} style={styles.activityRow}>
                    <Text style={[styles.activityTime, { color: c.ink4 }]}>{formatTime(item.at) ?? '--:--'}</Text>
                    <Text style={[styles.activityMessage, { color: c.ink3 }]} numberOfLines={2}>
                      {item.message}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            <Text style={[styles.caption, { color: c.ink3 }]}>
              Only photos still available on this iPhone are repaired automatically. Remote-only files need a server-side repair.
            </Text>
            <TouchableOpacity
              onPress={(repairStatus?.running && repairStatus.mode === 'missing') ? pauseRepair : startRepair}
              disabled={
                startingRepair ||
                pausingRepair ||
                (repairStatus?.running && repairStatus.mode === 'degraded') ||
                (!repairStatus?.running && missingLocalThumbnails === 0)
              }
              style={[
                styles.primaryButton,
                {
                  backgroundColor:
                    (repairStatus?.running && repairStatus.mode === 'degraded') ||
                    (!repairStatus?.running && missingLocalThumbnails === 0)
                      ? c.line2
                      : c.amber,
                },
              ]}
            >
              {startingRepair || pausingRepair ? (
                <ActivityIndicator color="#16110a" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {repairStatus?.running && repairStatus.mode === 'missing'
                    ? 'Pause repair'
                    : repairStatus?.phase === 'paused' && repairStatus.mode === 'missing'
                      ? 'Resume repair'
                      : 'Start repair'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Improve thumbnail quality (task 0553) ─────────────────────── */}
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Improve thumbnail quality</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <View style={styles.repairBlock}>
            <Text style={[styles.body, { color: c.ink2 }]}>
              This re-downloads each original photo, regenerates a sharper thumbnail, and uploads it. Use Wi-Fi for best results — your data plan will thank you.
            </Text>

            <View style={styles.statGrid}>
              <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                <Text style={[styles.statValue, { color: c.ink }]}>
                  {(repairSettings.improveQuality.thoroughMode ? degradedThorough : degradedNonPhotoKit).toLocaleString()}
                </Text>
                <Text style={[styles.statLabel, { color: c.ink3 }]}>need improvement</Text>
              </View>
              <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                <Text style={[styles.statValue, { color: c.ink }]}>
                  {formatBandwidthEstimate(
                    repairSettings.improveQuality.thoroughMode ? degradedThorough : degradedNonPhotoKit,
                  )}
                </Text>
                <Text style={[styles.statLabel, { color: c.ink3 }]}>est. download</Text>
              </View>
              <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                <Text style={[styles.statValue, { color: c.ink }]}>
                  {(repairStatus?.mode === 'degraded' ? (repairStatus.repaired ?? 0) : 0).toLocaleString()}
                </Text>
                <Text style={[styles.statLabel, { color: c.ink3 }]}>improved</Text>
              </View>
            </View>

            {repairStatus?.mode === 'degraded' && (repairStatus.running || repairStatus.phase === 'paused') ? (
              <>
                <View style={[styles.progressTrack, { backgroundColor: c.line }]}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        backgroundColor: c.amber,
                        width: `${repairStatus.totalMissing > 0
                          ? Math.min(100, Math.round((repairStatus.checked / repairStatus.totalMissing) * 100))
                          : 0}%`,
                      },
                    ]}
                  />
                </View>
                <View style={[styles.activityBox, { backgroundColor: c.paper, borderColor: c.line }]}>
                  <Text style={[styles.activityTitle, { color: c.ink }]}>
                    {repairStatus.currentAction ?? repairStatus.lastMessage ?? 'Working…'}
                  </Text>
                  <Text style={[styles.caption, { color: c.ink4 }]}>
                    Processed {(repairStatus.checked ?? 0).toLocaleString()} of {(repairStatus.totalMissing ?? 0).toLocaleString()} files
                    {` · ${formatBytes(repairStatus.bytesDownloaded ?? 0)} downloaded`}
                  </Text>
                  {repairStatus.activity?.length ? (
                    <View style={styles.activityList}>
                      {repairStatus.activity.slice(0, 3).map((item) => (
                        <View key={`imp-${item.at}-${item.message}`} style={styles.activityRow}>
                          <Text style={[styles.activityTime, { color: c.ink4 }]}>{formatTime(item.at) ?? '--:--'}</Text>
                          <Text style={[styles.activityMessage, { color: c.ink3 }]} numberOfLines={2}>
                            {item.message}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              </>
            ) : null}

            <View style={[styles.divider, { backgroundColor: c.line }]} />

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: c.ink }]}>Wi-Fi only</Text>
                <Text style={[styles.rowSub, { color: c.ink3 }]}>
                  Pauses when you leave Wi-Fi. Resumes automatically when you come back.
                </Text>
              </View>
              <NativeSwitch
                colors={c}
                value={repairSettings.improveQuality.wifiOnly}
                onValueChange={toggleImproveWifiOnly}
              />
            </View>

            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: c.ink }]}>Rebuild for photos in my camera roll too</Text>
                <Text style={[styles.rowSub, { color: c.ink3 }]}>
                  Off by default. Your iPhone already renders thumbnails for those locally. Turn on if you plan to delete the originals from your camera roll later.
                </Text>
              </View>
              <NativeSwitch
                colors={c}
                value={repairSettings.improveQuality.thoroughMode}
                onValueChange={toggleImproveThorough}
              />
            </View>

            <TouchableOpacity
              onPress={(repairStatus?.running && repairStatus.mode === 'degraded') ? pauseImprove : startImprove}
              disabled={
                startingImprove ||
                pausingImprove ||
                (repairStatus?.running && repairStatus.mode === 'missing') ||
                (!repairStatus?.running &&
                  (repairSettings.improveQuality.thoroughMode ? degradedThorough : degradedNonPhotoKit) === 0)
              }
              style={[
                styles.primaryButton,
                {
                  backgroundColor:
                    (repairStatus?.running && repairStatus.mode === 'missing') ||
                    (!repairStatus?.running &&
                      (repairSettings.improveQuality.thoroughMode ? degradedThorough : degradedNonPhotoKit) === 0)
                      ? c.line2
                      : c.amber,
                },
              ]}
            >
              {startingImprove || pausingImprove ? (
                <ActivityIndicator color="#16110a" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {repairStatus?.running && repairStatus.mode === 'degraded'
                    ? 'Pause improvement'
                    : repairStatus?.phase === 'paused' && repairStatus.mode === 'degraded'
                      ? 'Resume improvement'
                      : 'Start improvement'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {__DEV__ ? (
          <>
            <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Diagnostics</Text>
            <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
              <Text style={[styles.body, { color: c.ink2 }]}>
                Export the current vault and backup snapshot for debugging.
              </Text>
              <TouchableOpacity
                onPress={copyDiagnostics}
                style={[styles.secondaryButton, { borderColor: c.line, backgroundColor: c.paper }]}
                accessibilityLabel="Copy backup diagnostics"
                accessibilityRole="button"
              >
                <Text style={[styles.secondaryButtonText, { color: c.ink }]}>
                  {copiedDiagnostics ? 'Copied diagnostics' : 'Copy diagnostics JSON'}
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '800' },
  scroll: { flex: 1 },
  sectionTitle: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 18, marginBottom: 8 },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', padding: 12, gap: 12 },
  segment: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden' },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentText: { fontSize: 13, fontWeight: '800' },
  body: { fontSize: 13, lineHeight: 19 },
  estimateBox: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  estimateLabel: { fontSize: 12, fontWeight: '700' },
  estimateValue: { fontSize: 26, fontWeight: '900' },
  caption: { fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 15, fontWeight: '800' },
  rowSub: { fontSize: 12, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth },
  repairBlock: { gap: 8 },
  repairHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  progressTrack: { height: 6, borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999 },
  statGrid: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 10 },
  statValue: { fontSize: 20, fontWeight: '900' },
  statLabel: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  activityBox: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 3 },
  activityTitle: { fontSize: 14, fontWeight: '800' },
  activityList: { gap: 7 },
  activityRow: { flexDirection: 'row', gap: 8 },
  activityTime: { width: 44, fontSize: 11, fontWeight: '700' },
  activityMessage: { flex: 1, fontSize: 12, lineHeight: 16 },
  primaryButton: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  primaryButtonText: { color: '#16110a', fontSize: 15, fontWeight: '900' },
  secondaryButton: { minHeight: 46, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 14, fontWeight: '800' },
});
