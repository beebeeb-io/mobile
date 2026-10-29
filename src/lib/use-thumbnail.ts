import { sharedFileKeyIsLoaded, getSharedKeyResolver } from './shared-folder-keys';
import { isForeignSharedFile } from './shared-folder-tree';
import { accountEpoch } from './account-epoch';
import type { ThumbnailDecrypt } from './thumbnail';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useCrypto } from './crypto-context';
import { onThumbnailReady } from './thumbnail-events';
import { getCachedThumbnail, enqueueThumbnailLoad } from './thumbnail-cache';
import { cacheLocalThumbnail, fetchDecryptedThumbnailUri } from './thumbnail';
import {
  isThumbnailLoadCancelled,
  isThumbnailLoadTransient,
  type ThumbnailLoadResult,
} from './thumbnail-load-outcome';
import { getLocalIdentifier } from './local-identifier-map';
import { recordRuntimeTrace } from './runtime-trace';

interface UseThumbnailOptions {
  width?: number;
  height?: number;
  enabled?: boolean;
  mimeType?: string | null;
  hasThumbnail?: boolean;
  /**
   * Bump to force a re-run without changing the identity of the call (used by
   * `ThumbnailImage` after it invalidated a corrupt cache entry).
   */
  reloadKey?: number;
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
  fileKey: Uint8Array | ThumbnailDecrypt,
  opts: { width?: number; height?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const { width = 256, height = 256, signal } = opts;
  if (Platform.OS === 'ios' && !sharedFileKeyIsLoaded(fileId) && ThumbnailServiceNative?.getThumbnail) {
    try {
      const result = await ThumbnailServiceNative.getThumbnail(fileId, width, height);
      return result?.uri ?? null;
    } catch {
      return null;
    }
  }
  const result = await fetchDecryptedThumbnailUri(fileId, fileKey, signal);
  return isThumbnailLoadCancelled(result) || isThumbnailLoadTransient(result) ? null : result;
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
  const {
    width = 256,
    height = 256,
    enabled = true,
    mimeType = null,
    hasThumbnail = true,
    reloadKey = 0,
  } = options;
  const { getFileKeyBytes, decryptChunk: decryptFileChunk, isUnlocked } = useCrypto();
  const [state, setState] = useState<ThumbnailHookState>({ uri: null, source: null, failed: false });
  // Decrypted MIME metadata arrives after remote thumbnails can already be
  // visible. Only local-asset generation needs that value; restarting Android
  // remote loads here clears a valid URI and repeats cache/bridge work.
  // iOS retains its existing MIME-triggered native request behavior.
  const thumbnailMimeType = Platform.OS === 'android' && !getLocalIdentifier(fileId)
    ? null
    : mimeType;

  useEffect(() => {
    // P1-1 — one cancel flag PER EFFECT RUN. A shared ref was reset to false
    // by the next run before the previous run's abort resolved, so the old
    // load's `null` was reported as a failure and a still-visible tile went
    // blank (ThumbnailImage → onUnavailable → has_thumbnail:false).
    let cancelled = false;
    // A4 — one controller per effect run (cell mount / fileId change): the
    // cleanup aborts the queued or running load so an unmounted cell never
    // downloads, decrypts or writes.
    const controller = new AbortController();
    setState({ uri: null, source: null, failed: false });

    if (!enabled || !isUnlocked) return () => { cancelled = true; controller.abort(); };

    /**
     * A cancelled or dropped load (viewport change, unmount, account switch)
     * is NOT "no thumbnail": ignore it. Only a real 404 / missing thumbnail /
     * decrypt failure may set `failed` — that is what clears `has_thumbnail`.
     */
    const applyRemote = (
      result: ThumbnailLoadResult,
      traceSuccess: string,
      traceEmpty: string,
    ) => {
      if (cancelled) return;
      if (isThumbnailLoadCancelled(result)) return;
      // N1 — a transient failure (backoff, 429/5xx, network/disk throw) keeps
      // the placeholder and is retried on the next mount; never `failed`.
      if (isThumbnailLoadTransient(result)) return;
      if (result) {
        recordRuntimeTrace(traceSuccess, { fileId });
        setState({ uri: result, source: 'remote', failed: false });
      } else {
        recordRuntimeTrace(traceEmpty, { fileId });
        setState({ uri: null, source: null, failed: true });
      }
    };
    const fail = () => {
      if (cancelled) return;
      setState({ uri: null, source: null, failed: true });
    };

    recordRuntimeTrace('thumbnail.hook.request', {
      fileId,
      platform: Platform.OS,
      width,
      height,
      hasThumbnail,
    });

    // After a relaunch or a lock a shared file can have a cached decrypted name but no loaded native key, and nothing
    // else has to load it before this hook runs: resolve known foreign files BEFORE choosing the reader, and fail
    // (never fall to the ordinary reader, which would use the wrong key) when the key cannot be resolved.
    const start = () => {
      if (sharedFileKeyIsLoaded(fileId)) {
        void enqueueThumbnailLoad(
          fileId,
          (fId, innerSignal, epoch) =>
            fetchDecryptedThumbnailUri(fId, (n, c) => decryptFileChunk(fId, n, c), innerSignal, epoch),
          controller.signal,
        )
          .then((result) => applyRemote(result, 'thumbnail.hook.remote_success', 'thumbnail.hook.remote_empty'))
          .catch(fail);
        return;
      }
      if (Platform.OS === 'ios' && !sharedFileKeyIsLoaded(fileId) && ThumbnailServiceNative?.getThumbnail) {
        ThumbnailServiceNative
          .getThumbnail(fileId, width, height)
          .then((result) => {
            if (cancelled) return;
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
            if (cancelled) return;
            recordRuntimeTrace('thumbnail.hook.native_failed', {
              fileId,
              error: err instanceof Error ? err.message : String(err),
            });
            console.warn('[useThumbnail] native getThumbnail failed', fileId, err);
            setState({ uri: null, source: null, failed: true });
          });
        return;
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
          if (cancelled) return;
          if (cachedUri) {
            recordRuntimeTrace('thumbnail.hook.android_cache_hit', { fileId });
            setState({ uri: cachedUri, source: 'cache', failed: false });
            return;
          }
          if (cameraRollUri) {
            return cacheLocalThumbnail(fileId, cameraRollUri, thumbnailMimeType).then((localUri) => {
              if (cancelled) return;
              if (localUri) {
                recordRuntimeTrace('thumbnail.hook.android_photokit_success', { fileId });
                setState({ uri: localUri, source: 'photoKit', failed: false });
                return;
              }
              if (!hasThumbnail) {
                setState({ uri: null, source: null, failed: true });
                return;
              }
              return enqueueThumbnailLoad(fileId, async (fId, innerSignal, epoch) => {
                const fileKey = await getFileKeyBytes(fId);
                return fetchDecryptedThumbnailUri(fId, fileKey, innerSignal, epoch);
              }, controller.signal).then((result) => {
                applyRemote(result, 'thumbnail.hook.android_remote_success', 'thumbnail.hook.android_remote_empty');
              });
            });
          }
          if (!hasThumbnail) {
            setState({ uri: null, source: null, failed: true });
            return;
          }
          return enqueueThumbnailLoad(fileId, async (fId, innerSignal, epoch) => {
            const fileKey = await getFileKeyBytes(fId);
            return fetchDecryptedThumbnailUri(fId, fileKey, innerSignal, epoch);
          }, controller.signal).then((result) => {
            applyRemote(result, 'thumbnail.hook.remote_success', 'thumbnail.hook.remote_empty');
          });
        })
        .catch(fail);
    };
    const resolver = isForeignSharedFile(fileId, accountEpoch().accountId) && !sharedFileKeyIsLoaded(fileId) ? getSharedKeyResolver() : null;
    if (resolver) {
      void resolver.ensureLoaded([fileId])
        .then(result => {
          if (cancelled) return;
          if (result.get(fileId) !== 'loaded') { setState({ uri: null, source: null, failed: true }); return; }
          start();
        })
        .catch(fail);
    } else {
      start();
    }
    return () => { cancelled = true; controller.abort(); };
  }, [fileId, width, height, enabled, isUnlocked, thumbnailMimeType, hasThumbnail, reloadKey, getFileKeyBytes, decryptFileChunk]);

  // Subscribe to refresh events on iOS — when a remote thumbnail lands after
  // the initial render, the actor fires `onThumbnailReady` so we can update
  // without polling.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const sub = onThumbnailReady(({ fileId: changedId, uri, source }) => {
      if (changedId !== fileId) return;
      recordRuntimeTrace('thumbnail.hook.native_event_ready', {
        fileId,
        source,
      });
      setState({ uri, source: source as ThumbnailHookState['source'], failed: false });
    });
    return () => sub.remove();
  }, [fileId]);

  return state;
}
