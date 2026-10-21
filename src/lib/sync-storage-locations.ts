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

export interface PoolLookupState {
  known: Map<string, unknown>;
  /** Pools whose lookup settled without learning them: not asked again until the tree changes shape. */
  tried: Set<string>;
  /** pool key -> the one in-flight lookup every caller for that pool awaits. */
  inflight: Map<string, Promise<void>>;
}

export function newPoolLookupState(): PoolLookupState {
  return { known: new Map(), tried: new Set(), inflight: new Map() };
}

/**
 * Resolve the unknown pools of `nodes`. Callers for a pool already being looked
 * up await that SAME request instead of returning early, so each caller can
 * re-derive ITS OWN folder's rows once it resolves. Returns true when this call
 * waited on or ran a lookup (the caller should re-derive its rows); false when
 * there was nothing to resolve. A pool is marked `tried` only after its lookup
 * settles; a failed lookup is not marked, so the next tree bump retries it.
 */
export async function resolvePoolLocationsShared(
  state: PoolLookupState,
  nodes: readonly PoolNode[],
  fetchRows: () => Promise<readonly LocatedRow[]>,
): Promise<boolean> {
  const unknown = unknownPoolKeys(state.known, nodes).filter((k) => !state.tried.has(k));
  if (unknown.length === 0) return false;
  const waits: Promise<void>[] = [];
  const mine = unknown.filter((k) => !state.inflight.has(k));
  for (const k of unknown) {
    const p = state.inflight.get(k);
    if (p) waits.push(p);
  }
  if (mine.length > 0) {
    const run = (async () => {
      try {
        const rows = await fetchRows();
        learnPoolLocations(state.known, nodes, rows);
        for (const k of mine) if (!state.known.has(k)) state.tried.add(k);
      } finally {
        for (const k of mine) state.inflight.delete(k);
      }
    })();
    for (const k of mine) state.inflight.set(k, run);
    waits.push(run);
  }
  const settled = await Promise.allSettled(waits);
  return settled.some((s) => s.status === 'fulfilled');
}
