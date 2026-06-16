/**
 * Persistent decrypted-name cache (task 0807, design Pillar 2).
 *
 * A decrypted file name is valid until the file is renamed; `version_number`
 * (carried on every file/index row) is the invalidation key. We persist a
 * compact `fileId -> { name, mime, version }` map to the app document directory
 * so a COLD launch can render real names immediately — before the search-index
 * round-trip and without re-decrypting anything on-device.
 *
 * The cache stores ONLY decrypted plaintext names + mime, which already live
 * decrypted in the in-memory app state and the (encrypted) search index. The
 * file itself never leaves the device; this is a local, on-device convenience
 * cache (no cloud, no US dependency). It is disposable — a miss just falls back
 * to a one-shot batch decrypt.
 */

import * as FileSystem from 'expo-file-system';

export interface CachedName {
  name: string;
  mime: string | null;
  /** `version_number` the name was decrypted at; stale when the row's bumps. */
  version: number;
}

export type NameCache = Record<string, CachedName>;

const CACHE_FILE = `${FileSystem.documentDirectory ?? ''}beebeeb-name-cache-v1.json`;
// Soft cap so a huge vault can't grow the JSON unboundedly. Oldest-inserted keys
// are dropped first (insertion order) when exceeded.
const MAX_ENTRIES = 20000;
const SAVE_DEBOUNCE_MS = 1500;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: NameCache | null = null;

/** Read the persisted cache. Returns an empty map on any miss/parse failure. */
export async function loadNameCache(): Promise<NameCache> {
  if (!FileSystem.documentDirectory) return {};
  try {
    const info = await FileSystem.getInfoAsync(CACHE_FILE);
    if (!info.exists) return {};
    const raw = await FileSystem.readAsStringAsync(CACHE_FILE);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    // Defensive shape validation — never trust on-disk JSON blindly.
    const out: NameCache = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.name !== 'string') continue;
      out[id] = {
        name: v.name,
        mime: typeof v.mime === 'string' ? v.mime : null,
        version: typeof v.version === 'number' ? v.version : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function capEntries(cache: NameCache): NameCache {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_ENTRIES) return cache;
  const trimmed: NameCache = {};
  for (const key of keys.slice(keys.length - MAX_ENTRIES)) {
    trimmed[key] = cache[key]!;
  }
  return trimmed;
}

/** Write the cache to disk immediately (best-effort; failures are swallowed). */
export async function saveNameCacheNow(cache: NameCache): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  try {
    await FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(capEntries(cache)));
  } catch {
    // A failed name-cache write is non-fatal — names still resolve via the index
    // or a fresh batch decrypt next open.
  }
}

/**
 * Debounced persist — coalesces a burst of folder opens into one write. Pass the
 * latest full cache snapshot each time; the most recent wins.
 */
export function scheduleSaveNameCache(cache: NameCache): void {
  pending = cache;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = pending;
    pending = null;
    if (snapshot) void saveNameCacheNow(snapshot);
  }, SAVE_DEBOUNCE_MS);
}

/** Drop the on-disk cache (e.g. on sign-out). Best-effort. */
export async function clearNameCache(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    pending = null;
  }
  try {
    await FileSystem.deleteAsync(CACHE_FILE, { idempotent: true });
  } catch {
    // ignore
  }
}
