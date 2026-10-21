// @ts-nocheck
/**
 * Task 1919, by COUNTRY since task 2050 — mobile Data residency picker. Server
 * model (Guus, 2026-10-19): "Europe" is the default (no country, any of our
 * European data centers). Below it the user can choose one COUNTRY, and turn on
 * "Only store in <country>". Every row, including coming-soon rows, comes from
 * `GET /api/v1/storage-regions`; the client keeps NO list of its own, and never
 * renders a city (not even from an older server that still sends one).
 *
 * Mocks `./api` directly so this stays a pure logic test.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ── The 2050 wire shape ──────────────────────────────────────────────────────
const EUROPE = {
  id: 'europe', kind: 'region', name: 'Europe', country: null, country_code: null,
  status: 'live', selectable: true, is_default: true,
};
const DE = {
  id: 'de', kind: 'country', name: 'Germany', country: 'Germany', country_code: 'DE',
  status: 'live', selectable: true, is_default: false,
};
const FI = {
  id: 'fi', kind: 'country', name: 'Finland', country: 'Finland', country_code: 'FI',
  status: 'live', selectable: true, is_default: false,
};
const NL = {
  id: 'nl', kind: 'country', name: 'Netherlands', country: 'Netherlands', country_code: 'NL',
  status: 'coming_soon', selectable: false, is_default: false,
};
const NEW_LIST = [EUROPE, DE, FI, NL];

// ── The OLDER (task 1919) wire shape: one entry per datacenter, with a city ──
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
const OLD_LIST = [EUROPE, FSN1, HEL1, NBG1, EDE];
// What an older server names and the app must never render.
const LEGACY_CITIES = ['Falkenstein', 'Helsinki', 'Nuremberg', 'Ede'];

let storageRegionsImpl: () => Promise<any[]>;
let userRegionImpl: () => Promise<any>;
const setUserRegionCalls: Array<[string | null, boolean | undefined]> = [];

mock.module('./api', () => ({
  getStorageRegions: () => storageRegionsImpl(),
  getUserRegion: () => userRegionImpl(),
  setUserRegion: async (id: string | null, strict?: boolean) => {
    setUserRegionCalls.push([id, strict]);
    return { preferred_region: id, region_strict: strict === true };
  },
}));

const { buildRegionRows, loadRegionsData, selectRegion, setStrict, effectiveSelection, strictSwitchFor, strictSwitchOnPlatform, strictNoticeFor, STRICT_PLACEMENT_ON_MOBILE, allowOthersPayload, allowOthers, strictRefusalNote } =
  await import('./regions');
const { parseChoices } = await import('./storage-regions');

const rowsOf = (raw) => buildRegionRows(parseChoices(raw));

beforeEach(() => {
  setUserRegionCalls.length = 0;
  storageRegionsImpl = async () => NEW_LIST;
  userRegionImpl = async () => ({ preferred_region: null, region_strict: false, available_regions: [], choices: NEW_LIST });
});

describe('buildRegionRows — rows come only from the payload (2050 shape)', () => {
  test('Europe default first, then the live countries, the Netherlands coming soon last', () => {
    const rows = rowsOf(NEW_LIST);
    expect(rows.map((r) => r.id)).toEqual(['europe', 'de', 'fi', 'nl']);
    expect(rows.map((r) => r.label)).toEqual(['Europe', 'Germany', 'Finland', 'Netherlands']);

    const europe = rows[0];
    expect(europe.isDefault).toBe(true);
    expect(europe.isCountry).toBe(false);
    expect(europe.available).toBe(true);
    expect(europe.subtitle).toBe('Any of our European data centers. We place your files.');

    for (const r of rows.slice(1, 3)) {
      expect(r.available).toBe(true);
      expect(r.isCountry).toBe(true);
      expect(r.isDefault).toBe(false);
      expect(r.comingSoon).toBe(false);
      expect(r.subtitle).toBe('');
    }

    const nl = rows[3];
    expect(nl.available).toBe(false);
    expect(nl.comingSoon).toBe(true);
  });

  test('a country the API does not list is NOT invented (no static Finland / Netherlands)', () => {
    expect(rowsOf([EUROPE, DE]).map((r) => r.id)).toEqual(['europe', 'de']);
  });

  test('changing the API data changes the rows with no client change', () => {
    // The Netherlands goes live and a country the client has never heard of appears.
    const fr = {
      id: 'fr', kind: 'country', name: 'France', country: 'France', country_code: 'FR',
      status: 'live', selectable: true, is_default: false,
    };
    const rows = rowsOf([EUROPE, DE, fr, { ...NL, status: 'live', selectable: true }]);
    expect(rows.map((r) => r.id)).toEqual(['europe', 'de', 'fr', 'nl']);
    expect(rows.find((r) => r.id === 'fr').label).toBe('France');
    expect(rows.find((r) => r.id === 'nl').available).toBe(true);
    expect(rows.find((r) => r.id === 'nl').comingSoon).toBe(false);
  });

  test('selectable:false wins over status:live (render from selectable AND status)', () => {
    expect(rowsOf([EUROPE, { ...FI, selectable: false }]).find((r) => r.id === 'fi').available).toBe(false);
  });
});

describe('buildRegionRows — an OLDER server (datacenter entries with a city) never shows a city', () => {
  test('datacenters fold into one row per country, named by the country', () => {
    const rows = rowsOf(OLD_LIST);
    expect(rows.map((r) => r.label)).toEqual(['Europe', 'Germany', 'Finland', 'Netherlands']);
    // Two German datacenters are ONE row, sent by the first live datacenter's id (the old server accepts it).
    expect(rows.map((r) => r.id)).toEqual(['europe', 'fsn1', 'hel1', 'ede']);
    expect(rows.find((r) => r.id === 'ede').comingSoon).toBe(true);
    expect(rows.find((r) => r.id === 'ede').available).toBe(false);
  });

  test('no rendered field of any row carries a city name', () => {
    const shown = JSON.stringify(rowsOf(OLD_LIST).map((r) => [r.label, r.subtitle]));
    expect(LEGACY_CITIES.filter((city) => shown.includes(city))).toEqual([]);
  });

  test('a stored datacenter id still selects its country row (alias)', () => {
    const rows = rowsOf(OLD_LIST);
    expect(effectiveSelection(rows, 'nbg1')).toBe('fsn1');
    expect(effectiveSelection(rows, 'FSN1')).toBe('fsn1');
    expect(effectiveSelection(rows, 'hel1')).toBe('hel1');
  });

  test('a datacenter with no country is dropped rather than shown by its city', () => {
    const rows = rowsOf([EUROPE, { ...HEL1, country: null }]);
    expect(rows.map((r) => r.id)).toEqual(['europe']);
  });
});

describe('effectiveSelection', () => {
  test('no stored preference means the Europe default row is selected', () => {
    expect(effectiveSelection(rowsOf(NEW_LIST), null)).toBe('europe');
  });
  test('a stored country that is listed and selectable is selected', () => {
    expect(effectiveSelection(rowsOf(NEW_LIST), 'fi')).toBe('fi');
  });
  test('match is case-insensitive (server lowercases)', () => {
    expect(effectiveSelection(rowsOf(NEW_LIST), 'FI')).toBe('fi');
  });
  test('a stored country the API no longer lists selects NOTHING (honest, not Europe)', () => {
    expect(effectiveSelection(rowsOf([EUROPE, DE]), 'fi')).toBeNull();
  });
  test('the coming-soon country is never selected, even when stored', () => {
    expect(effectiveSelection(rowsOf(NEW_LIST), 'nl')).toBeNull();
  });
});

describe('loadRegionsData', () => {
  test('reads the list from the API and the preference + strict flag from /me/region', async () => {
    userRegionImpl = async () => ({ preferred_region: 'fi', region_strict: true, available_regions: [], choices: NEW_LIST });
    const data = await loadRegionsData();
    expect(data.failed).toBe(false);
    expect(data.rows.map((r) => r.id)).toEqual(['europe', 'de', 'fi', 'nl']);
    expect(data.preferredRegion).toBe('fi');
    expect(data.selectedId).toBe('fi');
    expect(data.strict).toBe(true);
  });

  test('an older server with no region_strict reads as strict off', async () => {
    userRegionImpl = async () => ({ preferred_region: 'fi', available_regions: [], choices: NEW_LIST });
    expect((await loadRegionsData()).strict).toBe(false);
  });

  test('an older server (datacenter entries, stored datacenter id) still loads without a city', async () => {
    storageRegionsImpl = async () => OLD_LIST;
    userRegionImpl = async () => ({ preferred_region: 'hel1', available_regions: [], choices: OLD_LIST });
    const data = await loadRegionsData();
    expect(data.failed).toBe(false);
    expect(data.selectedId).toBe('hel1');
    expect(LEGACY_CITIES.filter((city) => JSON.stringify(data.rows).includes(city))).toEqual([]);
  });

  test('preferred country missing from the list is reported as unavailable', async () => {
    storageRegionsImpl = async () => [EUROPE, DE];
    userRegionImpl = async () => ({ preferred_region: 'fi', available_regions: [], choices: [] });
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
    expect(data.rows).toHaveLength(4);
  });

  test('both calls failing yields NO invented rows and failed:true', async () => {
    storageRegionsImpl = async () => { throw new Error('network down'); };
    userRegionImpl = async () => { throw new Error('network down'); };
    const data = await loadRegionsData();
    expect(data.failed).toBe(true);
    expect(data.rows).toEqual([]);
    expect(data.selectedId).toBeNull();
    expect(data.strict).toBe(false);
  });

  test('preference call failing alone still shows the list (signed-out-ish / offline pref)', async () => {
    userRegionImpl = async () => { throw new Error('401'); };
    const data = await loadRegionsData();
    expect(data.failed).toBe(false);
    expect(data.rows).toHaveLength(4);
    expect(data.preferenceLoadFailed).toBe(true);
  });
});

describe('selectRegion', () => {
  test('sends the id verbatim for a country', async () => {
    await selectRegion(rowsOf(NEW_LIST).find((r) => r.id === 'fi'));
    expect(setUserRegionCalls).toEqual([['fi', false]]);
  });
  test('sends "europe" (not null) for the default row', async () => {
    await selectRegion(rowsOf(NEW_LIST).find((r) => r.id === 'europe'));
    expect(setUserRegionCalls).toEqual([['europe', false]]);
  });
  test('strict carries over to another country', async () => {
    await selectRegion(rowsOf(NEW_LIST).find((r) => r.id === 'de'), true);
    expect(setUserRegionCalls).toEqual([['de', true]]);
  });
  test('strict ends when the person goes back to Europe (strict needs a country)', async () => {
    await selectRegion(rowsOf(NEW_LIST).find((r) => r.id === 'europe'), true);
    expect(setUserRegionCalls).toEqual([['europe', false]]);
  });
  test('a coming-soon row is a no-op and never calls the API', async () => {
    const result = await selectRegion(rowsOf(NEW_LIST).find((r) => r.id === 'nl'));
    expect(result).toBeNull();
    expect(setUserRegionCalls).toEqual([]);
  });
});

describe('"Only store in <country>"', () => {
  test('the switch exists only while a live country is selected', () => {
    const rows = rowsOf(NEW_LIST);
    expect(strictSwitchFor(rows, 'europe')).toBeNull();
    expect(strictSwitchFor(rows, null)).toBeNull();
    expect(strictSwitchFor(rows, 'nl')).toBeNull();
    expect(strictSwitchFor(rows, 'nope')).toBeNull();
    expect(strictSwitchFor(rows, 'de')?.row.id).toBe('de');
  });

  test('copy names the country and says it is off by default', () => {
    const sw = strictSwitchFor(rowsOf(NEW_LIST), 'de');
    expect(sw.label).toBe('Only store in Germany');
    expect(sw.explanation).toBe(
      'Off by default. If Germany cannot take a new file, the upload stops instead of going to another EU country.',
    );
    expect(strictSwitchFor(rowsOf(NEW_LIST), 'fi').label).toBe('Only store in Finland');
  });

  test('on an older server the switch names the country, never the datacenter city', () => {
    const sw = strictSwitchFor(rowsOf(OLD_LIST), 'fsn1');
    expect(sw.label).toBe('Only store in Germany');
    expect(sw.explanation).not.toMatch(/Falkenstein|Nuremberg/);
  });

  test('setStrict PUTs the chosen country with the strict flag', async () => {
    const de = rowsOf(NEW_LIST).find((r) => r.id === 'de');
    await setStrict(de, true);
    await setStrict(de, false);
    expect(setUserRegionCalls).toEqual([['de', true], ['de', false]]);
  });

  test('setStrict is a no-op for Europe and for a coming-soon row', async () => {
    const rows = rowsOf(NEW_LIST);
    expect(await setStrict(rows.find((r) => r.id === 'europe'), true)).toBeNull();
    expect(await setStrict(rows.find((r) => r.id === 'nl'), true)).toBeNull();
    expect(setUserRegionCalls).toEqual([]);
  });
});

describe('task 2050 round 2: strict is hidden on mobile until native backup handles the refusal (task 2054)', () => {
  test('the one flag is off on iOS and on Android', () => {
    expect(STRICT_PLACEMENT_ON_MOBILE).toEqual({ ios: false, android: false });
  });

  test('no switch on iOS or Android, even with a country selected', () => {
    const rows = rowsOf(NEW_LIST);
    expect(strictSwitchOnPlatform(rows, 'de', 'ios')).toBeNull();
    expect(strictSwitchOnPlatform(rows, 'de', 'android')).toBeNull();
  });

  test('an unknown platform (web) keeps the old switch rule', () => {
    expect(strictSwitchOnPlatform(rowsOf(NEW_LIST), 'de', 'web')?.row.id).toBe('de');
  });

  test('a stored strict=true shows one honest line naming the API country', () => {
    expect(strictNoticeFor(rowsOf(NEW_LIST), 'de', true, 'ios')).toBe(
      'Only store in Germany is on. Change it on the web or desktop app.',
    );
  });

  test('no line when strict is off, on Europe, or when the switch is shown', () => {
    const rows = rowsOf(NEW_LIST);
    expect(strictNoticeFor(rows, 'de', false, 'ios')).toBeNull();
    expect(strictNoticeFor(rows, 'europe', true, 'ios')).toBeNull();
    expect(strictNoticeFor(rows, 'de', true, 'web')).toBeNull();
  });

  test('a stored strict=true is carried (never reset to false) through a country change', async () => {
    await selectRegion(rowsOf(NEW_LIST).find((r) => r.id === 'fi'), true);
    expect(setUserRegionCalls).toEqual([['fi', true]]);
  });
});

// ── Task 2053: strict on, pinned country unavailable ─────────────────────────
const FI_SOON = { ...FI, status: 'coming_soon', selectable: false };

describe('task 2053 strict + unavailable country', () => {
  test('loadRegionsData reports the refusal with the country name when listed but not selectable', async () => {
    storageRegionsImpl = async () => [EUROPE, DE, FI_SOON];
    userRegionImpl = async () => ({ preferred_region: 'fi', region_strict: true, available_regions: [], choices: [] });
    const data = await loadRegionsData();
    expect(data.strictRefusal).toEqual({ id: 'fi', name: 'Finland', listed: true });
  });

  test('country missing from choices: refusal with a generic or Intl name, listed false', async () => {
    storageRegionsImpl = async () => [EUROPE, DE];
    userRegionImpl = async () => ({ preferred_region: 'fi', region_strict: true, available_regions: [], choices: [] });
    const data = await loadRegionsData();
    expect(data.strictRefusal?.listed).toBe(false);
    expect(data.strictRefusal?.id).toBe('fi');
  });

  test('no refusal when strict is off or the country is available', async () => {
    storageRegionsImpl = async () => [EUROPE, DE, FI_SOON];
    userRegionImpl = async () => ({ preferred_region: 'fi', region_strict: false, available_regions: [], choices: [] });
    expect((await loadRegionsData()).strictRefusal).toBeNull();
    storageRegionsImpl = async () => NEW_LIST;
    userRegionImpl = async () => ({ preferred_region: 'fi', region_strict: true, available_regions: [], choices: [] });
    expect((await loadRegionsData()).strictRefusal).toBeNull();
  });

  test('refusal note says uploads are refused and names the country, never "another European data center"', () => {
    const note = strictRefusalNote({ id: 'fi', name: 'Finland', listed: true });
    expect(note).toContain('Finland');
    expect(note.toLowerCase()).toContain('refused');
    expect(note).not.toContain('another European');
  });

  test('allowOthersPayload: listed country keeps its id with strict false; missing sends null', () => {
    expect(allowOthersPayload({ id: 'fi', name: 'Finland', listed: true })).toEqual({ preferred: 'fi', strict: false });
    expect(allowOthersPayload({ id: 'fi', name: 'Finland', listed: false })).toEqual({ preferred: null, strict: false });
  });

  test('allowOthers PUTs exactly that payload', async () => {
    await allowOthers({ id: 'fi', name: 'Finland', listed: true });
    await allowOthers({ id: 'fi', name: 'Finland', listed: false });
    expect(setUserRegionCalls).toEqual([['fi', false], [null, false]]);
  });
});
