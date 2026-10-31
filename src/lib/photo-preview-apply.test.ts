// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let uploads: any[][] = [];
let inFlight = 0;
let maxInFlight = 0;
let uploadImpl: (...a: any[]) => Promise<unknown>;
let bulkCalls = 0;
let bulkImpl: () => Promise<number>;
let cacheCleared = 0;
let dropped: string[] = [];
let locked = false;
let setItemCalls = 0;
let accountId: string | null = 'acct-1';
let generation = 0;

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { setItemCalls += 1; store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  uploadPhotoPreviewNative: async (...a: any[]) => {
    uploads.push(a);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try { return await uploadImpl(...a); } finally { inFlight -= 1; }
  },
}));
mock.module('./api', () => ({
  getApiUrl: () => 'http://api.test',
  getToken: async () => 'tok',
  deleteAllPhotoPreviews: async () => { bulkCalls += 1; return bulkImpl(); },
}));
mock.module('./photo-preview-cache', () => ({
  clearPreviewCache: async () => { cacheCleared += 1; },
  dropCachedPreview: async (id: string) => { dropped.push(id); },
}));
mock.module('./expected-user', () => ({ getExpectedUserId: () => accountId }));
mock.module('./shared-folder-keys', () => ({
  sharedMasterHandleId: () => { if (locked) throw new Error('Vault is locked'); return 7; },
}));
mock.module('./account-epoch', () => ({
  accountEpoch: () => ({ generation, accountId }),
  isCurrentAccountEpoch: (e: any) => e.generation === generation,
}));

const { planApply, runApply, turnOffPreviews, rebuildPreviews, savedApplyRun, clearSavedApplyRun } = await import('./photo-preview-apply');

const setting = { enabled: true, format: 'heic', px: 2560 };
const KEY = 'beebeeb.preview-apply.v1.acct-1';
const tick = () => new Promise((r) => setTimeout(r, 0));

function opts(over = {}) {
  const ids = new Map<string, string>();
  for (let i = 0; i < 10; i++) ids.set(`f${i}`, `L${i}`);
  return { concurrency: 2, signal: new AbortController().signal, onProgress: () => {}, setting, localIds: ids, ...over };
}
const plan = (n: number) => ({ toCreate: Array.from({ length: n }, (_, i) => `f${i}`), skippedNotOnPhone: 0 });

beforeEach(() => {
  store.clear(); uploads = []; inFlight = 0; maxInFlight = 0; bulkCalls = 0; cacheCleared = 0; dropped = [];
  accountId = 'acct-1'; generation = 0; locked = false; setItemCalls = 0;
  uploadImpl = async () => { await tick(); return { bytes: 1 }; };
  bulkImpl = async () => 13;
});

describe('planApply', () => {
  const ids = new Map([['a', 'LA'], ['b', 'LB'], ['c', 'LC'], ['v', 'LV']]);
  const f = (id: string, extra = {}) => ({ id, mime_type: 'image/jpeg', has_preview: false, ...extra });

  test('skips files already at the setting, videos, and counts files not on the phone', () => {
    const files = [
      f('a'),
      f('b', { has_preview: true, preview_format: 'heic', preview_px: 2560 }),
      f('c', { has_preview: true, preview_format: 'jpeg', preview_px: 2560 }),
      f('v', { mime_type: 'video/mp4' }),
      f('gone'),
    ];
    expect(planApply(files, setting, ids)).toEqual({ toCreate: ['a', 'c'], skippedNotOnPhone: 1 });
  });

  test('force includes files already at the setting', () => {
    const files = [f('b', { has_preview: true, preview_format: 'heic', preview_px: 2560 })];
    expect(planApply(files, setting, ids, { force: true }).toCreate).toEqual(['b']);
  });
});

describe('runApply', () => {
  test('never runs more than 2 uploads at once and uses the setting', async () => {
    const r = await runApply(plan(7), opts({ concurrency: 9 }));
    expect(r).toEqual({ done: 7, failed: 0 });
    expect(maxInFlight).toBe(2);
    expect(uploads[0]).toEqual([7, 'http://api.test', 'tok', 'f0', 'L0', null, 'heic', 2560, 'acct-1']);
    expect(store.has(KEY)).toBe(false);
  });

  test('abort stops the run and keeps the remainder', async () => {
    const ac = new AbortController();
    let n = 0;
    uploadImpl = async () => { n += 1; if (n === 2) ac.abort(); await tick(); return { bytes: 1 }; };
    const r = await runApply(plan(8), opts({ signal: ac.signal }));
    expect(r.done).toBeLessThan(8);
    expect(uploads.length).toBeLessThan(8);
    const saved = JSON.parse(store.get(KEY)!);
    expect(saved.remaining.length).toBe(8 - r.done);
  });

  test('a later call resumes the remainder instead of starting over', async () => {
    const ac = new AbortController();
    let n = 0;
    uploadImpl = async () => { n += 1; if (n === 2) ac.abort(); await tick(); return { bytes: 1 }; };
    const first = await runApply(plan(6), opts({ signal: ac.signal }));
    uploads = [];
    uploadImpl = async () => ({ bytes: 1 });
    const second = await runApply(plan(6), opts());
    expect(first.done + second.done).toBe(6);
    expect(uploads.length).toBe(6 - first.done);
    expect(store.has(KEY)).toBe(false);
  });

  test('saved state for another setting is discarded', async () => {
    store.set(KEY, JSON.stringify({ format: 'jpeg', px: 1280, remaining: ['f9'] }));
    await runApply(plan(2), opts());
    expect(uploads.map((u) => u[3]).sort()).toEqual(['f0', 'f1']);
  });

  test('a failure is counted and does not stop the run', async () => {
    uploadImpl = async (...a: any[]) => { if (a[3] === 'f1') throw new Error('boom'); return { bytes: 1 }; };
    const progress: number[] = [];
    const r = await runApply(plan(4), opts({ onProgress: (d: number) => progress.push(d) }));
    expect(r).toEqual({ done: 3, failed: 1 });
    expect(progress.at(-1)).toBe(4);
  });

  test('stops when the account changes', async () => {
    uploadImpl = async () => { generation += 1; return { bytes: 1 }; };
    const r = await runApply(plan(6), opts());
    expect(r.done + r.failed).toBeLessThan(6);
  });
});

describe('turnOffPreviews / rebuildPreviews', () => {
  test('Off uses the bulk server route and empties the local cache', async () => {
    expect(await turnOffPreviews()).toBe(13);
    expect(bulkCalls).toBe(1);
    expect(cacheCleared).toBe(1);
  });

  test('Off failure is reported to the caller, local cache untouched', async () => {
    bulkImpl = async () => { throw new Error('offline'); };
    await expect(turnOffPreviews()).rejects.toThrow('offline');
    expect(cacheCleared).toBe(0);
  });

  test('rebuild regenerates files already at the setting, only those on the phone', async () => {
    const files = [
      { id: 'f1', mime_type: 'image/heic', has_preview: true, preview_format: 'heic', preview_px: 2560 },
      { id: 'zz', mime_type: 'image/heic', has_preview: true, preview_format: 'heic', preview_px: 2560 },
    ];
    const r = await rebuildPreviews(files, opts());
    expect(r).toEqual({ done: 1, failed: 0, skippedNotOnPhone: 1 });
    expect(uploads[0][3]).toBe('f1');
  });

  test('rebuild discards a saved remainder of the same setting and redoes the full plan', async () => {
    store.set(KEY, JSON.stringify({ format: 'heic', px: 2560, remaining: ['f9'] }));
    const files = ['f0', 'f1', 'f2'].map((id) => ({ id, mime_type: 'image/jpeg', has_preview: true, preview_format: 'heic', preview_px: 2560 }));
    const r = await rebuildPreviews(files, opts());
    expect(r.done).toBe(3);
    expect(uploads.map((u) => u[3]).sort()).toEqual(['f0', 'f1', 'f2']);
    expect(store.has(KEY)).toBe(false);
  });
});

describe('local cache and resume state', () => {
  test('each replaced preview drops its cached copy; failed ones are kept', async () => {
    uploadImpl = async (...a: any[]) => { await tick(); if (a[3] === 'f1') throw new Error('boom'); return {}; };
    await runApply(plan(3), opts());
    expect(dropped.sort()).toEqual(['f0', 'f2']);
  });

  test('the remainder is written every 25 files, not after each one', async () => {
    const ids = new Map<string, string>();
    for (let i = 0; i < 60; i++) ids.set(`f${i}`, `L${i}`);
    uploadImpl = async () => ({ bytes: 1 });
    await runApply(plan(60), opts({ localIds: ids, concurrency: 1, now: () => 0 }));
    // start + after 25 + after 50 (the final empty state is a remove, not a set)
    expect(setItemCalls).toBe(3);
  });

  test('the remainder is also written after 5 s', async () => {
    let t = 0;
    uploadImpl = async () => { t += 6_000; return { bytes: 1 }; };
    await runApply(plan(3), opts({ concurrency: 1, now: () => t }));
    expect(setItemCalls).toBe(3); // start + after f0 + after f1 (f2 empties it)
  });

  test('an aborted run saves its remainder right away', async () => {
    const ac = new AbortController();
    uploadImpl = async () => { ac.abort(); return {}; };
    await runApply(plan(10), opts({ signal: ac.signal, concurrency: 1, now: () => 0 }));
    expect(JSON.parse(store.get(KEY)!).remaining.length).toBe(9);
  });

  test('nothing is written for the old account after a sign-out', async () => {
    uploadImpl = async () => { generation += 1; return {}; };
    const before = setItemCalls;
    await runApply(plan(5), opts({ concurrency: 1 }));
    expect(setItemCalls).toBe(before + 1); // only the initial save
  });

  test('a vault lock stops the run and keeps the rest, not counted as failed', async () => {
    uploadImpl = async (...a: any[]) => { if (a[3] === 'f1') locked = true; return {}; };
    const r = await runApply(plan(5), opts({ concurrency: 1 }));
    expect(r.stoppedLocked).toBe(true);
    expect(r.failed).toBe(0);
    expect(JSON.parse(store.get(KEY)!).remaining.length).toBe(5 - r.done);
  });

  test('refuses to run without an account; savedApplyRun reads this account only', async () => {
    store.set(KEY, JSON.stringify({ format: 'heic', px: 2560, remaining: ['f1'] }));
    expect((await savedApplyRun())?.remaining).toEqual(['f1']);
    accountId = null;
    expect(await savedApplyRun()).toBeNull();
    await expect(runApply(plan(1), opts())).rejects.toThrow();
  });

  test('clearSavedApplyRun drops this account\'s remainder', async () => {
    store.set(KEY, JSON.stringify({ format: 'heic', px: 2560, remaining: ['f1'] }));
    await clearSavedApplyRun();
    expect(store.has(KEY)).toBe(false);
  });
});
