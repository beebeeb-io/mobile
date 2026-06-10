/**
 * share-key-store — captures the #key= fragment from share URLs before React
 * Navigation's routing strips them, and holds it until SharedViewScreen mounts.
 *
 * Flow:
 *   1. App.tsx's Linking handler captures the raw URL
 *   2. setPendingShareKey(token, key) enqueues {token, key}
 *   3. SharedViewScreen mounts with route.params.token
 *   4. consumeShareKey(token) / consumeShareKeyAsync(token) returns the key once
 *
 * Design (task 0710 — root-cause #2 of the flaky shares-with-key failures, sweep
 * wf_b68581a7-332): this used to be a single-slot singleton, so two share links
 * tapped in quick succession dropped the first (its capture clobbered), and an
 * in-memory-only capture was lost on a cold-start race (the app process can be
 * torn down between a universal-link tap and SharedViewScreen mounting). Both
 * failure modes looked random. We fix them with:
 *   - a token-keyed QUEUE (Map) so concurrent links don't clobber each other, and
 *   - per-token AsyncStorage write-through (TTL + delete-on-consume) so a capture
 *     survives a process restart.
 *
 * Security note: the stored value is the `#key=` URL fragment — material that is
 * already visible in the share link and scoped to exactly ONE share token. It is
 * NOT the user's master key and reveals nothing about the user's vault. Holding
 * it briefly, keyed by token, with a short TTL and delete-on-consume, exposes
 * nothing the link itself didn't already expose to whoever holds it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recordRuntimeTrace } from './runtime-trace';

interface PendingShareKey {
  shareKey: string;
  capturedAtMs: number;
}

const STORAGE_PREFIX = 'beebeeb.pendingShareKey.';
// A share link is normally opened within seconds of capture. 10 minutes is
// generous slack for a cold-start race while still tightly bounding how long a
// captured fragment can linger at rest.
const TTL_MS = 10 * 60 * 1000;

const storageKeyFor = (token: string): string => STORAGE_PREFIX + token;

// Token-keyed queue. Concurrent share links no longer clobber each other.
const queue = new Map<string, PendingShareKey>();
let hydrated = false;

// Overridable clock so TTL behaviour is unit-testable.
let nowMs: () => number = () => Date.now();

function isFresh(entry: PendingShareKey, atMs: number): boolean {
  return atMs - entry.capturedAtMs < TTL_MS;
}

function isValidEntry(value: unknown): value is PendingShareKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PendingShareKey).shareKey === 'string' &&
    typeof (value as PendingShareKey).capturedAtMs === 'number'
  );
}

/**
 * Capture a share key for `token`. Called by App.tsx's URL handler the moment a
 * `#key=` fragment is intercepted — BEFORE React Navigation strips the hash.
 * Writes through to AsyncStorage (best-effort) so the capture survives a
 * cold-start race.
 */
export function setPendingShareKey(token: string, shareKey: string): void {
  const capturedAtMs = nowMs();
  queue.set(token, { shareKey, capturedAtMs });
  recordRuntimeTrace('share-key.capture', { token, queueSize: queue.size, capturedAtMs });
  AsyncStorage.setItem(storageKeyFor(token), JSON.stringify({ shareKey, capturedAtMs })).catch(() => {
    // Best-effort: the in-memory queue is the primary path; persistence only
    // backs up the cold-start race, so a storage failure degrades gracefully.
  });
}

/**
 * Synchronous fast-path consume from the in-memory queue. Returns the key and
 * removes it from both layers (consume-once). Returns null on miss or expiry;
 * callers that need the cold-start fallback should follow up with
 * consumeShareKeyAsync.
 */
export function consumeShareKey(token: string): string | null {
  const entry = queue.get(token);
  if (!entry) return null;
  queue.delete(token);
  AsyncStorage.removeItem(storageKeyFor(token)).catch(() => {});
  if (!isFresh(entry, nowMs())) {
    recordRuntimeTrace('share-key.expired', { token, source: 'memory' });
    return null;
  }
  recordRuntimeTrace('share-key.consume', { token, source: 'memory' });
  return entry.shareKey;
}

/**
 * Consume with the cold-start fallback: tries the in-memory queue first, then
 * reads AsyncStorage directly (covers the window where a prior process persisted
 * the fragment but hydrateShareKeys hasn't completed yet). Consume-once across
 * both layers.
 */
export async function consumeShareKeyAsync(token: string): Promise<string | null> {
  const fromMemory = consumeShareKey(token);
  if (fromMemory) return fromMemory;
  try {
    const raw = await AsyncStorage.getItem(storageKeyFor(token));
    if (!raw) return null;
    await AsyncStorage.removeItem(storageKeyFor(token));
    const entry: unknown = JSON.parse(raw);
    if (!isValidEntry(entry)) return null;
    if (!isFresh(entry, nowMs())) {
      recordRuntimeTrace('share-key.expired', { token, source: 'storage' });
      return null;
    }
    recordRuntimeTrace('share-key.consume', { token, source: 'storage' });
    return entry.shareKey;
  } catch {
    return null;
  }
}

/**
 * Hydrate the in-memory queue from AsyncStorage. Call once at app startup so a
 * fragment persisted by a previous process is available to the sync fast-path.
 * Expired entries are pruned.
 */
export async function hydrateShareKeys(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const mine = allKeys.filter((k) => k.startsWith(STORAGE_PREFIX));
    const atMs = nowMs();
    for (const storageKey of mine) {
      const token = storageKey.slice(STORAGE_PREFIX.length);
      let raw: string | null = null;
      try {
        raw = await AsyncStorage.getItem(storageKey);
      } catch {
        continue;
      }
      let keep = false;
      if (raw) {
        try {
          const entry: unknown = JSON.parse(raw);
          if (isValidEntry(entry) && isFresh(entry, atMs)) {
            if (!queue.has(token)) queue.set(token, entry);
            keep = true;
          }
        } catch {
          keep = false;
        }
      }
      if (!keep) await AsyncStorage.removeItem(storageKey).catch(() => {});
    }
  } catch {
    // Corrupt/unavailable storage: start clean rather than block the launch path.
  }
}

/**
 * A screen-local resolver that memoises resolved keys per share token. The
 * store is consume-once + delete-on-consume, and React Navigation RE-RENDERS
 * (does not remount) SharedViewScreen when a second share link arrives — so the
 * same component instance sees a changing `token`. Re-resolving a token whose
 * key this screen already consumed (e.g. an A→C→A re-open where A's fragment was
 * stripped and consumed on first mount) must read this cache, otherwise the
 * second resolution finds the emptied queue and regresses the stale-wrong-key
 * bug into a missing-key one. Each screen owns one resolver (held in a ref).
 * (task 0710 — stale-key-on-renavigation fix)
 */
export function makeShareKeyResolver() {
  const cache = new Map<string, string>();
  return {
    resolveSync(token: string, routeKey: string | null): string | null {
      const cached = cache.get(token);
      if (cached) {
        recordRuntimeTrace('share-key.resolve', { token, source: 'cache' });
        return cached;
      }
      const key = routeKey ?? consumeShareKey(token);
      if (key) {
        cache.set(token, key);
        recordRuntimeTrace('share-key.resolve', { token, source: routeKey ? 'route' : 'queue' });
      }
      return key;
    },
    async resolveAsync(token: string): Promise<string | null> {
      const cached = cache.get(token);
      if (cached) return cached;
      const key = await consumeShareKeyAsync(token);
      if (key) {
        cache.set(token, key);
        recordRuntimeTrace('share-key.resolve', { token, source: 'queue-async' });
      }
      return key;
    },
  };
}

/** Test-only hooks. Not used by production code. */
export function __setClockForTest(fn: (() => number) | null): void {
  nowMs = fn ?? (() => Date.now());
}
export function __resetShareKeyStoreForTest(): void {
  queue.clear();
  hydrated = false;
  nowMs = () => Date.now();
}
