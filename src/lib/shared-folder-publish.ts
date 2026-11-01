import { accountEpoch, isCurrentAccountEpoch, onAccountEpochAdvance } from './account-epoch';
import { ancestorsOf, isForeignSharedFile, treeNode } from './shared-folder-tree';
import { getSharedKeyResolver, sharedFileKeyIsLoaded, sharedMasterHandleId } from './shared-folder-keys';
import { gatedPlaintextWrite } from './plaintext-gate';
import { custodyMemory, noteUpgradeRequired, type CustodyMemory } from './shared-folder-custody';

const ROOTS_TTL = 5 * 60_000;
const RETRY_TTL = 7 * 86_400_000;
const BATCH_SIZE = 1000;
interface PendingPublish { fileId: string; parentId: string | null; rootId: string | null; createdAt: number; }
interface FolderLink { folder_id: string; revoked_at?: string | null; expires_at?: string | null; }
interface PublishedKey { file_id: string; encrypted_file_key: string; }
/** C1/C3 promised Interfaces. Tests use marked port mocks until their lanes merge. */
export interface PublishPorts {
  enabled(): Promise<boolean>;
  links(): Promise<FolderLink[]>;
  folderHandleFor(root: string): Promise<number | null>;
  /** L7d/L11: the device-wide custody memory (a 409 upgrade_required is remembered for the folder). */
  custody: CustodyMemory;
  wrap(folderHandle: number, ids: string[]): Promise<{ fileId: string; wrapped: Uint8Array }[]>;
  publish(root: string, keys: PublishedKey[]): Promise<{ written: number; skipped: number }>;
  ancestors(id: string): string[];
  eligible(id: string): boolean;
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
  now(): number;
  current(): boolean;
}

export function isPublishableOwnedFile(id: string, accountId: string | null): boolean {
  const row = treeNode(id);
  return !row?.file_request_id && !row?.is_trashed && !row?.trashed_at
    && !sharedFileKeyIsLoaded(id) && !isForeignSharedFile(id, accountId);
}

export function createSharedFolderPublisher(p: PublishPorts) {
  const pending = new Map<string, PendingPublish>();
  let stopped = false, generation = 0, hydrated = false;
  let roots: { ids: Set<string>; at: number } | null = null;
  let work = Promise.resolve();
  const valid = (g: number) => !stopped && generation === g && p.current();
  const key = (row: PendingPublish) => JSON.stringify([row.fileId, row.rootId]);

  // Serial jobs make persistence, relaunch hydration and retry/removal atomic in JS.
  function schedule(run: (g: number) => Promise<void>): Promise<void> {
    const g = generation;
    work = work.catch(() => {}).then(async () => {
      try {
        if (!valid(g) || !await p.enabled() || !valid(g)) return;
        if (!hydrated) {
          const raw = await p.read().catch(() => null);
          if (!valid(g)) return;
          try {
            const rows: unknown = JSON.parse(raw ?? '[]');
            if (Array.isArray(rows)) for (const row of rows.slice(0, 100_000)) {
              if (typeof row?.fileId === 'string' && (row.rootId === null || typeof row.rootId === 'string')
                && (row.parentId === null || typeof row.parentId === 'string') && Number.isFinite(row.createdAt)
                && row.createdAt <= p.now() && p.now() - row.createdAt < RETRY_TTL) {
                // Copy only the permitted ID/age fields, never arbitrary JSON values.
                const entry = { fileId: row.fileId, parentId: row.parentId, rootId: row.rootId, createdAt: row.createdAt };
                pending.set(key(entry), entry);
              }
            }
          } catch { /* Corrupt/evicted cache is an empty best-effort queue. */ }
          hydrated = true;
        }
        for (const [id, row] of pending) if (p.now() - row.createdAt >= RETRY_TTL) pending.delete(id);
        await run(g);
      } catch { /* Publishing is best effort and never fails an upload. */ }
    });
    return work;
  }
  async function save(g: number) {
    if (valid(g)) await p.write(JSON.stringify([...pending.values()])).catch(() => {});
  }
  async function liveRoots(g: number): Promise<Set<string>> {
    if (roots && p.now() - roots.at < ROOTS_TTL) return roots.ids;
    const links = await p.links();
    if (!valid(g)) return new Set();
    const ids = new Set(links.filter(link => !link.revoked_at
      && (!link.expires_at || Date.parse(link.expires_at) > p.now())).map(link => link.folder_id));
    roots = { ids, at: p.now() };
    return ids;
  }
  async function send(root: string, rows: PendingPublish[], g: number) {
    for (let i = 0; i < rows.length && valid(g); i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const ids = [...new Set(batch.map(row => row.fileId))].filter(p.eligible);
      try {
        if (ids.length) {
          const handle = await p.folderHandleFor(root);
          if (!valid(g)) return;
          if (handle === null) throw new Error('Folder key unavailable');
          const wrapped = await p.wrap(handle, ids);
          if (!valid(g)) return;
          const byId = new Map(wrapped.map(row => [row.fileId, row.wrapped]));
          if (wrapped.length !== ids.length || byId.size !== ids.length
            || ids.some(id => byId.get(id)?.length !== 60)) throw new Error('Invalid child wraps');
          await p.publish(root, ids.map(file_id => ({ file_id,
            encrypted_file_key: btoa(String.fromCharCode(...byId.get(file_id)!)),
          })));
          if (!valid(g)) return;
        }
        batch.forEach(row => pending.delete(key(row)));
      } catch (error) {
        // L11: a 409 upgrade_required is the owner-must-convert state, not a transient failure: remember the folder
        // and drop the batch instead of retrying for seven days. (A seen folder is not flagged; the batch still goes.)
        if (valid(g) && await noteUpgradeRequired(p.custody, root, error)) {
          batch.forEach(row => pending.delete(key(row)));
          await save(g);
          continue;
        }
        // L7d: a publish only runs for a folder whose custody this device opened, so a later 404, 405
        // or 501 (or an unavailable custody) is a server claim to distrust, not proof the folder is
        // gone. The wraps stay queued; the seven-day window is what ends them.
        if (!valid(g)) return;
      }
      await save(g);
    }
  }
  async function flush(g: number) {
    // Persist before any network/native await, so a lock can leave a retry receipt.
    await save(g);
    if (!valid(g)) return;
    const groups = new Map<string, PendingPublish[]>();
    let sharedRoots: Set<string> | undefined;
    for (const [id, row] of [...pending]) {
      if (!p.eligible(row.fileId)) { pending.delete(id); continue; }
      let root = row.rootId;
      if (!root && row.parentId) {
        sharedRoots ??= await liveRoots(g);
        if (!valid(g)) return;
        root = [row.parentId, ...p.ancestors(row.parentId)].find(id => sharedRoots!.has(id)) ?? null;
      }
      if (!root) { pending.delete(id); continue; }
      // Once discovery succeeded, a retry need not repeat the root walk.
      if (!row.rootId) {
        pending.delete(id); row.rootId = root; pending.set(key(row), row);
      }
      const list = groups.get(root) ?? []; list.push(row); groups.set(root, list);
    }
    await save(g);
    if (!valid(g)) return;
    for (const [root, rows] of groups) {
      await send(root, rows, g);
      if (!valid(g)) return;
    }
  }
  function add(fileId: string, parentId: string | null, rootId: string | null) {
    const row = { fileId, parentId, rootId, createdAt: p.now() };
    if (p.eligible(fileId) && !pending.has(key(row))) pending.set(key(row), row);
  }
  return {
    publishOwnedKeys(rootId: string, fileIds: string[]): Promise<void> {
      // Explicit roots come from Task 10's newly created link; do not consult a stale link cache.
      return schedule(async g => { for (const id of new Set(fileIds)) add(id, null, rootId); await flush(g); });
    },
    onOwnerUpload(entry: { id: string; parent_id: string | null }): void {
      void schedule(async g => { add(entry.id, entry.parent_id, null); await flush(g); });
    },
    retryPending(): Promise<void> { return schedule(flush); },
    idle(): Promise<void> { return work; },
    invalidate() { stopped = true; generation++; roots = null; pending.clear(); },
    async clearPending(): Promise<void> {
      this.invalidate();
      await work;
      await p.remove().catch(() => {});
    },
  };
}

type Publisher = ReturnType<typeof createSharedFolderPublisher>;
type PublishApi = {
  getEvaluateFlags(): Promise<{ flags: Record<string, boolean> }>;
  listFolderLinks(): Promise<FolderLink[]>;
  publishSharedFolderKeys(root: string, keys: PublishedKey[]): Promise<{ written: number; skipped: number }>;
};
type PublishNative = {
  isSharedKeysNativeReady?(): boolean;
  sharedWrapChildKeys(master: number, folder: number, ids: string[]): Promise<{ fileId: string; wrapped: Uint8Array }[]>;
};
let current: Promise<Publisher | null> | null = null;
let version = 0;
let diskWork = Promise.resolve();
const instances = new Set<Publisher>();
export function clearPublishState(): void {
  version++;
  for (const instance of instances) instance.invalidate();
  current = null;
}
onAccountEpochAdvance(clearPublishState);
async function defaultPublisher(): Promise<Publisher | null> {
  if (current) return current;
  const epoch = accountEpoch(), v = version;
  if (!epoch.accountId) return null;
  try { sharedMasterHandleId(); } catch { return null; }
  current = (async () => {
    const fs = await import('expo-file-system/legacy');
    const api = await import('./api') as unknown as PublishApi;
    const native = await import('../../modules/beebeeb-crypto') as unknown as PublishNative;
    const { accountDigest } = await import('./files-mount-default');
    const valid = () => version === v && isCurrentAccountEpoch(epoch);
    if (!valid() || !fs.cacheDirectory) return null;
    const cacheDir = fs.cacheDirectory;
    const path = `${cacheDir}shared-publish-${accountDigest(epoch.accountId!)}.json`;
    let flag: Promise<boolean> | null = null;
    const instance = createSharedFolderPublisher({
      enabled: () => {
        if (!native.isSharedKeysNativeReady?.()) return Promise.resolve(false);
        // Same fail-closed, once-per-account flag contract as Task 9's React hook.
        flag ??= api.getEvaluateFlags().then(r => r.flags.shared_folders_v1 === true).catch(() => false);
        return flag;
      },
      links: () => api.listFolderLinks(),
      folderHandleFor: root => getSharedKeyResolver()?.folderHandleFor(root) ?? Promise.resolve(null),
      custody: custodyMemory,
      wrap: (folder, ids) => native.sharedWrapChildKeys(sharedMasterHandleId(), folder, ids),
      publish: (root, keys) => api.publishSharedFolderKeys(root, keys),
      ancestors: ancestorsOf, eligible: id => isPublishableOwnedFile(id, epoch.accountId),
      read: async () => { await diskWork; if (!valid()) return null; const info = await fs.getInfoAsync(path); return info.exists && valid() ? fs.readAsStringAsync(path) : null; },
      write: value => {
        diskWork = diskWork.catch(() => {}).then(async () => {
          if (valid()) await gatedPlaintextWrite('shared-publish IDs', path, fs, () => fs.writeAsStringAsync(path, value));
        });
        return diskWork;
      },
      remove: () => fs.deleteAsync(path, { idempotent: true }),
      now: Date.now, current: valid,
    });
    instances.add(instance); return instance;
  })();
  return current;
}
export async function publishOwnedKeys(rootId: string, fileIds: string[]): Promise<void> {
  try { await (await defaultPublisher())?.publishOwnedKeys(rootId, fileIds); } catch {}
}
export function onOwnerUpload(entry: { id: string; parent_id: string | null }): void {
  void defaultPublisher().then(p => p?.onOwnerUpload(entry)).catch(() => {});
}
export async function retryPending(): Promise<void> {
  try { await (await defaultPublisher())?.retryPending(); } catch {}
}
export async function clearPendingPublishes(): Promise<void> {
  const initializing = current;
  clearPublishState();
  try {
    await initializing?.catch(() => null);
    await Promise.all([...instances].map(p => p.clearPending()));
    instances.clear();
    await diskWork.catch(() => {});
    const fs = await import('expo-file-system/legacy');
    if (!fs.cacheDirectory) return;
    for (const name of await fs.readDirectoryAsync(fs.cacheDirectory)) {
      // caches-registry: example=shared-publish-00.json (the sign-out sweep of its own files)
      if (/^shared-publish-[a-f0-9]+\.json$/.test(name)) await fs.deleteAsync(`${fs.cacheDirectory}${name}`, { idempotent: true });
    }
  } catch { /* The registered cache purge also sweeps this exact prefix. */ }
}
