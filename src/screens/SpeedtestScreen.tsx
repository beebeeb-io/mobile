/**
 * Speed Test screen -- benchmarks latency, upload, download, and encryption.
 *
 * Ookla-style experience: animated semicircular gauge, phase stepper,
 * live speed readout, connection breakdown, and results summary.
 *
 * Gauge is built with the Animated API + rotation transforms (no extra deps).
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { fonts, spacing, type Colors } from '../theme';
import { getApiUrl, getToken, getRegion } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';

type C = Colors;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'connecting' | 'latency' | 'download' | 'upload' | 'encryption' | 'done';

interface PhaseInfo {
  key: Phase;
  label: string;
}

const PHASES: PhaseInfo[] = [
  { key: 'latency', label: 'Latency' },
  { key: 'download', label: 'Download' },
  { key: 'upload', label: 'Upload' },
  { key: 'encryption', label: 'Crypto' },
];

interface ConnectionInfo {
  server: string;
  latencyAvg: number;
  latencyMin: number;
  latencyMax: number;
  jitter: number;
}

interface Results {
  downloadMBps: number;
  uploadMBps: number;
  encryptionMBps: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  return ms < 1 ? '<1' : String(Math.round(ms));
}

function formatMBps(bytesPerSec: number): string {
  const mbps = bytesPerSec / (1024 * 1024);
  if (mbps >= 100) return mbps.toFixed(0);
  if (mbps >= 10) return mbps.toFixed(1);
  return mbps.toFixed(2);
}

function formatMBpsNum(bytesPerSec: number): number {
  return bytesPerSec / (1024 * 1024);
}

/** Map speed in MB/s to a 0-180 degree angle using a log scale for the gauge */
function speedToAngle(speedMBps: number): number {
  // Tick marks: 0, 25, 50, 100, 200, 500
  // Use log mapping for better visual distribution
  if (speedMBps <= 0) return 0;
  const maxLog = Math.log10(500);
  const speedLog = Math.log10(Math.min(speedMBps, 500));
  return Math.max(0, (speedLog / maxLog) * 180);
}

/** Compute jitter (standard deviation of latency measurements) */
function computeJitter(latencies: number[]): number {
  if (latencies.length < 2) return 0;
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const variance = latencies.reduce((sum, v) => sum + (v - mean) ** 2, 0) / latencies.length;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Gauge component
// ---------------------------------------------------------------------------

const GAUGE_SIZE = 240;
const GAUGE_STROKE = 14;
const GAUGE_RADIUS = (GAUGE_SIZE - GAUGE_STROKE) / 2;
const TICK_SPEEDS = [0, 25, 50, 100, 200, 500];

function Gauge({
  gaugeAnim,
  currentSpeed,
  unit,
  c,
}: {
  gaugeAnim: Animated.Value;
  currentSpeed: string;
  unit: string;
  c: C;
}) {
  // Needle rotation: maps 0-180 to the semicircle
  const needleRotation = gaugeAnim.interpolate({
    inputRange: [0, 180],
    outputRange: ['-90deg', '90deg'],
    extrapolate: 'clamp',
  });

  return (
    <View style={gaugeStyles.container}>
      {/* Background arc segments */}
      <View style={gaugeStyles.arcContainer}>
        {/* Background track */}
        {Array.from({ length: 36 }).map((_, i) => {
          const angle = (i * 5) - 90; // -90 to 85 degrees (180 deg semicircle)
          const rad = (angle * Math.PI) / 180;
          const x = GAUGE_RADIUS * Math.cos(rad);
          const y = GAUGE_RADIUS * Math.sin(rad);
          return (
            <View
              key={`bg-${i}`}
              style={[
                gaugeStyles.arcSegment,
                {
                  backgroundColor: c.line,
                  left: GAUGE_SIZE / 2 + x - 3,
                  top: GAUGE_SIZE / 2 + y - 3,
                  transform: [{ rotate: `${angle + 90}deg` }],
                },
              ]}
            />
          );
        })}

        {/* Animated fill segments -- using an overlay approach */}
        {Array.from({ length: 36 }).map((_, i) => {
          const segmentAngle = i * 5; // 0-175 degrees
          const angle = segmentAngle - 90;
          const rad = (angle * Math.PI) / 180;
          const x = GAUGE_RADIUS * Math.cos(rad);
          const y = GAUGE_RADIUS * Math.sin(rad);

          const opacity = gaugeAnim.interpolate({
            inputRange: [
              Math.max(0, segmentAngle - 5),
              segmentAngle,
              segmentAngle + 5,
            ],
            outputRange: [0, 1, 1],
            extrapolate: 'clamp',
          });

          return (
            <Animated.View
              key={`fill-${i}`}
              style={[
                gaugeStyles.arcSegment,
                {
                  backgroundColor: c.amber,
                  left: GAUGE_SIZE / 2 + x - 3,
                  top: GAUGE_SIZE / 2 + y - 3,
                  transform: [{ rotate: `${angle + 90}deg` }],
                  opacity,
                },
              ]}
            />
          );
        })}

        {/* Tick marks with labels */}
        {TICK_SPEEDS.map((speed) => {
          const tickAngle = speedToAngle(speed);
          const outerAngle = tickAngle - 90;
          const rad = (outerAngle * Math.PI) / 180;
          const outerR = GAUGE_RADIUS + 16;
          const x = outerR * Math.cos(rad);
          const y = outerR * Math.sin(rad);
          return (
            <View
              key={`tick-${speed}`}
              style={[
                gaugeStyles.tickLabel,
                {
                  left: GAUGE_SIZE / 2 + x - 16,
                  top: GAUGE_SIZE / 2 + y - 8,
                },
              ]}
            >
              <Text style={[gaugeStyles.tickText, { color: c.ink3 }]}>
                {speed}
              </Text>
            </View>
          );
        })}

        {/* Needle */}
        <Animated.View
          style={[
            gaugeStyles.needleContainer,
            {
              transform: [{ rotate: needleRotation }],
            },
          ]}
        >
          <View style={[gaugeStyles.needle, { backgroundColor: c.ink }]} />
        </Animated.View>

        {/* Center circle */}
        <View style={[gaugeStyles.centerDot, { backgroundColor: c.amber }]} />

        {/* Speed readout in center */}
        <View style={gaugeStyles.readout}>
          <Text style={[gaugeStyles.readoutValue, { color: c.ink, fontFamily: fonts.mono }]}>
            {currentSpeed}
          </Text>
          <Text style={[gaugeStyles.readoutUnit, { color: c.ink3 }]}>
            {unit}
          </Text>
        </View>
      </View>
    </View>
  );
}

const gaugeStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginVertical: spacing.lg,
  },
  arcContainer: {
    width: GAUGE_SIZE,
    height: GAUGE_SIZE / 2 + 30, // Half circle + space for labels
    position: 'relative',
    overflow: 'visible',
  },
  arcSegment: {
    position: 'absolute',
    width: 6,
    height: GAUGE_STROKE,
    borderRadius: 3,
  },
  tickLabel: {
    position: 'absolute',
    width: 32,
    alignItems: 'center',
  },
  tickText: {
    fontSize: 9,
    fontFamily: fonts.mono,
  },
  needleContainer: {
    position: 'absolute',
    left: GAUGE_SIZE / 2 - 2,
    top: GAUGE_SIZE / 2 - GAUGE_RADIUS + 10,
    width: 4,
    height: GAUGE_RADIUS - 10,
    transformOrigin: '2px 100%',
  },
  needle: {
    width: 4,
    height: '100%',
    borderRadius: 2,
  },
  centerDot: {
    position: 'absolute',
    left: GAUGE_SIZE / 2 - 8,
    top: GAUGE_SIZE / 2 - 8,
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  readout: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: GAUGE_SIZE / 2 - 60,
    alignItems: 'center',
  },
  readoutValue: {
    fontSize: 42,
    fontWeight: '700',
    letterSpacing: -1,
  },
  readoutUnit: {
    fontSize: 13,
    marginTop: -4,
  },
});

// ---------------------------------------------------------------------------
// Phase stepper
// ---------------------------------------------------------------------------

function PhaseStepper({
  currentPhase,
  c,
}: {
  currentPhase: Phase;
  c: C;
}) {
  const getPhaseState = (phase: PhaseInfo): 'pending' | 'active' | 'completed' => {
    if (currentPhase === 'idle') return 'pending';
    if (currentPhase === 'done') return 'completed';

    const currentIdx = PHASES.findIndex((p) => p.key === currentPhase);
    const phaseIdx = PHASES.findIndex((p) => p.key === phase.key);

    if (currentPhase === 'connecting') return 'pending';
    if (phaseIdx < currentIdx) return 'completed';
    if (phaseIdx === currentIdx) return 'active';
    return 'pending';
  };

  return (
    <View style={stepperStyles.container}>
      {PHASES.map((phase, index) => {
        const state = getPhaseState(phase);
        const dotColor =
          state === 'active' ? c.amber :
          state === 'completed' ? c.green :
          c.line2;
        const textColor =
          state === 'active' ? c.ink :
          state === 'completed' ? c.ink3 :
          c.ink4;

        return (
          <View key={phase.key} style={stepperStyles.step}>
            <View style={[stepperStyles.dot, { backgroundColor: dotColor }]} />
            <Text style={[stepperStyles.label, { color: textColor }]}>
              {phase.label}
            </Text>
            {index < PHASES.length - 1 && (
              <View
                style={[
                  stepperStyles.connector,
                  { backgroundColor: state === 'completed' ? c.green : c.line },
                ]}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

const stepperStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: '500',
  },
  connector: {
    width: 20,
    height: 1,
    marginHorizontal: 6,
  },
});

// ---------------------------------------------------------------------------
// Connection breakdown
// ---------------------------------------------------------------------------

function ConnectionBreakdown({
  info,
  c,
}: {
  info: ConnectionInfo;
  c: C;
}) {
  return (
    <View style={[breakdownStyles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
      <Text style={[breakdownStyles.title, { color: c.ink3 }]}>Connection</Text>
      <View style={breakdownStyles.row}>
        <Text style={[breakdownStyles.label, { color: c.ink3 }]}>Server</Text>
        <Text style={[breakdownStyles.value, { color: c.ink }]}>{info.server}</Text>
      </View>
      <View style={[breakdownStyles.separator, { backgroundColor: c.line }]} />
      <View style={breakdownStyles.row}>
        <Text style={[breakdownStyles.label, { color: c.ink3 }]}>Latency</Text>
        <Text style={[breakdownStyles.value, { color: c.ink, fontFamily: fonts.mono }]}>
          {formatMs(info.latencyAvg)} ms ({formatMs(info.latencyMin)}-{formatMs(info.latencyMax)})
        </Text>
      </View>
      <View style={[breakdownStyles.separator, { backgroundColor: c.line }]} />
      <View style={breakdownStyles.row}>
        <Text style={[breakdownStyles.label, { color: c.ink3 }]}>Jitter</Text>
        <Text style={[breakdownStyles.value, { color: c.ink, fontFamily: fonts.mono }]}>
          {formatMs(info.jitter)} ms
        </Text>
      </View>
    </View>
  );
}

const breakdownStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginTop: spacing.lg,
  },
  title: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  label: {
    fontSize: 13,
  },
  value: {
    fontSize: 13,
    fontWeight: '500',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});

// ---------------------------------------------------------------------------
// Results summary
// ---------------------------------------------------------------------------

function ResultsSummary({
  results,
  c,
}: {
  results: Results;
  c: C;
}) {
  const items = [
    {
      icon: 'arrow-down' as const,
      value: formatMBps(results.downloadMBps * 1024 * 1024),
      label: 'Download',
    },
    {
      icon: 'arrow-up' as const,
      value: formatMBps(results.uploadMBps * 1024 * 1024),
      label: 'Upload',
    },
    {
      icon: 'lock-closed' as const,
      value: formatMBps(results.encryptionMBps * 1024 * 1024),
      label: 'Encryption',
    },
  ];

  return (
    <View style={[summaryStyles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
      <View style={summaryStyles.row}>
        {items.map((item, i) => (
          <View key={item.label} style={summaryStyles.item}>
            <View style={summaryStyles.iconRow}>
              <Ionicons name={item.icon} size={14} color={c.amber} />
              <Text
                style={[
                  summaryStyles.value,
                  { color: c.ink, fontFamily: fonts.mono },
                ]}
              >
                {item.value}
              </Text>
            </View>
            <Text style={[summaryStyles.unit, { color: c.ink3 }]}>MB/s</Text>
            <Text style={[summaryStyles.label, { color: c.ink4 }]}>{item.label}</Text>
            {i < items.length - 1 && (
              <View
                style={[
                  summaryStyles.divider,
                  { backgroundColor: c.line },
                ]}
              />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

const summaryStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 18,
    marginTop: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  item: {
    flex: 1,
    alignItems: 'center',
    position: 'relative',
  },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  value: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  unit: {
    fontSize: 11,
    marginTop: 1,
  },
  label: {
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
  divider: {
    position: 'absolute',
    right: 0,
    top: 4,
    bottom: 4,
    width: StyleSheet.hairlineWidth,
  },
});

// ---------------------------------------------------------------------------
// Latency dots (ping visualization)
// ---------------------------------------------------------------------------

function LatencyDots({
  pings,
  c,
}: {
  pings: number[];
  c: C;
}) {
  return (
    <View style={latencyStyles.container}>
      {Array.from({ length: 5 }).map((_, i) => {
        const hasPing = i < pings.length;
        return (
          <View key={i} style={latencyStyles.pingItem}>
            <View
              style={[
                latencyStyles.dot,
                {
                  backgroundColor: hasPing ? c.amber : c.line,
                },
              ]}
            />
            {hasPing && (
              <Text style={[latencyStyles.pingValue, { color: c.ink3, fontFamily: fonts.mono }]}>
                {formatMs(pings[i])}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const latencyStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: spacing.lg,
  },
  pingItem: {
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  pingValue: {
    fontSize: 10,
  },
});

// ---------------------------------------------------------------------------
// Encryption progress bar
// ---------------------------------------------------------------------------

function EncryptionProgress({
  progress,
  chunkLabel,
  c,
}: {
  progress: number; // 0-1
  chunkLabel: string;
  c: C;
}) {
  return (
    <View style={encStyles.container}>
      <Text style={[encStyles.label, { color: c.ink3 }]}>
        Testing {chunkLabel} chunks
      </Text>
      <View style={[encStyles.track, { backgroundColor: c.line }]}>
        <View
          style={[
            encStyles.fill,
            { backgroundColor: c.amber, width: `${Math.round(progress * 100)}%` },
          ]}
        />
      </View>
    </View>
  );
}

const encStyles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.md,
  },
  label: {
    fontSize: 11,
    marginBottom: 6,
    textAlign: 'center',
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SpeedtestScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const crypto = useCrypto();

  const [phase, setPhase] = useState<Phase>('idle');
  const [statusText, setStatusText] = useState('');
  const [currentSpeed, setCurrentSpeed] = useState('--');
  const [currentUnit, setCurrentUnit] = useState('MB/s');
  const [region, setRegion] = useState('');
  const [pings, setPings] = useState<number[]>([]);
  const [encProgress, setEncProgress] = useState(0);
  const [encChunkLabel, setEncChunkLabel] = useState('');
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState('');

  const gaugeAnim = useRef(new Animated.Value(0)).current;

  const animateGauge = useCallback(
    (speedMBps: number) => {
      const angle = speedToAngle(speedMBps);
      Animated.spring(gaugeAnim, {
        toValue: angle,
        useNativeDriver: true,
        friction: 10,
        tension: 40,
      }).start();
    },
    [gaugeAnim],
  );

  const resetGauge = useCallback(() => {
    Animated.timing(gaugeAnim, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [gaugeAnim]);

  const runTest = useCallback(async () => {
    // Reset state
    setPhase('connecting');
    setStatusText('');
    setCurrentSpeed('--');
    setCurrentUnit('MB/s');
    setPings([]);
    setEncProgress(0);
    setEncChunkLabel('');
    setConnectionInfo(null);
    setResults(null);
    setError('');
    resetGauge();

    const apiUrl = getApiUrl();
    const token = await getToken();
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    // ── Region ──────────────────────────────────────────────────────────
    let serverLabel = 'Europe';
    try {
      const reg = await getRegion();
      const parts: string[] = [];
      if (reg.region) parts.push(reg.region.charAt(0).toUpperCase() + reg.region.slice(1));
      if (reg.jurisdiction) parts.push(reg.jurisdiction);
      serverLabel = parts.join(', ') || 'Europe';
      setRegion(serverLabel);
    } catch {
      setRegion('Unknown');
      serverLabel = 'Unknown';
    }

    setStatusText(`Connected to ${serverLabel}`);

    // ── 1. Latency ──────────────────────────────────────────────────────
    setPhase('latency');
    setCurrentUnit('ms');
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      try {
        await fetch(`${apiUrl}/health`);
      } catch {
        // count the attempt anyway
      }
      const ping = performance.now() - start;
      latencies.push(ping);
      setPings((prev) => [...prev, ping]);
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      setCurrentSpeed(formatMs(avg));
      setStatusText(`Ping ${i + 1}/5`);
    }

    let latencyAvg = 0;
    let latencyMin = 0;
    let latencyMax = 0;
    let jitter = 0;
    if (latencies.length > 0) {
      latencyAvg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      latencyMin = Math.min(...latencies);
      latencyMax = Math.max(...latencies);
      jitter = computeJitter(latencies);
    }

    // ── 2. Download ─────────────────────────────────────────────────────
    setPhase('download');
    setCurrentUnit('MB/s');
    setCurrentSpeed('0');
    resetGauge();
    setStatusText('Measuring download...');

    const DOWNLOAD_SIZE = 5_000_000; // 5 MB
    const downloadSpeeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      setStatusText(`Download ${i + 1}/3`);
      const start = performance.now();
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/speedtest?size=${DOWNLOAD_SIZE}`,
          { headers: authHeaders },
        );
        await res.arrayBuffer();
        const elapsed = (performance.now() - start) / 1000;
        if (elapsed > 0) {
          const speed = DOWNLOAD_SIZE / elapsed;
          downloadSpeeds.push(speed);
          const avgSpeed = downloadSpeeds.reduce((a, b) => a + b, 0) / downloadSpeeds.length;
          const mbps = formatMBpsNum(avgSpeed);
          setCurrentSpeed(formatMBps(avgSpeed));
          animateGauge(mbps);
        }
      } catch {
        // Skip failed attempt
      }
    }
    const avgDownload =
      downloadSpeeds.length > 0
        ? downloadSpeeds.reduce((a, b) => a + b, 0) / downloadSpeeds.length
        : 0;
    const downloadMBps = formatMBpsNum(avgDownload);

    // ── 3. Upload ───────────────────────────────────────────────────────
    setPhase('upload');
    setCurrentSpeed('0');
    resetGauge();
    setStatusText('Measuring upload...');

    const UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB
    const uploadBlob = new ArrayBuffer(UPLOAD_SIZE);
    const uploadSpeeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      setStatusText(`Upload ${i + 1}/3`);
      const start = performance.now();
      try {
        await fetch(`${apiUrl}/api/v1/speedtest`, {
          method: 'POST',
          headers: {
            ...authHeaders,
            'Content-Type': 'application/octet-stream',
          },
          body: uploadBlob,
        });
        const elapsed = (performance.now() - start) / 1000;
        if (elapsed > 0) {
          const speed = UPLOAD_SIZE / elapsed;
          uploadSpeeds.push(speed);
          const avgSpeed = uploadSpeeds.reduce((a, b) => a + b, 0) / uploadSpeeds.length;
          const mbps = formatMBpsNum(avgSpeed);
          setCurrentSpeed(formatMBps(avgSpeed));
          animateGauge(mbps);
        }
      } catch {
        // Skip failed attempt
      }
    }
    const avgUpload =
      uploadSpeeds.length > 0
        ? uploadSpeeds.reduce((a, b) => a + b, 0) / uploadSpeeds.length
        : 0;
    const uploadMBps = formatMBpsNum(avgUpload);

    // ── 4. Encryption ───────────────────────────────────────────────────
    setPhase('encryption');
    setCurrentSpeed('--');
    resetGauge();
    setStatusText('Benchmarking encryption...');

    let encryptionMBps = 0;

    try {
      if (!crypto.isUnlocked) {
        setStatusText('Vault locked');
        setCurrentSpeed('--');
      } else {
        const MIB = 1024 * 1024;
        const chunkSizes = [
          { size: 4 * MIB, label: '4 MB' },
          { size: 8 * MIB, label: '8 MB' },
          { size: 16 * MIB, label: '16 MB' },
          { size: 64 * MIB, label: '64 MB' },
        ];
        const benchFileId = 'speedtest-benchmark-00000000';

        let totalEncBytes = 0;
        let totalEncTime = 0;

        for (let ci = 0; ci < chunkSizes.length; ci++) {
          const { size, label } = chunkSizes[ci];
          setEncChunkLabel(label);
          setEncProgress((ci + 0.5) / chunkSizes.length);
          setStatusText(`Testing ${label} chunks`);

          const testChunk = new Uint8Array(size);
          for (let i = 0; i < Math.min(4096, size); i++) {
            testChunk[i] = Math.floor(Math.random() * 256);
          }

          const encStart = performance.now();
          const encResults: { nonce: Uint8Array; ciphertext: Uint8Array }[] = [];
          for (let i = 0; i < 2; i++) {
            const enc = await crypto.encryptChunk(benchFileId, testChunk);
            encResults.push(enc);
          }
          const encMs = performance.now() - encStart;

          totalEncBytes += 2 * size;
          totalEncTime += encMs;

          // Decrypt too for fairness (but we show encryption throughput)
          for (const { nonce, ciphertext } of encResults) {
            await crypto.decryptChunk(benchFileId, nonce, ciphertext);
          }

          setEncProgress((ci + 1) / chunkSizes.length);

          // Update gauge with running average
          if (totalEncTime > 0) {
            const runningMBps = formatMBpsNum(totalEncBytes / (totalEncTime / 1000));
            setCurrentSpeed(formatMBps(totalEncBytes / (totalEncTime / 1000)));
            animateGauge(runningMBps);
          }
        }

        encryptionMBps =
          totalEncTime > 0 ? formatMBpsNum(totalEncBytes / (totalEncTime / 1000)) : 0;
      }
    } catch {
      setStatusText('Crypto not available');
    }

    // ── Done ────────────────────────────────────────────────────────────
    setPhase('done');
    setStatusText('Test complete');
    resetGauge();

    setConnectionInfo({
      server: serverLabel,
      latencyAvg,
      latencyMin,
      latencyMax,
      jitter,
    });

    setResults({
      downloadMBps,
      uploadMBps,
      encryptionMBps,
    });
  }, [crypto, animateGauge, resetGauge]);

  const isRunning = phase !== 'idle' && phase !== 'done';

  return (
    <View style={[s.container, { backgroundColor: c.paper2 }]}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={s.backButton}
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={[s.headerTitle, { color: c.ink }]}>Speed Test</Text>
          {region !== '' && (
            <Text style={[s.headerRegion, { color: c.ink3 }]}>{region}</Text>
          )}
        </View>
        <View style={s.backButton} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + 24 }]}
      >
        {/* Phase stepper */}
        {phase !== 'idle' && <PhaseStepper currentPhase={phase} c={c} />}

        {/* Status text */}
        {statusText !== '' && (
          <Text style={[s.statusText, { color: c.ink3 }]}>{statusText}</Text>
        )}

        {/* Latency phase: ping dots */}
        {phase === 'latency' && <LatencyDots pings={pings} c={c} />}

        {/* Gauge -- visible during download, upload, encryption, and idle */}
        {(phase === 'idle' || phase === 'download' || phase === 'upload' || phase === 'encryption') && (
          <Gauge
            gaugeAnim={gaugeAnim}
            currentSpeed={currentSpeed}
            unit={phase === 'idle' ? 'MB/s' : currentUnit}
            c={c}
          />
        )}

        {/* Latency phase: show current average in big text */}
        {phase === 'latency' && (
          <View style={s.bigReadout}>
            <Text style={[s.bigReadoutValue, { color: c.ink, fontFamily: fonts.mono }]}>
              {currentSpeed}
            </Text>
            <Text style={[s.bigReadoutUnit, { color: c.ink3 }]}>ms</Text>
          </View>
        )}

        {/* Connecting phase */}
        {phase === 'connecting' && (
          <View style={s.bigReadout}>
            <Text style={[s.connectingText, { color: c.ink3 }]}>Connecting...</Text>
          </View>
        )}

        {/* Encryption progress bar */}
        {phase === 'encryption' && encChunkLabel !== '' && (
          <EncryptionProgress progress={encProgress} chunkLabel={encChunkLabel} c={c} />
        )}

        {/* Results summary (done phase) */}
        {phase === 'done' && results && <ResultsSummary results={results} c={c} />}

        {/* Connection breakdown (done phase) */}
        {phase === 'done' && connectionInfo && (
          <ConnectionBreakdown info={connectionInfo} c={c} />
        )}

        {/* Error display */}
        {error !== '' && (
          <Text style={[s.errorText, { color: c.red }]}>{error}</Text>
        )}

        {/* Run / retest button */}
        <TouchableOpacity
          style={[
            s.runButton,
            {
              backgroundColor: isRunning ? c.line2 : c.amber,
            },
          ]}
          onPress={runTest}
          disabled={isRunning}
          activeOpacity={0.7}
          accessibilityLabel={isRunning ? 'Test running' : phase === 'done' ? 'Run again' : 'Run speed test'}
          accessibilityRole="button"
        >
          <Ionicons
            name={phase === 'done' ? 'refresh-outline' : 'speedometer-outline'}
            size={18}
            color={isRunning ? c.ink3 : c.paper}
            style={{ marginRight: 8 }}
          />
          <Text style={[s.runButtonText, { color: isRunning ? c.ink3 : c.paper }]}>
            {isRunning ? 'Testing...' : phase === 'done' ? 'Test again' : 'Run test'}
          </Text>
        </TouchableOpacity>

        {/* Info note */}
        {phase === 'idle' && (
          <Text style={[s.note, { color: c.ink4 }]}>
            Tests connection to the Beebeeb API and measures on-device AES-256-GCM
            encryption throughput via the native crypto module.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerRegion: {
    fontSize: 11,
    marginTop: 2,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  statusText: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  bigReadout: {
    alignItems: 'center',
    marginVertical: spacing['2xl'],
  },
  bigReadoutValue: {
    fontSize: 56,
    fontWeight: '700',
    letterSpacing: -2,
  },
  bigReadoutUnit: {
    fontSize: 15,
    marginTop: -4,
  },
  connectingText: {
    fontSize: 18,
    fontWeight: '500',
  },
  errorText: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  runButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 10,
    marginTop: spacing.lg,
  },
  runButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  note: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.lg,
    lineHeight: 16,
    paddingHorizontal: spacing.md,
  },
});
