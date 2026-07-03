import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import type { PreviewLoadProgressEvent } from '../../modules/beebeeb-crypto';
import { useTheme } from '../lib/theme-context';
import { radii, spacing } from '../theme';

/**
 * 1180 — crash-safe Save progress.
 *
 * WHY THIS COMPONENT EXISTS (do not "simplify" it back into FilesScreen state):
 * 1177 wired decryptToTempFile's `onProgress` straight into a `setExporting(...)`
 * that lives on FilesScreen. On a 3 GB export the native layer emits a progress
 * event per network packet — hundreds per second — and every one re-rendered the
 * WHOLE FilesScreen, including its FlatList of thumbnail rows, during the most
 * memory-intensive phase of the decrypt. iOS' memory watchdog killed the app
 * (#188 then removed onProgress entirely, leaving only an indeterminate spinner).
 *
 * The native decrypt already streams to disk (URLSessionDownloadTask + per-chunk
 * decrypt), so there is NO decrypt-memory problem — the ONLY problem was render
 * churn. This component brings the percentage back WITHOUT that churn:
 *
 *   - It owns its OWN progress state (useState below). FilesScreen never holds
 *     the per-tick percentage.
 *   - FilesScreen updates it IMPERATIVELY through a ref (useImperativeHandle →
 *     `setProgress`). A progress tick calls `bannerRef.current?.setProgress(evt)`,
 *     which setStates INSIDE this component only. React re-renders this ~40pt
 *     banner and nothing else — FilesScreen and its FlatList are untouched
 *     because no state they depend on changed.
 *   - It is wrapped in React.memo, so even when FilesScreen DOES re-render (for
 *     unrelated reasons) this banner is skipped unless its `name` prop changed.
 *   - Pushes are throttled to ~5% buckets / 250ms as belt-and-suspenders, so even
 *     the isolated re-render count stays tiny.
 *
 * FilesScreen keeps `exporting: { name } | null` purely as a show/hide + name
 * toggle — it flips exactly twice per export (on start, on clear), never per tick.
 */

export interface ExportProgressBannerHandle {
  /** Feed a native progress event. Safe to call before/after mount (no-op if unmounted). */
  setProgress: (event: PreviewLoadProgressEvent) => void;
}

interface InternalProgress {
  stage: 'downloading' | 'decrypting' | null;
  /** 0..1 when known, -1 while indeterminate. */
  fraction: number;
  chunksCompleted: number;
  chunksTotal: number;
}

const INITIAL: InternalProgress = {
  stage: null,
  fraction: -1,
  chunksCompleted: 0,
  chunksTotal: 0,
};

/** Throttle: emit only when the 5% bucket or stage changes, or 250ms elapsed. */
const THROTTLE_MS = 250;
const BUCKET = 0.05;

function ExportProgressBannerImpl(
  { name }: { name: string },
  ref: React.Ref<ExportProgressBannerHandle>,
) {
  const { colors: c } = useTheme();
  const [progress, setProgressState] = useState<InternalProgress>(INITIAL);

  // Throttle bookkeeping lives in refs so it never triggers a render itself.
  const lastEmitAt = useRef(0);
  const lastBucket = useRef(-1);
  const lastStage = useRef<InternalProgress['stage']>(null);

  useImperativeHandle(
    ref,
    (): ExportProgressBannerHandle => ({
      setProgress: (event: PreviewLoadProgressEvent) => {
        // 'complete' / 'error' are handled by FilesScreen clearing `exporting`
        // (this banner unmounts). Only the two live stages update the %.
        if (event.stage !== 'downloading' && event.stage !== 'decrypting') return;

        let fraction = -1;
        let chunksCompleted = 0;
        let chunksTotal = 0;
        if (event.stage === 'downloading') {
          const total = event.bytesTotal ?? 0;
          fraction = total > 0 ? Math.max(0, Math.min(1, (event.bytesDownloaded ?? 0) / total)) : -1;
        } else {
          chunksCompleted = event.chunksCompleted ?? 0;
          chunksTotal = event.chunksTotal ?? 0;
          fraction = chunksTotal > 0 ? Math.max(0, Math.min(1, chunksCompleted / chunksTotal)) : -1;
        }

        // Belt-and-suspenders throttle — even though a tick only re-renders THIS
        // banner, keep that render count in the single digits per export.
        const now = Date.now();
        const bucket = fraction >= 0 ? Math.floor(fraction / BUCKET) : -1;
        const stageChanged = event.stage !== lastStage.current;
        const bucketChanged = bucket !== lastBucket.current;
        const timeElapsed = now - lastEmitAt.current >= THROTTLE_MS;
        if (!stageChanged && !bucketChanged && !timeElapsed) return;

        lastEmitAt.current = now;
        lastBucket.current = bucket;
        lastStage.current = event.stage;
        setProgressState({ stage: event.stage, fraction, chunksCompleted, chunksTotal });
      },
    }),
    [],
  );

  const pct = progress.fraction >= 0 ? Math.round(progress.fraction * 100) : null;

  let detail: string;
  if (progress.stage === 'downloading') {
    detail = pct != null ? `Downloading ${pct}%` : 'Downloading…';
  } else if (progress.stage === 'decrypting') {
    detail =
      progress.chunksTotal > 0
        ? `Decrypting ${progress.chunksCompleted}/${progress.chunksTotal}${pct != null ? ` (${pct}%)` : ''}`
        : 'Decrypting…';
  } else {
    detail = 'Preparing…';
  }

  return (
    <View
      style={[styles.banner, { backgroundColor: c.paper2, borderColor: c.line }]}
      accessibilityLabel={`Exporting ${name}, ${detail}`}
    >
      <ActivityIndicator size="small" color={c.amber} />
      <View style={styles.textCol}>
        <Text style={[styles.name, { color: c.ink2 }]} numberOfLines={1}>
          Exporting {name}
        </Text>
        <Text style={[styles.detail, { color: c.amberDeep }]} numberOfLines={1}>
          {detail}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 10,
  },
  textCol: { flex: 1 },
  name: { fontSize: 13, fontWeight: '500' },
  detail: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 1 },
});

/**
 * React.memo: FilesScreen re-renders (scroll shadow, file-list updates, etc.)
 * do NOT churn this banner — it only re-renders when `name` changes (twice per
 * export) or when its own imperative `setProgress` fires.
 */
const ExportProgressBanner = React.memo(forwardRef(ExportProgressBannerImpl));
ExportProgressBanner.displayName = 'ExportProgressBanner';

export default ExportProgressBanner;
