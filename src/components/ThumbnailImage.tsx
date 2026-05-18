import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useCrypto } from '../lib/crypto-context';
import { cacheLocalThumbnail, fetchDecryptedThumbnailUri } from '../lib/thumbnail';

interface Props {
  fileId: string;
  hasThumbnail?: boolean;
  /** Background shown while the image is loading or if it fails. */
  placeholderColor: string;
  /** False keeps the placeholder visible without starting a network fetch. */
  loadThumbnail?: boolean;
  /**
   * Local camera-roll URI for this photo (when it exists on device from backup).
   * If provided, the component generates a thumbnail from this local file
   * instead of downloading+decrypting from the server.
   */
  localAssetUri?: string | null;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export const ThumbnailImage = React.memo(function ThumbnailImage({
  fileId,
  hasThumbnail = true,
  placeholderColor,
  loadThumbnail = true,
  localAssetUri,
  style,
  accessibilityLabel,
}: Props) {
  const { getFileKeyBytes, isUnlocked } = useCrypto();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setUri(null);
    setFailed(false);
    if (!loadThumbnail) {
      setFailed(true);
      return () => {
        cancelledRef.current = true;
      };
    }

    // Wait for the vault to unlock before attempting any decryption.
    // Without this guard, thumbnails that mount while the vault is still
    // locked permanently show the placeholder because the effect never
    // re-runs — isUnlocked is now a dependency so it retries on unlock.
    if (!isUnlocked) {
      return () => {
        cancelledRef.current = true;
      };
    }

    // Priority 1: Use local camera-roll asset for thumbnail (no server call)
    if (localAssetUri) {
      cacheLocalThumbnail(fileId, localAssetUri)
        .then((cachedUri) => {
          if (cancelledRef.current) return;
          if (cachedUri) {
            setUri(cachedUri);
          } else {
            // Local generation failed — fall back to server fetch if has_thumbnail
            if (hasThumbnail) {
              return getFileKeyBytes(fileId)
                .then((fileKey) => fetchDecryptedThumbnailUri(fileId, fileKey))
                .then((serverUri) => {
                  if (!cancelledRef.current) {
                    if (serverUri) setUri(serverUri);
                    else setFailed(true);
                  }
                });
            }
            setFailed(true);
          }
        })
        .catch(() => {
          if (!cancelledRef.current) setFailed(true);
        });
      return () => {
        cancelledRef.current = true;
      };
    }

    // Priority 2: Fetch encrypted thumbnail from server
    if (!hasThumbnail) {
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
  }, [fileId, getFileKeyBytes, hasThumbnail, isUnlocked, loadThumbnail, localAssetUri]);

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
