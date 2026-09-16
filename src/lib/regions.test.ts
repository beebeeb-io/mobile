// @ts-nocheck
/**
 * Task 1422 — mobile Data Residency picker: derive rows from `/api/v1/regions`
 * (+ `/me/region` for the user's preference) instead of a hardcoded array,
 * while keeping the honest "Coming soon" rows for planned regions (decision
 * 1413) the API does not (yet) list.
 *
 * Mocks `./api` directly (welcome-seed.test.ts's pattern) so this stays a
 * pure logic test — no native-module scaffolding needed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let availableRegionsImpl: () => Promise<any[]> = async () => [
  { continent: 'europe', display_name: 'Europe', example_city: 'Falkenstein', is_default: true },
];
let userRegionImpl: () => Promise<any> = async () => ({
  preferred_region: 'europe',
  available_regions: [
    { continent: 'europe', display_name: 'Europe', example_city: 'Falkenstein', is_default: true },
  ],
});
const setUserRegionCalls: string[] = [];

mock.module('./api', () => ({
  getAvailableRegions: () => availableRegionsImpl(),
  getUserRegion: () => userRegionImpl(),
  setUserRegion: async (continent: string) => {
    setUserRegionCalls.push(continent);
    return { preferred_region: continent };
  },
}));

const { mergeRegions, loadRegionsData, selectRegion, PLANNED_REGIONS, DEFAULT_REGION_ROWS } =
  await import('./regions');

beforeEach(() => {
  setUserRegionCalls.length = 0;
  availableRegionsImpl = async () => [
    { continent: 'europe', display_name: 'Europe', example_city: 'Falkenstein', is_default: true },
  ];
  userRegionImpl = async () => ({
    preferred_region: 'europe',
    available_regions: [
      { continent: 'europe', display_name: 'Europe', example_city: 'Falkenstein', is_default: true },
    ],
  });
});

describe('mergeRegions — Falkenstein-only payload (today\'s reality)', () => {
  test('Europe row is available; Helsinki + Ede stay Coming soon, disabled', () => {
    const rows = mergeRegions([
      { continent: 'europe', display_name: 'Europe', example_city: 'Falkenstein', is_default: true },
    ]);
    expect(rows).toHaveLength(1 + PLANNED_REGIONS.length);

    const europe = rows.find((r) => r.id === 'europe');
    expect(europe?.available).toBe(true);
    expect(europe?.subtitle).toBe('Falkenstein, Germany');

    const helsinki = rows.find((r) => r.id === 'helsinki-fi');
    expect(helsinki?.available).toBe(false);
    expect(helsinki?.subtitle).toBe('Coming soon');

    const ede = rows.find((r) => r.id === 'ede-nl');
    expect(ede?.available).toBe(false);
    expect(ede?.subtitle).toBe('Coming soon');
  });
});

describe('mergeRegions — a region the API lists as available', () => {
  test('Helsinki becomes a selectable row and drops out of Coming soon', () => {
    const rows = mergeRegions([
      { continent: 'europe', display_name: 'Europe', example_city: 'Falkenstein', is_default: true },
      { continent: 'europe-fi', display_name: 'Helsinki', example_city: 'Helsinki', is_default: false },
    ]);

    const helsinki = rows.find((r) => r.label === 'Helsinki');
    expect(helsinki?.available).toBe(true);
    expect(helsinki?.id).toBe('europe-fi');
    expect(helsinki?.subtitle).toBe('Helsinki, Finland');

    // Ede is still unlisted -> still Coming soon.
    const ede = rows.find((r) => r.id === 'ede-nl');
    expect(ede?.available).toBe(false);
    expect(ede?.subtitle).toBe('Coming soon');

    // No duplicate Helsinki row (the planned placeholder must not also render).
    expect(rows.filter((r) => r.label === 'Helsinki')).toHaveLength(1);
  });
});

describe('loadRegionsData — API listing Helsinki as available', () => {
  test('the row is selectable and selecting it issues the PUT', async () => {
    availableRegionsImpl = async () => [
      { continent: 'europe', display_name: 'Europe', example_city: 'Falkenstein', is_default: true },
      { continent: 'europe-fi', display_name: 'Helsinki', example_city: 'Helsinki', is_default: false },
    ];
    userRegionImpl = async () => ({
      preferred_region: 'europe',
      available_regions: [],
    });

    const data = await loadRegionsData();
    expect(data.refreshFailed).toBe(false);

    const helsinki = data.rows.find((r) => r.label === 'Helsinki');
    expect(helsinki?.available).toBe(true);

    await selectRegion(helsinki!);
    expect(setUserRegionCalls).toEqual(['europe-fi']);
  });
});

describe('loadRegionsData — API omitting Helsinki', () => {
  test('the row renders as Coming soon and is disabled — selecting it is a no-op', async () => {
    const data = await loadRegionsData();
    const helsinki = data.rows.find((r) => r.id === 'helsinki-fi');
    expect(helsinki?.available).toBe(false);
    expect(helsinki?.subtitle).toBe('Coming soon');

    const result = await selectRegion(helsinki!);
    expect(result).toBeNull();
    expect(setUserRegionCalls).toEqual([]);
  });
});

describe('loadRegionsData — API failing', () => {
  test('falls back to the static rows without throwing', async () => {
    availableRegionsImpl = async () => { throw new Error('network down'); };
    userRegionImpl = async () => { throw new Error('network down'); };

    const data = await loadRegionsData();
    expect(data.refreshFailed).toBe(true);
    expect(data.preferredRegion).toBeNull();
    expect(data.rows).toEqual([...DEFAULT_REGION_ROWS]);
    expect(data.rows.some((r) => r.id === 'europe' && r.available)).toBe(true);
    expect(data.rows.some((r) => r.id === 'helsinki-fi' && !r.available)).toBe(true);
    expect(data.rows.some((r) => r.id === 'ede-nl' && !r.available)).toBe(true);
  });
});
