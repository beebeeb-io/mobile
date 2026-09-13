// @ts-nocheck
/**
 * Task 1399 follow-up (Codex P1 "Purge plaintext caches after deleting the
 * account") — proves `purgeThenSignOut` calls `purge()` BEFORE `signOut()`,
 * not the other way around. Ordering matters here as defense in depth: the
 * account-deletion flow's own cleanup guarantee should not silently depend
 * on `signOut()`'s internal step order never changing (see App.tsx —
 * `signOut()` also purges internally, but the deletion screen calls this
 * explicitly first).
 *
 * `./account-cleanup` imports `./name-cache` and `./thumbnail-cache` (which
 * transitively pull in `expo-file-system`/`react-native` — real
 * `react-native/index.js` uses Flow syntax bun's parser rejects outright)
 * and `../../modules/beebeeb-crypto`. Per the isolated-runner rule
 * (mobile/CLAUDE.md "Tests"), this file mocks all three itself. Static
 * `import` statements are hoisted above `mock.module` calls regardless of
 * source order, so `./account-cleanup` is loaded via a dynamic `await
 * import(...)` below the mocks (same pattern as `plaintext-storage.test.ts`).
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('./name-cache', () => ({
  clearNameCache: async () => {},
}));
mock.module('./thumbnail-cache', () => ({
  clearThumbnailCache: async () => {},
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  purgePlaintextStorage: async () => ({ removed: 0, failed: 0 }),
}));

const { purgeThenSignOut } = await import('./account-cleanup');

describe('purgeThenSignOut', () => {
  test('purges plaintext caches before signing out', async () => {
    const calls: string[] = [];
    await purgeThenSignOut({
      purge: async () => {
        calls.push('purge');
        return { removed: 3, failed: 0 };
      },
      signOut: async () => {
        calls.push('signOut');
      },
    });
    expect(calls).toEqual(['purge', 'signOut']);
  });

  test('awaits purge to fully complete before signOut starts', async () => {
    const calls: string[] = [];
    await purgeThenSignOut({
      purge: () =>
        new Promise((resolve) => {
          // Resolve on a later macrotask so a signOut() call that started
          // too early would show up in `calls` BEFORE 'purge-resolved'.
          setTimeout(() => {
            calls.push('purge-resolved');
            resolve({ removed: 1, failed: 0 });
          }, 0);
        }),
      signOut: async () => {
        calls.push('signOut');
      },
    });
    expect(calls).toEqual(['purge-resolved', 'signOut']);
  });
});
