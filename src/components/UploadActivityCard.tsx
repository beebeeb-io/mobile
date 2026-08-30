import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme-context';
import { fonts } from '../theme';
import { RateMeter, etaSeconds, formatEta, formatRate, ringRotations } from '../lib/upload-metrics';

/**
 * 1301 — Live-Activity-style upload card (the "C2" direction Guus picked).
 *
 * One compact glass card: amber `b` mark, filename, a slim progress bar, one
 * mono data line with the MEASURED on-device encryption rate + network rate +
 * ETA, and a progress ring. Replaces the 3-stage trust banner; the trust story
 * survives in the data line ("→ Falkenstein") and the done state
 * ("Stored in Falkenstein · key stayed here").
 *
 * Perf note: this card re-renders once per uploaded CHUNK (~4 MB, so every
 * 0.3–3 s) via FilesScreen's existing `upload` state — the same cadence the
 * old banner had. That is NOT the ExportProgressBanner situation (hundreds of
 * native events/sec), so no imperative-ref plumbing is needed here.
 *
 * The ring is pure RN (no react-native-svg): two filled half-discs, each
 * clipped to a half-window and rotated around the ring center, covered by an
 * inner circle to leave a stroke. Geometry in lib/upload-metrics.ringRotations.
 */

export type UploadStage = 1 | 2 | 3 | 'done';

export interface UploadActivityState {
  fileName: string;
  stage: UploadStage;
  percent: number;
  city: string;
  region: string;
  chunksUploaded?: number;
  chunksTotal?: number;
  chunkSizeBytes?: number;
  bytesUploaded?: number;
  bytesTotal?: number;
  cryptoBytesPerSec?: number;
}

// ---------------------------------------------------------------------------
// Progress ring
// ---------------------------------------------------------------------------

interface RingProps {
  size: number;
  stroke: number;
  progress: number; // 0..1
  color: string;
  trackColor: string;
  holeColor: string;
  children?: React.ReactNode;
}

function ProgressRing({ size, stroke, progress, color, trackColor, holeColor, children }: RingProps) {
  const { right, left } = ringRotations(progress);
  const half = size / 2;
  const disc = (side: 'left' | 'right', rotation: number) => (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        // The 'right' layer clips to the right half of the ring (x ∈ [half, size]),
        // the 'left' layer to the left half. (First ship had these mirrored —
        // the arc painted as wedges outside the track.)
        left: side === 'right' ? half : 0,
        width: half,
        height: size,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          position: 'absolute',
          top: 0,
          [side === 'right' ? 'left' : 'right']: 0,
          width: half,
          height: size,
          backgroundColor: color,
          // Round the outer edge so the disc is an exact half-circle.
          ...(side === 'right'
            ? { borderTopRightRadius: half, borderBottomRightRadius: half }
            : { borderTopLeftRadius: half, borderBottomLeftRadius: half }),
          transform: [
            // Shift the rotation pivot from the view center to the ring center
            // (the straight edge of the half-disc), then rotate the sweep.
            { translateX: side === 'right' ? -half / 2 : half / 2 },
            { rotate: `${rotation}deg` },
            { translateX: side === 'right' ? half / 2 : -half / 2 },
          ],
        }}
      />
    </View>
  );
  return (
    <View style={{ width: size, height: size }}>
      {/* Track */}
      <View
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: half,
          borderWidth: stroke,
          borderColor: trackColor,
        }}
      />
      {/* Arc: two half-disc sweeps (right = 0–180°, left = 180–360°) */}
      {disc('right', right)}
      {disc('left', left)}
      {/* Hole → turns the pie into a ring */}
      <View
        style={{
          position: 'absolute',
          top: stroke,
          left: stroke,
          width: size - stroke * 2,
          height: size - stroke * 2,
          borderRadius: (size - stroke * 2) / 2,
          backgroundColor: holeColor,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface UploadActivityCardProps {
  upload: UploadActivityState;
  bottom: number;
}

export const UploadActivityCard = React.memo(function UploadActivityCard({ upload, bottom }: UploadActivityCardProps) {
  const { colors: c, resolved } = useTheme();
  const dark = resolved === 'dark';

  // Smoothed network rate from bytesUploaded deltas. The meter lives across
  // renders; a batch's next file restarts the counter and the meter absorbs it.
  const meterRef = useRef(new RateMeter());
  const [netRate, setNetRate] = useState<number | null>(null);
  const bytesUploaded = upload.bytesUploaded;
  useEffect(() => {
    if (upload.stage === 2 && bytesUploaded != null) {
      setNetRate(meterRef.current.sample(bytesUploaded, Date.now()));
    }
  }, [upload.stage, bytesUploaded]);
  useEffect(() => {
    // New file (or retry): drop the previous file's rate history.
    meterRef.current.reset();
    setNetRate(null);
  }, [upload.fileName]);

  const done = upload.stage === 'done';
  const progress = done
    ? 1
    : upload.bytesTotal && upload.bytesTotal > 0 && upload.bytesUploaded != null
      ? upload.bytesUploaded / upload.bytesTotal
      : Math.max(0, Math.min(1, upload.percent / 100));

  const line = useMemo(() => {
    if (done) return `Stored in ${upload.city} · key stayed here`;
    if (upload.stage === 3) return `Storing in ${upload.city}…`;
    if (upload.stage === 1) return 'Encrypting on your device…';
    const parts: string[] = [];
    const crypto = formatRate(upload.cryptoBytesPerSec);
    if (crypto) parts.push(`AES ${crypto}`);
    const net = formatRate(netRate);
    parts.push(net ? `${net} → ${upload.city}` : `→ ${upload.city}`);
    return parts.join(' · ');
  }, [done, upload.stage, upload.city, upload.cryptoBytesPerSec, upload.bytesTotal, upload.bytesUploaded, netRate]);

  const pct = Math.round(progress * 100);
  // Countdown for the ring center — compact ("23s", "4m"), no "~" in the tight hole.
  const ringEta =
    !done && upload.stage === 2 && upload.bytesTotal && upload.bytesUploaded != null
      ? formatEta(etaSeconds(upload.bytesTotal - upload.bytesUploaded, netRate))?.slice(1) ?? null
      : null;
  const hairline = dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.10)';
  const track = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const tint = dark ? 'rgba(18,18,20,0.72)' : 'rgba(250,248,245,0.72)';
  const hole = dark ? '#1c1c20' : '#f2efe9';

  return (
    <View
      style={[styles.wrap, { bottom, borderColor: done ? c.amber : hairline, shadowOpacity: dark ? 0.45 : 0.18 }]}
      accessibilityRole="progressbar"
      accessibilityLabel={`Uploading ${upload.fileName}, ${pct} percent`}
      testID="upload-activity-card"
    >
      <BlurView intensity={40} tint={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      <View style={styles.row}>
        {/* Brand mark */}
        <View style={[styles.mark, { backgroundColor: c.amber }]}>
          <Text style={styles.markGlyph}>b</Text>
        </View>

        {/* Name + bar + data line */}
        <View style={styles.middle}>
          <Text style={[styles.fileName, { color: c.ink }]} numberOfLines={1}>
            {upload.fileName}
          </Text>
          <View style={[styles.barTrack, { backgroundColor: track }]}>
            <View
              style={[
                styles.barFill,
                { backgroundColor: c.amber, width: `${Math.max(2, pct)}%` as `${number}%` },
              ]}
            />
          </View>
          <Text style={[styles.dataLine, { color: c.ink3 }]} numberOfLines={1}>
            {line}
          </Text>
        </View>

        {/* Progress ring */}
        <ProgressRing size={44} stroke={4} progress={progress} color={c.amber} trackColor={track} holeColor={hole}>
          {done ? (
            <Ionicons name="checkmark" size={18} color={c.amber} />
          ) : (
            <Text style={[styles.ringPct, { color: c.ink }]}>{ringEta ?? pct}</Text>
          )}
        </ProgressRing>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 14,
    right: 14,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 30,
    elevation: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  mark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markGlyph: {
    fontSize: 24,
    fontWeight: '800',
    color: '#1a1a1e',
    letterSpacing: -1,
    marginTop: -2,
  },
  middle: {
    flex: 1,
    minWidth: 0,
    gap: 5,
  },
  fileName: {
    fontSize: 13.5,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  barTrack: {
    height: 5,
    borderRadius: 2.5,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2.5,
  },
  dataLine: {
    fontFamily: fonts.mono,
    // 10 (not 10.5): "AES 412 MB/s · 11.8 MB/s → Falkenstein" must fit the
    // middle column on a 390pt device without truncating.
    fontSize: 10,
  },
  ringPct: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '700',
    // JetBrains Mono is tabular by design — the % number doesn't jitter.
  },
});
