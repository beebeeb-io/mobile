import { BBLogo } from "../components/BBLogo";
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '../lib/theme-context'

export function ConstellationScannerScreen() {
  const { colors: c } = useTheme()
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.paper }]}>
      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: c.ink }]}>
          <BBLogo size={64} />
        </View>
        <Text style={[styles.title, { color: c.ink }]}>Constellation Scanner</Text>
        <Text style={[styles.subtitle, { color: c.ink3 }]}>
          Camera scanning will be available in the next build.
          The Amber Constellation codec is ready — the camera integration
          requires react-native-vision-camera which needs a compatible Xcode version.
        </Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  iconCircle: {
    width: 64, height: 64, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
})
