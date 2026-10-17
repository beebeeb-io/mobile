// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches the convention in the other src/lib/*.test.ts files).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let serverCalls = 0;
// Task 1919: the list of storage choices decides whether the default pool's
// city may stand in for "where is this file". One live datacenter: yes.
// Several: no, a file may be in any of them.
const dc = (id, status = 'live') => ({ id, kind: 'datacenter', name: id, city: id, status, selectable: status === 'live' });
let choices = [{ id: 'europe', kind: 'region', name: 'Europe', status: 'live', selectable: true }, dc('Falkenstein'), dc('Ede', 'coming_soon')];
let choicesFail = false;
mock.module('./api', () => ({
  getRegion: async () => {
    serverCalls += 1;
    return { city: 'Falkenstein', region: 'europe', jurisdiction: 'EU' };
  },
  getStorageRegions: async () => {
    if (choicesFail) throw new Error('boom');
    return choices;
  },
}));

const { loadRegionCity, peekRegionCity, __resetRegionCityForTests } = await import('./storage-region');
const { storageLocationLabel } = await import('./preview-info');

beforeEach(() => {
  __resetRegionCityForTests();
  serverCalls = 0;
  choicesFail = false;
  choices = [{ id: 'europe', kind: 'region', name: 'Europe', status: 'live', selectable: true }, dc('Falkenstein'), dc('Ede', 'coming_soon')];
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

describe('storage-region — more than one live datacenter (task 1919)', () => {
  test('the default city no longer stands in for a file\'s location: null -> "Europe"', async () => {
    choices = [choices[0], dc('Falkenstein'), dc('Helsinki'), dc('Nuremberg'), dc('Ede', 'coming_soon')];
    const city = await loadRegionCity();
    expect(city).toBeNull();
    expect(storageLocationLabel({ city })).toBe('Europe');
  });
  test('coming-soon datacenters do not count as live', async () => {
    expect(await loadRegionCity()).toBe('Falkenstein');
  });
  test('the list failing keeps the default city (single-datacenter servers, offline list)', async () => {
    choicesFail = true;
    expect(await loadRegionCity()).toBe('Falkenstein');
  });
});
