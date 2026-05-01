import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { darkColors, spacing } from '../theme';
import { generateConstellationHTML } from '../lib/constellation-renderer';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DevicePairingShowScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const html = useMemo(() => generateConstellationHTML(), []);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <TouchableOpacity
        style={styles.backRow}
        onPress={() => navigation.goBack()}
        activeOpacity={0.7}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.constellation}>
        <WebView
          source={{ html }}
          style={styles.webview}
          containerStyle={styles.webviewContainer}
          javaScriptEnabled
          scrollEnabled={false}
          bounces={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          originWhitelist={['*']}
          androidLayerType="hardware"
          setSupportMultipleWindows={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      </View>

      <View style={styles.footer}>
        <Text style={styles.status}>Waiting for another device…</Text>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: darkColors.darkBg,
  },
  backRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backText: {
    fontSize: 14,
    color: darkColors.ink2,
  },
  constellation: {
    flex: 1,
    backgroundColor: darkColors.darkBg,
  },
  webview: {
    flex: 1,
    backgroundColor: darkColors.darkBg,
  },
  webviewContainer: {
    backgroundColor: darkColors.darkBg,
  },
  footer: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  status: {
    fontSize: 14,
    color: darkColors.ink2,
    letterSpacing: 0.3,
    marginBottom: spacing.lg,
  },
  cancelButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: darkColors.amber,
    letterSpacing: 0.5,
  },
});
