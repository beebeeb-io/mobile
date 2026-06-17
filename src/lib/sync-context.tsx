/**
 * Sync context (React Native).
 *
 * Provides the in-memory file tree + op submission to React components.
 * The underlying SyncClient owns the SSE connection and pending-ops queue;
 * this context is a thin adapter that re-renders subscribers on every
 * tree-affecting event. Mirrors the web `sync-context.tsx`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { SyncClient, type ConnectionStatus } from './sync-client';
import type { SyncNode } from './api';
import { useAuth } from './auth';
import { onFilesDeleted } from './delete-cascade';

interface SyncContextValue {
  /** Connection state — `connected` once SSE handshake succeeds. */
  status: ConnectionStatus;
  /** True before the initial snapshot/catch-up resolves. */
  loading: boolean;
  /** Last error from the engine (snapshot fetch, stream open, op submit). */
  error: Error | null;
  /** True when sync is actively backing the UI (snapshot loaded). */
  ready: boolean;
  /**
   * Monotonic counter bumped on every op-induced tree mutation. Include in
   * effect deps to re-derive UI state when the tree changes.
   */
  treeVersion: number;
  /** All nodes belonging to a folder. */
  children: (parentId: string | null | undefined) => SyncNode[];
  /** Look up a single node by id. */
  getNode: (id: string) => SyncNode | undefined;
  /** All nodes — useful for search indexing. */
  allNodes: () => SyncNode[];
  /** Expand ids to include all descendants in the in-memory tree (for the
   *  delete-cascade dispatcher — folder deletes must fan out to their contents). */
  collectSubtreeIds: (ids: string[]) => string[];
  /** Submit a local op (optimistic apply + POST). */
  submitOp: (
    opType: string,
    payload: Record<string, unknown>,
  ) => Promise<{ accepted: boolean; reason?: string }>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const clientRef = useRef<SyncClient | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!user) {
      // Logged out — tear down any active client.
      clientRef.current?.stop();
      clientRef.current = null;
      setStatus('idle');
      setLoading(true);
      setReady(false);
      return;
    }

    const client = new SyncClient();
    clientRef.current = client;
    setLoading(true);
    setReady(false);
    setError(null);

    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'status' && event.status) {
        setStatus(event.status);
      } else if (event.type === 'snapshot') {
        setReady(true);
        setLoading(false);
        setTreeVersion((n) => n + 1);
      } else if (event.type === 'op') {
        setTreeVersion((n) => n + 1);
        // 0818 — a sync-arrived trash/delete (incl. 0816's cascade-tagged folder
        // op, whose subtree was captured before apply) fans out to every derived
        // store so a web delete doesn't leave orphaned backup rows / thumbnails /
        // offline copies / search hits. Fire-and-forget; the cascade is idempotent.
        if (event.deletedIds && event.deletedIds.length > 0) {
          void onFilesDeleted(event.deletedIds, { subtree: true });
        }
      } else if (event.type === 'error' && event.error) {
        setError(event.error);
      }
    });

    client
      .start()
      .then(() => {
        // Snapshot/catch-up complete — for catch-up the snapshot event
        // doesn't fire, so flip ready here too.
        setReady(true);
        setLoading(false);
      })
      .catch((err) => {
        // Sync engine couldn't start — likely the server doesn't yet expose
        // the sync endpoints. The app falls back to legacy listing.
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      unsubscribe();
      client.stop();
      clientRef.current = null;
    };
  }, [user]);

  const children_ = useCallback(
    (parentId: string | null | undefined): SyncNode[] => {
      return clientRef.current?.getChildren(parentId) ?? [];
    },
    [],
  );

  const getNode = useCallback((id: string): SyncNode | undefined => {
    return clientRef.current?.getNode(id);
  }, []);

  const allNodes = useCallback((): SyncNode[] => {
    return clientRef.current?.getAllNodes() ?? [];
  }, []);

  const collectSubtreeIds = useCallback((ids: string[]): string[] => {
    return clientRef.current?.collectSubtreeIds(ids) ?? ids;
  }, []);

  const submitOp = useCallback(
    async (
      opType: string,
      payload: Record<string, unknown>,
    ): Promise<{ accepted: boolean; reason?: string }> => {
      if (!clientRef.current) {
        return { accepted: false, reason: 'sync_not_started' };
      }
      return clientRef.current.submitOp(opType, payload);
    },
    [],
  );

  const value = useMemo<SyncContextValue>(
    () => ({
      status,
      loading,
      error,
      ready,
      treeVersion,
      children: children_,
      getNode,
      allNodes,
      collectSubtreeIds,
      submitOp,
    }),
    [status, loading, error, ready, treeVersion, children_, getNode, allNodes, collectSubtreeIds, submitOp],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new Error('useSync must be used within a SyncProvider');
  }
  return ctx;
}

/** Optional variant — returns null when no provider is mounted. */
export function useSyncOptional(): SyncContextValue | null {
  return useContext(SyncContext);
}
