// @ts-nocheck
// Task 2055 — a Drive row built from the sync tree carries only `storage_pool_id`;
// the country comes from GET /files rows joined to the same node.
import { describe, expect, test } from 'bun:test';
import { learnPoolLocations, knownPoolLocation, poolKey, unknownPoolKeys } from './sync-storage-locations';
import { fileStorageCountry, storageLocationLabel } from './storage-regions';

const FI = { country: 'Finland', country_code: 'FI' };
const node = (id, pool, updated = 't1', extra = {}) => ({ id, storage_pool_id: pool, updated_at: updated, is_folder: false, ...extra });
const row = (id, loc, updated = 't1') => ({ id, updated_at: updated, storage_location: loc });

describe('sync-storage-locations (task 2055)', () => {
  test('learns pool -> location from an API row joined to its node', () => {
    const known = new Map();
    learnPoolLocations(known, [node('a', 'pool-fi')], [row('a', FI)]);
    expect(storageLocationLabel(fileStorageCountry({ storage_location: knownPoolLocation(known, node('b', 'pool-fi')) }))).toBe('Finland');
  });

  test('a node that moved on (updated_at differs) does not teach its pool the old country', () => {
    const known = new Map();
    learnPoolLocations(known, [node('a', 'pool-de', 't2')], [row('a', FI, 't1')]);
    expect(knownPoolLocation(known, node('x', 'pool-de'))).toBeUndefined();
  });

  test('an Unknown or absent country teaches nothing', () => {
    const known = new Map();
    learnPoolLocations(known, [node('a', 'p')], [row('a', { country: 'Unknown' })]);
    expect(known.size).toBe(0);
  });

  test('null pool is the default pool under its own key', () => {
    expect(poolKey(null)).toBe('');
    const known = new Map();
    learnPoolLocations(known, [node('a', null)], [row('a', FI)]);
    expect(knownPoolLocation(known, node('z', undefined))).toEqual(FI);
  });

  test('unknownPoolKeys lists pools of files with no learned country; folders and uploads are skipped', () => {
    const known = new Map([['pool-fi', FI]]);
    const keys = unknownPoolKeys(known, [
      node('a', 'pool-fi'), node('b', 'pool-x'), node('c', 'pool-y', 't', { is_folder: true }), node('d', 'pool-z', 't', { is_uploading: true }),
    ]);
    expect(keys).toEqual(['pool-x']);
  });
});
