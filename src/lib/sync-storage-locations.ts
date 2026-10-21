/**
 * Task 2055 (mirrors web `src/lib/sync-storage-locations.ts`) — a file's real
 * storage COUNTRY on Drive rows built from the sync tree.
 *
 * `GET /api/v1/files` puts `storage_location` on every file row; a sync node
 * carries only its `storage_pool_id`. The location belongs to the POOL, so we
 * learn `pool -> location` by joining an API row to the sync node of the same
 * file (same `updated_at`), and a sync-derived row takes the location of its
 * node's pool. A pool never seen in an API row stays unknown: the row says
 * "Europe", never a guessed country. A null pool is the server's default pool
 * and is keyed on its own.
 */
import { fileStorageCountry } from './storage-regions';

export interface PoolNode {
  id: string;
  updated_at?: string;
  storage_pool_id?: string | null;
  is_folder?: boolean;
  is_uploading?: boolean;
}

export interface LocatedRow {
  id: string;
  updated_at?: string;
  storage_location?: unknown;
}

export function poolKey(storagePoolId: string | null | undefined): string {
  return storagePoolId ?? '';
}

/** Learn `pool -> location` from API rows naming a real country, joined to the same file's node. */
export function learnPoolLocations(
  known: Map<string, unknown>,
  nodes: readonly PoolNode[],
  rows: readonly LocatedRow[],
): void {
  if (rows.length === 0 || nodes.length === 0) return;
  const byId = new Map<string, PoolNode>();
  for (const n of nodes) byId.set(n.id, n);
  for (const r of rows) {
    if (fileStorageCountry(r) === null) continue;
    const n = byId.get(r.id);
    if (!n || n.updated_at !== r.updated_at) continue;
    known.set(poolKey(n.storage_pool_id), r.storage_location);
  }
}

/** The learned location of this node's pool, or undefined when the pool is unknown. */
export function knownPoolLocation(known: ReadonlyMap<string, unknown>, node: PoolNode): unknown {
  return known.get(poolKey(node.storage_pool_id));
}

/** Pool keys of finished files whose country is not learned yet (what a GET /files would resolve). */
export function unknownPoolKeys(known: ReadonlyMap<string, unknown>, nodes: readonly PoolNode[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.is_folder || n.is_uploading) continue;
    const k = poolKey(n.storage_pool_id);
    if (!known.has(k)) out.add(k);
  }
  return [...out];
}
