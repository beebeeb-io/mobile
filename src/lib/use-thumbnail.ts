import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useCrypto } from './crypto-context';
import { onThumbnailReady } from './thumbnail-events';
import { getCachedThumbnail, enqueueThumbnailLoad } from './thumbnail-cache';
import { cacheLocalThumbnail, fetchDecryptedThumbnailUri } from './thumbnail';
import { getLocalIdentifier } from './local-identifier-map';
import { recordRuntimeTrace } from './runtime-trace';

interface UseThumbnailOptions {
  width?: number;
  height?: number;
  enabled?: boolean;
  mimeType?: string | null;
  hasThumbnail?: boolean;
}

interface ThumbnailHookState {
  uri: string | null;
  source: 'photoKit' | 'remote' | 'cache' | null;
  failed: boolean;
}

const ThumbnailServiceNative = requireOptionalNativeModule<{
  getThumbnail: (fileId: string, width: number, height: number) => Promise<{ uri: string; source: string }>;
}>('ThumbnailService');

/**
 * Imperative one-shot thumbnail fetch, for call sites that are not components
 * and so cannot use the hook (task 1321).
 *
 * It exists because there was nowhere for them to migrate to: `useThumbnail`
 * covers render sites, but a plain async function had only the legacy
 * `fetchDecryptedThumbnailUri`, which throws unconditionally on iOS since the
 * BeebeebThumbnails migration. Those callers wrapped it in try/catch, so the
 * throw turned into a silently missing thumbnail rather than an error.
 *
 * Same routing as the hook: iOS through the native ThumbnailService actor
 * (PhotoKit-first, source-aware cache, single-flight), everything else through
 * the legacy path.
 */
export async function fetchThumbnailUriOnce(
  fileId: string,
  fileKey: Uint8Array,
  opts: { width?: number; height?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const { width = 256, height = 256, signal } = opts;
  if (Platform.OS === 'ios' && ThumbnailServiceNative?.getThumbnail) {
    try {
      const result = await ThumbnailServiceNative.getThumbnail(fileId, width, height);
      return result?.uri ?? null;
    } catch {
      return null;
    }
  }
  return fetchDecryptedThumbnailUri(fileId, fileKey, signal);
}

/**
 * Single hook for any render site that wants a thumbnail. iOS routes through
 * the native `ThumbnailService` actor (PhotoKit-first, source-aware cache,
 * single-flight). Android keeps the existing flow until the Kotlin worker
 * lands.
 */
export function useThumbnail(
  fileId: string,
  options: UseThumbnailOptions = {},
): ThumbnailHookState {
  const { width = 256, height = 256, enabled = true, mimeType = null, hasThumbnail = true } = options;
  const { getFileKeyBytes, isUnlocked } = useCrypto();
  const [state, setState] = useState<ThumbnailHookState>({ uri: null, source: null, failed: false });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setState({ uri: null, source: null, failed: false });

    if (!enabled || !isUnlocked) return () => { cancelledRef.current = true; };
    recordRuntimeTrace('thumbnail.hook.request', {
      fileId,
      platform: Platform.OS,
      width,
      height,
      hasThumbnail,
    });

    if (Platform.OS === 'ios' && ThumbnailServiceNative?.getThumbnail) {
      ThumbnailServiceNative
        .getThumbnail(fileId, width, height)
        .then((result) => {
          if (cancelledRef.current) return;
          recordRuntimeTrace('thumbnail.hook.native_success', {
            fileId,
            source: result.source,
          });
          setState({
            uri: result.uri,
            source: result.source as ThumbnailHookState['source'],
            failed: false,
          });
        })
        .catch((err) => {
          if (cancelledRef.current) return;
          recordRuntimeTrace('thumbnail.hook.native_failed', {
            fileId,
            error: err instanceof Error ? err.message : String(err),
          });
          console.warn('[useThumbnail] native getThumbnail failed', fileId, err);
          setState({ uri: null, source: null, failed: true });
        });
      return () => { cancelledRef.current = true; };
    }

    // Android (and the unlikely case where the iOS module is unregistered):
    // fall back to the existing fetch path. This preserves Android behaviour
    // exactly until the Kotlin worker lands.
    const cameraRollUri = (() => {
      const local = getLocalIdentifier(fileId);
      return local ? `ph://${local}` : null;
    })();

    getCachedThumbnail(fileId)
      .then((cachedUri) => {
        if (cancelledRef.current) return;
        if (cachedUri) {
          recordRuntimeTrace('thumbnail.hook.android_cache_hit', { fileId });
          setState({ uri: cachedUri, source: 'cache', failed: false });
          return;
        }
        if (cameraRollUri) {
          return cacheLocalThumbnail(fileId, cameraRollUri, mimeType).then((localUri) => {
            if (cancelledRef.current) return;
            if (localUri) {
              recordRuntimeTrace('thumbnail.hook.android_photokit_success', { fileId });
              setState({ uri: localUri, source: 'photoKit', failed: false });
              return;
            }
            if (!hasThumbnail) {
              setState({ uri: null, source: null, failed: true });
              return;
            }
            return enqueueThumbnailLoad(fileId, async (fId) => {
              const fileKey = await getFileKeyBytes(fId);
              return fetchDecryptedThumbnailUri(fId, fileKey);
            }).then((serverUri) => {
              if (cancelledRef.current) return;
              if (serverUri) {
                recordRuntimeTrace('thumbnail.hook.android_remote_success', { fileId });
                setState({ uri: serverUri, source: 'remote', failed: false });
              } else {
                recordRuntimeTrace('thumbnail.hook.android_remote_empty', { fileId });
                setState({ uri: null, source: null, failed: true });
              }
            });
          });
        }
        if (!hasThumbnail) {
          setState({ uri: null, source: null, failed: true });
          return;
        }
        return enqueueThumbnailLoad(fileId, async (fId) => {
          const fileKey = await getFileKeyBytes(fId);
          return fetchDecryptedThumbnailUri(fId, fileKey);
        }).then((serverUri) => {
          if (cancelledRef.current) return;
          if (serverUri) {
            recordRuntimeTrace('thumbnail.hook.remote_success', { fileId });
            setState({ uri: serverUri, source: 'remote', failed: false });
          } else {
            recordRuntimeTrace('thumbnail.hook.remote_empty', { fileId });
            setState({ uri: null, source: null, failed: true });
          }
        });
      })
      .catch(() => {
        if (cancelledRef.current) return;
        recordRuntimeTrace('thumbnail.hook.failed', { fileId });
        setState({ uri: null, source: null, failed: true });
      });

    return () => { cancelledRef.current = true; };
  }, [fileId, width, height, enabled, isUnlocked, mimeType, hasThumbnail, getFileKeyBytes]);

  // Subscribe to refresh events on iOS — when a remote thumbnail lands after
  // the initial render, the actor fires `onThumbnailReady` so we can update
  // without polling.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const sub = onThumbnailReady(({ fileId: changedId, uri, source }) => {
      if (changedId !== fileId) return;
      if (cancelledRef.current) return;
      recordRuntimeTrace('thumbnail.hook.native_event_ready', {
        fileId,
        source,
      });
      setState({ uri, source: source as ThumbnailHookState['source'], failed: false });
    });
    return () => sub.remove();
  }, [fileId]);

  const _markFailed = useCallback(() => {
    if (cancelledRef.current) return;
    setState((prev) => ({ ...prev, failed: true }));
  }, []);
  void _markFailed;

  return state;
}
