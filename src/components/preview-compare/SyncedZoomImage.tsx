import React from 'react';
import { Image, PixelRatio, StyleSheet, View } from 'react-native';

import { fullResTransform, type Box, type Viewport } from '../../lib/compare-viewport';

interface Props {
  uri: string | null;
  /** Pixel size of the image file; it is laid out at this size so every pixel is decoded. */
  pixels: Box;
  /** Pane size. */
  box: Box;
  /** Fitted (scale 1) image size inside the pane. */
  base: Box;
  viewport: Viewport;
  /**
   * Show only the part of the pane right of this x (Wipe mode). The image
   * keeps its place in the pane; the rest is clipped.
   */
  clipLeft?: number;
}

/**
 * One image shown at the shared fitted size under the shared viewport, so two
 * of these with the same viewport show exactly the same spot. React Native
 * decodes an image to its layout size times the screen scale, so the Image is
 * laid out at its full pixel size and the fit and zoom live in the transform;
 * zooming then reveals real pixels instead of enlarging a screen-sized bitmap.
 * Gestures are attached by the parent, around the pane.
 */
export function SyncedZoomImage({ uri, pixels, box, base, viewport, clipLeft = 0 }: Props) {
  if (!uri || base.w <= 0 || pixels.w <= 0 || pixels.h <= 0) return <View style={{ width: box.w, height: box.h }} />;
  const ratio = PixelRatio.get();
  const layout: Box = { w: pixels.w / ratio, h: pixels.h / ratio };
  const t = fullResTransform(viewport, base, layout);
  const image = (
    <Image
      source={{ uri }}
      resizeMode="stretch"
      fadeDuration={0}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: layout.w,
        height: layout.h,
        transform: [
          { translateX: t.translateX - clipLeft },
          { translateY: t.translateY },
          { scaleX: t.scaleX },
          { scaleY: t.scaleY },
        ],
      }}
    />
  );
  if (clipLeft > 0) {
    return (
      <View
        pointerEvents="none"
        style={[styles.clip, { left: clipLeft, width: Math.max(box.w - clipLeft, 0), height: box.h }]}
      >
        {image}
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={{ width: box.w, height: box.h, overflow: 'hidden' }}>
      {image}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: 'absolute', top: 0, overflow: 'hidden' },
});
