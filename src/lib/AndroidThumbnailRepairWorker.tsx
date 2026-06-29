import React, { useEffect, useRef } from 'react';
import { AppState, InteractionManager, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

// Defensive: this component is mounted only on Android (App.tsx checks Platform).
if (Platform.OS !== 'android' && __DEV__) {
  console.warn('AndroidThumbnailRepairWorker loaded on non-Android — App.tsx should gate this.');
}

import { getFileIndex } from './api';
import type { FileEntry } from './api';
import { encryptedMetadataPayloadToBytes } from './encrypted-metadata';
import { loadCachedFileIndex, saveCachedFileIndex } from './file-index-cache';
import { getRemoteToLocalMap } from '../services/BackupDatabase';
import { ensureThumbnailForImage, generateAndUploadPhotoLibraryThumbnail } from './thumbnail';
import { invalidateCachedThumbnail } from './thumbnail-cache';
import { invalidateInMemoryThumbCache } from './thumbnail';
import { formatBytes } from './format';
// ---------------------------------------------------------------------------
// Inlined from thumbnail-repair-predicate.ts (deleted in task 22)
// ---------------------------------------------------------------------------

/** Decoded ciphertext bytes below this threshold are treated as DEGRADED. */
const DEGRADED_THUMBNAIL_BYTES_THRESHOLD = 30 * 1024;

function isDegradedThumbnail(file: FileEntry): boolean {
  if (file.is_folder || file.is_uploading) return false;
  if (file.has_thumbnail !== true) return false;
  const bytes = file.thumbnail_bytes;
  if (bytes == null) return true;
  return bytes < DEGRADED_THUMBNAIL_BYTES_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Inlined from thumbnail-repair-settings.ts (deleted in task 22)
// ---------------------------------------------------------------------------

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ThumbnailImproveQualitySettings {
  wifiOnly: boolean;
  thoroughMode: boolean;
}

export interface ThumbnailRepairSettings {
  autoRepairWhileIdle: boolean;
  improveQuality: ThumbnailImproveQualitySettings;
}

export type ThumbnailRepairPhase =
  | 'idle' | 'queued' | 'scanning' | 'repairing' | 'paused' | 'completed' | 'failed';

export type ThumbnailRepairMode = 'missing' | 'degraded';

export interface ThumbnailRepairActivity {
  at: number;
  message: string;
}

export interface ThumbnailRepairStatus {
  requestedAt: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  running: boolean;
  phase: ThumbnailRepairPhase;
  mode: ThumbnailRepairMode;
  checked: number;
  remaining: number;
  repaired: number;
  skipped: number;
  failed: number;
  totalMissing: number;
  bytesDownloaded: number;
  lastRunAt: number | null;
  lastMessage: string | null;
  currentAction: string | null;
  currentFileName: string | null;
  activity: ThumbnailRepairActivity[];
}

const SETTINGS_KEY = 'beebeeb:thumbnail-repair-settings:v1';
const STATUS_KEY = 'beebeeb:thumbnail-repair-status:v1';

export const DEFAULT_THUMBNAIL_REPAIR_STATUS: ThumbnailRepairStatus = {
  requestedAt: null, startedAt: null, updatedAt: null, completedAt: null,
  running: false, phase: 'idle', mode: 'missing',
  checked: 0, remaining: 0, repaired: 0, skipped: 0, failed: 0,
  totalMissing: 0, bytesDownloaded: 0,
  lastRunAt: null, lastMessage: null, currentAction: null, currentFileName: null,
  activity: [],
};

function normalizeImproveQuality(
  value: Partial<ThumbnailImproveQualitySettings> | null | undefined,
): ThumbnailImproveQualitySettings {
  return {
    wifiOnly: value?.wifiOnly !== false,
    thoroughMode: value?.thoroughMode === true,
  };
}

function normalizeSettings(value: Partial<ThumbnailRepairSettings> | null): ThumbnailRepairSettings {
  return {
    autoRepairWhileIdle: value?.autoRepairWhileIdle === true,
    improveQuality: normalizeImproveQuality(value?.improveQuality),
  };
}

function normalizeStatus(value: Partial<ThumbnailRepairStatus> | null): ThumbnailRepairStatus {
  const phase = value?.phase;
  const activity = Array.isArray(value?.activity)
    ? value.activity.filter((item) => (
        item && typeof item.at === 'number' && typeof item.message === 'string' && item.message.trim().length > 0
      )).slice(0, 8)
    : [];
  const mode: ThumbnailRepairMode = value?.mode === 'degraded' ? 'degraded' : 'missing';
  return {
    requestedAt: typeof value?.requestedAt === 'number' ? value.requestedAt : null,
    startedAt: typeof value?.startedAt === 'number' ? value.startedAt : null,
    updatedAt: typeof value?.updatedAt === 'number' ? value.updatedAt : null,
    completedAt: typeof value?.completedAt === 'number' ? value.completedAt : null,
    running: value?.running === true,
    phase: phase === 'queued' || phase === 'scanning' || phase === 'repairing' || phase === 'paused' || phase === 'completed' || phase === 'failed' ? phase : 'idle',
    mode,
    checked: typeof value?.checked === 'number' ? value.checked : 0,
    remaining: typeof value?.remaining === 'number' ? value.remaining : 0,
    repaired: typeof value?.repaired === 'number' ? value.repaired : 0,
    skipped: typeof value?.skipped === 'number' ? value.skipped : 0,
    failed: typeof value?.failed === 'number' ? value.failed : 0,
    totalMissing: typeof value?.totalMissing === 'number' ? value.totalMissing : 0,
    bytesDownloaded: typeof value?.bytesDownloaded === 'number' && value.bytesDownloaded >= 0 ? value.bytesDownloaded : 0,
    lastRunAt: typeof value?.lastRunAt === 'number' ? value.lastRunAt : null,
    lastMessage: typeof value?.lastMessage === 'string' ? value.lastMessage : null,
    currentAction: typeof value?.currentAction === 'string' ? value.currentAction : null,
    currentFileName: typeof value?.currentFileName === 'string' ? value.currentFileName : null,
    activity,
  };
}

async function getThumbnailRepairSettings(): Promise<ThumbnailRepairSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY).catch(() => null);
  if (!raw) return { autoRepairWhileIdle: false, improveQuality: { wifiOnly: true, thoroughMode: false } };
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<ThumbnailRepairSettings>);
  } catch {
    await AsyncStorage.removeItem(SETTINGS_KEY).catch(() => {});
    return { autoRepairWhileIdle: false, improveQuality: { wifiOnly: true, thoroughMode: false } };
  }
}

async function getThumbnailRepairStatus(): Promise<ThumbnailRepairStatus> {
  const raw = await AsyncStorage.getItem(STATUS_KEY).catch(() => null);
  if (!raw) return DEFAULT_THUMBNAIL_REPAIR_STATUS;
  try {
    return normalizeStatus(JSON.parse(raw) as Partial<ThumbnailRepairStatus>);
  } catch {
    await AsyncStorage.removeItem(STATUS_KEY).catch(() => {});
    return DEFAULT_THUMBNAIL_REPAIR_STATUS;
  }
}

async function setThumbnailRepairStatus(next: ThumbnailRepairStatus): Promise<ThumbnailRepairStatus> {
  const normalized = normalizeStatus(next);
  await AsyncStorage.setItem(STATUS_KEY, JSON.stringify(normalized));
  return normalized;
}
import { getPerformanceStorageSettings, type PerformanceStorageProfile } from './performance-storage-settings';
import type { ThumbnailVariant } from './thumbnail-policy';
import { useCrypto } from './crypto-context';

const MIN_DELAY_MS = 2_500;
const MAX_DELAY_MS = 60_000;
const MANUAL_REPAIR_DELAY_MS = 250;
const MANUAL_REPAIR_FAILURE_DELAY_MS = 2_000;
const REPAIR_TIMEOUT_MS = 45_000;
const MANUAL_MAX_PER_SESSION = 2_000;
const AUTO_MAX_PER_SESSION = 40;
const MANUAL_REPAIR_BATCH_SIZE = 16;
const MANUAL_REPAIR_CONCURRENCY = 6;
const AUTO_REPAIR_BATCH_SIZE = 1;
const AUTO_REPAIR_CONCURRENCY = 1;
const MAX_CONSECUTIVE_FAILURES = 5;

// ---- Degraded-mode bulk backfill (task 0553) --------------------------------
//
// Up to DEGRADED_CONCURRENCY files in flight at a time. Latency is fine,
// bandwidth efficiency matters. WiFi-only by default. Respects server
// rate-limit headers by backing off when X-RateLimit-Remaining is low or on 429.

/** Inter-file delay between successful degraded regenerations. */
const DEGRADED_REPAIR_DELAY_MS = 750;

/** Backoff after a failure in degraded mode. */
const DEGRADED_REPAIR_FAILURE_DELAY_MS = 5_000;

/** Per-session cap on degraded regenerations. ~ a 2 GB download budget at 100 KB/photo. */
const DEGRADED_MAX_PER_SESSION = 20_000;

/** Max concurrent file downloads in degraded (bulk-backfill) mode. */
const DEGRADED_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type ErrorCategory =
  | 'network_5xx' | 'network_429' | 'photoKit_missing'
  | 'decrypt_failed' | 'generate_failed' | 'upload_too_large'
  | 'timeout' | 'unknown';

function classifyError(error: unknown, httpStatus: number | null): ErrorCategory {
  if (httpStatus === 429) return 'network_429';
  if (httpStatus && httpStatus >= 500) return 'network_5xx';
  if (httpStatus === 413) return 'upload_too_large';
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/decrypt/i.test(msg)) return 'decrypt_failed';
  if (/PHAsset|local asset/i.test(msg)) return 'photoKit_missing';
  return 'unknown';
}

function categoryUserText(c: ErrorCategory): string {
  switch (c) {
    case 'network_5xx': return 'Server hiccup';
    case 'network_429': return 'Slowing down to respect server limits';
    case 'photoKit_missing': return 'Photo no longer in Photos app';
    case 'decrypt_failed': return "Couldn't decrypt — file may be corrupt";
    case 'generate_failed': return "Couldn't generate thumbnail";
    case 'upload_too_large': return 'Photo too small to thumbnail';
    case 'timeout': return 'Took too long, will try again';
    default: return 'Something went wrong';
  }
}

interface RepairResult {
  checked: number;
  repaired: number;
  skipped: number;
  failed: number;
}

interface DegradedRepairDiagnostics {
  scans: number;
  uploaded: number;
  uploadedCameraRollBacked: number;
  failed: number;
}

const degradedRepairDiagnostics: DegradedRepairDiagnostics = {
  scans: 0,
  uploaded: 0,
  uploadedCameraRollBacked: 0,
  failed: 0,
};

function logDegradedScan(candidates: FileEntry[], localMap: Map<string, string>, thoroughMode: boolean): void {
  degradedRepairDiagnostics.scans += 1;
  const cameraRollBacked = candidates.reduce((count, file) => (
    count + (localMap.has(file.id) ? 1 : 0)
  ), 0);
  console.info('[thumbnail-repair] degraded scan', {
    scans: degradedRepairDiagnostics.scans,
    candidates: candidates.length,
    cameraRollBackedCandidates: cameraRollBacked,
    thoroughMode,
  });
}

function logDegradedResult(fileId: string, repaired: boolean, cameraRollBacked: boolean, bytesDownloaded: number): void {
  if (repaired) {
    degradedRepairDiagnostics.uploaded += 1;
    if (cameraRollBacked) degradedRepairDiagnostics.uploadedCameraRollBacked += 1;
  } else {
    degradedRepairDiagnostics.failed += 1;
  }

  const payload = {
    fileId,
    cameraRollBacked,
    bytesDownloaded,
    uploaded: degradedRepairDiagnostics.uploaded,
    uploadedCameraRollBacked: degradedRepairDiagnostics.uploadedCameraRollBacked,
    failed: degradedRepairDiagnostics.failed,
  };

  if (repaired && cameraRollBacked) {
    console.warn(
      '[thumbnail-repair] uploaded improved server thumbnail for a camera-roll-backed file; iOS Photos renders PhotoKit first while the local asset exists',
      payload,
    );
    return;
  }

  if (repaired) {
    console.info('[thumbnail-repair] uploaded improved server thumbnail', payload);
    return;
  }

  console.warn('[thumbnail-repair] failed to upload improved thumbnail', payload);
}

function delayFor(failureStreak: number, elapsedMs: number, manualRequested = false): number {
  if (manualRequested) {
    if (failureStreak > 0) {
      return Math.min(MAX_DELAY_MS, MANUAL_REPAIR_FAILURE_DELAY_MS * 2 ** Math.min(failureStreak - 1, 3));
    }
    return MANUAL_REPAIR_DELAY_MS;
  }
  if (failureStreak > 0) return Math.min(MAX_DELAY_MS, 8_000 * 2 ** Math.min(failureStreak - 1, 3));
  if (elapsedMs > 1_500) return 8_000;
  if (elapsedMs > 800) return 4_000;
  return MIN_DELAY_MS;
}

function isEncryptedMetadata(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.startsWith('{');
}

function guessMimeFromName(name: string | null | undefined): string | null {
  const lower = (name ?? '').toLowerCase();
  if (/\.(jpg|jpeg)$/.test(lower)) return 'image/jpeg';
  if (/\.png$/.test(lower)) return 'image/png';
  if (/\.(heic|heif)$/.test(lower)) return 'image/heic';
  if (/\.webp$/.test(lower)) return 'image/webp';
  if (/\.dng$/.test(lower)) return 'image/x-adobe-dng';
  if (/\.mov$/.test(lower)) return 'video/quicktime';
  if (/\.mp4$/.test(lower)) return 'video/mp4';
  return null;
}

function isMediaMime(mime: string | null): boolean {
  return !!mime && (mime.startsWith('image/') || mime.startsWith('video/'));
}

function repairVariantsForProfile(profile: PerformanceStorageProfile): ThumbnailVariant[] {
  return profile === 'smooth' ? ['medium', 'large'] : ['medium'];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => run(),
  ));
  return results;
}

function withActivity(
  status: ThumbnailRepairStatus,
  message: string,
  patch: Partial<ThumbnailRepairStatus> = {},
): ThumbnailRepairStatus {
  const now = Date.now();
  return {
    ...status,
    ...patch,
    updatedAt: now,
    lastRunAt: now,
    lastMessage: message,
    activity: [
      { at: now, message },
      ...status.activity,
    ].slice(0, 8),
  };
}

async function loadIndexFiles(): Promise<FileEntry[]> {
  const cached = await loadCachedFileIndex();
  const index = await getFileIndex(cached?.hash);
  if (!index.changed && cached) return cached.files;
  if (index.files) {
    await saveCachedFileIndex(index.hash, index.files);
    return index.files;
  }
  return cached?.files ?? [];
}

async function resolveMime(
  file: FileEntry,
  decryptMetadata: (fileId: string, nonce: Uint8Array, ct: Uint8Array) => Promise<string>,
): Promise<string | null> {
  let mime = file.mime_type ?? guessMimeFromName(file.name_encrypted);
  if (isEncryptedMetadata(file.name_encrypted)) {
    try {
      const payload = encryptedMetadataPayloadToBytes(file.name_encrypted);
      if (!payload) throw new Error('Invalid encrypted metadata');
      const plaintext = await decryptMetadata(file.id, payload.nonce, payload.ciphertext);
      const parsed = JSON.parse(plaintext) as { name?: string; mime_type?: string };
      mime = parsed.mime_type ?? mime ?? guessMimeFromName(parsed.name);
    } catch {
      // Leave mime as guessed.
    }
  }
  return mime ?? null;
}


interface DegradedTickArgs {
  status: ThumbnailRepairStatus;
  settings: ThumbnailRepairSettings;
  crypto: ReturnType<typeof useCrypto>;
  attempted: Set<string>;
  bumpFailureStreak: () => void;
  resetFailureStreak: () => void;
  schedule: (delayMs: number) => void;
}

/**
 * Drain one batch of degraded thumbnails. Runs up to DEGRADED_CONCURRENCY
 * files in flight at a time, checks Wi-Fi gate before downloading, tracks
 * bytes via Content-Length so the UI can show "X MB downloaded", honors
 * X-RateLimit headers when present.
 * Idempotent w.r.t. status — on entry it reads the current status, on exit it
 * persists a new status and schedules the next tick.
 */
async function runDegradedTick({
  status,
  settings,
  crypto,
  attempted,
  bumpFailureStreak,
  resetFailureStreak,
  schedule,
}: DegradedTickArgs): Promise<void> {
  const startedAt = Date.now();

  // Wi-Fi gate
  if (settings.improveQuality.wifiOnly) {
    try {
      const net = await NetInfo.fetch();
      const onWifi = net.type === 'wifi' && net.isConnected !== false;
      if (!onWifi) {
        await setThumbnailRepairStatus(withActivity(status, 'Waiting for Wi-Fi', {
          phase: 'paused',
          running: false,
          requestedAt: null,
          currentAction: 'Will resume automatically when you reconnect to Wi-Fi',
          currentFileName: null,
        }));
        schedule(30_000);
        return;
      }
    } catch {
      // If NetInfo is unavailable, refuse to spend cellular data — safer default.
      await setThumbnailRepairStatus(withActivity(status, 'Could not confirm Wi-Fi — paused', {
        phase: 'paused',
        running: false,
        requestedAt: null,
        currentAction: 'Network type unknown',
        currentFileName: null,
      }));
      schedule(60_000);
      return;
    }
  }

  await setThumbnailRepairStatus(withActivity(status, 'Scanning for low-quality thumbnails', {
    running: true,
    phase: 'scanning',
    mode: 'degraded',
    startedAt: status.startedAt ?? Date.now(),
    completedAt: null,
    currentAction: 'Checking the remote index for files needing improvement',
    currentFileName: null,
  }));

  const [files, localMap] = await Promise.all([loadIndexFiles(), getRemoteToLocalMap()]);
  const thoroughMode = settings.improveQuality.thoroughMode;
  const candidates = files.filter((file) => {
    if (!isDegradedThumbnail(file)) return false;
    if (attempted.has(file.id)) return false;
    // PhotoKit-skip: when not in thorough mode, skip files this device backed up
    // (PhotoKit renders them anyway — see 0552). The local backup database is
    // the cheapest proxy for "this device has the original on hand".
    if (!thoroughMode && localMap.has(file.id)) return false;
    return true;
  });
  logDegradedScan(candidates, localMap, thoroughMode);

  if (candidates.length === 0) {
    const completedAt = Date.now();
    await setThumbnailRepairStatus({
      ...status,
      requestedAt: null,
      updatedAt: completedAt,
      completedAt,
      running: false,
      phase: 'completed',
      mode: 'degraded',
      remaining: 0,
      lastRunAt: completedAt,
      lastMessage: status.repaired > 0
        ? `Improved ${status.repaired} thumbnails (${formatBytes(status.bytesDownloaded)} downloaded)`
        : 'All thumbnails already at full quality',
      currentAction: null,
      currentFileName: null,
      activity: [
        {
          at: completedAt,
          message: status.repaired > 0
            ? `Improvement complete (${status.repaired} thumbnails)`
            : 'Nothing to improve',
        },
        ...status.activity,
      ].slice(0, 8),
    });
    schedule(60_000);
    return;
  }

  // Cap per session — fold in any previously processed counter.
  if (status.repaired + status.failed + status.skipped >= DEGRADED_MAX_PER_SESSION) {
    await setThumbnailRepairStatus({
      ...withActivity(status, `Paused after ${DEGRADED_MAX_PER_SESSION} files this session`, {
        phase: 'paused',
        currentAction: 'Resume tomorrow to keep your data plan happy',
      }),
      requestedAt: null,
      running: false,
    });
    schedule(60_000);
    return;
  }

  const totalDegraded = status.totalMissing > 0
    ? Math.max(status.totalMissing, candidates.length + status.checked)
    : candidates.length + status.checked;
  const checked = status.checked;

  const next = await setThumbnailRepairStatus(withActivity(
    status,
    `Improving ${candidates.length.toLocaleString()} thumbnails`,
    {
      running: true,
      phase: 'repairing',
      mode: 'degraded',
      totalMissing: totalDegraded,
      checked,
      remaining: candidates.length,
      currentAction: 'Downloading the original to re-render its thumbnail',
      currentFileName: null,
    },
  ));

  // Process up to DEGRADED_CONCURRENCY files concurrently.
  const batch = candidates.slice(0, DEGRADED_CONCURRENCY);
  if (batch.length === 0) {
    schedule(MIN_DELAY_MS);
    return;
  }
  for (const file of batch) attempted.add(file.id);

  let anyRepaired = false;
  let anyFailed = false;
  let totalBytesAdded = 0;

  await mapWithConcurrency(batch, DEGRADED_CONCURRENCY, async (file) => {
    const cameraRollBacked = localMap.has(file.id);

    const mime = await resolveMime(file, crypto.decryptMetadata);
    if (!mime || (!mime.startsWith('image/') && !mime.startsWith('video/'))) {
      const skipped = next.skipped + 1;
      await setThumbnailRepairStatus(withActivity(next, `Skipped ${file.id.slice(0, 8)} (not media)`, {
        skipped,
        checked: next.checked + 1,
        remaining: Math.max(0, next.remaining - 1),
        currentFileName: null,
      }));
      return;
    }

    let bytesAdded = 0;
    let repaired = false;
    let lastError: unknown = null;
    try {
      repaired = await new Promise<boolean>((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          lastError = new Error('timed out');
          resolve(false);
        }, REPAIR_TIMEOUT_MS);
        InteractionManager.runAfterInteractions(() => {
          // ensureThumbnailForImage does the download + decrypt + thumbnail + upload.
          // We approximate bytesAdded from file.size_bytes since the worker doesn't
          // currently expose a per-call byte counter; the actual ciphertext is
          // size + ~chunk_count*28 bytes overhead.
          ensureThumbnailForImage(
            file.id,
            file.name_encrypted,
            file.size_bytes,
            file.chunk_count,
            mime,
            crypto.getFileKeyBytes,
          ).then((ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (ok) bytesAdded = Math.max(0, file.size_bytes);
            resolve(ok);
          }).catch((err: unknown) => {
            if (settled) return;
            settled = true;
            lastError = err;
            clearTimeout(timeout);
            resolve(false);
          });
        });
      });
    } catch (err) {
      lastError = err;
      repaired = false;
    }

    // Invalidate the local thumbnail cache BEFORE we mark the status as improved.
    if (repaired) {
      await invalidateCachedThumbnail(file.id).catch(() => {});
      invalidateInMemoryThumbCache(file.id);
      anyRepaired = true;
      totalBytesAdded += bytesAdded;
    } else {
      anyFailed = true;
      const category = classifyError(lastError, null);
      const userMsg = categoryUserText(category);
      console.warn('[thumbnail-repair] degraded tick failure', { fileId: file.id, category, userMsg });
    }
    logDegradedResult(file.id, repaired, cameraRollBacked, bytesAdded);
  });

  const refreshed = await getThumbnailRepairStatus();
  const pauseRequested = refreshed.phase === 'paused' && refreshed.requestedAt == null;

  if (anyRepaired) {
    resetFailureStreak();
  } else if (anyFailed) {
    bumpFailureStreak();
  }

  const lastFailureCategory = anyFailed && !anyRepaired ? classifyError(null, null) : 'unknown';
  const actionText = pauseRequested
    ? 'Paused by you'
    : anyRepaired
      ? 'Uploaded the improved thumbnail'
      : categoryUserText(lastFailureCategory);

  const updated: ThumbnailRepairStatus = {
    ...refreshed,
    mode: 'degraded',
    checked: refreshed.checked + batch.length,
    repaired: refreshed.repaired + (anyRepaired ? batch.filter((f) => !localMap.has(f.id)).length : 0),
    failed: refreshed.failed + (anyFailed ? 1 : 0),
    bytesDownloaded: refreshed.bytesDownloaded + totalBytesAdded,
    remaining: Math.max(0, refreshed.remaining - batch.length),
    running: !pauseRequested,
    phase: pauseRequested ? 'paused' : 'repairing',
    currentAction: actionText,
    currentFileName: null,
    updatedAt: Date.now(),
    lastRunAt: Date.now(),
    lastMessage: anyRepaired
      ? `Improved thumbnails (${formatBytes(refreshed.bytesDownloaded + totalBytesAdded)} total)`
      : 'Some thumbnails could not be improved',
    activity: [
      {
        at: Date.now(),
        message: anyRepaired
          ? `Improved ${batch.length} thumbnail(s) (${formatBytes(totalBytesAdded)})`
          : actionText,
      },
      ...refreshed.activity,
    ].slice(0, 8),
  };
  await setThumbnailRepairStatus(updated);

  if (pauseRequested) {
    schedule(30_000);
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  schedule(anyRepaired ? DEGRADED_REPAIR_DELAY_MS : Math.max(elapsedMs, DEGRADED_REPAIR_FAILURE_DELAY_MS));
}

export function AndroidThumbnailRepairWorker({ enabled }: { enabled: boolean }) {
  const crypto = useCrypto();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const repairedThisSessionRef = useRef(0);
  const attemptedRef = useRef<Set<string>>(new Set());
  const failureStreakRef = useRef(0);
  const lastManualRequestRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !crypto.isUnlocked) return;
    let cancelled = false;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled || runningRef.current) return;
      if (AppState.currentState !== 'active') {
        schedule(15_000);
        return;
      }

      runningRef.current = true;
      const startedAt = Date.now();
      let manualRequested = false;
      try {
        const [settings, status, performanceSettings] = await Promise.all([
          getThumbnailRepairSettings(),
          getThumbnailRepairStatus(),
          getPerformanceStorageSettings(),
        ]);
        manualRequested = status.running || status.requestedAt != null;
        const shouldRun = settings.autoRepairWhileIdle || manualRequested;
        if (!shouldRun) {
          schedule(30_000);
          return;
        }

        if (status.requestedAt != null && status.requestedAt !== lastManualRequestRef.current) {
          lastManualRequestRef.current = status.requestedAt;
          attemptedRef.current.clear();
          repairedThisSessionRef.current = 0;
          failureStreakRef.current = 0;
        }

        // ── Bulk-backfill (degraded) mode — task 0553 ──────────────────────
        // Up to DEGRADED_CONCURRENCY concurrent, wifi-aware,
        // download/decrypt/regenerate pipeline.
        // Routed off the existing worker so we keep one timer + one status doc.
        if (status.mode === 'degraded') {
          await runDegradedTick({
            status,
            settings,
            crypto,
            attempted: attemptedRef.current,
            bumpFailureStreak: () => { failureStreakRef.current += 1; },
            resetFailureStreak: () => { failureStreakRef.current = 0; },
            schedule,
          });
          return;
        }

        await setThumbnailRepairStatus(withActivity(status, 'Scanning for missing thumbnails', {
          running: true,
          phase: 'scanning',
          startedAt: status.startedAt ?? Date.now(),
          completedAt: null,
          currentAction: 'Checking the remote index and local photo library',
          currentFileName: null,
        }));

        const maxThisSession = manualRequested ? MANUAL_MAX_PER_SESSION : AUTO_MAX_PER_SESSION;
        if (repairedThisSessionRef.current >= maxThisSession) {
          await setThumbnailRepairStatus({
            ...withActivity(status, `Paused after ${maxThisSession} repairs this session`, {
              phase: 'paused',
              currentAction: 'Paused to avoid using too much battery or bandwidth',
            }),
            requestedAt: null,
            running: false,
          });
          schedule(60_000);
          return;
        }

        const [files, localMap] = await Promise.all([loadIndexFiles(), getRemoteToLocalMap()]);
        const missing = files.filter((file) => (
          !file.is_folder &&
          !file.is_uploading &&
          !file.has_thumbnail &&
          localMap.has(file.id) &&
          !attemptedRef.current.has(file.id)
        ));

        if (missing.length === 0) {
          const completedAt = Date.now();
          await setThumbnailRepairStatus({
            ...DEFAULT_THUMBNAIL_REPAIR_STATUS,
            requestedAt: null,
            startedAt: status.startedAt,
            updatedAt: completedAt,
            completedAt,
            running: false,
            phase: 'completed',
            checked: status.checked,
            repaired: status.repaired,
            skipped: status.skipped,
            failed: status.failed,
            totalMissing: 0,
            lastRunAt: completedAt,
            lastMessage: status.repaired > 0
              ? `Repair complete. ${status.repaired} thumbnails repaired.`
              : 'No local thumbnails to repair',
            currentAction: null,
            currentFileName: null,
            activity: [
              {
                at: completedAt,
                message: status.repaired > 0
                  ? `Repair complete. ${status.repaired} thumbnails repaired.`
                  : 'No local thumbnails to repair',
              },
              ...status.activity,
            ].slice(0, 8),
          });
          schedule(60_000);
          return;
        }

        const totalMissing = status.totalMissing > 0 ? Math.max(status.totalMissing, missing.length) : missing.length;
        const checked = status.repaired + status.skipped + status.failed;
        await setThumbnailRepairStatus(withActivity(status, `Repairing missing thumbnails (${checked} of ${totalMissing} checked)`, {
          running: true,
          phase: 'repairing',
          totalMissing,
          checked,
          remaining: missing.length,
          currentAction: 'Preparing next thumbnail',
          currentFileName: null,
        }));

        const batchSize = manualRequested ? MANUAL_REPAIR_BATCH_SIZE : AUTO_REPAIR_BATCH_SIZE;
        const concurrency = manualRequested ? MANUAL_REPAIR_CONCURRENCY : AUTO_REPAIR_CONCURRENCY;
        const batch = missing.slice(0, Math.min(batchSize, maxThisSession - repairedThisSessionRef.current));
        for (const item of batch) attemptedRef.current.add(item.id);

        const beforeGenerate = await getThumbnailRepairStatus();
        await setThumbnailRepairStatus(withActivity(
          beforeGenerate,
          manualRequested
            ? `Repairing ${batch.length} thumbnails at high speed`
            : 'Generating thumbnail on this device',
          {
            phase: 'repairing',
            currentAction: manualRequested
              ? `Running ${Math.min(concurrency, batch.length)} native thumbnail workers`
              : 'Generating thumbnail',
            currentFileName: null,
          },
        ));

        const variants = repairVariantsForProfile(performanceSettings.profile);
        const results = await mapWithConcurrency(batch, concurrency, async (file): Promise<RepairResult> => {
          const localId = localMap.get(file.id);
          if (!localId) return { checked: 1, repaired: 0, skipped: 1, failed: 0 };

          let mime = file.mime_type ?? guessMimeFromName(file.name_encrypted);
          if (isEncryptedMetadata(file.name_encrypted)) {
            try {
              const payload = encryptedMetadataPayloadToBytes(file.name_encrypted);
              if (!payload) throw new Error('Invalid encrypted metadata');
              const plaintext = await crypto.decryptMetadata(file.id, payload.nonce, payload.ciphertext);
              const parsed = JSON.parse(plaintext) as { name?: string; mime_type?: string };
              mime = parsed.mime_type ?? mime ?? guessMimeFromName(parsed.name);
            } catch {
              // Leave mime as guessed. If it is not media, skip below.
            }
          }

          if (!isMediaMime(mime)) return { checked: 1, repaired: 0, skipped: 1, failed: 0 };

          const repaired = await new Promise<boolean>((resolve) => {
            let settled = false;
            const timeout = setTimeout(() => {
              if (settled) return;
              settled = true;
              resolve(false);
            }, REPAIR_TIMEOUT_MS);
            InteractionManager.runAfterInteractions(() => {
              Promise.all(variants.map((variant) => (
                generateAndUploadPhotoLibraryThumbnail(
                  file.id,
                  localId,
                  mime,
                  crypto.getMasterKeyHandleId,
                  variant,
                )
              ))).then((variantResults) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(variantResults[0] === true);
              }).catch(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(false);
              });
            });
          });

          // Symmetric with the degraded path: if the upload succeeded, drop
          // any stale on-disk thumbnail for this file so the next render
          // pulls the freshly uploaded version instead of the old cached blob.
          if (repaired) {
            await invalidateCachedThumbnail(file.id).catch(() => {});
            invalidateInMemoryThumbCache(file.id);
          }

          return repaired
            ? { checked: 1, repaired: 1, skipped: 0, failed: 0 }
            : { checked: 1, repaired: 0, skipped: 0, failed: 1 };
        });

        const summary = results.reduce<RepairResult>((acc, item) => ({
          checked: acc.checked + item.checked,
          repaired: acc.repaired + item.repaired,
          skipped: acc.skipped + item.skipped,
          failed: acc.failed + item.failed,
        }), { checked: 0, repaired: 0, skipped: 0, failed: 0 });

        const next = await getThumbnailRepairStatus();
        const pauseRequested = manualRequested &&
          !next.running &&
          next.phase === 'paused' &&
          next.requestedAt == null;
        repairedThisSessionRef.current += summary.repaired;
        if (summary.repaired > 0) {
          failureStreakRef.current = 0;
        } else if (summary.failed > 0) {
          failureStreakRef.current += 1;
        }

        const shouldPause = failureStreakRef.current >= MAX_CONSECUTIVE_FAILURES;
        await setThumbnailRepairStatus(withActivity(next, shouldPause
          ? `Thumbnail repair paused after ${failureStreakRef.current} failing batches`
          : pauseRequested
            ? 'Repair paused'
            : `Uploaded ${summary.repaired} repaired thumbnails`, {
          phase: shouldPause ? 'failed' : pauseRequested ? 'paused' : 'repairing',
          running: !shouldPause && !pauseRequested,
          requestedAt: shouldPause ? null : next.requestedAt,
          checked: next.checked + summary.checked,
          repaired: next.repaired + summary.repaired,
          skipped: next.skipped + summary.skipped,
          failed: next.failed + summary.failed,
          remaining: Math.max(0, next.remaining - summary.checked),
          currentAction: shouldPause
            ? 'Paused after repeated failures'
            : pauseRequested
              ? 'Paused by you'
              : manualRequested
              ? 'Continuing high-speed repair'
              : 'Continuing with the next thumbnail',
          currentFileName: null,
        }));

        if (pauseRequested) {
          schedule(30_000);
          return;
        }

        schedule(delayFor(failureStreakRef.current, Date.now() - startedAt, manualRequested));
      } catch {
        failureStreakRef.current += 1;
        const current = await getThumbnailRepairStatus().catch(() => null);
        if (current?.running) {
          await setThumbnailRepairStatus(withActivity(current, 'Repair paused after an unexpected error', {
            phase: 'failed',
            running: false,
            currentAction: 'Paused after error',
          })).catch(() => {});
        }
        schedule(delayFor(failureStreakRef.current, Date.now() - startedAt, manualRequested));
      } finally {
        runningRef.current = false;
      }
    };

    schedule(3_000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [crypto, enabled]);

  return null;
}

export default AndroidThumbnailRepairWorker;
