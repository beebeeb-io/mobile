// @ts-nocheck — bun:test types are outside the Expo tsconfig.
import { beforeEach, expect, mock, test } from 'bun:test';
let calls = 0;
let reply: () => Promise<{ flags: Record<string, boolean> }>;
mock.module('./api', () => ({ getEvaluateFlags: () => { calls++; return reply(); } }));
const { loadSharedFoldersFlag } = await import('./use-shared-folders-flag');
const { advanceAccountEpoch } = await import('./account-epoch');
beforeEach(() => { advanceAccountEpoch(); calls = 0; reply = async () => ({ flags: { shared_folders_v1: true } }); });
test('useSharedFoldersFlag_is_false_on_error_and_when_the_flag_is_absent', async () => {
  reply = async () => { throw new Error('offline'); };
  expect(await loadSharedFoldersFlag()).toBe(false);
  advanceAccountEpoch(); reply = async () => ({ flags: {} });
  expect(await loadSharedFoldersFlag()).toBe(false);
});
test('is_cached_once_per_account_epoch', async () => {
  expect(await Promise.all([loadSharedFoldersFlag(), loadSharedFoldersFlag()])).toEqual([true, true]);
  expect(await loadSharedFoldersFlag()).toBe(true); expect(calls).toBe(1);
  advanceAccountEpoch(); await loadSharedFoldersFlag(); expect(calls).toBe(2);
});
test('a_late_flag_result_cannot_enable_the_next_account', async () => {
  let resolve!: (value: { flags: Record<string, boolean> }) => void;
  reply = () => new Promise(r => { resolve = r; });
  const pending = loadSharedFoldersFlag(); advanceAccountEpoch();
  resolve({ flags: { shared_folders_v1: true } }); expect(await pending).toBe(false);
});
