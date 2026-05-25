import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { getNativeBackupDiagnostics, BeebeebThumbnails, type QueueStats } from '../../modules/beebeeb-crypto';
import { useCrypto } from '../lib/crypto-context';
import { useTheme } from '../lib/theme-context';
import { getFileIndex } from '../lib/api';
import { loadCachedFileIndex, saveCachedFileIndex } from '../lib/file-index-cache';
import {
  estimatePerformanceStorage,
  getPerformanceStorageSettings,
  setPerformanceStorageSettings,
  PROFILE_LABELS,
  type PerformanceStorageProfile,
} from '../lib/performance-storage-settings';

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

export default function AdvancedSettingsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { getUnlockDiagnostics } = useCrypto();
  const [profile, setProfile] = useState<PerformanceStorageProfile>('balanced');
  const [fileCount, setFileCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);

  const estimate = useMemo(() => estimatePerformanceStorage(fileCount, profile), [fileCount, profile]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [perf, stats] = await Promise.all([
        getPerformanceStorageSettings(),
        Platform.OS === 'ios' ? BeebeebThumbnails.getQueueStats().catch(() => null) : Promise.resolve(null),
      ]);
      setProfile(perf.profile);
      setQueueStats(stats);
      // Fetch file count separately — non-blocking.
      loadCachedFileIndex().then(async (cached) => {
        const index = await getFileIndex(cached?.hash);
        const files = !index.changed && cached
          ? cached.files
          : index.files ?? cached?.files ?? [];
        if (index.changed && index.files) await saveCachedFileIndex(index.hash, index.files);
        setFileCount(files.filter((f) => !f.is_folder && !f.is_uploading).length);
      }).catch(() => {});
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (Platform.OS !== 'ios') return;
      BeebeebThumbnails.getQueueStats().then(setQueueStats).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const updateProfile = useCallback(async (next: PerformanceStorageProfile) => {
    setProfile(next);
    await setPerformanceStorageSettings({ profile: next });
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

        {/* ── Photos ────────────────────────────────────────────────────── */}
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Photos</Text>
        <TouchableOpacity
          style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}
          onPress={() => navigation.navigate('ThumbnailQuality')}
          accessibilityRole="button"
          accessibilityLabel="Thumbnail quality settings"
        >
          <View style={styles.row}>
            <Text style={[styles.rowTitle, { color: c.ink }]}>Thumbnail quality</Text>
            <Ionicons name="chevron-forward" size={18} color={c.ink3} />
          </View>
          <Text style={[styles.rowSub, { color: c.ink3 }]}>
            {Platform.OS === 'ios'
              ? 'Choose how sharp your saved thumbnails should be. Apply to existing photos.'
              : 'Thumbnail regeneration is available on iOS in this version.'}
          </Text>
        </TouchableOpacity>

        {queueStats && (queueStats.pending + queueStats.running + queueStats.failedRetry > 0) ? (
          <TouchableOpacity
            style={[styles.card, { backgroundColor: c.paper2, borderColor: c.amber, marginTop: 8 }]}
            onPress={() => navigation.navigate('ThumbnailWorker')}
            accessibilityRole="button"
            accessibilityLabel="View thumbnail improvement progress"
          >
            <Text style={[styles.rowTitle, { color: c.ink }]}>
              {`Improving thumbnails… ${queueStats.succeeded.toLocaleString()} done`}
            </Text>
            <Text style={[styles.rowSub, { color: c.ink3 }]}>
              {`${(queueStats.pending + queueStats.running + queueStats.failedRetry).toLocaleString()} remaining`}
            </Text>
          </TouchableOpacity>
        ) : null}

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
  rowTitle: { fontSize: 15, fontWeight: '800' },
  rowSub: { fontSize: 12, lineHeight: 17 },
  secondaryButton: { minHeight: 46, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 14, fontWeight: '800' },
});
