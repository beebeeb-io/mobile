import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors } from '../theme'

interface BBLogoProps {
  size?: number
}

export function BBLogo({ size = 48 }: BBLogoProps) {
  const radius = size * 0.2
  const fontSize = size * 0.62

  return (
    <View style={[styles.mark, { width: size, height: size, borderRadius: radius }]}>
      <Text style={[styles.text, { fontSize, lineHeight: size * 0.85 }]}>b</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  mark: {
    backgroundColor: colors.amber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#1A1714',
    fontWeight: '800',
    letterSpacing: -1,
  },
})
