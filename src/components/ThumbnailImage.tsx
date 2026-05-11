import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useCrypto } from '../lib/crypto-context';
import { fetchDecryptedThumbnailUri } from '../lib/thumbnail';

interface Props {
  fileId: string;
  hasThumbnail?: boolean;
  /** Background shown while the image is loading or if it fails. */
  placeholderColor: string;
  /** False keeps the placeholder visible without starting a network fetch. */
  loadThumbnail?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export const ThumbnailImage = React.memo(function ThumbnailImage({
  fileId,
  hasThumbnail = true,
  placeholderColor,
  loadThumbnail = true,
  style,
  accessibilityLabel,
}: Props) {
  const { getFileKeyBytes } = useCrypto();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setUri(null);
    setFailed(false);
    if (!hasThumbnail || !loadThumbnail) {
      setFailed(true);
      return () => {
        cancelledRef.current = true;
      };
    }
    (async () => {
      const fileKey = await getFileKeyBytes(fileId);
      return fetchDecryptedThumbnailUri(fileId, fileKey);
    })()
      .then((cacheUri) => {
        if (cacheUri && !cancelledRef.current) setUri(cacheUri);
        if (!cacheUri && !cancelledRef.current) setFailed(true);
      })
      .catch(() => {
        if (!cancelledRef.current) setFailed(true);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [fileId, getFileKeyBytes, hasThumbnail, loadThumbnail]);

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
