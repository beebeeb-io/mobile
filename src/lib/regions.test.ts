// @ts-nocheck
/**
 * Task 1919 — mobile Data residency picker. Server model (Guus, 2026-10-17):
 * "Europe" is the default (no country, any of our European datacenters). Below
 * it the user can choose one datacenter. Every row, including coming-soon
 * rows, comes from `GET /api/v1/storage-regions`; the client keeps NO list of
 * its own (no static ids, cities or countries).
 *
 * Mocks `./api` directly so this stays a pure logic test.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const EUROPE = {
  id: 'europe', kind: 'region', name: 'Europe', city: null, country: null, country_code: null,
  status: 'live', selectable: true, is_default: true,
};
const FSN1 = {
  id: 'fsn1', kind: 'datacenter', name: 'Falkenstein', city: 'Falkenstein', country: 'Germany',
  country_code: 'DE', status: 'live', selectable: true, is_default: false,
};
const HEL1 = {
  id: 'hel1', kind: 'datacenter', name: 'Helsinki', city: 'Helsinki', country: 'Finland',
  country_code: 'FI', status: 'live', selectable: true, is_default: false,
};
const NBG1 = {
  id: 'nbg1', kind: 'datacenter', name: 'Nuremberg', city: 'Nuremberg', country: 'Germany',
  country_code: 'DE', status: 'live', selectable: true, is_default: false,
};
const EDE = {
  id: 'ede', kind: 'datacenter', name: 'Ede', city: 'Ede', country: 'Netherlands',
  country_code: 'NL', status: 'coming_soon', selectable: false, is_default: false,
};
const FULL = [EUROPE, FSN1, HEL1, NBG1, EDE];

let storageRegionsImpl: () => Promise<any[]>;
let userRegionImpl: () => Promise<any>;
const setUserRegionCalls: Array<string | null> = [];

mock.module('./api', () => ({
  getStorageRegions: () => storageRegionsImpl(),
  getUserRegion: () => userRegionImpl(),
  setUserRegion: async (id: string | null) => {
    setUserRegionCalls.push(id);
    return { preferred_region: id };
  },
}));

const { buildRegionRows, loadRegionsData, selectRegion, effectiveSelection } =
  await import('./regions');

beforeEach(() => {
  setUserRegionCalls.length = 0;
  storageRegionsImpl = async () => FULL;
  userRegionImpl = async () => ({ preferred_region: null, available_regions: [], choices: FULL });
});

describe('buildRegionRows — rows come only from the payload', () => {
  test('Europe default first, then the three live datacenters, Ede coming soon last', () => {
    const rows = buildRegionRows(FULL);
    expect(rows.map((r) => r.id)).toEqual(['europe', 'fsn1', 'hel1', 'nbg1', 'ede']);

    const europe = rows[0];
    expect(europe.label).toBe('Europe');
    expect(europe.isDefault).toBe(true);
    expect(europe.available).toBe(true);
    // Europe is "no specific country": the subtitle says so and names no city.
    expect(europe.subtitle).toMatch(/any/i);
    expect(europe.subtitle).not.toMatch(/Falkenstein|Germany|Helsinki|Nuremberg/);

    expect(rows[1].subtitle).toBe('Falkenstein, Germany');
    expect(rows[2].subtitle).toBe('Helsinki, Finland');
    expect(rows[3].subtitle).toBe('Nuremberg, Germany');
    for (const r of rows.slice(1, 4)) {
      expect(r.available).toBe(true);
      expect(r.isDefault).toBe(false);
      expect(r.comingSoon).toBe(false);
    }

    const ede = rows[4];
    expect(ede.available).toBe(false);
    expect(ede.comingSoon).toBe(true);
    expect(ede.subtitle).toBe('Ede, Netherlands');
  });

  test('a datacenter the API does not list is NOT invented (no static Helsinki / Ede)', () => {
    const rows = buildRegionRows([EUROPE, FSN1]);
    expect(rows.map((r) => r.id)).toEqual(['europe', 'fsn1']);
  });

  test('changing the API data changes the rows with no client change', () => {
    // Ede goes live, Nuremberg is withdrawn, and a city the client has never heard of appears.
    const lyon = {
      id: 'lyo1', kind: 'datacenter', name: 'Lyon', city: 'Lyon', country: 'France',
      country_code: 'FR', status: 'live', selectable: true, is_default: false,
    };
    const rows = buildRegionRows([
      EUROPE, FSN1, HEL1, lyon, { ...EDE, status: 'live', selectable: true },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['europe', 'fsn1', 'hel1', 'lyo1', 'ede']);
    expect(rows.find((r) => r.id === 'lyo1').subtitle).toBe('Lyon, France');
    expect(rows.find((r) => r.id === 'ede').available).toBe(true);
    expect(rows.find((r) => r.id === 'ede').comingSoon).toBe(false);
  });

  test('selectable:false wins over status:live (render from selectable AND status)', () => {
    const rows = buildRegionRows([EUROPE, { ...HEL1, selectable: false }]);
    expect(rows.find((r) => r.id === 'hel1').available).toBe(false);
  });

  test('a city with no country renders the city alone, never "Name, null"', () => {
    const rows = buildRegionRows([EUROPE, { ...HEL1, country: null }]);
    expect(rows.find((r) => r.id === 'hel1').subtitle).toBe('Helsinki');
  });
});

describe('effectiveSelection', () => {
  test('no stored preference means the Europe default row is selected', () => {
    expect(effectiveSelection(buildRegionRows(FULL), null)).toBe('europe');
  });
  test('a stored datacenter that is listed and selectable is selected', () => {
    expect(effectiveSelection(buildRegionRows(FULL), 'hel1')).toBe('hel1');
  });
  test('match is case-insensitive (server lowercases)', () => {
    expect(effectiveSelection(buildRegionRows(FULL), 'HEL1')).toBe('hel1');
  });
  test('a stored datacenter the API no longer lists selects NOTHING (honest, not Europe)', () => {
    expect(effectiveSelection(buildRegionRows([EUROPE, FSN1]), 'hel1')).toBeNull();
  });
});

describe('loadRegionsData', () => {
  test('reads the list from the API and the preference from /me/region', async () => {
    userRegionImpl = async () => ({ preferred_region: 'hel1', available_regions: [], choices: FULL });
    const data = await loadRegionsData();
    expect(data.failed).toBe(false);
    expect(data.rows.map((r) => r.id)).toEqual(['europe', 'fsn1', 'hel1', 'nbg1', 'ede']);
    expect(data.preferredRegion).toBe('hel1');
    expect(data.selectedId).toBe('hel1');
  });

  test('preferred datacenter missing from the list is reported as unavailable', async () => {
    storageRegionsImpl = async () => [EUROPE, FSN1];
    userRegionImpl = async () => ({ preferred_region: 'hel1', available_regions: [], choices: [] });
    const data = await loadRegionsData();
    expect(data.selectedId).toBeNull();
    expect(data.preferredUnavailable).toBe(true);
  });

  test('null preference selects Europe and is not "unavailable"', async () => {
    const data = await loadRegionsData();
    expect(data.selectedId).toBe('europe');
    expect(data.preferredUnavailable).toBe(false);
  });

  test('falls back to /me/region choices when the public list fails', async () => {
    storageRegionsImpl = async () => { throw new Error('boom'); };
    const data = await loadRegionsData();
    expect(data.failed).toBe(false);
    expect(data.rows).toHaveLength(5);
  });

  test('both calls failing yields NO invented rows and failed:true', async () => {
    storageRegionsImpl = async () => { throw new Error('network down'); };
    userRegionImpl = async () => { throw new Error('network down'); };
    const data = await loadRegionsData();
    expect(data.failed).toBe(true);
    expect(data.rows).toEqual([]);
    expect(data.selectedId).toBeNull();
  });

  test('preference call failing alone still shows the list (signed-out-ish / offline pref)', async () => {
    userRegionImpl = async () => { throw new Error('401'); };
    const data = await loadRegionsData();
    expect(data.failed).toBe(false);
    expect(data.rows).toHaveLength(5);
    expect(data.preferenceLoadFailed).toBe(true);
  });
});

describe('selectRegion', () => {
  test('sends the id verbatim for a datacenter', async () => {
    const rows = buildRegionRows(FULL);
    await selectRegion(rows.find((r) => r.id === 'hel1'));
    expect(setUserRegionCalls).toEqual(['hel1']);
  });
  test('sends "europe" (not null) for the default row', async () => {
    const rows = buildRegionRows(FULL);
    await selectRegion(rows.find((r) => r.id === 'europe'));
    expect(setUserRegionCalls).toEqual(['europe']);
  });
  test('a coming-soon row is a no-op and never calls the API', async () => {
    const rows = buildRegionRows(FULL);
    const result = await selectRegion(rows.find((r) => r.id === 'ede'));
    expect(result).toBeNull();
    expect(setUserRegionCalls).toEqual([]);
  });
});
