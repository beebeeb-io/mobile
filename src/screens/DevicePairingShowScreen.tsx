import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing } from '../theme';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DevicePairingShowScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <TouchableOpacity style={styles.backRow} onPress={() => navigation.goBack()} activeOpacity={0.7}>
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>
      <View style={styles.body}>
        <View style={styles.patternFrame}>
          {/* Placeholder for animated pairing pattern */}
          <View style={styles.patternInner} />
        </View>
        <Text style={styles.label}>Pairing pattern</Text>
        <Text style={styles.sub}>
          This pattern will be displayed here once Amber Constellation{'\n'}(Plan 03) is implemented.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  backRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backText: { fontSize: 14, color: colors.ink3 },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  patternFrame: {
    width: 200,
    height: 200,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.line2,
    backgroundColor: colors.paper2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  patternInner: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: colors.line2,
    backgroundColor: colors.paper,
  },
  label: { fontSize: 15, fontWeight: '600', color: colors.ink, marginBottom: 6 },
  sub: { fontSize: 12, color: colors.ink4, textAlign: 'center', lineHeight: 18 },
});
