/**
 * WebViewReproScreen — `__DEV__`-only minimal repro harness for task 1564
 * (react-native-webview paints nothing on iOS 27).
 *
 * Mounts a single bare `react-native-webview` `WebView` with an inline
 * `source={{html}}` whose body is an opaque solid color and visible text —
 * nothing else on screen competes with it. If this doesn't paint on a given
 * build/sim/OS combination, the defect is in the WebView mount path itself,
 * not in any app-specific styling, sizing, or preview logic layered on top.
 *
 * Reachable only in a __DEV__ build via deep link (never registered in a
 * production build — see the `__DEV__` branch of `linking.config.screens`
 * in App.tsx, same pattern as GlassGallery/Storage/Privacy):
 *
 *   xcrun simctl openurl <udid> beebeeb://dev/webview-repro
 *
 * DELETE (or leave unreachable) before this task's PR ships if the fix
 * doesn't need it kept around — it is a diagnostic tool, not a feature.
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const REPRO_HTML = '<body style="background:red"><h1 style="color:white">HELLO</h1></body>';

export default function WebViewReproScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <TouchableOpacity
        style={styles.backRow}
        onPress={() => navigation.goBack()}
        activeOpacity={0.7}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.label} testID="webview-repro-label">
        WebView repro (task 1564)
      </Text>
      <WebView
        testID="webview-repro"
        originWhitelist={['*']}
        source={{ html: REPRO_HTML }}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  backRow: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  backText: {
    color: '#fff',
    fontSize: 16,
  },
  label: {
    color: '#fff',
    fontSize: 14,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  webview: {
    flex: 1,
    backgroundColor: '#000',
  },
});
