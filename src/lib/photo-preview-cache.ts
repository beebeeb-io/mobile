import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { downloadPhotoPreviewNative } from '../../modules/beebeeb-crypto';
import { onAccountEpochAdvance } from './account-epoch';
import { getApiUrl, getToken } from './api';
import { withPlaintextLease, writePlaintext } from './plaintext-gate';
import { sharedMasterHandleId } from './shared-folder-keys';

/**
 * Local cache of decrypted photo previews. Plaintext, so it lives only under
 * Library/Caches (not backed up, purged on sign-out via the caches registry).
 * Files are `<fileId>.img`; recency, plus the format and size each preview was
 * made at, are tracked in a small index so the cache can be trimmed
 * least-recently-viewed first and a replaced preview is noticed.
 */

const DIR_NAME = 'beebeeb-previews-v1';
const INDEX_NAME = '.lru-index.json';
const INDEX_TMP_NAME = '.lru-index.tmp';
const FILE_EXT = '.img';
const LIMIT_KEY = 'beebeeb.preview-cache-limit.v1';
const GB = 1024 * 1024 * 1024;
const MAX_DEFAULT_LIMIT = 20 * GB;
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface Deps {
  now: () => number;
  totalDisk: () => Promise<number>;
  handleId: () => number;
}

const defaultDeps: Deps = {
  now: () => Date.now(),
  totalDisk: () => FileSystem.getTotalDiskCapacityAsync(),
  handleId: () => sharedMasterHandleId(),
};
let deps: Deps = defaultDeps;

/**
 * Last use, and the format/size the cached preview was made at, plus the stored
 * preview's size on the server (`preview_bytes`: plaintext + 28) when known.
 */
interface IndexEntry { t: number; f?: string; p?: number; b?: number }

/** Nonce (12) + AEAD tag (16): the server's `preview_bytes` is the plaintext size plus this. */
const PREVIEW_WIRE_OVERHEAD = 28;
let index: Map<string, IndexEntry> | null = null;
/** Ids being downloaded right now: never trimmed (their file may not be indexed yet). */
const inFlight = new Set<string>();

// The index is reloaded from disk after a sign-out or account switch.
onAccountEpochAdvance(() => {
  index = null;
});

/** Test hook: swap the clock, disk-size and key-handle sources and drop in-memory state. */
export function __resetPreviewCacheForTests(overrides: Partial<Deps> = {}): void {
  deps = { ...defaultDeps, ...overrides };
  index = null;
  inFlight.clear();
  saveChain = Promise.resolve();
}

export function previewCacheDir(): string {
  // caches-registry: example=beebeeb-previews-v1/
  return `${FileSystem.cacheDirectory}${DIR_NAME}/`;
}

function fileUri(fileId: string): string {
  return `${previewCacheDir()}${fileId}${FILE_EXT}`;
}

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

async function ensureDir(): Promise<void> {
  await FileSystem.makeDirectoryAsync(previewCacheDir(), { intermediates: true }).catch(() => {});
}

function parseEntry(v: unknown): IndexEntry | null {
  if (typeof v === 'number') return { t: v }; // older index: recency only
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.t !== 'number') return null;
  const entry: IndexEntry = { t: o.t };
  if (typeof o.f === 'string' && o.f) entry.f = o.f;
  if (typeof o.p === 'number' && o.p > 0) entry.p = o.p;
  if (typeof o.b === 'number' && o.b > 0) entry.b = o.b;
  return entry;
}

async function loadIndex(): Promise<Map<string, IndexEntry>> {
  if (index) return index;
  const map = new Map<string, IndexEntry>();
  try {
    const raw = JSON.parse(await FileSystem.readAsStringAsync(`${previewCacheDir()}${INDEX_NAME}`));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        const entry = parseEntry(v);
        if (entry && FILE_ID_RE.test(k)) map.set(k, entry);
      }
    }
  } catch { /* no index yet, or unreadable: start empty */ }
  index = map;
  return map;
}

// All index saves run one after another; each writes a temp file in the cache dir and moves it over the index.
let saveChain: Promise<void> = Promise.resolve();

function saveIndex(): Promise<void> {
  saveChain = saveChain.then(async () => {
    if (!index) return;
    const target = `${previewCacheDir()}${INDEX_NAME}`;
    const tmp = `${previewCacheDir()}${INDEX_TMP_NAME}`;
    try {
      await FileSystem.writeAsStringAsync(tmp, JSON.stringify(Object.fromEntries(index)));
      await FileSystem.moveAsync({ from: tmp, to: target });
    } catch {
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    }
  });
  return saveChain;
}

async function touch(fileId: string, made?: { format?: string; px?: number; bytes?: number }): Promise<void> {
  const idx = await loadIndex();
  const entry: IndexEntry = made ? {} as IndexEntry : { ...(idx.get(fileId) ?? {}) } as IndexEntry;
  entry.t = deps.now();
  if (made?.format) entry.f = made.format;
  if (made?.px) entry.p = made.px;
  if (made?.bytes) entry.b = made.bytes;
  idx.set(fileId, entry);
  await saveIndex();
}

async function removeFile(fileId: string, persist = true): Promise<void> {
  await FileSystem.deleteAsync(fileUri(fileId), { idempotent: true }).catch(() => {});
  (await loadIndex()).delete(fileId);
  if (persist) await saveIndex();
}

interface Entry { id: string; size: number; mtime: number }

async function listEntries(): Promise<Entry[]> {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(previewCacheDir());
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const name of names) {
    if (!name.endsWith(FILE_EXT)) continue;
    const id = name.slice(0, -FILE_EXT.length);
    if (!FILE_ID_RE.test(id)) continue;
    const info = await FileSystem.getInfoAsync(`${previewCacheDir()}${name}`).catch(() => null) as
      { exists: boolean; isDirectory?: boolean; size?: number; modificationTime?: number } | null;
    if (!info || !info.exists || info.isDirectory) continue;
    out.push({ id, size: info.size ?? 0, mtime: info.modificationTime ?? 0 });
  }
  return out;
}

/** The stored preview as the file row describes it now. */
export interface ExpectedPreview {
  format?: string | null;
  px?: number | null;
  /** `preview_bytes`: the stored (encrypted) preview's size. */
  bytes?: number | null;
}

/**
 * Cached preview uri for a file (marks it as just used), or null. With `expected`
 * (the row's `preview_format`/`preview_px`/`preview_bytes`), a cached copy made at
 * another format or size, or of another stored preview (a different byte size: a
 * re-made preview, e.g. after a new file version), or with unknown values, is a
 * miss: it is removed so the caller downloads the current preview.
 */
export async function getCachedPreview(fileId: string, expected?: ExpectedPreview): Promise<string | null> {
  if (!FILE_ID_RE.test(fileId)) return null;
  const uri = fileUri(fileId);
  const info = await FileSystem.getInfoAsync(uri).catch(() => null) as { exists: boolean; isDirectory?: boolean } | null;
  if (!info || !info.exists || info.isDirectory) return null;
  if (expected && expected.format && expected.px) {
    const entry = (await loadIndex()).get(fileId);
    const otherPreview = typeof expected.bytes === 'number' && expected.bytes > 0 && entry?.b !== expected.bytes;
    if (!entry || entry.f !== expected.format || entry.p !== expected.px || otherPreview) {
      await removeFile(fileId);
      return null;
    }
  }
  await touch(fileId);
  return uri;
}

/** Forget the cached copy of a file's preview (this device just replaced it). */
export async function dropCachedPreview(fileId: string): Promise<void> {
  if (!FILE_ID_RE.test(fileId)) return;
  await removeFile(fileId);
}

function errorCode(e: unknown): string {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (typeof err?.code === 'string' && err.code.startsWith('preview_')) return err.code;
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (msg.includes('preview_missing')) return 'preview_missing';
  if (msg.includes('preview_corrupt')) return 'preview_corrupt';
  return 'preview_error';
}

/**
 * Download + decrypt the server preview into the cache. A missing, corrupt,
 * truncated or otherwise failing preview gives null so callers fall back to the
 * thumbnail or original. Bad or missing previews are removed from the cache; a
 * transient failure keeps an already-cached valid copy.
 */
export async function fetchPreviewToCache(fileId: string, expected?: ExpectedPreview): Promise<string | null> {
  if (!FILE_ID_RE.test(fileId)) return null;
  inFlight.add(fileId);
  try {
    return await fetchPreviewToCacheInner(fileId, expected);
  } finally {
    inFlight.delete(fileId);
  }
}

async function fetchPreviewToCacheInner(fileId: string, expected?: ExpectedPreview): Promise<string | null> {
  const uri = fileUri(fileId);
  const before = await FileSystem.getInfoAsync(uri).catch(() => null) as { exists: boolean; size?: number } | null;
  const hadValidFile = !!before && before.exists && (before.size ?? 0) > 0;
  try {
    const token = await getToken();
    if (!token) return null;
    const handleId = deps.handleId();
    // A plaintext writer: refused (and its output discarded) once a sign-out purge closed the gate.
    const result = await withPlaintextLease('photo preview cache', async (lease) => {
      lease.assertValid();
      await ensureDir();
      return writePlaintext(lease, uri, FileSystem, () =>
        downloadPhotoPreviewNative(handleId, getApiUrl(), token, fileId, uriToPath(uri)),
      );
    });
    const info = await FileSystem.getInfoAsync(uri) as { exists: boolean; size?: number };
    if (!result || !info.exists || !(info.size && info.size > 0)) {
      await removeFile(fileId);
      return null;
    }
    // What the server says it sent wins; the row's values fill a header it left out.
    const made = result as { format?: unknown; px?: unknown; bytes?: unknown };
    await touch(fileId, {
      format: typeof made.format === 'string' && made.format ? made.format : expected?.format ?? undefined,
      px: typeof made.px === 'number' && made.px > 0 ? made.px : expected?.px ?? undefined,
      bytes: typeof made.bytes === 'number' && made.bytes > 0 ? made.bytes + PREVIEW_WIRE_OVERHEAD : undefined,
    });
    return uri;
  } catch (e) {
    // The server saying the preview is gone or bad invalidates a cached copy. A transient
    // failure (network, locked vault) leaves a valid cached file alone.
    const code = errorCode(e);
    if (code === 'preview_missing' || code === 'preview_corrupt' || !hadValidFile) await removeFile(fileId);
    return null;
  }
}

/** Index times are ms; file modification times come in seconds. */
function mtimeMs(mtime: number): number {
  return mtime > 1e11 ? mtime : mtime * 1000;
}

/**
 * Delete least-recently-used previews until the cache is within `limitBytes`.
 * Ids in `keep` (e.g. the preview on screen) and ids being downloaded are never
 * removed. A file the index does not know yet is ordered by its modification time.
 */
export async function trimPreviewCache(
  limitBytes: number,
  keep: Set<string> = new Set(),
): Promise<{ removed: number; bytes: number }> {
  const idx = await loadIndex();
  const entries = await listEntries();
  let bytes = entries.reduce((n, e) => n + e.size, 0);
  let removed = 0;
  if (bytes > limitBytes) {
    const order = entries
      .filter((e) => !keep.has(e.id) && !inFlight.has(e.id))
      .map((e) => ({ ...e, used: idx.get(e.id)?.t ?? mtimeMs(e.mtime) }))
      .sort((a, b) => a.used - b.used || a.mtime - b.mtime);
    for (const e of order) {
      if (bytes <= limitBytes) break;
      await removeFile(e.id, false);
      bytes -= e.size;
      removed += 1;
    }
    await saveIndex();
  }
  return { removed, bytes };
}

export async function previewCacheUsage(): Promise<{ files: number; bytes: number }> {
  const entries = await listEntries();
  return { files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) };
}

/** Compare/settings samples (plaintext camera-roll encodes); removed after sign-out. */
export async function deletePreviewSamples(): Promise<void> {
  await FileSystem.deleteAsync(`${previewCacheDir()}samples/`, { idempotent: true }).catch(() => {});
}

export async function clearPreviewCache(): Promise<void> {
  await FileSystem.deleteAsync(previewCacheDir(), { idempotent: true }).catch(() => {});
  index = new Map();
  saveChain = Promise.resolve();
}

async function defaultLimitBytes(): Promise<number> {
  try {
    const total = await deps.totalDisk();
    if (Number.isFinite(total) && total > 0) return Math.min(MAX_DEFAULT_LIMIT, Math.floor(total * 0.1));
  } catch { /* fall through */ }
  return MAX_DEFAULT_LIMIT;
}

/** Per-device limit (SecureStore); default `min(20 GB, 10% of total disk)`. */
export async function getPreviewCacheLimitBytes(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(LIMIT_KEY);
    if (raw !== null && /^\d+$/.test(raw)) return Number(raw);
  } catch { /* use the default */ }
  return defaultLimitBytes();
}

/**
 * The settings slider let go: clamp to [min, max], store it, and trim the cache to
 * it right away (a lowered limit frees space now). Returns the stored limit and
 * the cache size after the trim.
 */
export async function commitPreviewCacheLimit(
  value: number,
  min: number,
  max: number,
): Promise<{ limit: number; usageBytes: number }> {
  const limit = Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
  await setPreviewCacheLimitBytes(limit);
  await trimPreviewCache(limit);
  const usage = await previewCacheUsage();
  return { limit, usageBytes: usage.bytes };
}

export async function setPreviewCacheLimitBytes(bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Invalid preview cache limit');
  await SecureStore.setItemAsync(LIMIT_KEY, String(Math.floor(bytes)), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}
