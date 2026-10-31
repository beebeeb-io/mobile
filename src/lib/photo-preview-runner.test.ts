// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let vaultReady: (() => void) | null = null;
mock.module('./api', () => ({ serverSupportsPhotoPreviews: async () => true }));
mock.module('./photo-preview-apply', () => ({
  runApply: async () => ({ done: 0, failed: 0 }),
  rebuildPreviews: async () => ({ done: 0, failed: 0, skippedNotOnPhone: 0 }),
  savedApplyRun: async () => null,
  clearSavedApplyRun: async () => {},
}));
mock.module('./photo-preview-settings', () => ({ loadPhotoPreviewSettingStrict: async () => ({ enabled: false }) }));
let settingListener: ((s: any) => void) | null = null;
mock.module('./photo-preview-sync', () => ({
  syncPhotoPreviewSettingToNative: async () => {},
  knownPhotoPreviewSetting: () => null,
  onPhotoPreviewSettingChange: (l: (s: any) => void) => { settingListener = l; return () => {}; },
}));
mock.module('./shared-folder-keys', () => ({
  onVaultKeysReady: (l: () => void) => { vaultReady = l; return () => {}; },
  sharedMasterHandleId: () => 7,
}));

const { setExpectedUserId } = await import('./expected-user');
const { advanceAccountEpoch } = await import('./account-epoch');
const runner = await import('./photo-preview-runner');

const setting = { enabled: true, format: 'heic', px: 2560 };
const tick = () => new Promise((r) => setTimeout(r, 0));

let calls: any;
let saved: any;
let unlocked: boolean;
let settingNow: any;
let clock: number;
let release: (() => void) | null;
let events: any[];
let known: any;

function deps(over = {}) {
  return {
    runApply: async (plan: any, opts: any) => {
      calls.run.push({ plan, opts });
      opts.onProgress(0, 3);
      await new Promise<void>((r) => { release = r; });
      opts.onProgress(3, 3);
      return opts.signal.aborted ? { done: 1, failed: 0 } : { done: 3, failed: 0 };
    },
    rebuildPreviews: async (files: any) => { calls.rebuild.push(files); return { done: files.length, failed: 0, skippedNotOnPhone: 0 }; },
    savedApplyRun: async () => saved,
    clearSaved: async () => { calls.cleared += 1; },
    loadSetting: async () => settingNow,
    serverSupported: async () => true,
    syncSetting: async (id: any) => { calls.sync.push(id); },
    knownSetting: () => known,
    localIds: async () => new Map([['f1', 'L1']]),
    refreshIndex: async () => { calls.refresh += 1; },
    vaultUnlocked: () => unlocked,
    now: () => clock,
    ...over,
  };
}

beforeEach(() => {
  calls = { run: [], rebuild: [], sync: [], refresh: 0, cleared: 0 };
  saved = { format: 'heic', px: 2560, remaining: ['f1'] };
  unlocked = true;
  settingNow = { ...setting };
  clock = 1_000_000;
  release = null;
  events = [];
  known = null;
  setExpectedUserId('acct-1');
  runner.__setPhotoPreviewRunnerDepsForTests(deps());
  runner.onPhotoPreviewRun((e) => events.push(e));
});

describe('photo preview runner', () => {
  test('a run outlives its starter, reports progress, refreshes the index when done', async () => {
    const done = runner.startPhotoPreviewRun({ kind: 'apply', plan: { toCreate: ['a', 'b', 'c'], skippedNotOnPhone: 0 }, setting, localIds: new Map() });
    await tick();
    expect(runner.photoPreviewRunProgress()).toEqual({ kind: 'apply', done: 0, total: 3 });
    // A second start while running is refused.
    expect(runner.startPhotoPreviewRun({ kind: 'apply', plan: { toCreate: [], skippedNotOnPhone: 0 }, setting, localIds: new Map() })).toBeNull();
    release!();
    const outcome = await done;
    expect(outcome).toMatchObject({ kind: 'apply', done: 3, failed: 0, aborted: false, resumed: false });
    expect(calls.refresh).toBe(1);
    expect(runner.photoPreviewRunProgress()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'finished', outcome });
  });

  test('Stop aborts the run and drops the remainder so nothing resumes it', async () => {
    const done = runner.startPhotoPreviewRun({ kind: 'apply', plan: { toCreate: ['a'], skippedNotOnPhone: 0 }, setting, localIds: new Map() });
    await tick();
    runner.stopPhotoPreviewRun();
    release!();
    const outcome = await done;
    expect(outcome.aborted).toBe(true);
    expect(outcome.stoppedByUser).toBe(true);
    expect(calls.cleared).toBe(1);
  });

  test('sign-out aborts the run and no finished event reaches the next account', async () => {
    const done = runner.startPhotoPreviewRun({ kind: 'apply', plan: { toCreate: ['a'], skippedNotOnPhone: 0 }, setting, localIds: new Map() });
    await tick();
    advanceAccountEpoch();
    release!();
    expect((await done).aborted).toBe(true);
    expect(events.some((e) => e.type === 'finished')).toBe(false);
    expect(calls.refresh).toBe(0);
    expect(calls.cleared).toBe(0);
  });

  test('resume continues the saved remainder while enabled at the same setting', async () => {
    expect(await runner.resumePhotoPreviewRun()).toBe(true);
    await tick();
    expect(calls.run).toHaveLength(1);
    expect(calls.run[0].plan.toCreate).toEqual([]);
    expect(calls.run[0].opts.setting).toEqual(setting);
    release!();
  });

  test('no resume: nothing saved, previews off, other setting, locked, or no account', async () => {
    saved = null;
    expect(await runner.resumePhotoPreviewRun()).toBe(false);
    saved = { format: 'heic', px: 2560, remaining: ['f1'] };
    settingNow = { ...setting, enabled: false };
    expect(await runner.resumePhotoPreviewRun()).toBe(false);
    settingNow = { ...setting, px: 3840 };
    expect(await runner.resumePhotoPreviewRun()).toBe(false);
    settingNow = { ...setting };
    unlocked = false;
    expect(await runner.resumePhotoPreviewRun()).toBe(false);
    unlocked = true;
    setExpectedUserId(null);
    expect(await runner.resumePhotoPreviewRun()).toBe(false);
    expect(calls.run).toHaveLength(0);
  });

  test('unlock triggers a resume', async () => {
    expect(vaultReady).not.toBeNull();
    vaultReady!();
    await tick(); await tick();
    expect(calls.run).toHaveLength(1);
    release!();
  });

  test('app active re-syncs the setting, throttled unless forced', async () => {
    saved = null;
    await runner.photoPreviewAppActive({ accountId: 'acct-1', force: true });
    await runner.photoPreviewAppActive();
    clock += runner.APP_ACTIVE_THROTTLE_MS - 1;
    await runner.photoPreviewAppActive();
    expect(calls.sync).toEqual(['acct-1']);
    clock += 1;
    await runner.photoPreviewAppActive();
    expect(calls.sync).toEqual(['acct-1', undefined]);
  });

  test('rebuild goes through rebuildPreviews', async () => {
    const outcome = await runner.startPhotoPreviewRun({ kind: 'rebuild', files: [{ id: 'f1' }], setting, localIds: new Map() });
    expect(calls.rebuild).toHaveLength(1);
    expect(outcome.kind).toBe('rebuild');
  });

  test('a setting change to Off (e.g. a preference_update from another device) aborts the run and drops the remainder', async () => {
    const done = runner.startPhotoPreviewRun({ kind: 'apply', plan: { toCreate: ['a'], skippedNotOnPhone: 0 }, setting, localIds: new Map() });
    await tick();
    settingListener!({ ...setting, enabled: false });
    release!();
    const outcome = await done;
    expect(outcome.aborted).toBe(true);
    expect(outcome.stoppedBySettingChange).toBe(true);
    expect(calls.cleared).toBe(1);
  });

  test('another format or size stops the run too; the same setting does not', async () => {
    const done = runner.startPhotoPreviewRun({ kind: 'apply', plan: { toCreate: ['a'], skippedNotOnPhone: 0 }, setting, localIds: new Map() });
    await tick();
    settingListener!({ ...setting });
    expect(runner.photoPreviewRunProgress()).not.toBeNull();
    settingListener!({ ...setting, px: 1280 });
    release!();
    expect((await done).stoppedBySettingChange).toBe(true);
  });

  test('a resume re-checks the setting after loading the ids', async () => {
    known = { ...setting, enabled: false };
    expect(await runner.resumePhotoPreviewRun()).toBe(false);
    expect(calls.run).toHaveLength(0);
  });

  test('a pressed Apply runs its fresh plan; a resume continues the saved remainder', async () => {
    const pressed = runner.startPhotoPreviewRun({ kind: 'apply', plan: { toCreate: ['a'], skippedNotOnPhone: 0 }, setting, localIds: new Map(), discardSaved: true });
    await tick();
    expect(calls.run[0].opts.discardSaved).toBe(true);
    release!();
    await pressed;
    await runner.resumePhotoPreviewRun();
    await tick();
    expect(calls.run[1].opts.discardSaved).toBe(false);
    release!();
  });
});
