import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing } from '../theme';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DevicePairingScanScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <TouchableOpacity style={styles.backRow} onPress={() => navigation.goBack()} activeOpacity={0.7}>
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>
      <View style={styles.body}>
        <View style={styles.placeholder}>
          <Text style={styles.placeholderLabel}>Camera scanner</Text>
          <Text style={styles.placeholderSub}>
            Will open device camera to scan the pairing pattern.{'\n'}Requires Plan 03 (Amber Constellation).
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.darkBg },
  backRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backText: { fontSize: 14, color: colors.paper, opacity: 0.7 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  placeholder: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: radii.lg,
    padding: spacing.xl,
    alignItems: 'center',
  },
  placeholderLabel: { fontSize: 14, fontWeight: '600', color: colors.paper, marginBottom: 8 },
  placeholderSub: { fontSize: 12, color: 'rgba(255,255,255,0.45)', textAlign: 'center', lineHeight: 18 },
});
