/**
 * __DEV__-only diagnostic screen — task 1399 follow-up (Codex P1 "Purge
 * plaintext caches after deleting the account").
 *
 * Runs the SAME `purgeAllPlaintextCaches()` that `signOut()` and the
 * account-deletion success path call, and renders the returned
 * `{removed, failed}` counts on screen. Exists so a QA lane without
 * Maestro/tap access can trigger and screenshot the purge reproducibly:
 *
 *   xcrun simctl openurl <udid> beebeeb://dev/purge-plaintext-caches
 *
 * Deliberately does NOT also call signOut() — this device may be signed
 * into an account this lane does not own, and invalidating that session
 * just to test the purge would be a bigger blast radius than the test
 * needs. The purge-then-signOut CALL ORDER is covered separately by
 * `account-cleanup.test.ts` (mocked deps, no real session involved).
 *
 * Same class of tool as the `beebeeb://dev/glass` screen (task 1311) —
 * absent from release builds (App.tsx only registers this route when
 * `__DEV__`).
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { purgeAllPlaintextCaches, type PlaintextStoragePurgeResult } from '../lib/account-cleanup';

type Status =
  | { kind: 'running' }
  | { kind: 'done'; result: PlaintextStoragePurgeResult }
  | { kind: 'error'; message: string };

export default function DevPlaintextPurgeScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<Status>({ kind: 'running' });

  useEffect(() => {
    let cancelled = false;
    purgeAllPlaintextCaches()
      .then((result) => {
        if (!cancelled) setStatus({ kind: 'done', result });
      })
      .catch((err) => {
        if (!cancelled) setStatus({ kind: 'error', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.paper }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
    >
      <Text style={[styles.title, { color: c.ink }]}>Plaintext purge (dev)</Text>
      <Text style={[styles.subtitle, { color: c.ink3 }]}>
        Calls purgeAllPlaintextCaches() — the same function signOut() and account
        deletion call. Does NOT sign out.
      </Text>
      <View style={[styles.card, { borderColor: c.line, backgroundColor: c.paper2 }]}>
        {status.kind === 'running' && (
          <Text style={[styles.mono, { color: c.ink2 }]} testID="dev-purge-status">
            running…
          </Text>
        )}
        {status.kind === 'done' && (
          <Text style={[styles.mono, { color: c.ink }]} testID="dev-purge-status">
            {`removed: ${status.result.removed}\nfailed: ${status.result.failed}`}
          </Text>
        )}
        {status.kind === 'error' && (
          <Text style={[styles.mono, { color: c.red }]} testID="dev-purge-status">
            {`error: ${status.message}`}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 6 },
  subtitle: { fontSize: 12, lineHeight: 17, marginBottom: 18 },
  card: { borderWidth: 1, borderRadius: 12, padding: 16 },
  mono: { fontFamily: 'Menlo', fontSize: 14, lineHeight: 20 },
});
