/**
 * CRDT sync client (React Native).
 *
 * Mirrors the web `sync-client.ts` (see repos/web/src/lib/sync-client.ts) but
 * uses React Native primitives:
 *   - `react-native-sse` for the SSE connection (web's native EventSource is
 *     unavailable; on Platform.OS === 'web' we still use globalThis.EventSource).
 *   - `expo-secure-store` for last_seq / pending_ops / device_id persistence,
 *     with a localStorage fallback for the web preview.
 *
 * Protocol: docs/superpowers/specs/2026-05-02-crdt-sync-engine-design.md
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
// react-native-sse exports a class that mirrors the web EventSource API.
// Cast to a minimal interface so we can swap in window.EventSource on web.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import RNEventSource from 'react-native-sse';

import {
  getApiUrl,
  getSnapshot,
  getSyncOps,
  submitSyncOps,
  getStreamToken,
  getToken,
} from './api';
import type { SyncOp, SyncNode, FileEntry } from './api';
import { isSyncOp } from './sync-op-guard';
import { loadCachedFileIndex, saveCachedFileIndex } from './file-index-cache';
import { syncDecryptedEntriesToFileProvider } from './file-provider-mount';
import { getDeviceId } from './device-identity';

const LAST_SEQ_KEY = 'bb_sync_last_seq';
const PENDING_OPS_KEY = 'bb_sync_pending_ops';

const RECONNECT_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 30_000;

// Debounce window for persisting the live tree to the on-disk index cache (and
// the iOS File Provider cache) after remote ops. A burst of ops (e.g. catch-up
// after reconnect, or a multi-file web trash) collapses into one disk write.
const CACHE_PERSIST_DEBOUNCE_MS = 800;

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface PendingOp {
  client_op_id: string;
  op_type: string;
  payload: Record<string, unknown>;
  /** Snapshot of the affected node before the op was applied (for rollback). */
  rollback?: SyncNode | null;
  /** Logical id the op affects, used to look up the node. */
  target_id?: string;
}

interface SyncEvent {
  type: 'snapshot' | 'op' | 'status' | 'error';
  status?: ConnectionStatus;
  error?: Error;
  op?: SyncOp;
  /** For a trash/delete op: the affected file ids — the SUBTREE (node +
   *  descendants) for a 0816 cascade-tagged folder op, or just the node for a
   *  plain file. Captured BEFORE the op is applied (a delete removes the rows),
   *  so the delete-cascade dispatcher (0818) can fan out to every derived store. */
  deletedIds?: string[];
}

type Listener = (event: SyncEvent) => void;

// ---------------------------------------------------------------------------
// Storage abstraction — SecureStore on native, localStorage on web.
// SecureStore values are <= ~2 KB on iOS, which is fine for our small payloads.
// ---------------------------------------------------------------------------

const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    }
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
      return;
    }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // SecureStore can fail on devices without secure enclave — silently skip.
    }
  },
};

// ---------------------------------------------------------------------------
// UUID — used only for `client_op_id` (uniqueness, not secrecy required).
// crypto.getRandomValues is not guaranteed in React Native, so use Math.random.
// ---------------------------------------------------------------------------

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Device identity is now owned by the canonical `device-identity` module
// (task 0863). Re-export it here so existing importers (api.ts and this file's
// SyncClient) keep working — the value is the same `bb_sync_device_id` this
// engine has always used, so there is no PhotoKit-dedup churn or op-origin
// discontinuity for already-synced devices.
export { getDeviceId };

async function loadLastSeq(): Promise<number> {
  const raw = await storage.get(LAST_SEQ_KEY);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function saveLastSeq(seq: number): Promise<void> {
  await storage.set(LAST_SEQ_KEY, String(seq));
}

async function loadPendingOps(): Promise<PendingOp[]> {
  try {
    const raw = await storage.get(PENDING_OPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingOp[]) : [];
  } catch {
    return [];
  }
}

async function savePendingOps(ops: PendingOp[]): Promise<void> {
  await storage.set(PENDING_OPS_KEY, JSON.stringify(ops));
}

// ---------------------------------------------------------------------------
// EventSource shim — react-native-sse on native, window.EventSource on web.
// Both expose .addEventListener('open' | 'message' | 'error', cb) and .close().
// ---------------------------------------------------------------------------

interface ESLike {
  close(): void;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
}

function createEventSource(url: string, headers: Record<string, string>): ESLike {
  if (Platform.OS === 'web') {
    if (typeof globalThis === 'undefined' || typeof globalThis.EventSource === 'undefined') {
      throw new Error('EventSource not available in this web runtime');
    }
    // Browser EventSource doesn't support headers — auth piggybacks on the
    // ?token= query param exchanged via /sync/stream-token.
    return new globalThis.EventSource(url) as unknown as ESLike;
  }
  // react-native-sse supports custom headers, but we use the same query-token
  // approach as web for parity with the spec.
  const ES = RNEventSource as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => ESLike;
  return new ES(url, { headers });
}

// ---------------------------------------------------------------------------
// SyncClient
// ---------------------------------------------------------------------------

/**
 * SyncClient owns the in-memory tree, the SSE connection, and the
 * pending-ops queue. UI layers subscribe via `subscribe()` to be notified
 * of tree changes.
 *
 * Lifecycle:
 *   const c = new SyncClient()
 *   await c.start()        // boot: snapshot or catch-up + open stream
 *   c.stop()               // close stream, keep last_seq in storage
 */
export class SyncClient {
  private tree = new Map<string, SyncNode>();
  private lastSeq = 0;
  private pendingOps: PendingOp[] = [];
  private deviceId = '';
  private eventSource: ESLike | null = null;
  private status: ConnectionStatus = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private started = false;
  private destroyed = false;
  // Write-through persistence (debounced). `cachePersistTimer` coalesces a burst
  // of remote ops; `dirtyParents` accumulates the parent folders whose listing
  // changed so we can signal exactly those File Provider enumerators.
  private cachePersistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtyParents = new Set<string | null>();

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  getNode(id: string): SyncNode | undefined {
    return this.tree.get(id);
  }

  getAllNodes(): SyncNode[] {
    return Array.from(this.tree.values());
  }

  /** Children of a folder. `null`/`undefined` returns root nodes. */
  getChildren(parentId: string | null | undefined): SyncNode[] {
    const target = parentId ?? null;
    const out: SyncNode[] = [];
    for (const node of this.tree.values()) {
      if ((node.parent_id ?? null) === target) out.push(node);
    }
    return out;
  }

  /**
   * Expand a set of node ids to include every descendant in the in-memory tree
   * (BFS over parent_id). Used by the delete-cascade dispatcher (0818) so a
   * folder delete fans out to ALL of its contents across the derived stores,
   * and by the recursive cascade-apply below. Cycle-safe via a visited set.
   */
  collectSubtreeIds(rootIds: string[]): string[] {
    const childrenByParent = new Map<string | null, string[]>();
    for (const node of this.tree.values()) {
      const p = node.parent_id ?? null;
      const list = childrenByParent.get(p);
      if (list) list.push(node.id);
      else childrenByParent.set(p, [node.id]);
    }
    const result = new Set<string>();
    const stack: string[] = [];
    for (const id of rootIds) {
      if (!result.has(id)) {
        result.add(id);
        stack.push(id);
      }
    }
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const childId of childrenByParent.get(cur) ?? []) {
        if (!result.has(childId)) {
          result.add(childId);
          stack.push(childId);
        }
      }
    }
    return [...result];
  }

  /** Ids a trash/delete op removes from the live view: the SUBTREE for a 0816
   *  cascade-tagged folder op, else just the node. Must be called BEFORE the op
   *  is applied (delete drops the rows). Empty for non-delete ops. */
  private deletedIdsForOp(opType: string, payload: Record<string, unknown>): string[] {
    if (opType !== 'file_trash' && opType !== 'file_delete') return [];
    const id = payload.id as string | undefined;
    if (!id) return [];
    return payload.cascade === true ? this.collectSubtreeIds([id]) : [id];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[SyncClient] Listener error:', err);
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  /** Boot. Idempotent — calling twice is a no-op. */
  async start(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.setStatus('connecting');

    try {
      // Async load of persisted state — RN storage is async, unlike the web's
      // synchronous localStorage. Done here so the constructor stays cheap.
      this.deviceId = await getDeviceId();
      this.lastSeq = await loadLastSeq();
      this.pendingOps = await loadPendingOps();

      if (this.lastSeq === 0) {
        // Fresh device — load full snapshot.
        const snap = await getSnapshot();
        this.applySnapshot(snap);
      } else {
        // Returning device — catch up on missed ops.
        try {
          const ops = await getSyncOps(this.lastSeq);
          for (const op of ops) {
            await this.applyRemoteOp(op);
          }
          // The mobile tree is in-memory only. SecureStore can preserve
          // lastSeq across reinstalls/relaunches, so a catch-up with no ops
          // may otherwise mark an empty tree as ready.
          if (this.tree.size === 0) {
            const snap = await getSnapshot();
            this.applySnapshot(snap);
          }
        } catch (err) {
          // Catch-up failed — fall back to full snapshot to recover.
          console.warn('[SyncClient] catch-up failed, fetching snapshot', err);
          const snap = await getSnapshot();
          this.tree.clear();
          this.applySnapshot(snap);
        }
      }

      void this.openStream();

      // Flush any locally-queued ops from a prior session.
      if (this.pendingOps.length > 0) {
        void this.flushPending();
      }
    } catch (err) {
      this.started = false;
      this.setStatus('disconnected');
      this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      throw err;
    }
  }

  /** Tear down. Stream closed, last_seq persisted, pending ops kept. */
  stop(): void {
    this.destroyed = true;
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.cachePersistTimer) {
      clearTimeout(this.cachePersistTimer);
      this.cachePersistTimer = null;
      // Flush any pending write-through so a stop right after a remote trash
      // doesn't leave the on-disk index stale for the next cold launch.
      if (this.dirtyParents.size > 0) void this.persistCacheNow();
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.setStatus('idle');
    this.listeners.clear();
  }

  private applySnapshot(snap: SyncSnapshotLike): void {
    for (const node of snap.nodes) {
      this.tree.set(node.id, node);
    }
    this.lastSeq = snap.seq_id;
    void saveLastSeq(this.lastSeq);
    this.emit({ type: 'snapshot' });
  }

  private async openStream(): Promise<void> {
    if (this.destroyed) return;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    let token: string;
    try {
      const tokenResp = await getStreamToken();
      token = tokenResp.stream_token;
    } catch (err) {
      this.scheduleReconnect();
      this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }

    const url = `${getApiUrl()}/api/v1/sync/stream?token=${encodeURIComponent(token)}`;
    const sessionToken = (await getToken()) ?? '';

    let es: ESLike;
    try {
      es = createEventSource(url, sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {});
    } catch (err) {
      this.scheduleReconnect();
      this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    this.eventSource = es;

    es.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.setStatus('connected');
    });

    es.addEventListener('message', (event: { data?: string }) => {
      const data = event.data;
      if (!data) return;
      try {
        const msg = JSON.parse(data) as unknown;
        // The server multiplexes event-bus notifications (`{type: "file.created", …}`
        // — no seq_id / op_type / payload) onto the same SSE stream as sync ops and
        // documents that "the client can ignore non-sync events". Applying one as
        // an op threw `payload.id` on undefined for every folder the backup
        // reconcile created (1305 — RN 0.86 surfaces the rejection as an error).
        if (!isSyncOp(msg)) return;
        void this.applyRemoteOp(msg);
      } catch (err) {
        console.error('[SyncClient] Failed to parse SSE message', err);
      }
    });

    es.addEventListener('error', () => {
      // Both EventSource implementations auto-reconnect, but we manage backoff
      // and token refresh explicitly so closes here are deliberate.
      es.close();
      if (this.eventSource === es) {
        this.eventSource = null;
      }
      if (this.destroyed) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    this.setStatus('reconnecting');
    const delay = Math.min(
      RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.destroyed) return;
    // After a long disconnect, fetch any ops we missed before re-opening
    // the stream — gapless resume.
    try {
      const ops = await getSyncOps(this.lastSeq);
      for (const op of ops) {
        await this.applyRemoteOp(op);
      }
    } catch (err) {
      console.warn('[SyncClient] reconnect catch-up failed', err);
    }
    void this.openStream();
  }

  /**
   * Apply a remote op (from SSE or catch-up) to the tree. If the op was
   * originally submitted by this client (echo), the optimistic update is
   * already in place — we just confirm it.
   */
  private async applyRemoteOp(op: SyncOp): Promise<void> {
    if (!isSyncOp(op)) return; // defensive: catch-up / snapshot paths share this entry
    if (op.seq_id <= this.lastSeq) return; // already applied

    // Echo suppression.
    if (op.client_op_id) {
      const idx = this.pendingOps.findIndex((p) => p.client_op_id === op.client_op_id);
      if (idx !== -1) {
        this.pendingOps.splice(idx, 1);
        await savePendingOps(this.pendingOps);
        // Tree already reflects the change locally — only update seq.
        this.lastSeq = op.seq_id;
        await saveLastSeq(this.lastSeq);
        this.emit({ type: 'op', op });
        return;
      }
    }

    // Capture the affected parents BEFORE applying — a delete removes the node
    // and a move rewrites its parent_id, so the pre-op parent would otherwise be
    // lost. We persist the live tree (and prune the File Provider cache) for
    // these folders after the op lands.
    const affectedParents = this.affectedParentsForOp(op.op_type, op.payload);
    // 0818 — capture the deleted subtree BEFORE applying (a cascade delete drops
    // the descendant rows) so the dispatcher can invalidate every store.
    const deletedIds = this.deletedIdsForOp(op.op_type, op.payload);

    this.applyOpToTree(op.op_type, op.payload);
    this.lastSeq = op.seq_id;
    await saveLastSeq(this.lastSeq);
    this.emit({ type: 'op', op, deletedIds: deletedIds.length > 0 ? deletedIds : undefined });

    if (affectedParents) {
      for (const parent of affectedParents) this.dirtyParents.add(parent);
      this.scheduleCachePersist();
    }
  }

  /**
   * Parents whose child listing this op changes, or `null` when the op does not
   * affect any folder listing (e.g. share notifications, file_update which only
   * mutates metadata in place). Returns the OLD parent for trash/delete and BOTH
   * old + new parents for a move so the source folder is reconciled too.
   */
  private affectedParentsForOp(
    opType: string,
    payload: Record<string, unknown>,
  ): Set<string | null> | null {
    const id = payload.id as string | undefined;
    switch (opType) {
      case 'file_create':
      case 'folder_create': {
        const parent = (payload.parent_id as string | null | undefined) ?? null;
        return new Set<string | null>([parent]);
      }
      case 'file_trash':
      case 'file_restore':
      case 'file_delete': {
        if (!id) return null;
        const existing = this.tree.get(id);
        return new Set<string | null>([existing?.parent_id ?? null]);
      }
      case 'file_move':
      case 'folder_move': {
        const parents = new Set<string | null>();
        if (id) {
          const existing = this.tree.get(id);
          parents.add(existing?.parent_id ?? null);
        }
        parents.add((payload.new_parent_id as string | null | undefined) ?? null);
        return parents;
      }
      case 'file_rename':
      case 'folder_rename': {
        // Rename changes the displayed name but not which folder it lives in;
        // still reconcile the parent so the File Provider picks up the new name.
        if (!id) return null;
        const existing = this.tree.get(id);
        return new Set<string | null>([existing?.parent_id ?? null]);
      }
      default:
        // file_update (metadata-only), share_create/revoke, unknown — no listing
        // change that the on-disk index / File Provider cache needs to mirror.
        return null;
    }
  }

  /**
   * Debounced write-through. Persists the live (non-trashed) tree to the on-disk
   * index cache so a cold launch never resurrects a remotely-trashed file, and
   * on iOS re-syncs the affected folders into the File Provider SQLite cache
   * (which now prunes vanished rows). Best-effort — failures are swallowed.
   */
  private scheduleCachePersist(): void {
    if (this.destroyed) return;
    if (this.cachePersistTimer) return;
    this.cachePersistTimer = setTimeout(() => {
      this.cachePersistTimer = null;
      void this.persistCacheNow();
    }, CACHE_PERSIST_DEBOUNCE_MS);
  }

  private async persistCacheNow(): Promise<void> {
    const parents = this.dirtyParents;
    this.dirtyParents = new Set<string | null>();
    if (parents.size === 0) return;

    // Trashed-ancestor closure: the set of node ids that are themselves trashed
    // OR live under a folder that is trashed. The server has no recursive trash
    // — trashing a folder leaves its descendants with is_trashed=false — so a
    // plain `!node.is_trashed` filter would keep those descendants "live" and
    // resurrect them on a cold launch (index cache) or strand them in Files.app
    // (File Provider rows under an already-removed folder). Walking ancestors
    // once collapses the whole subtree. `trashedFolderIds` are the roots of
    // those collapsed subtrees, whose descendant rows we must explicitly prune.
    const { closure, trashedFolderIds } = this.computeTrashedClosure();

    // Live view = nodes not in the trashed-ancestor closure.
    const liveNodes: SyncNode[] = [];
    for (const node of this.tree.values()) {
      if (!closure.has(node.id)) liveNodes.push(node);
    }

    // Persist the on-disk index cache (FileEntry-shaped). Reuse the existing
    // cache hash when present so the next getFileIndex() conditional fetch still
    // short-circuits; fall back to a sentinel that forces a refetch otherwise.
    try {
      const existing = await loadCachedFileIndex().catch(() => null);
      const hash = existing?.hash ?? 'live-writethrough';
      const files = liveNodes.map(syncNodeToFileEntry);
      await saveCachedFileIndex(hash, files);
    } catch {
      // disk write best-effort; the next full fetch reconciles
    }

    // iOS File Provider write-through. Push each affected folder's COMPLETE
    // non-trashed child set with prune enabled so vanished rows are deleted and
    // Files.app re-enumerates. Names already cached in SQLite are preserved
    // (the upsert COALESCEs name_decrypted), so we pass an empty name map.
    if (Platform.OS !== 'ios') return;

    // Build the complete entry set for every dirty parent (using the live view,
    // so trashed-folder descendants are excluded), plus the explicit pruneParents
    // list. pruneParents must include:
    //   - every dirty parent (so an EMPTY folder — last child trashed remotely —
    //     still seeds an empty keep-set in Swift and gets its surviving row
    //     pruned + signaled, the BLOCKER fix), and
    //   - every trashed FOLDER id (so descendant rows whose parent_id == that
    //     folder are cleared even though the folder's own parent was the only
    //     thing affectedParentsForOp reported — the HIGH fix).
    const entries = liveNodes
      .filter((n) => parents.has(n.parent_id ?? null))
      .map(syncNodeToFileEntry);
    const pruneParents: (string | null)[] = [
      ...parents,
      ...trashedFolderIds,
    ];
    try {
      await syncDecryptedEntriesToFileProvider(entries, {}, null, {
        prune: true,
        pruneParents,
      });
    } catch {
      // best-effort; the next folder enumeration reconciles
    }
  }

  /**
   * Walk the in-memory tree to find every node that is trashed or has a trashed
   * ancestor folder. Because the server does not recursively trash, a trashed
   * folder's children keep is_trashed=false; this closure treats the whole
   * subtree under any trashed folder as gone. Returns the id closure plus the
   * set of trashed folder ids (the subtree roots whose descendant rows need
   * pruning from the persisted caches).
   */
  private computeTrashedClosure(): {
    closure: Set<string>;
    trashedFolderIds: Set<string>;
  } {
    const closure = new Set<string>();
    const trashedFolderIds = new Set<string>();

    // Memoized ancestor-trashed check. A node is in the closure if it is itself
    // trashed or any ancestor folder is trashed. Cache results per id to keep
    // the walk linear even for deep trees.
    const memo = new Map<string, boolean>();
    const isTrashedOrUnderTrashed = (id: string): boolean => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      const node = this.tree.get(id);
      if (!node) {
        memo.set(id, false);
        return false;
      }
      // Mark visiting to break any (malformed) parent cycle.
      memo.set(id, false);
      const result =
        node.is_trashed ||
        (node.parent_id != null && isTrashedOrUnderTrashed(node.parent_id));
      memo.set(id, result);
      return result;
    };

    for (const node of this.tree.values()) {
      if (node.is_trashed && node.is_folder) trashedFolderIds.add(node.id);
      if (isTrashedOrUnderTrashed(node.id)) closure.add(node.id);
    }

    return { closure, trashedFolderIds };
  }

  /** Mutate the in-memory tree based on op type + payload. */
  private applyOpToTree(opType: string, payload: Record<string, unknown>): void {
    switch (opType) {
      case 'file_create':
      case 'folder_create': {
        const node = payloadToNode(payload, opType === 'folder_create');
        if (node) this.tree.set(node.id, node);
        break;
      }
      case 'file_update': {
        const id = payload.id as string | undefined;
        if (!id) return;
        const existing = this.tree.get(id);
        if (!existing) return;
        this.tree.set(id, {
          ...existing,
          size_bytes: (payload.size_bytes as number | undefined) ?? existing.size_bytes,
          version_number:
            (payload.version_number as number | undefined) ?? existing.version_number,
          mime_type:
            (payload.mime_type as string | null | undefined) ?? existing.mime_type,
          has_thumbnail:
            (payload.has_thumbnail as boolean | undefined) ?? existing.has_thumbnail,
          content_hash:
            (payload.content_hash as string | undefined) ?? existing.content_hash,
          updated_at: new Date().toISOString(),
        });
        break;
      }
      case 'file_move':
      case 'folder_move': {
        const id = payload.id as string | undefined;
        if (!id) return;
        const existing = this.tree.get(id);
        if (!existing) return;
        this.tree.set(id, {
          ...existing,
          parent_id: (payload.new_parent_id as string | null | undefined) ?? null,
          updated_at: new Date().toISOString(),
        });
        break;
      }
      case 'file_rename':
      case 'folder_rename': {
        const id = payload.id as string | undefined;
        if (!id) return;
        const existing = this.tree.get(id);
        if (!existing) return;
        this.tree.set(id, {
          ...existing,
          name_encrypted:
            (payload.new_name_encrypted as string | undefined) ?? existing.name_encrypted,
          updated_at: new Date().toISOString(),
        });
        break;
      }
      case 'file_trash': {
        const id = payload.id as string | undefined;
        if (!id) return;
        // 0816/0818 — a cascade-tagged folder trash recursively trashes the
        // whole subtree, so descendants don't linger "live" in the in-memory
        // tree (which previously left stale rows under a web-deleted folder).
        const ids = payload.cascade === true ? this.collectSubtreeIds([id]) : [id];
        for (const nid of ids) {
          const existing = this.tree.get(nid);
          if (existing) this.tree.set(nid, { ...existing, is_trashed: true });
        }
        break;
      }
      case 'file_restore': {
        const id = payload.id as string | undefined;
        if (!id) return;
        // Symmetric with cascade trash: un-trash the subtree for a cascade op.
        const ids = payload.cascade === true ? this.collectSubtreeIds([id]) : [id];
        for (const nid of ids) {
          const existing = this.tree.get(nid);
          if (existing) this.tree.set(nid, { ...existing, is_trashed: false });
        }
        break;
      }
      case 'file_delete': {
        const id = payload.id as string | undefined;
        if (!id) return;
        // Cascade-tagged folder delete removes the whole subtree from the tree.
        const ids = payload.cascade === true ? this.collectSubtreeIds([id]) : [id];
        for (const nid of ids) this.tree.delete(nid);
        break;
      }
      case 'share_create':
      case 'share_revoke':
        // Notification-only — UI listens for these to refresh share state.
        break;
      default:
        // Unknown op type — ignore for forward compatibility.
        break;
    }
  }

  /**
   * Submit a local op. Applies optimistically, queues for the server,
   * rolls back on rejection.
   */
  async submitOp(
    opType: string,
    payload: Record<string, unknown>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const clientOpId = uuid();
    const targetId = (payload.id as string | undefined) ?? null;
    const rollback = targetId ? this.tree.get(targetId) ?? null : null;

    // Optimistic local apply.
    this.applyOpToTree(opType, payload);

    const pending: PendingOp = {
      client_op_id: clientOpId,
      op_type: opType,
      payload,
      rollback,
      target_id: targetId ?? undefined,
    };
    this.pendingOps.push(pending);
    await savePendingOps(this.pendingOps);
    this.emit({ type: 'op' });

    try {
      const result = await submitSyncOps([
        {
          client_op_id: clientOpId,
          op_type: opType,
          payload,
          device_id: this.deviceId,
        },
      ]);

      const rejected = result.rejected.find((r) => r.client_op_id === clientOpId);
      if (rejected) {
        // Remove from pending and roll back the local change.
        const idx = this.pendingOps.findIndex((p) => p.client_op_id === clientOpId);
        if (idx !== -1) {
          this.pendingOps.splice(idx, 1);
          await savePendingOps(this.pendingOps);
        }
        if (targetId) {
          if (rollback) this.tree.set(targetId, rollback);
          else this.tree.delete(targetId);
        }
        // Apply the winning op if present.
        if (rejected.winning_op) {
          this.applyOpToTree(rejected.winning_op.op_type, rejected.winning_op.payload);
        }
        this.emit({ type: 'op' });
        return { accepted: false, reason: rejected.reason ?? 'rejected' };
      }
      // Accepted ops stay in pending until echoed via SSE — that confirms the
      // server's seq_id assignment.
      return { accepted: true };
    } catch (err) {
      // Network error — leave it in pending; we'll flush on reconnect.
      this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      return { accepted: true }; // optimistic state stays
    }
  }

  private async flushPending(): Promise<void> {
    if (this.pendingOps.length === 0) return;
    const batch = this.pendingOps.map((p) => ({
      client_op_id: p.client_op_id,
      op_type: p.op_type,
      payload: p.payload,
      device_id: this.deviceId,
    }));
    try {
      const result = await submitSyncOps(batch);
      for (const rej of result.rejected) {
        const idx = this.pendingOps.findIndex((p) => p.client_op_id === rej.client_op_id);
        if (idx === -1) continue;
        const [pending] = this.pendingOps.splice(idx, 1);
        if (pending.target_id) {
          if (pending.rollback) this.tree.set(pending.target_id, pending.rollback);
          else this.tree.delete(pending.target_id);
        }
        if (rej.winning_op) {
          this.applyOpToTree(rej.winning_op.op_type, rej.winning_op.payload);
        }
      }
      await savePendingOps(this.pendingOps);
      this.emit({ type: 'op' });
    } catch (err) {
      console.warn('[SyncClient] Failed to flush pending ops', err);
    }
  }

  /**
   * R13 — optimistically mirror a LOCAL move/rename into the in-memory tree
   * WITHOUT posting it. The authoritative write already went out over the REST
   * file API (`moveFile`/`renameFile`); the server emits the matching sync op,
   * which echoes back over SSE and re-applies the SAME absolute change
   * idempotently. Without this, an optimistic move/rename lived only in the
   * screen's `setFiles` state and was reverted the instant the list re-derived
   * from `getChildren()` (focus / treeVersion re-render) before the echo
   * arrived — and, while the stream is disconnected, until the next snapshot.
   * No-op until the node is loaded (the legacy index path covers that case).
   */
  applyLocalOp(opType: string, payload: Record<string, unknown>): void {
    const id = payload.id as string | undefined;
    if (!id || !this.tree.has(id)) return;
    const affectedParents = this.affectedParentsForOp(opType, payload);
    this.applyOpToTree(opType, payload);
    this.emit({ type: 'op' });
    if (affectedParents) {
      for (const parent of affectedParents) this.dirtyParents.add(parent);
      this.scheduleCachePersist();
    }
  }
}

interface SyncSnapshotLike {
  seq_id: number;
  nodes: SyncNode[];
}

/**
 * Project a sync-tree node onto the FileEntry shape the on-disk index cache and
 * File Provider sync expect. `chunk_count` defaults to 0 (SyncNode may omit it);
 * the index cache's validator requires it to be a number, and a cold-launch
 * render only needs name/size/folder fields — the real chunk_count arrives with
 * the next full fetch.
 */
function syncNodeToFileEntry(node: SyncNode): FileEntry {
  return {
    id: node.id,
    name_encrypted: node.name_encrypted,
    parent_id: node.parent_id ?? null,
    is_folder: node.is_folder,
    size_bytes: node.size_bytes,
    mime_type: node.mime_type ?? null,
    chunk_count: node.chunk_count ?? 0,
    created_at: node.created_at,
    updated_at: node.updated_at,
    version_number: node.version_number,
    storage_pool_id: node.storage_pool_id ?? null,
    has_thumbnail: node.has_thumbnail,
    is_starred: node.is_starred,
  };
}

function payloadToNode(
  payload: Record<string, unknown>,
  isFolder: boolean,
): SyncNode | null {
  const id = payload.id as string | undefined;
  if (!id) return null;
  const now = new Date().toISOString();
  return {
    id,
    name_encrypted: (payload.name_encrypted as string | undefined) ?? '',
    parent_id: (payload.parent_id as string | null | undefined) ?? null,
    is_folder: isFolder,
    size_bytes: (payload.size_bytes as number | undefined) ?? 0,
    mime_type: (payload.mime_type as string | null | undefined) ?? null,
    content_hash: (payload.content_hash as string | null | undefined) ?? null,
    version_number: (payload.version_number as number | undefined) ?? 1,
    has_thumbnail: (payload.has_thumbnail as boolean | undefined) ?? false,
    storage_pool_id: (payload.storage_pool_id as string | null | undefined) ?? null,
    is_trashed: false,
    is_starred: false,
    chunk_count: (payload.chunk_count as number | undefined) ?? 1,
    created_at: now,
    updated_at: now,
  };
}
