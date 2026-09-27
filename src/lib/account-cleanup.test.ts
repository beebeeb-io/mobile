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

const purgeCalls: string[] = [];
mock.module('./name-cache', () => ({
  clearNameCache: async () => { purgeCalls.push('names'); },
}));
mock.module('./thumbnail-cache', () => ({
  clearThumbnailCache: async () => { purgeCalls.push('thumbnails'); },
}));
// Task 1593 — the decrypted preview cache (Library/Caches/preview/).
let previewClear: () => Promise<void> = async () => { purgeCalls.push('previews'); };
mock.module('./native-decrypt', () => ({
  clearPreviewCache: () => previewClear(),
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  purgePlaintextStorage: async () => { purgeCalls.push('native'); return { removed: 0, failed: 0 }; },
}));

const { purgeThenSignOut, purgeAllPlaintextCaches, purgePreviewPlaintextWhileSignedOut } = await import('./account-cleanup');
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('purgeAllPlaintextCaches (task 1593 — preview plaintext survived sign-out)', () => {
  test('clears the decrypted preview cache along with thumbnails, names and the native registry', async () => {
    purgeCalls.length = 0;
    await purgeAllPlaintextCaches();
    expect(purgeCalls).toContain('previews');
    expect(purgeCalls.indexOf('previews')).toBeLessThan(purgeCalls.indexOf('native'));
    expect(purgeCalls.sort()).toEqual(['names', 'native', 'previews', 'thumbnails']);
  });

  test('a failing preview purge never blocks the rest of sign-out', async () => {
    purgeCalls.length = 0;
    previewClear = async () => { throw new Error('disk'); };
    await expect(purgeAllPlaintextCaches()).resolves.toEqual({ removed: 0, failed: 0 });
    await expect(purgePreviewPlaintextWhileSignedOut()).resolves.toBeUndefined();
    previewClear = async () => { purgeCalls.push('previews'); };
  });

  test('purgePreviewPlaintextWhileSignedOut clears the preview cache', async () => {
    purgeCalls.length = 0;
    await purgePreviewPlaintextWhileSignedOut();
    expect(purgeCalls).toEqual(['previews']);
  });
});

describe('App.tsx runs the preview sweep whenever nobody is signed in (task 1593)', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');
  test('cold launch with no stored session', () => {
    expect(app).toMatch(/if \(!tokenExists\) void purgePreviewPlaintextWhileSignedOut\(\);/);
  });
  test('rejected token at launch, session expiry, and an account deleted elsewhere', () => {
    expect(app).toMatch(/startupAuthState = 'invalid-token';[\s\S]{0,200}setUser\(null\);\s*void purgePreviewPlaintextWhileSignedOut\(\);/);
    expect(app).toMatch(/registerSessionExpiredHandler\(\(\) => \{[\s\S]{0,200}void purgePreviewPlaintextWhileSignedOut\(\);\s*setUser\(null\);/);
    expect(app).toMatch(/stashAccountDeletedNotice\(\{ deletedAt, shredAfter \}\);\s*void purgePreviewPlaintextWhileSignedOut\(\);/);
  });
  test('ordinary sign-out goes through purgeAllPlaintextCaches (which now includes previews)', () => {
    expect(app).toMatch(/await purgeAllPlaintextCaches\(\)/);
  });
});

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
