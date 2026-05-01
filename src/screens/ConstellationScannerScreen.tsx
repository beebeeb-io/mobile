import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../theme'

export function ConstellationScannerScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Text style={styles.iconText}>b</Text>
        </View>
        <Text style={styles.title}>Constellation Scanner</Text>
        <Text style={styles.subtitle}>
          Camera scanning will be available in the next build.
          The Amber Constellation codec is ready — the camera integration
          requires react-native-vision-camera which needs a compatible Xcode version.
        </Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.paper },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  iconCircle: {
    width: 64, height: 64, borderRadius: 16,
    backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center',
    marginBottom: 20,
  },
  iconText: { color: colors.amber, fontSize: 28, fontWeight: '800' },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink, marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.ink3, textAlign: 'center', lineHeight: 22 },
})
