/**
 * Local identifier map — task 0552.
 *
 * Maps `file_id → iOS PHAsset.localIdentifier` for the authenticated user so
 * the photo grid can short-circuit thumbnail rendering: if a file's
 * `localIdentifier` is still resolvable in PhotoKit, we render directly from
 * the OS-level cached image and skip the encrypted-blob download entirely.
 *
 * - **Loaded once after auth**, then persisted to disk so the map survives
 *   restart (refreshing only after each successful `photoBackupMark()`).
 * - **Single-shot fetch.** At ~80 bytes/row for typical PHAsset identifiers
 *   even a 100k-photo vault stays under 8 MB — pagination buys us nothing
 *   except complexity. The endpoint is rate-limited at the file-routes tier
 *   (1k req/60s/user); we refresh on event boundaries, not on demand.
 * - **Android-safe.** This module is iOS-targeted. On Android the map is
 *   empty (PHAsset doesn't exist) and `getLocalIdentifier` always returns
 *   null, which is exactly the behaviour we want — Android falls through to
 *   the encrypted-thumbnail path unchanged.
 */

import * as FileSystem from 'expo-file-system';
import { fetchPhotoBackupIdentifierMap, photoBackupClearAssociation } from './api';
import { invalidateCachedThumbnail } from './thumbnail-cache';
import { invalidateInMemoryThumbCache } from './thumbnail';
import { onAssociationCleared } from './thumbnail-events';

let ThumbnailServiceNative: {
  setLocalIdentifierMap?: (map: Record<string, string>) => Promise<void>;
  removeLocalIdentifier?: (fileId: string) => Promise<void>;
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('expo-modules-core');
  ThumbnailServiceNative = mod.requireOptionalNativeModule?.('ThumbnailService') ?? null;
} catch {
  ThumbnailServiceNative = null;
}

type MapChangeListener = (changedFileId: string) => void;
const mapChangeListeners = new Set<MapChangeListener>();

export function onLocalMapChanged(listener: MapChangeListener): () => void {
  mapChangeListeners.add(listener);
  return () => {
    mapChangeListeners.delete(listener);
  };
}

function emitMapChanged(fileId: string): void {
  for (const listener of mapChangeListeners) {
    try {
      listener(fileId);
    } catch (err) {
      console.warn('[local-identifier-map] listener threw', err);
    }
  }
}

const STORAGE_FILE = `${FileSystem.documentDirectory ?? ''}local-id-map.json`;

interface PersistedMap {
  /** ISO timestamp when the map was last fetched from the server. */
  fetched_at: string;
  /** file_id (UUID) → PHAsset.localIdentifier */
  identifiers: Record<string, string>;
}

let inMemoryMap: Record<string, string> = {};
let isReady = false;
let inflightFetch: Promise<void> | null = null;

/** Quick synchronous lookup once the map has been hydrated. */
export function getLocalIdentifier(fileId: string): string | null {
  if (!isReady) return null;
  return inMemoryMap[fileId] ?? null;
}

/** Returns the currently-known map size — useful for diagnostics. */
export function getLocalIdentifierMapSize(): number {
  return Object.keys(inMemoryMap).length;
}

/**
 * Whether the map is hydrated (either from disk or from a successful fetch).
 * Callers that need to wait for it should `await refreshLocalIdentifierMap()`.
 */
export function isLocalIdentifierMapReady(): boolean {
  return isReady;
}

/**
 * Hydrate the map at app launch.
 *
 * Behaviour:
 *  1. Read the disk cache so the photo grid has an immediate answer on cold
 *     start (PhotoKit decisions block render, so a stale-but-present map is
 *     strictly better than a network round-trip on every launch).
 *  2. Kick off a fresh fetch in the background. Returns the disk hydration
 *     promise — the network refresh is fire-and-forget.
 */
let associationListenerRegistered = false;

export async function initLocalIdentifierMap(): Promise<void> {
  await loadFromDisk();
  if (!associationListenerRegistered) {
    onAssociationCleared(({ fileId }) => {
      void removeLocalIdentifier(fileId);
    });
    associationListenerRegistered = true;
  }
  // Fire and forget — never block app startup on this.
  void refreshLocalIdentifierMap();
}

/**
 * Fetch the latest map from the server, persist it, and atomically swap the
 * in-memory copy. Coalesces concurrent callers onto the same inflight promise
 * so we never issue duplicate requests when the grid scrolls fast.
 */
export async function refreshLocalIdentifierMap(): Promise<void> {
  if (inflightFetch) return inflightFetch;
  inflightFetch = (async () => {
    try {
      const next = await fetchPhotoBackupIdentifierMap();
      // Files that are NEWLY PhotoKit-backed (weren't in the map before, are
      // now) probably have a poisoned encrypted-blob cache from before the
      // PhotoKit short-circuit landed. Drop those cache entries so the
      // PhotoKit path can take over on the next render. Best-effort, async.
      const previouslyKnown = new Set(Object.keys(inMemoryMap));
      const newlyKnown = Object.keys(next).filter((id) => !previouslyKnown.has(id));
      inMemoryMap = next;
      isReady = true;
      await saveToDisk({ fetched_at: new Date().toISOString(), identifiers: next });
      // Fire invalidation in the background — never block the refresh.
      // Drop both the on-disk cache AND the in-memory map so the next
      // render re-stats and pulls from PhotoKit.
      for (const id of newlyKnown) invalidateInMemoryThumbCache(id);
      void Promise.all(newlyKnown.map((id) => invalidateCachedThumbnail(id))).catch(
        (err) => console.warn('[local-identifier-map] cache invalidation failed', err),
      );
      if (ThumbnailServiceNative?.setLocalIdentifierMap) {
        await ThumbnailServiceNative.setLocalIdentifierMap(next).catch((err) => {
          console.warn('[local-identifier-map] native sync failed', err);
        });
      }
    } catch (err) {
      // Network failure — leave the disk cache (or empty map) in place. The
      // photo grid will fall through to the encrypted-blob path for any
      // unknown file_id, which is the correct behaviour.
      console.warn('[local-identifier-map] refresh failed', err);
    } finally {
      inflightFetch = null;
    }
  })();
  return inflightFetch;
}

/**
 * Remove a single fileId from the local-identifier map. Triggered when the
 * native `ThumbnailService` emits `onAssociationCleared` (which fires after a
 * PhotoKit `requestImage` returns PHPhotosErrorDomain code 3164, "asset not
 * found").
 *
 * Effects:
 *  1. Drops the entry from the in-memory map AND the persisted disk copy.
 *  2. Invalidates both the in-memory thumbnail cache and the on-disk one so
 *     the next render re-resolves via the remote path.
 *  3. Fires `onLocalMapChanged` so other listeners (the native side, primarily)
 *     can purge their state too.
 *  4. Calls the server's `/clear-association` endpoint so the server-side
 *     `user_local_identifiers` row for THIS device is deleted (the Plan A
 *     migration re-keys the table to `(user_id, device_id, file_id)`).
 */
export async function removeLocalIdentifier(fileId: string): Promise<void> {
  if (!(fileId in inMemoryMap)) return;
  delete inMemoryMap[fileId];
  await saveToDisk({
    fetched_at: new Date().toISOString(),
    identifiers: { ...inMemoryMap },
  });
  invalidateInMemoryThumbCache(fileId);
  void invalidateCachedThumbnail(fileId).catch((err) => {
    console.warn('[local-identifier-map] cache invalidation failed', err);
  });
  emitMapChanged(fileId);
  if (ThumbnailServiceNative?.removeLocalIdentifier) {
    await ThumbnailServiceNative.removeLocalIdentifier(fileId).catch((err) => {
      console.warn('[local-identifier-map] native removeLocalIdentifier failed', err);
    });
  }
  try {
    await photoBackupClearAssociation(fileId);
  } catch (err) {
    // Best-effort: a transient network failure here just means the server
    // row stays until the next time the user opens this file. The local
    // map is the truth for render-path purposes.
    console.warn('[local-identifier-map] clear-association POST failed', err);
  }
}

/**
 * Clear the map (sign-out hygiene).
 */
export async function clearLocalIdentifierMap(): Promise<void> {
  inMemoryMap = {};
  isReady = false;
  try {
    await FileSystem.deleteAsync(STORAGE_FILE, { idempotent: true });
  } catch {
    // best-effort
  }
  if (ThumbnailServiceNative?.setLocalIdentifierMap) {
    await ThumbnailServiceNative.setLocalIdentifierMap({}).catch(() => {});
  }
}

async function loadFromDisk(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(STORAGE_FILE);
    if (!info.exists) return;
    const raw = await FileSystem.readAsStringAsync(STORAGE_FILE);
    const parsed = JSON.parse(raw) as PersistedMap;
    if (parsed && typeof parsed === 'object' && parsed.identifiers && typeof parsed.identifiers === 'object') {
      inMemoryMap = parsed.identifiers;
      isReady = true;
    }
  } catch (err) {
    console.warn('[local-identifier-map] disk load failed', err);
  }
}

async function saveToDisk(payload: PersistedMap): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(STORAGE_FILE, JSON.stringify(payload));
  } catch (err) {
    console.warn('[local-identifier-map] disk save failed', err);
  }
}
