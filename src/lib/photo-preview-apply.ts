import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadPhotoPreviewNative } from '../../modules/beebeeb-crypto';
import { accountEpoch, isCurrentAccountEpoch } from './account-epoch';
import { deleteAllPhotoPreviews, getApiUrl, getToken, type FileEntry } from './api';
import { getExpectedUserId } from './expected-user';
import { clearPreviewCache, dropCachedPreview } from './photo-preview-cache';
import type { PhotoPreviewSetting } from './photo-preview-settings';
import { sharedMasterHandleId } from './shared-folder-keys';

/**
 * Apply / Rebuild / Off for the photo preview tier. Apply creates previews in the
 * current setting for photos whose original is on this phone, resumably. A new
 * preview replaces the old one in a single PUT, so a photo is never without a
 * preview while it is being redone. The files index learns about every change
 * through the server's `file_update` sync ops (and the runner's refresh after a run).
 */

type PlanFile = Pick<FileEntry, 'id' | 'has_preview' | 'preview_format' | 'preview_px' | 'mime_type'>;

export interface ApplyPlan {
  toCreate: string[];
  skippedNotOnPhone: number;
}

export interface ApplyOptions {
  concurrency: number;
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
  /** The setting to generate. Required; also keys the saved resume state. */
  setting: PhotoPreviewSetting;
  /** file id -> PhotoKit local identifier. */
  localIds: Map<string, string>;
  /** Rebuild: start from the plan, never from a saved remainder. */
  discardSaved?: boolean;
  /** Test hook for the resume-state write throttle. */
  now?: () => number;
}

export interface ApplyResult {
  done: number;
  failed: number;
  /** The vault locked during the run: the rest is saved for later, not failed. */
  stoppedLocked?: boolean;
}

const MAX_APPLY_CONCURRENCY = 2;
const KEY_PREFIX = 'beebeeb.preview-apply.v1.';
/** The resume state is written every this many files, or this often, and on stop. */
export const PERSIST_EVERY_FILES = 25;
export const PERSIST_EVERY_MS = 5_000;

interface SavedRun {
  format: string;
  px: number;
  remaining: string[];
}

export function planApply(
  files: PlanFile[],
  setting: Pick<PhotoPreviewSetting, 'format' | 'px'>,
  localIds: Map<string, string>,
  opts: { force?: boolean } = {},
): ApplyPlan {
  const toCreate: string[] = [];
  let skippedNotOnPhone = 0;
  for (const f of files) {
    if (!f.mime_type || !f.mime_type.toLowerCase().startsWith('image/')) continue;
    if (!opts.force && f.has_preview && f.preview_format === setting.format && f.preview_px === setting.px) continue;
    if (!localIds.get(f.id)) {
      skippedNotOnPhone += 1;
      continue;
    }
    toCreate.push(f.id);
  }
  return { toCreate, skippedNotOnPhone };
}

function storageKey(accountId: string): string {
  return `${KEY_PREFIX}${accountId}`;
}

async function loadSaved(key: string): Promise<SavedRun | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && typeof v.format === 'string' && typeof v.px === 'number' && Array.isArray(v.remaining)) {
      return { format: v.format, px: v.px, remaining: v.remaining.filter((x: unknown) => typeof x === 'string') };
    }
  } catch { /* unreadable state counts as none */ }
  return null;
}

async function save(key: string, run: SavedRun | null): Promise<void> {
  try {
    if (run && run.remaining.length > 0) await AsyncStorage.setItem(key, JSON.stringify(run));
    else await AsyncStorage.removeItem(key);
  } catch { /* progress is best effort; the run itself continues */ }
}

/** The saved remainder of this account's interrupted run, if any. */
export async function savedApplyRun(): Promise<SavedRun | null> {
  const accountId = accountEpoch().accountId;
  if (!accountId) return null;
  const saved = await loadSaved(storageKey(accountId));
  return saved && saved.remaining.length > 0 ? saved : null;
}

/** Forget this account's saved remainder (the user stopped the run). */
export async function clearSavedApplyRun(): Promise<void> {
  const accountId = accountEpoch().accountId;
  if (accountId) await save(storageKey(accountId), null);
}

function vaultUnlocked(): boolean {
  try {
    sharedMasterHandleId();
    return true;
  } catch {
    return false;
  }
}

/**
 * Create previews for the planned files, at most 2 at a time. Remaining ids are saved
 * (every 25 files or 5 s, and when the run stops) so an aborted or killed run
 * continues on the next call with the same setting. A failed file is counted and
 * skipped; it never stops the run. Refuses to run without a known account.
 */
export async function runApply(plan: ApplyPlan, opts: ApplyOptions): Promise<ApplyResult> {
  const concurrency = Math.max(1, Math.min(MAX_APPLY_CONCURRENCY, opts.concurrency));
  const now = opts.now ?? Date.now;
  const epoch = accountEpoch();
  if (!epoch.accountId) throw new Error('No signed-in account');
  const key = storageKey(epoch.accountId);
  const { format, px } = opts.setting;

  const saved = opts.discardSaved ? null : await loadSaved(key);
  const queue = saved && saved.format === format && saved.px === px ? [...saved.remaining] : [...plan.toCreate];
  const total = queue.length;
  let done = 0;
  let failed = 0;
  let stoppedLocked = false;
  const inFlight = new Set<string>();
  let sinceSave = 0;
  let savedAt = now();

  // Never write after a sign-out or account switch: the remainder belongs to the old account.
  const persist = async () => {
    if (!isCurrentAccountEpoch(epoch)) return;
    sinceSave = 0;
    savedAt = now();
    await save(key, { format, px, remaining: [...inFlight, ...queue] });
  };
  await persist();
  opts.onProgress(0, total);

  const worker = async () => {
    while (!opts.signal.aborted && isCurrentAccountEpoch(epoch) && !stoppedLocked) {
      if (!vaultUnlocked()) {
        stoppedLocked = true;
        return;
      }
      const fileId = queue.shift();
      if (fileId === undefined) return;
      inFlight.add(fileId);
      const localId = opts.localIds.get(fileId);
      try {
        if (!localId) throw new Error('not on this phone');
        await uploadPhotoPreviewNative(
          sharedMasterHandleId(), getApiUrl(), (await getToken()) ?? '', fileId, localId, null, format, px,
          getExpectedUserId() ?? epoch.accountId,
        );
        done += 1;
        // This device replaced the stored preview: a cached copy is out of date.
        await dropCachedPreview(fileId).catch(() => {});
      } catch (err) {
        if (opts.signal.aborted || !vaultUnlocked()) {
          // Interrupted, not failed: keep it for the next run.
          queue.unshift(fileId);
          if (!opts.signal.aborted) stoppedLocked = true;
        } else {
          failed += 1;
          console.warn('[photo-preview-apply] preview failed', err);
        }
      } finally {
        inFlight.delete(fileId);
      }
      sinceSave += 1;
      if (sinceSave >= PERSIST_EVERY_FILES || now() - savedAt >= PERSIST_EVERY_MS) await persist();
      opts.onProgress(done + failed, total);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  // Finished, aborted or stopped: the remainder (empty when finished) is saved now.
  await persist();
  return stoppedLocked ? { done, failed, stoppedLocked } : { done, failed };
}

/**
 * Turn off: the server removes every stored preview of the account in one call
 * (`DELETE /files/previews`), then the local preview cache is emptied. Returns how
 * many the server removed; throws when the server could not be asked.
 */
export async function turnOffPreviews(): Promise<number> {
  const removed = await deleteAllPhotoPreviews();
  await clearPreviewCache().catch(() => {});
  return removed;
}

/**
 * Rebuild: regenerate the preview of every image whose original is on this phone, even
 * when it already matches the setting. A saved remainder of an earlier run is
 * discarded. Each upload replaces the stored preview in one request, so no photo is
 * left without a preview in between.
 */
export async function rebuildPreviews(
  files: PlanFile[],
  opts: ApplyOptions,
): Promise<ApplyResult & { skippedNotOnPhone: number }> {
  const plan = planApply(files, opts.setting, opts.localIds, { force: true });
  const result = await runApply(plan, { ...opts, discardSaved: true });
  return { ...result, skippedNotOnPhone: plan.skippedNotOnPhone };
}
