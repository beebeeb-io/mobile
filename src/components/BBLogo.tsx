import React from 'react'
import { Image, View } from 'react-native'

interface BBLogoProps {
  size?: number
}

// Brand mark — renders the rasterized master icon from assets/icon.png
// (regenerated from repos/core/brand/logo-mark.svg by build-icons.sh).
// Rendering the same PNG as the app icon guarantees the in-app mark is
// pixel-identical to what users see on the home screen, regardless of
// font availability on the device.
export function BBLogo({ size = 48 }: BBLogoProps) {
  return (
    <View style={{ width: size, height: size }}>
      <Image
        source={require('../../assets/icon.png')}
        style={{ width: size, height: size, borderRadius: size * 0.2 }}
        resizeMode="cover"
      />
    </View>
  )
}
