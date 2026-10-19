// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 2050 — the pure country model (src/lib/storage-regions.ts): per-file
// country, the "Europe" fallback, the older-server fold and the strict refusal
// copy. A city is never shown and never read.
import { describe, expect, test } from 'bun:test';
import {
  fileStorageCountry,
  parseChoices,
  storageLocationLabel,
  strictCountryFromMessage,
  strictExplanation,
  strictLabel,
  strictRefusalMessage,
} from './storage-regions';

describe('fileStorageCountry — the per-file location is a country, never a city', () => {
  test('reads storage_location.country', () => {
    expect(fileStorageCountry({ storage_location: { country: 'Germany', country_code: 'DE' } })).toBe('Germany');
  });

  test('a transition-release server also sends a city: it is ignored', () => {
    expect(
      fileStorageCountry({ storage_location: { country: 'Germany', country_code: 'DE', city: 'Falkenstein' } }),
    ).toBe('Germany');
  });

  test('a file with ONLY the deprecated city has no country (the city is never used as one)', () => {
    expect(fileStorageCountry({ storage_location: { city: 'Falkenstein' } })).toBeNull();
    expect(fileStorageCountry({ storage_location: { region: 'fsn1', city: 'Helsinki', provider: 'x' } })).toBeNull();
  });

  test('absent, malformed, blank and "Unknown" are no country', () => {
    expect(fileStorageCountry(null)).toBeNull();
    expect(fileStorageCountry(undefined)).toBeNull();
    expect(fileStorageCountry({})).toBeNull();
    expect(fileStorageCountry({ storage_location: null })).toBeNull();
    expect(fileStorageCountry({ storage_location: { country: 7 } })).toBeNull();
    expect(fileStorageCountry({ storage_location: { country: '  ' } })).toBeNull();
    expect(fileStorageCountry({ storage_location: { country: 'Unknown' } })).toBeNull();
  });
});

describe('storageLocationLabel', () => {
  test('names the country', () => {
    expect(storageLocationLabel('Germany')).toBe('Germany');
    expect(storageLocationLabel(' Finland ')).toBe('Finland');
  });

  test('a file with no country reads "Europe", never a filler or a city', () => {
    expect(storageLocationLabel(null)).toBe('Europe');
    expect(storageLocationLabel(undefined)).toBe('Europe');
    expect(storageLocationLabel('')).toBe('Europe');
    expect(storageLocationLabel('Unknown')).toBe('Europe');
    expect(storageLocationLabel(fileStorageCountry({ storage_location: { city: 'Falkenstein' } }))).toBe('Europe');
  });
});

describe('parseChoices', () => {
  const europe = { id: 'europe', kind: 'region', name: 'Europe', country: null, country_code: null, status: 'live', selectable: true, is_default: true };
  const de = { id: 'de', kind: 'country', name: 'Germany', country: 'Germany', country_code: 'DE', status: 'live', selectable: true, is_default: false };

  test('a list that is not an array is empty (an older server has no `choices`)', () => {
    expect(parseChoices(undefined)).toEqual([]);
    expect(parseChoices({})).toEqual([]);
    expect(parseChoices('x')).toEqual([]);
  });

  test('keeps the 2050 shape as is', () => {
    const out = parseChoices([europe, de]);
    expect(out.map((c) => [c.id, c.kind, c.name, c.selectable, c.is_default])).toEqual([
      ['europe', 'region', 'Europe', true, true],
      ['de', 'country', 'Germany', true, false],
    ]);
  });

  test('a coming-soon entry is never selectable, whatever the payload claims', () => {
    const [nl] = parseChoices([{ ...de, id: 'nl', name: 'Netherlands', country: 'Netherlands', status: 'coming_soon', selectable: true }]);
    expect(nl.selectable).toBe(false);
  });

  test('malformed entries are dropped', () => {
    expect(parseChoices([null, 5, { id: 'x' }, { ...de, status: 'weird' }, { ...de, id: '' }])).toEqual([]);
  });

  test('older server: datacenters fold into countries and the city is dropped', () => {
    const dc = (id, city, country, code, status = 'live') => ({
      id, kind: 'datacenter', name: city, city, country, country_code: code, status, selectable: status === 'live', is_default: false,
    });
    const out = parseChoices([europe, dc('fsn1', 'Falkenstein', 'Germany', 'DE'), dc('nbg1', 'Nuremberg', 'Germany', 'DE'), dc('hel1', 'Helsinki', 'Finland', 'FI'), dc('ede', 'Ede', 'Netherlands', 'NL', 'coming_soon')]);
    expect(out.map((c) => c.name)).toEqual(['Europe', 'Germany', 'Finland', 'Netherlands']);
    expect(out[1].aliases).toEqual(['fsn1', 'nbg1']);
    expect(['Falkenstein', 'Nuremberg', 'Helsinki', 'Ede'].filter((city) => JSON.stringify(out).includes(city))).toEqual([]);
  });

  test('older server: a country is live as soon as one of its datacenters is', () => {
    const dc = (id, status) => ({
      id, kind: 'datacenter', name: id, city: id, country: 'Germany', country_code: 'DE', status, selectable: status === 'live', is_default: false,
    });
    const [row] = parseChoices([dc('a', 'coming_soon'), dc('b', 'live')]);
    expect(row.status).toBe('live');
    expect(row.selectable).toBe(true);
    expect(row.id).toBe('b');
  });
});

describe('strict copy', () => {
  test('label and explanation name the country (same words as the web app)', () => {
    expect(strictLabel('Germany')).toBe('Only store in Germany');
    expect(strictExplanation('Germany')).toBe(
      'Off by default. If Germany cannot take a new file, the upload stops instead of going to another EU country.',
    );
  });
});

describe('strictRefusalMessage — the 409 region_unavailable_strict refusal', () => {
  test('names the COUNTRY the server sent', () => {
    expect(strictRefusalMessage({ code: 'region_unavailable_strict', details: { country: 'Germany' } })).toBe(
      "Germany can't take new files right now, so this upload stopped. Your choice is set to only Germany. Try again later, or allow other EU countries in Settings.",
    );
  });

  test('never reads the deprecated city alias', () => {
    const msg = strictRefusalMessage({ code: 'region_unavailable_strict', details: { city: 'Falkenstein' } });
    expect(msg).not.toMatch(/Falkenstein/);
    expect(msg).toMatch(/^Your chosen country can't take new files right now/);
  });

  test('no details at all still reads honestly', () => {
    expect(strictRefusalMessage({ code: 'region_unavailable_strict' })).toBe(
      "Your chosen country can't take new files right now, so this upload stopped. Your choice is set to only that country. Try again later, or allow other EU countries in Settings.",
    );
  });

  test('any other error is not this refusal', () => {
    expect(strictRefusalMessage({ code: 'quota_exceeded' })).toBeNull();
    expect(strictRefusalMessage(null)).toBeNull();
    expect(strictRefusalMessage(new Error('x'))).toBeNull();
  });
});

describe('strictCountryFromMessage — the native uploader envelope carries no country', () => {
  test('reads the country from the server sentence', () => {
    expect(
      strictCountryFromMessage(
        "Germany can't take new files right now, so this upload stopped. Your choice is set to only Germany.",
      ),
    ).toBe('Germany');
    expect(strictCountryFromMessage("Finland can't take new files right now, so ...")).toBe('Finland');
  });

  test('anything else yields no country (the copy then says "Your chosen country")', () => {
    expect(strictCountryFromMessage('Upload failed (HTTP 409)')).toBeNull();
    expect(strictCountryFromMessage('')).toBeNull();
    expect(strictCountryFromMessage(null)).toBeNull();
  });
});
