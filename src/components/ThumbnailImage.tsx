import React, { useEffect } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useThumbnail } from '../lib/use-thumbnail';

// Dynamic require keeps the JS layer working when the native binding isn't
// linked (web preview, jest, etc.).
type BlurhashViewType = React.ComponentType<{
  blurhash: string;
  style?: StyleProp<ViewStyle>;
}>;
let BlurhashView: BlurhashViewType | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('react-native-blurhash');
  BlurhashView = (mod?.Blurhash ?? null) as BlurhashViewType | null;
} catch {
  BlurhashView = null;
}

interface Props {
  fileId: string;
  hasThumbnail?: boolean;
  placeholderColor: string;
  loadThumbnail?: boolean;
  localAssetUri?: string | null;
  mimeType?: string | null;
  blurhash?: string | null;
  onUnavailable?: (fileId: string) => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export const ThumbnailImage = React.memo(function ThumbnailImage({
  fileId,
  hasThumbnail = true,
  placeholderColor,
  loadThumbnail = true,
  localAssetUri: _localAssetUri,
  mimeType,
  blurhash,
  onUnavailable,
  style,
  accessibilityLabel,
}: Props) {
  const { uri, failed } = useThumbnail(fileId, {
    enabled: loadThumbnail,
    hasThumbnail,
    mimeType,
  });

  useEffect(() => {
    if (failed) onUnavailable?.(fileId);
  }, [failed, fileId, onUnavailable]);

  return (
    <View
      style={[styles.container, { backgroundColor: placeholderColor }, style]}
      accessibilityLabel={accessibilityLabel}
    >
      {blurhash && BlurhashView && !uri && !failed && (
        <BlurhashView blurhash={blurhash} style={StyleSheet.absoluteFill} />
      )}
      {uri && !failed && (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => onUnavailable?.(fileId)}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
});
