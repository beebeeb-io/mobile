import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import {
  onPoolStats,
  onFileCompleted,
  onWorkerFailure,
  type PoolStatsEvent,
  type WorkerFailureEvent,
} from '../lib/thumbnail-events';
import { useTheme } from '../lib/theme-context';
import { formatThroughput } from '../lib/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const STAGE_LABELS: Record<string, string> = {
  idle: 'Idle',
  photoKit: 'Reading photo',
  resize: 'Resizing',
  encrypt: 'Encrypting',
  upload: 'Uploading',
};

const MAX_VISIBLE_PERM_FAILURES = 25;

interface WorkerSlot {
  slot: number;
  fileId: string | null;
  stage: string;
  elapsedMs: number;
}

interface PermanentFailure {
  fileId: string;
  retrying: boolean;
}

function formatEta(etaSec: number): string {
  if (etaSec <= 0) return 'done';
  if (etaSec < 60) return `${Math.ceil(etaSec)}s`;
  const mins = Math.round(etaSec / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

function formatWorkerThroughput(filesPerSec: number, kbPerSec: number): string {
  return `${filesPerSec.toFixed(1)} files/s · ${formatThroughput(kbPerSec)}`;
}

export default function ThumbnailWorkerScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();

  const [stats, setStats] = useState<QueueStats | null>(null);
  const [workers, setWorkers] = useState<WorkerSlot[]>(
    Array.from({ length: 6 }, (_, i) => ({ slot: i, fileId: null, stage: 'idle', elapsedMs: 0 })),
  );
  const [kbPerSec, setKbPerSec] = useState(0);
  const [permFailures, setPermFailures] = useState<PermanentFailure[]>([]);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const initialLoadRef = useRef(false);

  // Load initial state
  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    void (async () => {
      try {
        const [s, failedIds] = await Promise.all([
          BeebeebThumbnails.getQueueStats(),
          BeebeebThumbnails.listFailedPermanentFiles(),
        ]);
        setStats(s);
        setPermFailures(failedIds.slice(0, MAX_VISIBLE_PERM_FAILURES).map((id) => ({ fileId: id, retrying: false })));
      } catch {
        // Native module unavailable.
      }
    })();
  }, []);

  // Subscribe to pool events
  useEffect(() => {
    const poolSub = onPoolStats((event: PoolStatsEvent) => {
      setStats({
        pending: event.queueDepth,
        running: event.workers.filter((w) => w.fileId !== null).length,
        succeeded: stats?.succeeded ?? 0,
        failedRetry: event.retrying,
        failedPerm: stats?.failedPerm ?? 0,
        filesPerSec: event.filesPerSec,
        etaSec: event.etaSec,
        isPaused: event.isPaused,
        isThermalThrottled: event.isThermalThrottled,
      });
      setKbPerSec(event.kbPerSec);
      setWorkers(
        event.workers.length > 0
          ? event.workers
          : workers,
      );
    });

    const fileSub = onFileCompleted((event) => {
      if (event.success) {
        setStats((prev) =>
          prev ? { ...prev, succeeded: prev.succeeded + 1 } : prev,
        );
        // Remove from perm failures if it had been retried and succeeded
        setPermFailures((prev) => prev.filter((f) => f.fileId !== event.fileId));
      }
    });

    const failSub = onWorkerFailure((event: WorkerFailureEvent) => {
      // Only add to permanent failures list if it hasn't been retried yet
      setPermFailures((prev) => {
        const exists = prev.some((f) => f.fileId === event.fileId);
        if (exists) return prev;
        if (prev.length >= MAX_VISIBLE_PERM_FAILURES) return prev;
        return [...prev, { fileId: event.fileId, retrying: false }];
      });
    });

    return () => {
      poolSub.remove();
      fileSub.remove();
      failSub.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePauseResume = useCallback(async () => {
    if (!stats) return;
    if (stats.isPaused) {
      setResuming(true);
      try {
        await BeebeebThumbnails.resumeWorkers();
        setStats((prev) => prev ? { ...prev, isPaused: false } : prev);
      } finally {
        setResuming(false);
      }
    } else {
      setPausing(true);
      try {
        await BeebeebThumbnails.pauseWorkers();
        setStats((prev) => prev ? { ...prev, isPaused: true } : prev);
      } finally {
        setPausing(false);
      }
    }
  }, [stats]);

  const handleRetry = useCallback(async (fileId: string) => {
    setPermFailures((prev) =>
      prev.map((f) => f.fileId === fileId ? { ...f, retrying: true } : f),
    );
    try {
      await BeebeebThumbnails.retryFile(fileId);
    } catch {
      // Ignore — will appear back in perm failures if it fails again.
    } finally {
      setPermFailures((prev) =>
        prev.map((f) => f.fileId === fileId ? { ...f, retrying: false } : f),
      );
    }
  }, []);

  const completed = stats?.succeeded ?? 0;
  const total = completed + (stats?.pending ?? 0) + (stats?.running ?? 0) + (stats?.failedRetry ?? 0);
  const progress = total > 0 ? completed / total : 0;

  const isActive = stats != null && !stats.isPaused && (stats.pending > 0 || stats.running > 0 || stats.failedRetry > 0);
  const remaining = (stats?.pending ?? 0) + (stats?.running ?? 0) + (stats?.failedRetry ?? 0);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Improving thumbnails</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
      >
        {/* Big numbers */}
        <View style={styles.bigNumbers}>
          <Text style={[styles.bigNumber, { color: c.ink }]}>{completed.toLocaleString()}</Text>
          <Text style={[styles.bigNumberDivider, { color: c.ink3 }]}>/</Text>
          <Text style={[styles.bigTotal, { color: c.ink3 }]}>{total.toLocaleString()}</Text>
          {isActive ? <ActivityIndicator color={c.amber} style={styles.spinner} /> : null}
        </View>

        {/* Progress bar */}
        <View style={[styles.progressTrack, { backgroundColor: c.line }]}>
          <View style={[styles.progressFill, { backgroundColor: c.amber, width: `${progress * 100}%` }]} />
        </View>

        {/* Throughput + ETA */}
        {stats && (stats.filesPerSec > 0 || stats.etaSec > 0) ? (
          <Text style={[styles.throughputLine, { color: c.ink3 }]}>
            {formatWorkerThroughput(stats.filesPerSec, kbPerSec)}
            {stats.etaSec > 0 ? ` · ETA ${formatEta(stats.etaSec)}` : ''}
            {stats.isThermalThrottled ? ' · throttled' : ''}
          </Text>
        ) : remaining === 0 ? (
          <Text style={[styles.throughputLine, { color: c.green }]}>All done</Text>
        ) : stats?.isPaused ? (
          <Text style={[styles.throughputLine, { color: c.ink3 }]}>Paused</Text>
        ) : (
          <Text style={[styles.throughputLine, { color: c.ink4 }]}>Waiting for workers…</Text>
        )}

        {/* Active workers */}
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Active workers</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          {workers.map((w) => (
            <View key={w.slot} style={styles.workerRow}>
              <View style={[styles.slotBadge, { backgroundColor: w.fileId ? c.amber : c.line }]}>
                <Text style={[styles.slotText, { color: w.fileId ? '#16110a' : c.ink4 }]}>
                  {w.slot + 1}
                </Text>
              </View>
              <View style={styles.workerInfo}>
                <Text style={[styles.workerFileId, { color: w.fileId ? c.ink : c.ink4 }]} numberOfLines={1}>
                  {w.fileId ? w.fileId.slice(0, 8) : '—'}
                </Text>
                <Text style={[styles.workerStage, { color: c.ink3 }]}>
                  {STAGE_LABELS[w.stage] ?? w.stage}
                  {w.elapsedMs > 0 && w.fileId ? ` · ${(w.elapsedMs / 1000).toFixed(1)}s` : ''}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* Tally card */}
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Tally</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <View style={styles.statGrid}>
            <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
              <Text style={[styles.statValue, { color: c.green }]}>{(stats?.succeeded ?? 0).toLocaleString()}</Text>
              <Text style={[styles.statLabel, { color: c.ink3 }]}>Updated</Text>
            </View>
            <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
              <Text style={[styles.statValue, { color: c.amber }]}>{(stats?.failedRetry ?? 0).toLocaleString()}</Text>
              <Text style={[styles.statLabel, { color: c.ink3 }]}>Retrying</Text>
            </View>
            <View style={[styles.statBox, { backgroundColor: c.paper, borderColor: c.line }]}>
              <Text style={[styles.statValue, { color: c.red }]}>{(stats?.failedPerm ?? 0).toLocaleString()}</Text>
              <Text style={[styles.statLabel, { color: c.ink3 }]}>Failed</Text>
            </View>
          </View>
        </View>

        {/* Permanent failures list */}
        {permFailures.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: c.ink3 }]}>
              {`Failed permanently (${permFailures.length})`}
            </Text>
            <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
              {permFailures.map((failure, index) => (
                <View key={failure.fileId}>
                  {index > 0 ? <View style={[styles.divider, { backgroundColor: c.line }]} /> : null}
                  <View style={styles.failureRow}>
                    <Text style={[styles.failureFileId, { color: c.ink3 }]} numberOfLines={1}>
                      {failure.fileId.slice(0, 16)}…
                    </Text>
                    <TouchableOpacity
                      onPress={() => void handleRetry(failure.fileId)}
                      disabled={failure.retrying}
                      style={[styles.retryButton, { borderColor: c.line, backgroundColor: c.paper }]}
                    >
                      {failure.retrying ? (
                        <ActivityIndicator color={c.amber} size="small" />
                      ) : (
                        <Text style={[styles.retryButtonText, { color: c.ink }]}>Retry</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[
              styles.primaryButton,
              { backgroundColor: stats?.isPaused ? c.amber : c.paper2, borderColor: stats?.isPaused ? c.amber : c.line },
            ]}
            onPress={() => void handlePauseResume()}
            disabled={pausing || resuming}
            accessibilityRole="button"
            accessibilityLabel={stats?.isPaused ? 'Resume workers' : 'Pause workers'}
          >
            {pausing || resuming ? (
              <ActivityIndicator color={stats?.isPaused ? '#16110a' : c.ink} />
            ) : (
              <Text style={[styles.primaryButtonText, { color: stats?.isPaused ? '#16110a' : c.ink }]}>
                {stats?.isPaused ? 'Resume' : 'Pause'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryButton, { borderColor: c.line, backgroundColor: c.paper }]}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Hide and continue in background"
          >
            <Text style={[styles.secondaryButtonText, { color: c.ink2 }]}>
              Hide and continue in background
            </Text>
          </TouchableOpacity>
        </View>
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
  title: { fontSize: 18, fontWeight: '800' },
  scroll: { flex: 1 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 18,
    marginBottom: 8,
  },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', padding: 12, gap: 10 },
  bigNumbers: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    marginBottom: 10,
  },
  bigNumber: { fontSize: 36, fontWeight: '900' },
  bigNumberDivider: { fontSize: 28, fontWeight: '400' },
  bigTotal: { fontSize: 28, fontWeight: '400', flex: 1 },
  spinner: { marginLeft: 8 },
  progressTrack: { height: 8, borderRadius: 999, overflow: 'hidden', marginBottom: 8 },
  progressFill: { height: '100%', borderRadius: 999 },
  throughputLine: { fontSize: 12, lineHeight: 17, marginBottom: 4 },
  workerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  slotBadge: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotText: { fontSize: 12, fontWeight: '800' },
  workerInfo: { flex: 1 },
  workerFileId: { fontSize: 13, fontWeight: '700' },
  workerStage: { fontSize: 11 },
  statGrid: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 10 },
  statValue: { fontSize: 20, fontWeight: '900' },
  statLabel: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  failureRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  failureFileId: { flex: 1, fontSize: 12, fontFamily: 'JetBrainsMono-Regular' },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 56,
    alignItems: 'center',
  },
  retryButtonText: { fontSize: 13, fontWeight: '700' },
  actions: { marginTop: 20, gap: 10 },
  primaryButton: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { fontSize: 15, fontWeight: '900' },
  secondaryButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { fontSize: 14, fontWeight: '700' },
});
