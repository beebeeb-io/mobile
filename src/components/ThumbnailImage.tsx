import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useCrypto } from '../lib/crypto-context';
import { cacheLocalThumbnail, fetchDecryptedThumbnailUri, generateAndUploadThumbnail } from '../lib/thumbnail';
import {
  getCachedThumbnail,
  enqueueThumbnailLoad,
} from '../lib/thumbnail-cache';
import { getLocalIdentifier } from '../lib/local-identifier-map';

// Task 0552: blurhash placeholder. Dynamic require so the JS layer keeps
// working even when the native binding isn't linked (web preview, jest, etc.).
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
  mimeType?: string | null;
  /**
   * Optional blurhash placeholder string (task 0552). Rendered immediately
   * as a low-resolution colour gradient before either PhotoKit or the
   * encrypted-blob path resolves. ~25 bytes from the server.
   */
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
  localAssetUri,
  mimeType,
  blurhash,
  onUnavailable,
  style,
  accessibilityLabel,
}: Props) {
  const { getFileKeyBytes, isUnlocked } = useCrypto();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const cancelledRef = useRef(false);
  const markUnavailable = useCallback(() => {
    setFailed(true);
    onUnavailable?.(fileId);
  }, [fileId, onUnavailable]);

  useEffect(() => {
    setUri(null);
    setFailed(false);
  }, [fileId]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!loadThumbnail) {
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

    // Task 0552 PhotoKit short-circuit: if this fileId is known to be backed
    // by a still-resolvable PHAsset, render from the camera roll directly and
    // skip the encrypted-blob round-trip. We treat the identifier map as
    // authoritative — if the asset has since been deleted from the library,
    // `cacheLocalThumbnail` returns null and we fall through to the encrypted
    // path. This is the (a)-(b)-(c) priority sequence from the task spec.
    const cameraRollUri = localAssetUri ?? (() => {
      const local = getLocalIdentifier(fileId);
      return local ? `ph://${local}` : null;
    })();

    // Step 1: Check persistent cache immediately (no network, no decrypt).
    // If the thumbnail is already on disk, show it instantly.
    getCachedThumbnail(fileId)
      .then((cachedUri) => {
        if (cancelledRef.current) return;
        if (cachedUri) {
          setUri(cachedUri);
          return; // Done — no network needed.
        }

        // Step 2: Not cached. Use local asset or server fetch via the queue.
        if (cameraRollUri) {
          return cacheLocalThumbnail(fileId, cameraRollUri, mimeType)
            .then((localCachedUri) => {
              if (cancelledRef.current) return;
              if (localCachedUri) {
                setUri(localCachedUri);
                if (!hasThumbnail) {
                  void generateAndUploadThumbnail(fileId, cameraRollUri, mimeType, getFileKeyBytes);
                }
              } else if (hasThumbnail) {
                // Local generation failed — enqueue server fetch (concurrency limited)
                return enqueueThumbnailLoad(fileId, async (fId) => {
                  const fileKey = await getFileKeyBytes(fId);
                  return fetchDecryptedThumbnailUri(fId, fileKey);
                }).then((serverUri) => {
                  if (!cancelledRef.current) {
                    if (serverUri) setUri(serverUri);
                    else markUnavailable();
                  }
                });
              } else {
                markUnavailable();
              }
            });
        }

        // No local asset — fetch from server via concurrency-limited queue
        if (!hasThumbnail) {
          markUnavailable();
          return;
        }

        return enqueueThumbnailLoad(fileId, async (fId) => {
          const fileKey = await getFileKeyBytes(fId);
          return fetchDecryptedThumbnailUri(fId, fileKey);
        }).then((fetchedUri) => {
          if (!cancelledRef.current) {
            if (fetchedUri) setUri(fetchedUri);
            else markUnavailable();
          }
        });
      })
      .catch(() => {
        if (!cancelledRef.current) markUnavailable();
      });

    return () => {
      cancelledRef.current = true;
    };
  }, [fileId, getFileKeyBytes, hasThumbnail, isUnlocked, loadThumbnail, localAssetUri, markUnavailable, mimeType]);

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
          onError={markUnavailable}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
});
