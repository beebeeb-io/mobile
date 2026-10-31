import { accountEpoch, isCurrentAccountEpoch, onAccountEpochAdvance } from './account-epoch';
import { serverSupportsPhotoPreviews, type FileEntry } from './api';
import {
  clearSavedApplyRun,
  rebuildPreviews,
  runApply,
  savedApplyRun,
  type ApplyOptions,
  type ApplyPlan,
  type ApplyResult,
} from './photo-preview-apply';
import { loadPhotoPreviewSettingStrict, type PhotoPreviewSetting } from './photo-preview-settings';
import {
  knownPhotoPreviewSetting,
  onPhotoPreviewSettingChange,
  syncPhotoPreviewSettingToNative,
} from './photo-preview-sync';
import { onVaultKeysReady, sharedMasterHandleId } from './shared-folder-keys';

/**
 * App-level runner for Apply / Rebuild. A run is owned by this module, not by the
 * settings screen: leaving the screen does not stop it. The screen subscribes to
 * progress and can stop it. On launch, unlock and foreground an interrupted run of
 * this account continues by itself while previews are still enabled. A sign-out or
 * account switch aborts it.
 */

export type PhotoPreviewRunKind = 'apply' | 'rebuild';

export interface PhotoPreviewRunProgress {
  kind: PhotoPreviewRunKind;
  done: number;
  total: number;
}

export interface PhotoPreviewRunOutcome extends ApplyResult {
  kind: PhotoPreviewRunKind;
  aborted: boolean;
  /** Stopped with the Stop button: the remainder is dropped, nothing resumes it. */
  stoppedByUser?: boolean;
  /** Stopped because the setting changed (Off, or another format/size), here or on another device. */
  stoppedBySettingChange?: boolean;
  /** The run threw before or while making previews. */
  error?: boolean;
  /** Started by the app (resume), not by a button. */
  resumed: boolean;
}

export type PhotoPreviewRunEvent =
  | { type: 'progress'; progress: PhotoPreviewRunProgress }
  | { type: 'finished'; outcome: PhotoPreviewRunOutcome };

type PlanFile = Pick<FileEntry, 'id' | 'has_preview' | 'preview_format' | 'preview_px' | 'mime_type'>;

export type PhotoPreviewRunRequest =
  | {
    kind: 'apply';
    plan: ApplyPlan;
    setting: PhotoPreviewSetting;
    localIds: Map<string, string>;
    /** A pressed Apply runs its fresh plan; only a resume continues the saved remainder. */
    discardSaved?: boolean;
  }
  | { kind: 'rebuild'; files: PlanFile[]; setting: PhotoPreviewSetting; localIds: Map<string, string> };

interface RunnerDeps {
  runApply: typeof runApply;
  rebuildPreviews: typeof rebuildPreviews;
  savedApplyRun: typeof savedApplyRun;
  clearSaved: typeof clearSavedApplyRun;
  loadSetting: () => Promise<PhotoPreviewSetting>;
  serverSupported: () => Promise<boolean>;
  syncSetting: (accountId?: string | null) => Promise<void>;
  /** The setting last read or mirrored this session (no request), or null. */
  knownSetting: () => PhotoPreviewSetting | null;
  localIds: () => Promise<Map<string, string>>;
  /** Re-read the files index from the server so every screen sees the new previews. */
  refreshIndex: () => Promise<void>;
  vaultUnlocked: () => boolean;
  now: () => number;
}

const defaultDeps: RunnerDeps = {
  runApply,
  rebuildPreviews,
  savedApplyRun,
  clearSaved: clearSavedApplyRun,
  loadSetting: loadPhotoPreviewSettingStrict,
  serverSupported: serverSupportsPhotoPreviews,
  syncSetting: syncPhotoPreviewSettingToNative,
  knownSetting: knownPhotoPreviewSetting,
  // Loaded lazily: both pull in native storage this module should not load early.
  localIds: async () => (await import('../services/BackupDatabase')).getRemoteToLocalMap(),
  refreshIndex: async () => {
    await (await import('./file-index-loader')).loadFileIndex({ force: true });
  },
  vaultUnlocked: () => {
    try {
      sharedMasterHandleId();
      return true;
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
};

let deps: RunnerDeps = defaultDeps;
interface CurrentRun {
  controller: AbortController;
  progress: PhotoPreviewRunProgress;
  setting: PhotoPreviewSetting;
  stoppedByUser: boolean;
  stoppedBySettingChange: boolean;
}
let current: CurrentRun | null = null;
let resuming = false;
let lastActiveAt = -Infinity;
const listeners = new Set<(event: PhotoPreviewRunEvent) => void>();

/** Foreground re-sync of the setting is throttled to once per this window. */
export const APP_ACTIVE_THROTTLE_MS = 60_000;

function emit(event: PhotoPreviewRunEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A listener never breaks the run.
    }
  }
}

/** The run in progress, or null. */
export function photoPreviewRunProgress(): PhotoPreviewRunProgress | null {
  return current ? { ...current.progress } : null;
}

export function onPhotoPreviewRun(listener: (event: PhotoPreviewRunEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Stop the run in progress (the Stop button, or Turn off). The remainder is dropped,
 * so nothing resumes it; Apply plans again from the files that still need a preview.
 */
export function stopPhotoPreviewRun(): void {
  if (!current) return;
  current.stoppedByUser = true;
  current.controller.abort();
}

async function execute(request: PhotoPreviewRunRequest, resumed: boolean): Promise<PhotoPreviewRunOutcome> {
  const controller = new AbortController();
  const epoch = accountEpoch();
  const initialTotal = request.kind === 'apply' ? request.plan.toCreate.length : request.files.length;
  const run: CurrentRun = {
    controller,
    progress: { kind: request.kind, done: 0, total: initialTotal },
    setting: { ...request.setting },
    stoppedByUser: false,
    stoppedBySettingChange: false,
  };
  current = run;
  emit({ type: 'progress', progress: { ...current.progress } });
  const opts: ApplyOptions = {
    concurrency: 2,
    signal: controller.signal,
    setting: request.setting,
    localIds: request.localIds,
    discardSaved: request.kind === 'apply' ? request.discardSaved === true : undefined,
    onProgress: (done, total) => {
      if (!current || current.controller !== controller) return;
      current.progress = { kind: request.kind, done, total };
      emit({ type: 'progress', progress: { ...current.progress } });
    },
  };
  let outcome: PhotoPreviewRunOutcome;
  try {
    const result = request.kind === 'apply'
      ? await deps.runApply(request.plan, opts)
      : await deps.rebuildPreviews(request.files, opts);
    outcome = {
      kind: request.kind,
      done: result.done,
      failed: result.failed,
      ...(result.stoppedLocked ? { stoppedLocked: true } : {}),
      ...(result.quotaExceeded ? { quotaExceeded: true } : {}),
      aborted: controller.signal.aborted,
      resumed,
    };
  } catch {
    outcome = { kind: request.kind, done: 0, failed: 0, aborted: controller.signal.aborted, error: true, resumed };
  } finally {
    if (current?.controller === controller) current = null;
  }
  if ((run.stoppedByUser || run.stoppedBySettingChange) && isCurrentAccountEpoch(epoch)) {
    if (run.stoppedBySettingChange) outcome.stoppedBySettingChange = true;
    else outcome.stoppedByUser = true;
    // Nothing should continue a run for a setting that is no longer wanted.
    await deps.clearSaved().catch(() => {});
  }
  // Every screen should see the new previews (and the right counts) right away.
  if (outcome.done > 0 && isCurrentAccountEpoch(epoch)) await deps.refreshIndex().catch(() => {});
  if (isCurrentAccountEpoch(epoch)) emit({ type: 'finished', outcome });
  return outcome;
}

/**
 * Start Apply or Rebuild. False when a run is already going (it keeps going).
 * Resolves with the outcome once the run ends.
 */
export function startPhotoPreviewRun(request: PhotoPreviewRunRequest): Promise<PhotoPreviewRunOutcome> | null {
  if (current) return null;
  return execute(request, false);
}

/**
 * Continue this account's interrupted run when previews are still enabled at the
 * same setting, the server supports them and the vault is unlocked. Never throws.
 */
export async function resumePhotoPreviewRun(): Promise<boolean> {
  if (current || resuming) return false;
  resuming = true;
  try {
    const epoch = accountEpoch();
    if (!epoch.accountId || !deps.vaultUnlocked()) return false;
    const saved = await deps.savedApplyRun();
    if (!saved) return false;
    if (!(await deps.serverSupported())) return false;
    const setting = await deps.loadSetting();
    if (!setting.enabled || setting.format !== saved.format || setting.px !== saved.px) return false;
    const localIds = await deps.localIds();
    if (!isCurrentAccountEpoch(epoch) || current) return false;
    // The setting may have changed while the ids loaded (Off here, or a sync op).
    const latest = deps.knownSetting();
    if (latest && settingDiffers(latest, setting)) return false;
    // An empty plan: runApply picks up the saved remainder for this setting.
    void execute({ kind: 'apply', plan: { toCreate: [], skippedNotOnPhone: 0 }, setting, localIds }, true);
    return true;
  } catch {
    return false;
  } finally {
    resuming = false;
  }
}

/**
 * Launch, unlock and foreground: mirror the account setting natively (throttled
 * unless `force`) and resume an interrupted run. Never throws.
 */
export async function photoPreviewAppActive(options: { accountId?: string | null; force?: boolean } = {}): Promise<void> {
  const now = deps.now();
  if (!options.force && now - lastActiveAt < APP_ACTIVE_THROTTLE_MS) return;
  lastActiveAt = now;
  await deps.syncSetting(options.accountId).catch(() => {});
  await resumePhotoPreviewRun();
}

function settingDiffers(next: PhotoPreviewSetting, run: PhotoPreviewSetting): boolean {
  return !next.enabled || next.format !== run.format || next.px !== run.px;
}

// Off, or another format/size (on this device or, via a preference_update sync op,
// on another one): a run for the old setting must not keep uploading.
onPhotoPreviewSettingChange((next) => {
  if (!current || !settingDiffers(next, current.setting)) return;
  current.stoppedBySettingChange = true;
  current.controller.abort();
});

// Sign-out or account switch: the run belongs to the old account.
onAccountEpochAdvance(() => {
  current?.controller.abort();
  lastActiveAt = -Infinity;
});

// Every unlock: the key is usable now, so an interrupted run can continue.
onVaultKeysReady(() => {
  void resumePhotoPreviewRun();
});

/** Test hook. */
export function __setPhotoPreviewRunnerDepsForTests(overrides: Partial<RunnerDeps>): void {
  deps = { ...defaultDeps, ...overrides };
  current = null;
  resuming = false;
  lastActiveAt = -Infinity;
  listeners.clear();
}
