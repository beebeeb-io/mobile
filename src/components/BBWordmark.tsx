import React from 'react'
import { Text, type TextStyle } from 'react-native'
import { useTheme } from '../lib/theme-context'

interface BBWordmarkProps {
  /** Approximate visual height of the wordmark in points. Defaults to 22. */
  size?: number
  /** Optional override; otherwise color comes from the theme (ink on light,
   *  paper on dark). The ".io" tail is always amber. */
  color?: string
  style?: TextStyle
}

// Wordmark — mirrors repos/core/brand/logo-wordmark{,-light}.svg.
// The SVG variants exist for tools that need a raster; in-app we render
// live text so it can scale and theme cleanly. "beebeeb" picks up the
// current theme's ink; ".io" is always amber per the brand rules.
export function BBWordmark({ size = 22, color, style }: BBWordmarkProps) {
  const { colors } = useTheme()
  const inkColor = color ?? colors.ink
  return (
    <Text
      allowFontScaling={false}
      style={[
        {
          fontSize: size,
          fontWeight: '700',
          letterSpacing: -0.5,
          color: inkColor,
        },
        style,
      ]}
    >
      beebeeb<Text style={{ color: colors.amber }}>.io</Text>
    </Text>
  )
}
