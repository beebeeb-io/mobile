// @ts-nocheck
// Task 1539 (finding 1, P0) — "Lock file" enforcement shared by PreviewScreen.
//
// RED on main: `src/lib/preview-lock-gate.ts` does not exist on main at all
// (the only lock check anywhere in the app was inline inside FilesScreen's
// `openFile()` — grep confirmed exactly one call site of `isFileLocked`, and
// zero references to it or LocalAuthentication in PhotosScreen.tsx or
// PreviewScreen.tsx), so this whole file fails at module resolution:
//   error: Cannot find module './preview-lock-gate' from ...
// See the task Notes for the pasted failure.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

// Dynamic import AFTER mock.module — a static top-level `import` here would
// be hoisted/linked before the mock registration runs (real ESM semantics),
// so `expo-secure-store` would load for real and crash on react-native's
// Flow syntax. Matches the pattern every other api.ts/backup-context.ts test
// in this repo already uses for exactly this reason.
const { checkLockedFileIds, isPreviewGated } = await import('./preview-lock-gate');
const { lockFile } = await import('./file-locks');

beforeEach(() => {
  store.clear();
});

describe('checkLockedFileIds', () => {
  test('returns only the ids that are locked, out of a mixed batch', async () => {
    await lockFile('photo-locked-1');
    await lockFile('photo-locked-2');

    const locked = await checkLockedFileIds([
      'photo-locked-1',
      'photo-unlocked-1',
      'photo-locked-2',
      'photo-unlocked-2',
    ]);

    expect(locked.has('photo-locked-1')).toBe(true);
    expect(locked.has('photo-locked-2')).toBe(true);
    expect(locked.has('photo-unlocked-1')).toBe(false);
    expect(locked.has('photo-unlocked-2')).toBe(false);
    expect(locked.size).toBe(2);
  });

  test('dedupes repeated ids (e.g. the same file appearing twice in a swipe window)', async () => {
    await lockFile('dup-1');
    const locked = await checkLockedFileIds(['dup-1', 'dup-1', 'dup-1']);
    expect([...locked]).toEqual(['dup-1']);
  });

  test('an empty batch resolves to an empty set with no SecureStore surprises', async () => {
    const locked = await checkLockedFileIds([]);
    expect(locked.size).toBe(0);
  });

  test('nothing locked yet (fresh SecureStore) returns an empty set for real ids', async () => {
    const locked = await checkLockedFileIds(['never-locked-1', 'never-locked-2']);
    expect(locked.size).toBe(0);
  });
});

describe('isPreviewGated — the decision PhotosScreen/PreviewScreen skipped entirely on main', () => {
  test('a locked file not yet authenticated this session is gated', () => {
    const locked = new Set(['file-1']);
    const authenticated = new Set<string>();
    expect(isPreviewGated('file-1', locked, authenticated)).toBe(true);
  });

  test('a locked file already authenticated this session is NOT re-gated', () => {
    const locked = new Set(['file-1']);
    const authenticated = new Set(['file-1']);
    expect(isPreviewGated('file-1', locked, authenticated)).toBe(false);
  });

  test('an unlocked file is never gated', () => {
    const locked = new Set(['some-other-file']);
    const authenticated = new Set<string>();
    expect(isPreviewGated('file-1', locked, authenticated)).toBe(false);
  });

  test('swiping to a DIFFERENT locked neighbor re-gates even if a prior file was authenticated', () => {
    // This is the exact swipe-pager bypass from the finding: reaching a
    // locked neighbor by swipe must gate it even though some OTHER file
    // (or none) was authenticated earlier in the session.
    const locked = new Set(['file-A', 'file-B']);
    const authenticated = new Set(['file-A']);
    expect(isPreviewGated('file-B', locked, authenticated)).toBe(true);
  });

  test('a null/undefined fileId (no file open yet) is never gated', () => {
    const locked = new Set(['file-1']);
    expect(isPreviewGated(null, locked, new Set())).toBe(false);
    expect(isPreviewGated(undefined, locked, new Set())).toBe(false);
  });
});
