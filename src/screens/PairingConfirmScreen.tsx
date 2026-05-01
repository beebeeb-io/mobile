// Placeholder — implemented in Plan 03 Task 4.
// Shows after the constellation scanner successfully decodes a session payload.
import React from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useNavigation, useRoute } from '@react-navigation/native'
import type { RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, spacing } from '../theme'
import type { RootStackParamList } from '../App'

type Nav = NativeStackNavigationProp<RootStackParamList>
type Route = RouteProp<RootStackParamList, 'PairingConfirm'>

export default function PairingConfirmScreen() {
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const insets = useSafeAreaInsets()
  const { nodeCount } = route.params ?? {}

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <TouchableOpacity
        style={styles.backRow}
        onPress={() => navigation.goBack()}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>
      <View style={styles.body}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{nodeCount ?? 0}</Text>
          <Text style={styles.badgeLabel}>nodes detected</Text>
        </View>
        <Text style={styles.title}>Pattern decoded</Text>
        <Text style={styles.sub}>
          Enter the 6-digit code shown on the other device to complete pairing.{'\n'}
          (Full implementation coming in Task 4.)
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  backRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backText: { fontSize: 14, color: colors.ink3 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  badge: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.amberBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing['2xl'],
    borderWidth: 2,
    borderColor: colors.amberDeep,
  },
  badgeText: { fontSize: 28, fontWeight: '700', color: colors.amberDeep },
  badgeLabel: { fontSize: 9, color: colors.amberDeep, letterSpacing: 0.5, textTransform: 'uppercase' },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink, marginBottom: 8, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: colors.ink3, textAlign: 'center', lineHeight: 20 },
})
