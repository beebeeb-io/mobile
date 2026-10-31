import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshControl,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { BeebeebThumbnails, type QueueStats } from '../../modules/beebeeb-crypto';
import { useTheme } from '../lib/theme-context';
import { loadFileIndex } from '../lib/file-index-loader';
import { formatBytes } from '../lib/format';
import {
  estimatePerformanceStorage,
  getPerformanceStorageSettings,
  setPerformanceStorageSettings,
  PROFILE_LABELS,
  type PerformanceStorageProfile,
} from '../lib/performance-storage-settings';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PROFILES: PerformanceStorageProfile[] = ['light', 'balanced', 'smooth'];

function profileCopy(profile: PerformanceStorageProfile): string {
  if (profile === 'light') return 'Loads remote thumbnails only when they scroll into view.';
  if (profile === 'smooth') return 'Prefetches normal thumbnails and opens photos with a larger preview thumbnail.';
  return 'Prefetches normal thumbnails around the viewport for smoother scrolling.';
}

export default function AdvancedSettingsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const [profile, setProfile] = useState<PerformanceStorageProfile>('balanced');
  const [fileCount, setFileCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
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
      // Task 1959: through the coalescing loader, not a fresh /files/index walk per mount.
      loadFileIndex().then(({ files }) => {
        setFileCount((files ?? []).filter((f) => !f.is_folder && !f.is_uploading).length);
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


  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Photo loading & quality</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.amber} />}
      >
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Photo loading</Text>
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
          <Text style={[styles.body, { color: c.ink2 }]}>{profileCopy(profile)} This changes loading speed and local storage use, not the quality of your original photos.</Text>
          <View style={[styles.estimateBox, { backgroundColor: c.paper, borderColor: c.line }]}>
            <Text style={[styles.estimateLabel, { color: c.ink3 }]}>Estimated local cache</Text>
            <Text style={[styles.estimateValue, { color: c.ink }]}>{formatBytes(estimate.estimatedBytes)}</Text>
            <Text style={[styles.caption, { color: c.ink4 }]}>
              Based on {fileCount.toLocaleString()} files. Smooth adds a larger preview tier; originals load only when requested.
            </Text>
          </View>
        </View>

        {Platform.OS === 'ios' ? <>
        {/* ── Photos ────────────────────────────────────────────────────── */}
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Photos</Text>
        <TouchableOpacity
          style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}
          onPress={() => navigation.navigate('PhotoPreviews')}
          accessibilityRole="button"
          accessibilityLabel="Photo previews settings"
        >
          <View style={styles.row}>
            <Text style={[styles.rowTitle, { color: c.ink }]}>Photo previews</Text>
            <Ionicons name="chevron-forward" size={18} color={c.ink3} />
          </View>
          <Text style={[styles.rowSub, { color: c.ink3 }]}>
            Larger, sharper photos that open instantly. Choose format and size.
          </Text>
        </TouchableOpacity>

        </> : null}

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
});
