import React from 'react'
import { View, StyleSheet } from 'react-native'

interface BBLogoProps {
  size?: number
}

// Brand mark — mirrors the geometry in repos/core/brand/logo-mark.svg
// exactly so the in-app mark matches the app icon pixel-for-pixel.
// Reference viewBox is 512x512; we scale every coordinate by `size / 512`.
const REF = 512
const AMBER = '#F5B800'
const INK = '#1A1714'

export function BBLogo({ size = 48 }: BBLogoProps) {
  const s = size / REF
  return (
    <View
      style={[
        styles.square,
        { width: size, height: size, borderRadius: 102 * s, backgroundColor: AMBER },
      ]}
    >
      {/* Stem */}
      <View
        style={{
          position: 'absolute',
          left: 138 * s,
          top: 68 * s,
          width: 72 * s,
          height: 360 * s,
          borderRadius: 8 * s,
          backgroundColor: INK,
        }}
      />
      {/* Bowl (outer circle) */}
      <View
        style={{
          position: 'absolute',
          left: (312 - 120) * s,
          top: (308 - 120) * s,
          width: 240 * s,
          height: 240 * s,
          borderRadius: 120 * s,
          backgroundColor: INK,
        }}
      />
      {/* Counter (amber hole in the bowl) */}
      <View
        style={{
          position: 'absolute',
          left: (316 - 54) * s,
          top: (308 - 54) * s,
          width: 108 * s,
          height: 108 * s,
          borderRadius: 54 * s,
          backgroundColor: AMBER,
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  square: {
    overflow: 'hidden',
  },
})
