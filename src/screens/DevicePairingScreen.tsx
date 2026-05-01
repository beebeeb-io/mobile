import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, shadows, spacing } from '../theme';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DevicePairingScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton} activeOpacity={0.7}>
          <View style={styles.backArrow} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.heading}>Add a device</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.subheading}>
        Link another device to your account. Both devices must be unlocked.
      </Text>

      <View style={styles.cards}>
        {/* Card A: Scan */}
        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate('DevicePairingScan')}
          activeOpacity={0.85}
        >
          <View style={[styles.cardIcon, styles.cardIconScan]}>
            {/* Camera outline */}
            <View style={styles.cameraBody}>
              <View style={styles.cameraLens} />
            </View>
          </View>
          <Text style={styles.cardTitle}>Scan with this device</Text>
          <Text style={styles.cardDesc}>
            Point your camera at the pattern shown on your other device.
          </Text>
          <View style={styles.cardArrow}>
            <Text style={styles.cardArrowText}>→</Text>
          </View>
        </TouchableOpacity>

        {/* Card B: Show */}
        <TouchableOpacity
          style={styles.card}
          onPress={() => navigation.navigate('DevicePairingShow')}
          activeOpacity={0.85}
        >
          <View style={[styles.cardIcon, styles.cardIconShow]}>
            {/* Globe outline */}
            <View style={styles.globeOuter}>
              <View style={styles.globeH} />
              <View style={styles.globeV} />
            </View>
          </View>
          <Text style={styles.cardTitle}>Show on this device</Text>
          <Text style={styles.cardDesc}>
            Display a pattern for your other device to scan.
          </Text>
          <View style={styles.cardArrow}>
            <Text style={styles.cardArrowText}>→</Text>
          </View>
        </TouchableOpacity>
      </View>

      <Text style={styles.footnote}>
        Your key material never leaves either device. Pairing uses an encrypted local channel.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper2,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 60,
  },
  backArrow: {
    width: 8,
    height: 8,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.ink2,
    transform: [{ rotate: '45deg' }],
  },
  backText: { fontSize: 14, color: colors.ink2 },
  heading: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  headerSpacer: { minWidth: 60 },

  subheading: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: spacing.xl,
    marginBottom: spacing['2xl'],
  },

  cards: {
    paddingHorizontal: spacing.lg,
    gap: 14,
  },

  card: {
    backgroundColor: colors.paper,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.xl,
    ...shadows.md,
  },

  cardIcon: {
    width: 52,
    height: 52,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  cardIconScan: { backgroundColor: colors.amberBg },
  cardIconShow: { backgroundColor: '#eef2ff' },

  // Camera icon
  cameraBody: {
    width: 28,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.amberDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraLens: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.amberDeep,
  },

  // Globe icon
  globeOuter: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#4f6bcd',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  globeH: {
    position: 'absolute',
    width: 26,
    height: 2,
    backgroundColor: '#4f6bcd',
    opacity: 0.6,
  },
  globeV: {
    position: 'absolute',
    width: 2,
    height: 26,
    backgroundColor: '#4f6bcd',
    opacity: 0.6,
  },

  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 4,
    letterSpacing: -0.2,
  },
  cardDesc: {
    fontSize: 13,
    color: colors.ink3,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  cardArrow: { alignSelf: 'flex-end' },
  cardArrowText: { fontSize: 16, color: colors.ink4 },

  footnote: {
    fontSize: 11,
    color: colors.ink4,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: spacing.xl,
    marginTop: spacing['2xl'],
  },
});
