import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useThumbnail } from '../lib/use-thumbnail';
import { invalidateCachedThumbnail } from '../lib/thumbnail-cache';
import { invalidateInMemoryThumbCache } from '../lib/thumbnail';
import { recordRuntimeTrace } from '../lib/runtime-trace';

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
  // Task 2233 round 2 (case 8) — a cache file that exists but cannot be
  // decoded (0-byte write, truncated WebP) surfaces as <Image onError>. Once
  // per fileId we drop the corrupt entry and reload; a second error means the
  // thumbnail is genuinely unavailable.
  const [reloadKey, setReloadKey] = useState(0);
  const retriedRef = useRef(false);

  useEffect(() => {
    retriedRef.current = false;
    setReloadKey(0);
  }, [fileId]);

  const { uri, failed } = useThumbnail(fileId, {
    enabled: loadThumbnail,
    hasThumbnail,
    mimeType,
    reloadKey,
  });

  useEffect(() => {
    if (failed) onUnavailable?.(fileId);
  }, [failed, fileId, onUnavailable]);

  const handleImageError = useCallback(() => {
    if (!retriedRef.current && uri && uri.startsWith('file://')) {
      retriedRef.current = true;
      invalidateInMemoryThumbCache(fileId);
      void invalidateCachedThumbnail(fileId).finally(() => {
        setReloadKey((key) => key + 1);
      });
      return;
    }
    onUnavailable?.(fileId);
  }, [fileId, onUnavailable, uri]);

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
          onLoad={__DEV__ && Platform.OS === 'android'
            ? () => recordRuntimeTrace('thumbnail.image.loaded', { fileId })
            : undefined}
          onError={handleImageError}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
});
