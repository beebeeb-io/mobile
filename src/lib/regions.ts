/**
 * Data-residency picker data layer (task 1919, supersedes 1422).
 *
 * Product model (Guus, 2026-10-17): "Europe" is the DEFAULT. It means no
 * specific country, any of our European datacenters; the server places the
 * files. Below it the user can choose one specific datacenter. Datacenters
 * that are not live yet are listed as "coming soon" and cannot be chosen.
 *
 * EVERYTHING comes from the API. `GET /api/v1/storage-regions` (public) is the
 * list, `GET /api/v1/me/region` is the user's preference (and carries the same
 * list as `choices`). This file keeps no list of its own: no static ids, no
 * city -> country map, no planned/coming-soon rows. When the server adds a
 * datacenter or flips one from coming soon to live, the picker changes
 * without an App Store release. Copy names cities only, never the provider.
 *
 * If nothing can be fetched the picker shows no rows and says so (it never
 * invents a list).
 */
import { getStorageRegions, getUserRegion, setUserRegion, type StorageChoice } from './api';

export interface RegionRow {
  /** The server id, sent verbatim to `PUT /me/region`. */
  id: string;
  label: string;
  subtitle: string;
  /** Selectable: the server says it is live AND selectable. */
  available: boolean;
  comingSoon: boolean;
  /** True only for the "Europe" row (the server's `is_default`). */
  isDefault: boolean;
}

/** "Helsinki, Finland"; the city alone when the payload has no country. */
function locationLabel(c: StorageChoice): string {
  const city = c.city ?? c.name;
  return c.country ? `${city}, ${c.country}` : city;
}

/** Turn the API list into picker rows. Order is the server's order. */
export function buildRegionRows(choices: readonly StorageChoice[]): RegionRow[] {
  return choices.map((c) => {
    const available = c.selectable === true && c.status === 'live';
    return {
      id: c.id,
      label: c.name,
      subtitle: c.kind === 'region'
        ? 'Any of our European datacenters. We place your files.'
        : locationLabel(c),
      available,
      comingSoon: c.status === 'coming_soon',
      isDefault: c.is_default === true,
    };
  });
}

/**
 * Which row shows as selected. No stored preference means the default
 * (Europe) row. A stored datacenter that the API no longer lists as
 * selectable selects NOTHING: showing Europe would misstate the saved value.
 */
export function effectiveSelection(
  rows: readonly RegionRow[],
  preferredRegion: string | null,
): string | null {
  if (preferredRegion == null) {
    return rows.find((r) => r.isDefault && r.available)?.id ?? null;
  }
  const wanted = preferredRegion.toLowerCase();
  return rows.find((r) => r.available && r.id.toLowerCase() === wanted)?.id ?? null;
}

export interface RegionsData {
  rows: RegionRow[];
  /** The stored value from the server: null, "europe" or a datacenter id. */
  preferredRegion: string | null;
  /** Row id to show as selected, or null. */
  selectedId: string | null;
  /** A datacenter is stored but the API does not list it as selectable now. */
  preferredUnavailable: boolean;
  /** `/me/region` failed, so the current choice is unknown. */
  preferenceLoadFailed: boolean;
  /** Neither the public list nor `/me/region` answered; `rows` is empty. */
  failed: boolean;
}

/** Fetch the list + the preference. Never throws. */
export async function loadRegionsData(): Promise<RegionsData> {
  const [list, pref] = await Promise.allSettled([getStorageRegions(), getUserRegion()]);

  let choices: readonly StorageChoice[] | null = null;
  if (list.status === 'fulfilled' && Array.isArray(list.value)) {
    choices = list.value;
  } else if (pref.status === 'fulfilled' && Array.isArray(pref.value.choices)) {
    choices = pref.value.choices;
  }

  if (!choices) {
    return {
      rows: [],
      preferredRegion: null,
      selectedId: null,
      preferredUnavailable: false,
      preferenceLoadFailed: pref.status === 'rejected',
      failed: true,
    };
  }

  const rows = buildRegionRows(choices);
  const preferenceLoadFailed = pref.status === 'rejected';
  const preferredRegion = pref.status === 'fulfilled' ? (pref.value.preferred_region ?? null) : null;
  // With an unknown preference (offline / failed) select nothing rather than guess.
  const selectedId = preferenceLoadFailed ? null : effectiveSelection(rows, preferredRegion);
  return {
    rows,
    preferredRegion,
    selectedId,
    preferredUnavailable: !preferenceLoadFailed && preferredRegion != null && selectedId === null,
    preferenceLoadFailed,
    failed: false,
  };
}

/** Apply a selection. No-ops (never calls the API) for a coming-soon row. */
export async function selectRegion(
  row: Pick<RegionRow, 'id' | 'available'>,
): Promise<{ preferred_region: string | null } | null> {
  if (!row.available) return null;
  return setUserRegion(row.id);
}
