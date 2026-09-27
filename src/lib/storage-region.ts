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
import { getRegion } from './api';

type RegionFetcher = () => Promise<{ city?: string | null }>;

/** `undefined` = not fetched yet; `null` = the server named no city. */
let cachedCity: string | null | undefined;
let inflight: Promise<string | null> | null = null;

/** The cached city, if a fetch already succeeded this app run. */
export function peekRegionCity(): string | null | undefined {
  return cachedCity;
}

/**
 * The storage city from `GET /api/v1/region` (cached after the first
 * success; concurrent callers share one request). Rejects when the call
 * fails — callers fall back to "Europe", and a later call retries.
 */
export function loadRegionCity(fetcher: RegionFetcher = getRegion): Promise<string | null> {
  if (cachedCity !== undefined) return Promise.resolve(cachedCity);
  if (!inflight) {
    inflight = fetcher()
      .then((r) => {
        const city = r?.city?.trim() || null;
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
