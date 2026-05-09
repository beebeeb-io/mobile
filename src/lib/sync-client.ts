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
import type { SyncOp, SyncNode } from './api';

const LAST_SEQ_KEY = 'bb_sync_last_seq';
const PENDING_OPS_KEY = 'bb_sync_pending_ops';
const DEVICE_ID_KEY = 'bb_sync_device_id';

const RECONNECT_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 30_000;

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

async function getDeviceId(): Promise<string> {
  let id = await storage.get(DEVICE_ID_KEY);
  if (!id) {
    id = uuid();
    await storage.set(DEVICE_ID_KEY, id);
  }
  return id;
}

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
        const op = JSON.parse(data) as SyncOp;
        void this.applyRemoteOp(op);
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

    this.applyOpToTree(op.op_type, op.payload);
    this.lastSeq = op.seq_id;
    await saveLastSeq(this.lastSeq);
    this.emit({ type: 'op', op });
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
        const existing = this.tree.get(id);
        if (existing) this.tree.set(id, { ...existing, is_trashed: true });
        break;
      }
      case 'file_restore': {
        const id = payload.id as string | undefined;
        if (!id) return;
        const existing = this.tree.get(id);
        if (existing) this.tree.set(id, { ...existing, is_trashed: false });
        break;
      }
      case 'file_delete': {
        const id = payload.id as string | undefined;
        if (id) this.tree.delete(id);
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
}

interface SyncSnapshotLike {
  seq_id: number;
  nodes: SyncNode[];
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
    has_thumbnail: false,
    storage_pool_id: (payload.storage_pool_id as string | null | undefined) ?? null,
    is_trashed: false,
    is_starred: false,
    chunk_count: (payload.chunk_count as number | undefined) ?? 1,
    created_at: now,
    updated_at: now,
  };
}
