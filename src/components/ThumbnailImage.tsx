import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { getDownloadUrl, getToken } from '../lib/api';

const THUMB_DIR = `${FileSystem.cacheDirectory}thumbs/`;

let dirReady: Promise<void> | null = null;
async function ensureThumbDir(): Promise<void> {
  if (!dirReady) {
    dirReady = (async () => {
      const info = await FileSystem.getInfoAsync(THUMB_DIR);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
      }
    })();
  }
  return dirReady;
}

const inflight = new Map<string, Promise<string>>();

async function downloadThumb(fileId: string): Promise<string> {
  const existing = inflight.get(fileId);
  if (existing) return existing;

  const promise = (async () => {
    await ensureThumbDir();
    const cacheUri = `${THUMB_DIR}${fileId}`;
    const info = await FileSystem.getInfoAsync(cacheUri);
    if (info.exists && info.size && info.size > 0) {
      return cacheUri;
    }

    const token = await getToken();
    if (!token) throw new Error('Not signed in');

    const result = await FileSystem.downloadAsync(getDownloadUrl(fileId), cacheUri, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (result.status >= 400) {
      // Don't keep a poisoned file (HTML error body etc.) in cache.
      await FileSystem.deleteAsync(cacheUri, { idempotent: true });
      throw new Error(`Thumbnail download failed (HTTP ${result.status})`);
    }
    return result.uri;
  })();

  inflight.set(fileId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(fileId);
  }
}

interface Props {
  fileId: string;
  /** Background shown while the image is loading or if it fails. */
  placeholderColor: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export const ThumbnailImage = React.memo(function ThumbnailImage({
  fileId,
  placeholderColor,
  style,
  accessibilityLabel,
}: Props) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setUri(null);
    setFailed(false);
    downloadThumb(fileId)
      .then((cacheUri) => {
        if (!cancelledRef.current) setUri(cacheUri);
      })
      .catch(() => {
        if (!cancelledRef.current) setFailed(true);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [fileId]);

  return (
    <View
      style={[styles.container, { backgroundColor: placeholderColor }, style]}
      accessibilityLabel={accessibilityLabel}
    >
      {uri && !failed && (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
});
