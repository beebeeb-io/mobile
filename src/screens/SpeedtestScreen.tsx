/**
 * Speed Test screen -- benchmarks latency, upload, download, and encryption.
 *
 * Native diagnostics experience with live phase status, metric cards,
 * connection breakdown, and results summary.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { fonts, spacing, type Colors } from '../theme';
import { getApiUrl, getToken, getRegion } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import { saveDevicePerformanceProfile } from '../lib/device-performance';

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
  measuredAt?: string;
  networkType?: string;
  uploadSkipped?: boolean;
}

interface TransferSample {
  label: string;
  size: number;
}

interface TransferResult {
  bytes: number;
  seconds: number;
}

interface LastSpeedtestRun {
  measuredAt: string;
  networkType: string;
  downloadMbps: number;
  uploadMbps: number | null;
  encryptionMBps: number;
  uploadSkipped: boolean;
}

const MIB = 1024 * 1024;
const SPEEDTEST_LAST_RUN_KEY = 'beebeeb.speedtest.lastRun.v1';
const LARGE_SAMPLE_MIN_MBPS = 25;
const TRANSFER_SAMPLES: TransferSample[] = [
  { label: '1 MB', size: 1 * MIB },
  { label: '5 MB', size: 5 * MIB },
  { label: '20 MB', size: 20 * MIB },
];

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

function formatMbps(bytesPerSec: number): string {
  const mbps = (bytesPerSec * 8) / 1_000_000;
  if (mbps >= 100) return mbps.toFixed(0);
  if (mbps >= 10) return mbps.toFixed(1);
  return mbps.toFixed(2);
}

function formatMbpsValue(mbps: number): string {
  if (mbps >= 100) return mbps.toFixed(0);
  if (mbps >= 10) return mbps.toFixed(1);
  return mbps.toFixed(2);
}

function bytesPerSecondToMbps(bytesPerSec: number): number {
  return (bytesPerSec * 8) / 1_000_000;
}

function formatMBpsNum(bytesPerSec: number): number {
  return bytesPerSec / (1024 * 1024);
}

function mbpsFromStoredMBps(mbps: number): number {
  return bytesPerSecondToMbps(mbps * 1024 * 1024);
}

function shouldRunLargeSample(bytesPerSec: number): boolean {
  return bytesPerSecondToMbps(bytesPerSec) >= LARGE_SAMPLE_MIN_MBPS;
}

function formatNetworkType(type: string): string {
  switch (type) {
    case 'wifi':
      return 'Wi-Fi';
    case 'cellular':
      return 'Cellular';
    case 'ethernet':
      return 'Ethernet';
    case 'none':
      return 'Offline';
    case 'unknown':
      return 'Unknown';
    default:
      return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Unknown';
  }
}

function formatLastRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Map speed in MB/s to a 0-1 progress value using a log scale. */
function speedToProgress(speedMBps: number): number {
  if (speedMBps <= 0) return 0;
  const maxLog = Math.log10(500);
  const speedLog = Math.log10(Math.min(speedMBps, 500));
  return Math.max(0, Math.min(1, speedLog / maxLog));
}

/** Compute jitter (standard deviation of latency measurements) */
function computeJitter(latencies: number[]): number {
  if (latencies.length < 2) return 0;
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const variance = latencies.reduce((sum, v) => sum + (v - mean) ** 2, 0) / latencies.length;
  return Math.sqrt(variance);
}

function xhrTransfer(
  url: string,
  options: {
    body?: ArrayBuffer;
    headers?: Record<string, string>;
    method: 'GET' | 'POST';
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<TransferResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const startedAt = performance.now();
    xhr.open(options.method, url);
    xhr.responseType = 'arraybuffer';
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    if (options.method === 'POST') {
      xhr.upload.onprogress = (event) => {
        options.onProgress?.(event.loaded, event.lengthComputable ? event.total : options.body?.byteLength ?? 0);
      };
    } else {
      xhr.onprogress = (event) => {
        options.onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
      };
    }
    xhr.onerror = () => reject(new Error('Network request failed'));
    xhr.ontimeout = () => reject(new Error('Network request timed out'));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Speedtest request failed with HTTP ${xhr.status}`));
        return;
      }
      const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.001);
      const responseBytes = xhr.response instanceof ArrayBuffer ? xhr.response.byteLength : 0;
      resolve({
        bytes: options.method === 'POST' ? options.body?.byteLength ?? 0 : responseBytes,
        seconds: elapsed,
      });
    };
    xhr.send(options.body ?? null);
  });
}

function phaseTitle(phase: Phase): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting to Beebeeb';
    case 'latency':
      return 'Latency';
    case 'download':
      return 'Download';
    case 'upload':
      return 'Upload';
    case 'encryption':
      return 'On-device encryption';
    case 'done':
      return 'Result';
    case 'idle':
    default:
      return 'Ready to test';
  }
}

function phaseIcon(phase: Phase): keyof typeof Ionicons.glyphMap {
  switch (phase) {
    case 'connecting':
      return 'radio-outline';
    case 'latency':
      return 'pulse-outline';
    case 'download':
      return 'arrow-down-outline';
    case 'upload':
      return 'arrow-up-outline';
    case 'encryption':
      return 'lock-closed-outline';
    case 'done':
      return 'checkmark-circle-outline';
    case 'idle':
    default:
      return 'speedometer-outline';
  }
}

function phaseCaption(phase: Phase, statusText: string): string {
  if (statusText) return statusText;
  switch (phase) {
    case 'idle':
      return 'Measures API latency, transfer speed, and local crypto throughput.';
    case 'done':
      return 'Last completed benchmark';
    default:
      return 'Benchmark running';
  }
}

function MetricPanel({
  phase,
  statusText,
  currentSpeed,
  unit,
  progress,
  c,
}: {
  phase: Phase;
  statusText: string;
  currentSpeed: string;
  unit: string;
  progress: number;
  c: C;
}) {
  const clamped = Math.max(0, Math.min(1, progress));
  const value = phase === 'idle' ? 'Ready' : phase === 'connecting' ? '...' : currentSpeed;
  const displayUnit = phase === 'idle' || phase === 'connecting' ? '' : unit;
  const progressLabel = phase === 'idle' ? 'Start' : phase === 'done' ? 'Complete' : 'Running';

  return (
    <View style={[meterStyles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
      <View style={meterStyles.topRow}>
        <View style={[meterStyles.iconWrap, { backgroundColor: c.amberBg }]}>
          <Ionicons name={phaseIcon(phase)} size={20} color={c.amber} />
        </View>
        <View style={meterStyles.titleBlock}>
          <Text style={[meterStyles.title, { color: c.ink }]}>{phaseTitle(phase)}</Text>
          <Text style={[meterStyles.caption, { color: c.ink2 }]} numberOfLines={2}>
            {phaseCaption(phase, statusText)}
          </Text>
        </View>
      </View>

      <View style={meterStyles.readoutRow}>
        <Text
          style={[
            meterStyles.value,
            {
              color: c.ink,
              fontFamily: phase === 'idle' ? undefined : fonts.mono,
              fontSize: phase === 'idle' ? 42 : 52,
            },
          ]}
        >
          {value}
        </Text>
        {displayUnit !== '' && (
          <Text style={[meterStyles.unit, { color: c.ink3 }]}>{displayUnit}</Text>
        )}
      </View>

      <View style={[meterStyles.track, { backgroundColor: c.line }]}>
        <View
          style={[
            meterStyles.fill,
            {
              backgroundColor: c.amber,
              width: `${Math.round((phase === 'done' ? 1 : clamped) * 100)}%`,
            },
          ]}
        />
      </View>
      <View style={meterStyles.scaleRow}>
        <Text style={[meterStyles.scaleText, { color: c.ink4 }]}>{progressLabel}</Text>
        <Text style={[meterStyles.scaleText, { color: c.ink4 }]}>
          {phase === 'latency'
            ? 'lower is better'
            : phase === 'download' || phase === 'upload' || phase === 'encryption'
              ? 'sample progress'
              : 'Mbps scale'}
        </Text>
      </View>
    </View>
  );
}

const meterStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 18,
    marginBottom: spacing.lg,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  caption: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  readoutRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 22,
  },
  value: {
    fontSize: 52,
    fontWeight: '800',
    letterSpacing: 0,
  },
  unit: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 10,
    marginLeft: 8,
  },
  track: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 14,
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
  scaleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  scaleText: {
    fontSize: 11,
    fontWeight: '500',
  },
});

function BenchmarkGrid({
  phase,
  currentSpeed,
  currentUnit,
  liveLatencyMs,
  liveResults,
  results,
  c,
}: {
  phase: Phase;
  currentSpeed: string;
  currentUnit: string;
  liveLatencyMs: number | null;
  liveResults: Partial<Results>;
  results: Results | null;
  c: C;
}) {
  const latencyValue = phase === 'latency' && currentSpeed !== '--'
    ? currentSpeed
    : liveLatencyMs !== null
      ? formatMs(liveLatencyMs)
      : '--';
  const latencyUnit = latencyValue !== '--' ? 'ms' : '';
  const downloadValue = results
    ? formatMbps(results.downloadMBps * 1024 * 1024)
    : liveResults.downloadMBps !== undefined
      ? formatMbps(liveResults.downloadMBps * 1024 * 1024)
      : phase === 'download'
        ? currentSpeed
        : '--';
  const uploadValue = results
    ? results.uploadSkipped
      ? 'Skipped'
      : formatMbps(results.uploadMBps * 1024 * 1024)
    : liveResults.uploadMBps !== undefined
      ? liveResults.uploadSkipped
        ? 'Skipped'
        : formatMbps(liveResults.uploadMBps * 1024 * 1024)
      : phase === 'upload'
        ? currentSpeed
        : '--';
  const cryptoValue = results
    ? formatMBps(results.encryptionMBps * 1024 * 1024)
    : liveResults.encryptionMBps !== undefined
      ? formatMBps(liveResults.encryptionMBps * 1024 * 1024)
      : phase === 'encryption'
        ? currentSpeed
        : '--';
  const items = [
    {
      icon: 'pulse-outline' as const,
      label: 'Latency',
      value: latencyValue,
      unit: latencyUnit,
      active: phase === 'latency',
    },
    {
      icon: 'arrow-down-outline' as const,
      label: 'Download',
      value: downloadValue,
      unit: downloadValue !== '--' ? 'Mbps' : '',
      active: phase === 'download',
    },
    {
      icon: 'arrow-up-outline' as const,
      label: 'Upload',
      value: uploadValue,
      unit: uploadValue !== '--' && uploadValue !== 'Skipped' ? 'Mbps' : '',
      active: phase === 'upload',
    },
    {
      icon: 'lock-closed-outline' as const,
      label: 'Crypto',
      value: cryptoValue,
      unit: cryptoValue !== '--' ? 'MB/s' : '',
      active: phase === 'encryption',
    },
  ];

  return (
    <View style={gridStyles.container}>
      {items.map((item) => (
        <View
          key={item.label}
          style={[
            gridStyles.tile,
            {
              backgroundColor: item.active ? c.amberBg : c.paper,
              borderColor: item.active ? c.amber : c.line,
            },
          ]}
        >
          <View style={gridStyles.tileHeader}>
            <Ionicons name={item.icon} size={16} color={item.active ? c.amberDeep : c.ink3} />
            <Text style={[gridStyles.tileLabel, { color: c.ink3 }]}>{item.label}</Text>
          </View>
          <View style={gridStyles.tileValueRow}>
            <Text style={[gridStyles.tileValue, { color: c.ink, fontFamily: fonts.mono }]}>
              {item.value}
            </Text>
            {item.unit !== '' && (
              <Text style={[gridStyles.tileUnit, { color: c.ink3 }]}>{item.unit}</Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const gridStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: spacing.md,
  },
  tile: {
    width: '48.6%',
    borderWidth: 1,
    borderRadius: 8,
    padding: 13,
    minHeight: 96,
  },
  tileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  tileLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  tileValueRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 15,
  },
  tileValue: {
    fontSize: 27,
    fontWeight: '800',
    letterSpacing: 0,
  },
  tileUnit: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 5,
    marginBottom: 4,
  },
});

function TestScope({ c }: { c: C }) {
  const rows = [
    {
      icon: 'radio-outline' as const,
      title: 'API route',
      detail: 'Round trip to the active Beebeeb region',
    },
    {
      icon: 'swap-vertical-outline' as const,
      title: 'Transfer',
      detail: 'Download and upload sample payloads',
    },
    {
      icon: 'shield-checkmark-outline' as const,
      title: 'Local crypto',
      detail: 'Encrypt and decrypt on this iPhone',
    },
  ];

  return (
    <View style={[scopeStyles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
      {rows.map((row, index) => (
        <View key={row.title}>
          <View style={scopeStyles.row}>
            <View style={[scopeStyles.scopeIcon, { backgroundColor: c.paper2 }]}>
              <Ionicons name={row.icon} size={16} color={c.ink2} />
            </View>
            <View style={scopeStyles.scopeCopy}>
              <Text style={[scopeStyles.scopeTitle, { color: c.ink }]}>{row.title}</Text>
              <Text style={[scopeStyles.scopeDetail, { color: c.ink3 }]}>{row.detail}</Text>
            </View>
          </View>
          {index < rows.length - 1 && (
            <View style={[scopeStyles.separator, { backgroundColor: c.line }]} />
          )}
        </View>
      ))}
    </View>
  );
}

const scopeStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 8,
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  scopeIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  scopeCopy: {
    flex: 1,
  },
  scopeTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  scopeDetail: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 58,
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
    borderRadius: 8,
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
      value: formatMbps(results.downloadMBps * 1024 * 1024),
      unit: 'Mbps',
      label: 'Download',
    },
    {
      icon: 'arrow-up' as const,
      value: results.uploadSkipped ? 'Skipped' : formatMbps(results.uploadMBps * 1024 * 1024),
      unit: results.uploadSkipped ? '' : 'Mbps',
      label: 'Upload',
    },
    {
      icon: 'lock-closed' as const,
      value: formatMBps(results.encryptionMBps * 1024 * 1024),
      unit: 'MB/s',
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
            <Text style={[summaryStyles.unit, { color: c.ink3 }]}>{item.unit}</Text>
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
      {results.measuredAt && (
        <Text style={[summaryStyles.note, { color: c.ink4 }]}>
          Tested {formatLastRunTime(results.measuredAt)}
          {results.networkType ? ` on ${formatNetworkType(results.networkType)}` : ''}.
        </Text>
      )}
    </View>
  );
}

function LastRunSummary({
  lastRun,
  c,
}: {
  lastRun: LastSpeedtestRun;
  c: C;
}) {
  return (
    <View style={[summaryStyles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
      <Text style={[summaryStyles.lastTitle, { color: c.ink3 }]}>Last speed test</Text>
      <Text style={[summaryStyles.note, { color: c.ink4 }]}>
        {formatLastRunTime(lastRun.measuredAt)} on {formatNetworkType(lastRun.networkType)}
      </Text>
      <View style={summaryStyles.lastRow}>
        <Text style={[summaryStyles.lastMetric, { color: c.ink, fontFamily: fonts.mono }]}>
          {formatMbpsValue(lastRun.downloadMbps)} Mbps down
        </Text>
        <Text style={[summaryStyles.lastMetric, { color: c.ink, fontFamily: fonts.mono }]}>
          {lastRun.uploadSkipped || lastRun.uploadMbps === null
            ? 'Upload skipped'
            : `${formatMbpsValue(lastRun.uploadMbps)} Mbps up`}
        </Text>
      </View>
    </View>
  );
}

const summaryStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 8,
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
    letterSpacing: 0,
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
  note: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 14,
    textAlign: 'center',
  },
  lastTitle: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  lastRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'center',
    marginTop: 12,
  },
  lastMetric: {
    fontSize: 12,
    fontWeight: '600',
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
  const [currentUnit, setCurrentUnit] = useState('Mbps');
  const [region, setRegion] = useState('');
  const [pings, setPings] = useState<number[]>([]);
  const [encProgress, setEncProgress] = useState(0);
  const [encChunkLabel, setEncChunkLabel] = useState('');
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [liveLatencyMs, setLiveLatencyMs] = useState<number | null>(null);
  const [liveResults, setLiveResults] = useState<Partial<Results>>({});
  const [error, setError] = useState('');
  const [meterProgress, setMeterProgress] = useState(0);
  const [networkType, setNetworkType] = useState('unknown');
  const [lastRun, setLastRun] = useState<LastSpeedtestRun | null>(null);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(SPEEDTEST_LAST_RUN_KEY)
      .then((raw) => {
        if (!mounted || !raw) return;
        setLastRun(JSON.parse(raw) as LastSpeedtestRun);
      })
      .catch(() => {});
    NetInfo.fetch()
      .then((state) => {
        if (mounted) setNetworkType(state.type ?? 'unknown');
      })
      .catch(() => {});
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (mounted) setNetworkType(state.type ?? 'unknown');
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const animateGauge = useCallback(
    (speedMBps: number) => {
      setMeterProgress(speedToProgress(speedMBps));
    },
    [],
  );

  const resetGauge = useCallback(() => {
    setMeterProgress(0);
  }, []);

  const runTest = useCallback(async (options?: { full?: boolean }) => {
    // Reset state
    setPhase('connecting');
    setStatusText('');
    setCurrentSpeed('--');
    setCurrentUnit('Mbps');
    setPings([]);
    setEncProgress(0);
    setEncChunkLabel('');
    setConnectionInfo(null);
    setResults(null);
    setLiveLatencyMs(null);
    setLiveResults({});
    setError('');
    resetGauge();

    try {
    const apiUrl = getApiUrl();
    const token = await getToken();
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    const net = await NetInfo.fetch();
    const runNetworkType = net.type ?? 'unknown';
    const skipUploadOnCellular = runNetworkType === 'cellular' && !options?.full;
    setNetworkType(runNetworkType);

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
      setMeterProgress(Math.max(0, Math.min(1, 1 - avg / 250)));
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
    setLiveLatencyMs(latencyAvg);

    // ── 2. Download (parallel streams) ─────────────────────────────────
    setPhase('download');
    setCurrentUnit('Mbps');
    setCurrentSpeed('0');
    resetGauge();
    setStatusText('Measuring download...');

    let totalDownloadBytes = 0;
    let totalDownloadTime = 0;
    for (let i = 0; i < TRANSFER_SAMPLES.length; i++) {
      if (i === 2 && totalDownloadTime > 0 && !shouldRunLargeSample(totalDownloadBytes / totalDownloadTime)) {
        setStatusText(`Download settled after 5 MB (${formatMbps(totalDownloadBytes / totalDownloadTime)} Mbps)`);
        setMeterProgress(1);
        break;
      }
      const sample = TRANSFER_SAMPLES[i];
      setStatusText(`Downloading ${sample.label} sample (${i + 1}/${TRANSFER_SAMPLES.length})`);
      const result = await xhrTransfer(`${apiUrl}/api/v1/speedtest?size=${sample.size}`, {
        headers: authHeaders,
        method: 'GET',
        onProgress: (loaded, total) => {
          const sampleProgress = total > 0 ? loaded / total : loaded / sample.size;
          setMeterProgress(Math.max(0, Math.min(1, (i + sampleProgress) / TRANSFER_SAMPLES.length)));
        },
      });
      if (result.seconds > 0 && result.bytes > 0) {
        totalDownloadBytes += result.bytes;
        totalDownloadTime += result.seconds;
        setCurrentSpeed(formatMbps(totalDownloadBytes / totalDownloadTime));
      }
    }
    const downloadMBps = totalDownloadTime > 0
      ? formatMBpsNum(totalDownloadBytes / totalDownloadTime)
      : 0;
    setLiveResults((prev) => ({ ...prev, downloadMBps }));

    // ── 3. Upload (parallel streams) ────────────────────────────────────
    setPhase('upload');
    setCurrentUnit('Mbps');
    setCurrentSpeed('0');
    resetGauge();
    setStatusText('Measuring upload...');

    let totalUploadBytes = 0;
    let totalUploadTime = 0;
    let uploadSkipped = false;
    if (skipUploadOnCellular) {
      uploadSkipped = true;
      setCurrentSpeed('Skipped');
      setStatusText('Upload skipped on cellular. Run full test to include it.');
      setMeterProgress(1);
    } else {
      for (let i = 0; i < TRANSFER_SAMPLES.length; i++) {
        if (i === 2 && totalUploadTime > 0 && !shouldRunLargeSample(totalUploadBytes / totalUploadTime)) {
          setStatusText(`Upload settled after 5 MB (${formatMbps(totalUploadBytes / totalUploadTime)} Mbps)`);
          setMeterProgress(1);
          break;
        }
        const sample = TRANSFER_SAMPLES[i];
        setStatusText(`Uploading ${sample.label} sample (${i + 1}/${TRANSFER_SAMPLES.length})`);
        const uploadBlob = new ArrayBuffer(sample.size);
        const result = await xhrTransfer(`${apiUrl}/api/v1/speedtest`, {
          body: uploadBlob,
          headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
          method: 'POST',
          onProgress: (loaded, total) => {
            const sampleProgress = total > 0 ? loaded / total : loaded / sample.size;
            setMeterProgress(Math.max(0, Math.min(1, (i + sampleProgress) / TRANSFER_SAMPLES.length)));
          },
        });
        if (result.seconds > 0 && result.bytes > 0) {
          totalUploadBytes += result.bytes;
          totalUploadTime += result.seconds;
          setCurrentSpeed(formatMbps(totalUploadBytes / totalUploadTime));
        }
      }
    }
    const uploadMBps = totalUploadTime > 0
      ? formatMBpsNum(totalUploadBytes / totalUploadTime)
      : 0;
    setLiveResults((prev) => ({ ...prev, uploadMBps, uploadSkipped }));

    // ── 4. Encryption ───────────────────────────────────────────────────
    setPhase('encryption');
    setCurrentUnit('MB/s');
    setCurrentSpeed('--');
    resetGauge();
    setStatusText('Benchmarking encryption...');

    let encryptionMBps = 0;

    try {
      if (!crypto.isUnlocked) {
        setStatusText('Vault locked');
        setCurrentSpeed('--');
      } else {
        const chunkSizes = [
          { size: 1 * MIB, label: '1 MB' },
          { size: 4 * MIB, label: '4 MB' },
          { size: 8 * MIB, label: '8 MB' },
          { size: 16 * MIB, label: '16 MB' },
        ];
        const benchFileId = 'speedtest-benchmark-00000000';

        let totalEncBytes = 0;
        let totalEncTime = 0;
        let totalDecBytes = 0;
        let totalDecTime = 0;

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
          const enc = await crypto.encryptChunk(benchFileId, testChunk);
          encResults.push(enc);
          const encMs = performance.now() - encStart;

          totalEncBytes += size;
          totalEncTime += encMs;

          // Decrypt too for fairness (but we show encryption throughput)
          for (const { nonce, ciphertext } of encResults) {
            const decStart = performance.now();
            await crypto.decryptChunk(benchFileId, nonce, ciphertext);
            totalDecBytes += size;
            totalDecTime += performance.now() - decStart;
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
        if (totalDecTime > 0 && totalDecBytes > 0) {
          await saveDevicePerformanceProfile({
            decryptBytesPerSecond: totalDecBytes / (totalDecTime / 1000),
            encryptionBytesPerSecond: totalEncTime > 0 ? totalEncBytes / (totalEncTime / 1000) : undefined,
            measuredAt: new Date().toISOString(),
            source: 'speedtest',
          });
        }
      }
    } catch {
      setStatusText('Crypto not available');
    }
    setLiveResults((prev) => ({ ...prev, encryptionMBps }));

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

    const measuredAt = new Date().toISOString();
    const nextResults = {
      downloadMBps,
      uploadMBps,
      encryptionMBps,
      measuredAt,
      networkType: runNetworkType,
      uploadSkipped,
    };
    setResults(nextResults);
    const nextLastRun: LastSpeedtestRun = {
      measuredAt,
      networkType: runNetworkType,
      downloadMbps: mbpsFromStoredMBps(downloadMBps),
      uploadMbps: uploadSkipped ? null : mbpsFromStoredMBps(uploadMBps),
      encryptionMBps,
      uploadSkipped,
    };
    setLastRun(nextLastRun);
    await AsyncStorage.setItem(SPEEDTEST_LAST_RUN_KEY, JSON.stringify(nextLastRun));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Speed test failed';
      setError(message);
      setStatusText('Speed test failed');
      setPhase('idle');
      setCurrentSpeed('--');
      setCurrentUnit('Mbps');
      resetGauge();
    }
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
        <MetricPanel
          phase={phase}
          statusText={statusText}
          currentSpeed={currentSpeed}
          unit={currentUnit}
          progress={meterProgress}
          c={c}
        />

        <BenchmarkGrid
          phase={phase}
          currentSpeed={currentSpeed}
          currentUnit={currentUnit}
          liveLatencyMs={liveLatencyMs}
          liveResults={liveResults}
          results={results}
          c={c}
        />

        <Text style={[s.note, { color: c.ink4 }]}>
          Network speed is shown in Mbps, like most speed tests. Crypto is shown in MB/s because it measures local file throughput. 1 MB/s is about 8 Mbps.
        </Text>

        {phase !== 'idle' && <PhaseStepper currentPhase={phase} c={c} />}

        {phase === 'latency' && <LatencyDots pings={pings} c={c} />}

        {/* Encryption progress bar */}
        {phase === 'encryption' && encChunkLabel !== '' && (
          <EncryptionProgress progress={encProgress} chunkLabel={encChunkLabel} c={c} />
        )}

        {/* Connection breakdown (done phase) */}
        {phase === 'done' && connectionInfo && (
          <ConnectionBreakdown info={connectionInfo} c={c} />
        )}

        {phase === 'done' && results && <ResultsSummary results={results} c={c} />}

        {phase === 'idle' && !results && lastRun && <LastRunSummary lastRun={lastRun} c={c} />}

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
          onPress={() => runTest()}
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

        {networkType === 'cellular' && !isRunning && (
          <TouchableOpacity
            style={[s.secondaryButton, { borderColor: c.line }]}
            onPress={() => runTest({ full: true })}
            activeOpacity={0.7}
            accessibilityLabel="Run full speed test including upload"
            accessibilityRole="button"
          >
            <Text style={[s.secondaryButtonText, { color: c.ink }]}>
              Run full test including upload
            </Text>
          </TouchableOpacity>
        )}

        {phase === 'idle' && <TestScope c={c} />}
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
  secondaryButton: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  secondaryButtonText: {
    fontSize: 14,
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
