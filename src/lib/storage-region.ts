/**
 * storage-region — the ONE source for "where is my data stored" in the app
 * (task 1592 item 4).
 *
 * The server documents `GET /api/v1/region` (the default pool's location) as
 * the source for "stored in {city}". Task 1583 wired the Info sheet to it
 * ("Falkenstein, Germany"), but the Encryption details sheet still printed
 * the hard-coded `trustLocation()` filler ("Europe · EU region"), so the same
 * file named two different places depending on which sheet you opened.
 *
 * One fetch per app run (the region rarely changes); a failed fetch is NOT
 * cached, so the next sheet that opens tries again. The label itself comes
 * from `storageLocationLabel` (src/lib/preview-info.ts): a known city reads
 * "Falkenstein, Germany", no city reads "Europe" — never a filler.
 */
import { useEffect, useState } from 'react';
import { getRegion, getStorageRegions, type StorageChoice } from './api';

type RegionFetcher = () => Promise<{ city?: string | null }>;
type ChoicesFetcher = () => Promise<readonly StorageChoice[]>;

/** `undefined` = not fetched yet; `null` = the server named no city. */
let cachedCity: string | null | undefined;
let inflight: Promise<string | null> | null = null;

/** The cached city, if a fetch already succeeded this app run. */
export function peekRegionCity(): string | null | undefined {
  return cachedCity;
}

/**
 * The storage city from `GET /api/v1/region` (cached after the first
 * success; concurrent callers share one request). `null` also when several
 * datacenters are live (see below). Rejects when the call
 * fails — callers fall back to "Europe", and a later call retries.
 */
export function loadRegionCity(
  fetcher: RegionFetcher = getRegion,
  choicesFetcher: ChoicesFetcher = getStorageRegions,
): Promise<string | null> {
  if (cachedCity !== undefined) return Promise.resolve(cachedCity);
  if (!inflight) {
    inflight = fetcher()
      .then(async (r) => {
        let city = r?.city?.trim() || null;
        // Task 1919: with more than one live datacenter the default pool's
        // city says nothing about where a given file is (the app's file
        // lists do not carry a per-file location), so name no city rather
        // than the wrong one. A failed or missing list changes nothing.
        try {
          const live = (await choicesFetcher()).filter(
            (c) => c.kind === 'datacenter' && c.status === 'live',
          );
          if (live.length > 1) city = null;
        } catch {
          // keep the default city
        }
        cachedCity = city;
        return city;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * The storage city for a sheet that is `active` (open): `undefined` while
 * loading, `null` when unknown or the fetch failed, else the city.
 */
export function useRegionCity(active: boolean): string | null | undefined {
  const [city, setCity] = useState<string | null | undefined>(cachedCity);
  useEffect(() => {
    if (!active) return;
    if (cachedCity !== undefined) {
      setCity(cachedCity);
      return;
    }
    let cancelled = false;
    loadRegionCity()
      .then((c) => {
        if (!cancelled) setCity(c);
      })
      .catch(() => {
        if (!cancelled) setCity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return city;
}

/** Test-only: forget the cached city. */
export function __resetRegionCityForTests(): void {
  cachedCity = undefined;
  inflight = null;
}
