// @ts-nocheck — Bun test types are not part of the app TypeScript environment.
import { describe, expect, test } from 'bun:test';
import { loadFolderWithCachedRows } from './folder-navigation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cold folder loading independent of full-vault disk index', () => {
  test('starts and completes folder request while disk cache is still blocked', async () => {
    const cache = deferred<string[] | null>();
    let requests = 0;
    const load = loadFolderWithCachedRows(async () => { requests++; return ['fresh']; }, () => cache.promise, () => {});
    expect(requests).toBe(1);
    expect(await load).toEqual(['fresh']);
    cache.resolve(['old']);
  });

  test('cache can paint while network is pending, then fresh rows win', async () => {
    const network = deferred<string[]>();
    const painted: string[][] = [];
    const load = loadFolderWithCachedRows(() => network.promise, async () => ['cached'], (rows) => painted.push(rows));
    await tick();
    expect(painted).toEqual([['cached']]);
    network.resolve(['fresh']);
    expect(await load).toEqual(['fresh']);
  });

  test('late cache cannot resurrect rows after an authoritative empty folder response', async () => {
    const cache = deferred<string[] | null>();
    const painted: string[][] = [];
    expect(await loadFolderWithCachedRows(async () => [], () => cache.promise, (rows) => painted.push(rows))).toEqual([]);
    cache.resolve(['deleted']);
    await tick();
    expect(painted).toEqual([]);
  });

  test('disk cache failure does not fail folder listing', async () => {
    expect(await loadFolderWithCachedRows(async () => ['fresh'], async () => { throw new Error('disk'); }, () => {})).toEqual(['fresh']);
  });

  test('network error remains visible and late cache cannot overwrite the settled error', async () => {
    const cache = deferred<string[] | null>();
    const painted: string[][] = [];
    await expect(loadFolderWithCachedRows(async () => { throw new Error('offline'); }, () => cache.promise, (rows) => painted.push(rows))).rejects.toThrow('offline');
    cache.resolve(['old']);
    await tick();
    expect(painted).toEqual([]);
  });

  test('refresh can bypass disk cache', async () => {
    expect(await loadFolderWithCachedRows(async () => ['fresh'], null, () => { throw new Error('unexpected cache'); })).toEqual(['fresh']);
  });
});
