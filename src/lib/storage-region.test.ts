// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches the convention in the other src/lib/*.test.ts files).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let serverCalls = 0;
mock.module('./api', () => ({
  getRegion: async () => {
    serverCalls += 1;
    return { city: 'Falkenstein', region: 'europe', jurisdiction: 'EU' };
  },
}));

const { loadRegionCity, peekRegionCity, __resetRegionCityForTests } = await import('./storage-region');
const { storageLocationLabel } = await import('./preview-info');

beforeEach(() => {
  __resetRegionCityForTests();
  serverCalls = 0;
});

describe('storage-region — one source for "Stored in" (task 1592 item 4)', () => {
  test('defaults to GET /api/v1/region and labels it the way the Info sheet does', async () => {
    const city = await loadRegionCity();
    expect(serverCalls).toBe(1);
    expect(city).toBe('Falkenstein');
    // The Encryption details sheet and the Info sheet print the same words.
    expect(storageLocationLabel({ city })).toBe('Falkenstein, Germany');
    expect(storageLocationLabel({ city })).not.toContain('EU region');
  });

  test('one request per app run; concurrent callers share it', async () => {
    const [a, b] = await Promise.all([loadRegionCity(), loadRegionCity()]);
    await loadRegionCity();
    expect([a, b]).toEqual(['Falkenstein', 'Falkenstein']);
    expect(serverCalls).toBe(1);
    expect(peekRegionCity()).toBe('Falkenstein');
  });

  test('a failed fetch rejects and is NOT cached — the next open retries', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { city: 'Falkenstein' };
    };
    await expect(loadRegionCity(flaky)).rejects.toThrow('offline');
    expect(peekRegionCity()).toBeUndefined();
    expect(await loadRegionCity(flaky)).toBe('Falkenstein');
    expect(calls).toBe(2);
  });

  test('no city from the server → null → "Europe", never a filler', async () => {
    const city = await loadRegionCity(async () => ({ city: '  ' }));
    expect(city).toBeNull();
    expect(storageLocationLabel({ city })).toBe('Europe');
  });
});
