// @ts-nocheck
// Flow "iOS core journeys on the simulator", fix lane 2 (P2): a locked file
// opened from the Files tab asked for Face ID TWICE — once in
// FilesScreen.openFile's pre-navigation check, then again in PreviewScreen,
// which enforces its own gate (task 1539) and knows nothing about the first
// prompt. PhotosScreen dropped the same pre-check for the same reason
// (PhotosScreen.tsx openPhoto comment, PR #109 review).
//
// These tests drive the real Files -> Preview path: FilesScreen's
// `passesOpenLockGate(file)` decides whether navigation proceeds, then
// Preview's own gate (checkLockedFileIds + isPagerPageGated) decides whether
// the user must tap-to-authenticate, which calls authenticateAsync exactly
// like PreviewScreen.handleUnlockCurrent.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let authCalls = 0;
let authResult = true;

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('expo-local-authentication', () => ({
  authenticateAsync: async () => {
    authCalls += 1;
    return { success: authResult };
  },
}));

const { passesOpenLockGate } = await import('./open-lock-gate');
const { checkLockedFileIds, isPagerPageGated } = await import('./preview-lock-gate');
const { lockFile } = await import('./file-locks');
const LocalAuthentication = await import('expo-local-authentication');

beforeEach(() => {
  store.clear();
  authCalls = 0;
  authResult = true;
});

/** Mirrors PreviewScreen's mount-time gate + tap-to-authenticate handler. */
async function previewUnlock(fileId: string): Promise<boolean> {
  const locked = await checkLockedFileIds([fileId]);
  const authenticated = new Set<string>();
  if (!isPagerPageGated(fileId, locked, authenticated, true)) return true;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Authenticate to open this file',
    disableDeviceFallback: true,
  });
  if (result.success) authenticated.add(fileId);
  return !isPagerPageGated(fileId, locked, authenticated, true);
}

describe('Files tab -> Preview for a locked file', () => {
  test('asks for Face ID exactly once across the whole journey', async () => {
    await lockFile('locked-file');
    const proceeds = await passesOpenLockGate({ id: 'locked-file', is_folder: false });
    expect(proceeds).toBe(true);
    const visible = await previewUnlock('locked-file');
    expect(visible).toBe(true);
    expect(authCalls).toBe(1);
  });

  test('Files never shows plaintext itself: Preview still gates a locked file (fail-closed)', async () => {
    await lockFile('locked-file');
    await passesOpenLockGate({ id: 'locked-file', is_folder: false });
    const locked = await checkLockedFileIds(['locked-file']);
    expect(isPagerPageGated('locked-file', locked, new Set(), true)).toBe(true);
  });

  test('a failed Face ID in Preview keeps the file gated', async () => {
    await lockFile('locked-file');
    await passesOpenLockGate({ id: 'locked-file', is_folder: false });
    authResult = false;
    expect(await previewUnlock('locked-file')).toBe(false);
    expect(authCalls).toBe(1);
  });

  test('an unlocked file prompts zero times', async () => {
    expect(await passesOpenLockGate({ id: 'plain', is_folder: false })).toBe(true);
    expect(await previewUnlock('plain')).toBe(true);
    expect(authCalls).toBe(0);
  });
});

describe('locked folders still gate navigation in FilesScreen (no Preview behind them)', () => {
  test('locked folder: one prompt, navigation proceeds on success', async () => {
    await lockFile('locked-folder');
    expect(await passesOpenLockGate({ id: 'locked-folder', is_folder: true })).toBe(true);
    expect(authCalls).toBe(1);
  });

  test('locked folder: failed Face ID blocks navigation', async () => {
    await lockFile('locked-folder');
    authResult = false;
    expect(await passesOpenLockGate({ id: 'locked-folder', is_folder: true })).toBe(false);
    expect(authCalls).toBe(1);
  });

  test('unlocked folder: no prompt', async () => {
    expect(await passesOpenLockGate({ id: 'plain-folder', is_folder: true })).toBe(true);
    expect(authCalls).toBe(0);
  });
});
