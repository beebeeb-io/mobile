/**
 * Speed Test screen -- benchmarks latency, upload, download, and encryption.
 *
 * Runs 4 sequential benchmarks against the Beebeeb API and the native crypto
 * module, showing real-time results in an amber-accented dark-themed layout.
 */

import React, { useCallback, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { fonts, spacing, type Colors } from '../theme';
import { getApiUrl, getToken, getRegion } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';

type C = Colors;

type TestState = 'idle' | 'running' | 'done' | 'error';

interface TestResult {
  state: TestState;
  value: string;
  detail?: string;
}

const INITIAL_RESULT: TestResult = { state: 'idle', value: '' };

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

// ---------------------------------------------------------------------------
// Test result row
// ---------------------------------------------------------------------------

function TestSection({
  label,
  icon,
  result,
  c,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  result: TestResult;
  c: C;
}) {
  return (
    <View style={[s.testCard, { backgroundColor: c.paper, borderColor: c.line }]}>
      <View style={s.testHeader}>
        <Ionicons name={icon} size={18} color={c.ink3} style={{ marginRight: 10, width: 20 }} />
        <Text style={[s.testLabel, { color: c.ink }]}>{label}</Text>
        {result.state === 'running' && (
          <ActivityIndicator size="small" color={c.amber} style={{ marginLeft: 'auto' }} />
        )}
        {result.state === 'done' && (
          <Text style={[s.testValue, { color: c.amber, fontFamily: fonts.mono }]}>
            {result.value}
          </Text>
        )}
        {result.state === 'error' && (
          <Text style={[s.testValue, { color: c.red, fontFamily: fonts.mono }]}>
            {result.value || 'Failed'}
          </Text>
        )}
      </View>
      {result.state === 'running' && result.value !== '' && (
        <Text style={[s.testDetail, { color: c.ink3 }]}>{result.value}</Text>
      )}
      {result.detail && result.state !== 'running' && (
        <Text style={[s.testDetail, { color: c.ink3 }]}>{result.detail}</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SpeedtestScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const crypto = useCrypto();

  const [latency, setLatency] = useState<TestResult>(INITIAL_RESULT);
  const [upload, setUpload] = useState<TestResult>(INITIAL_RESULT);
  const [download, setDownload] = useState<TestResult>(INITIAL_RESULT);
  const [encryption, setEncryption] = useState<TestResult>(INITIAL_RESULT);
  const [running, setRunning] = useState(false);
  const [region, setRegion] = useState('');

  const runTest = useCallback(async () => {
    setRunning(true);
    setLatency(INITIAL_RESULT);
    setUpload(INITIAL_RESULT);
    setDownload(INITIAL_RESULT);
    setEncryption(INITIAL_RESULT);

    const apiUrl = getApiUrl();
    const token = await getToken();
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    // ── Region ──────────────────────────────────────────────────────────
    try {
      const reg = await getRegion();
      const parts: string[] = [];
      if (reg.region) parts.push(reg.region.charAt(0).toUpperCase() + reg.region.slice(1));
      if (reg.jurisdiction) parts.push(reg.jurisdiction);
      setRegion(parts.join(' · ') || 'Europe');
    } catch {
      setRegion('Unknown');
    }

    // ── 1. Latency ──────────────────────────────────────────────────────
    setLatency({ state: 'running', value: 'Pinging...' });
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      try {
        await fetch(`${apiUrl}/health`);
      } catch {
        // count the attempt anyway
      }
      latencies.push(performance.now() - start);
      setLatency({
        state: 'running',
        value: `Ping ${i + 1}/5...`,
      });
    }
    if (latencies.length > 0) {
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const min = Math.min(...latencies);
      const max = Math.max(...latencies);
      setLatency({
        state: 'done',
        value: `${formatMs(avg)} ms`,
        detail: `min ${formatMs(min)} / max ${formatMs(max)} ms`,
      });
    } else {
      setLatency({ state: 'error', value: 'Failed' });
    }

    // ── 2. Upload ───────────────────────────────────────────────────────
    setUpload({ state: 'running', value: 'Uploading...' });
    const UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB
    const uploadBlob = new ArrayBuffer(UPLOAD_SIZE);
    const uploadSpeeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      setUpload({ state: 'running', value: `Upload ${i + 1}/3...` });
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
        if (elapsed > 0) uploadSpeeds.push(UPLOAD_SIZE / elapsed);
      } catch {
        // Skip failed attempt
      }
    }
    if (uploadSpeeds.length > 0) {
      const avg = uploadSpeeds.reduce((a, b) => a + b, 0) / uploadSpeeds.length;
      setUpload({
        state: 'done',
        value: `${formatMBps(avg)} MB/s`,
        detail: `3x 5 MB uploads`,
      });
    } else {
      setUpload({ state: 'error', value: 'Failed' });
    }

    // ── 3. Download ─────────────────────────────────────────────────────
    setDownload({ state: 'running', value: 'Downloading...' });
    const DOWNLOAD_SIZE = 5_000_000; // 5 MB
    const downloadSpeeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      setDownload({ state: 'running', value: `Download ${i + 1}/3...` });
      const start = performance.now();
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/speedtest?size=${DOWNLOAD_SIZE}`,
          { headers: authHeaders },
        );
        await res.arrayBuffer();
        const elapsed = (performance.now() - start) / 1000;
        if (elapsed > 0) downloadSpeeds.push(DOWNLOAD_SIZE / elapsed);
      } catch {
        // Skip failed attempt
      }
    }
    if (downloadSpeeds.length > 0) {
      const avg = downloadSpeeds.reduce((a, b) => a + b, 0) / downloadSpeeds.length;
      setDownload({
        state: 'done',
        value: `${formatMBps(avg)} MB/s`,
        detail: `3x 5 MB downloads`,
      });
    } else {
      setDownload({ state: 'error', value: 'Failed' });
    }

    // ── 4. Encryption ───────────────────────────────────────────────────
    setEncryption({ state: 'running', value: 'Benchmarking crypto...' });
    try {
      if (!crypto.isUnlocked) {
        setEncryption({
          state: 'done',
          value: '--',
          detail: 'Vault locked -- unlock to benchmark',
        });
      } else {
        // Encrypt 10 MB in 1 MB chunks (the native module operates on chunks)
        const CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB
        const TOTAL_MB = 10;
        const testChunk = new Uint8Array(CHUNK_SIZE);
        // Fill a small portion with random data; the rest being zero is fine
        // for benchmarking crypto throughput.
        for (let i = 0; i < Math.min(1024, CHUNK_SIZE); i++) {
          testChunk[i] = Math.floor(Math.random() * 256);
        }

        // Use a synthetic file ID for the benchmark key derivation
        const benchFileId = 'speedtest-benchmark-00000000';

        // Encrypt
        const encStart = performance.now();
        const encResults: { nonce: Uint8Array; ciphertext: Uint8Array }[] = [];
        for (let i = 0; i < TOTAL_MB; i++) {
          const enc = await crypto.encryptChunk(benchFileId, testChunk);
          encResults.push(enc);
        }
        const encElapsed = (performance.now() - encStart) / 1000;

        // Decrypt
        const decStart = performance.now();
        for (const { nonce, ciphertext } of encResults) {
          await crypto.decryptChunk(benchFileId, nonce, ciphertext);
        }
        const decElapsed = (performance.now() - decStart) / 1000;

        const encMBps = encElapsed > 0 ? formatMBps((TOTAL_MB * CHUNK_SIZE) / encElapsed) : '--';
        const decMBps = decElapsed > 0 ? formatMBps((TOTAL_MB * CHUNK_SIZE) / decElapsed) : '--';

        setEncryption({
          state: 'done',
          value: `${encMBps} MB/s`,
          detail: `AES-256-GCM · encrypt ${encMBps} / decrypt ${decMBps} MB/s`,
        });
      }
    } catch {
      setEncryption({ state: 'error', value: 'Not available' });
    }

    setRunning(false);
  }, [crypto]);

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
        {/* Test cards */}
        <TestSection label="Latency" icon="pulse-outline" result={latency} c={c} />
        <TestSection label="Upload" icon="cloud-upload-outline" result={upload} c={c} />
        <TestSection label="Download" icon="cloud-download-outline" result={download} c={c} />
        <TestSection label="Encryption" icon="lock-closed-outline" result={encryption} c={c} />

        {/* Run button */}
        <TouchableOpacity
          style={[
            s.runButton,
            {
              backgroundColor: running ? c.line2 : c.amber,
            },
          ]}
          onPress={runTest}
          disabled={running}
          activeOpacity={0.7}
          accessibilityLabel={running ? 'Test running' : 'Run speed test'}
          accessibilityRole="button"
        >
          {running ? (
            <ActivityIndicator size="small" color={c.ink3} />
          ) : (
            <>
              <Ionicons name="speedometer-outline" size={18} color={c.paper} style={{ marginRight: 8 }} />
              <Text style={[s.runButtonText, { color: c.paper }]}>Run test</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Info note */}
        <Text style={[s.note, { color: c.ink4 }]}>
          Tests connection to the Beebeeb API and measures on-device AES-256-GCM
          encryption throughput via the native crypto module.
        </Text>
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
  testCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: spacing.sm,
  },
  testHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  testLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  testValue: {
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 'auto',
  },
  testDetail: {
    fontSize: 11,
    marginTop: 4,
    marginLeft: 30,
    fontFamily: fonts.mono,
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
