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

import * as FileSystem from 'expo-file-system/legacy';
import { gatedPlaintextWrite } from './plaintext-gate';

import { notePlaintextPathCreated } from './plaintext-storage';
import { isCurrentAccountEpoch, StaleAccountError, type AccountEpoch } from './account-epoch';
import type { OwnerNameConvention } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';

export interface CachedName {
  name: string;
  mime: string | null;
  /** `version_number` the name was decrypted at; stale when the row's bumps. */
  version: number;
  /**
   * SF-0002: the convention the name was authenticated with. An entry written
   * before this field existed has none, and is a MISS on load — the first
   * launch after the upgrade re-decrypts once rather than trusting a name whose
   * write verdict is unknown.
   */
  convention: OwnerNameConvention;
}

export type NameCache = Record<string, CachedName>;

const CONVENTIONS = new Set<string>(['string_or_binary', 'string', 'binary', 'upper_repair']);

const CACHE_FILE = `${FileSystem.documentDirectory ?? ''}beebeeb-name-cache-v1.json`;
// Soft cap so a huge vault can't grow the JSON unboundedly. Oldest-inserted keys
// are dropped first (insertion order) when exceeded.
const MAX_ENTRIES = 20000;
const SAVE_DEBOUNCE_MS = 1500;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: { cache: NameCache; epoch: AccountEpoch } | null = null;

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
      // SF-0002: an entry without a valid convention is a miss.
      if (typeof v.convention !== 'string' || !CONVENTIONS.has(v.convention)) continue;
      out[id] = {
        name: v.name,
        mime: typeof v.mime === 'string' ? v.mime : null,
        version: typeof v.version === 'number' ? v.version : 0,
        convention: v.convention as OwnerNameConvention,
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

/**
 * Write the cache to disk immediately (best-effort; failures are swallowed).
 *
 * Task 1959 round 3: `epoch` is REQUIRED — the account epoch
 * (`account-epoch.ts`) the caller's names belong to, captured when its work
 * started (before its first await). The write is dropped when that account is
 * no longer the signed-in one. The plaintext gate alone did not cover this: a
 * writer that started under A and reached the write after B signed in got a
 * fresh lease from the reopened gate and wrote A's decrypted names into B's
 * session.
 */
export async function saveNameCacheNow(cache: NameCache, epoch: AccountEpoch): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  try {
    // Task 1593 round 3 — decrypted names are plaintext: a write racing a
    // sign-out purge is refused / discarded (caught below like any failure).
    await gatedPlaintextWrite('name cache', CACHE_FILE, FileSystem, () => {
      // Checked synchronously right before the write, inside the lease.
      if (!epoch || !isCurrentAccountEpoch(epoch)) throw new StaleAccountError('name cache');
      return FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(capEntries(cache)));
    });
    notePlaintextPathCreated();
  } catch {
    // A failed name-cache write is non-fatal — names still resolve via the index
    // or a fresh batch decrypt next open.
  }
}

/**
 * Debounced persist — coalesces a burst of folder opens into one write. Pass the
 * latest full cache snapshot each time; the most recent wins. `epoch` is the
 * account the snapshot's names belong to (see `saveNameCacheNow`).
 */
export function scheduleSaveNameCache(cache: NameCache, epoch: AccountEpoch): void {
  pending = { cache, epoch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = pending;
    pending = null;
    if (snapshot) void saveNameCacheNow(snapshot.cache, snapshot.epoch);
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Remove specific file ids from the persisted name cache — the reconcile (0817)
 * drops names for files that no longer exist server-side so stale entries don't
 * linger. Returns the count removed. Best-effort; persists immediately.
 */
export async function pruneNameCache(fileIds: string[] | Set<string>, epoch: AccountEpoch): Promise<number> {
  const ids = fileIds instanceof Set ? fileIds : new Set(fileIds);
  if (ids.size === 0) return 0;
  // Task 1959 round 3: the read below is a window for a sign-out; the write
  // re-checks `epoch` synchronously before it touches the file.
  const cache = await loadNameCache();
  let removed = 0;
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(cache, id)) {
      delete cache[id];
      removed += 1;
    }
  }
  if (removed > 0) await saveNameCacheNow(cache, epoch);
  return removed;
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
