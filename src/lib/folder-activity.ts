import { getSharedFolderActivity, listFolderLinks } from './api';
import type { SharedFolderActivityRow } from './folder-link-types';
import { folderLinkNative } from './folder-link-create';
import { accountEpoch, isCurrentAccountEpoch, isStaleAccountError, StaleAccountError } from './account-epoch';
export type ActivityView = SharedFolderActivityRow & { text: string; label: string | null; actor: string | null };
export interface FolderActivityPorts {
  getSharedFolderActivity: typeof getSharedFolderActivity;
  listFolderLinks: typeof listFolderLinks;
  folderHandleFor(folderId: string): Promise<number | null>;
  sharedFolderDecryptName(handle: number, envelope: string): Promise<string | null>;
}
export interface FolderActivityGroup { folderId: string; rows: ActivityView[]; failed: boolean }
const defaultPorts: FolderActivityPorts = {
  getSharedFolderActivity, listFolderLinks,
  // C2 Task 5 resolver Interface, pending merge; tests use a MARKED MOCK.
  folderHandleFor: async folderId => (require('./shared-folder-keys') as { getSharedKeyResolver(): { folderHandleFor(id: string): Promise<number | null> } | null }).getSharedKeyResolver()?.folderHandleFor(folderId) ?? null,
  // C1 Task 3 native reader Interface. Ciphertext envelopes pass through unchanged.
  sharedFolderDecryptName: (handle, envelope) => folderLinkNative.sharedFolderDecryptName(handle, envelope),
};
export function describeActivity(row: SharedFolderActivityRow, label: string | null, actor: string | null): string {
  const n = row.item_count;
  const who = actor || 'Someone';
  switch (row.kind) {
    case 'files_added': return `${n} ${n === 1 ? 'file' : 'files'} added${label ? ` via ${label}` : ''}`;
    case 'items_renamed': return `${n} ${n === 1 ? 'item' : 'items'} renamed by ${who}`;
    case 'items_deleted': return `${n} ${n === 1 ? 'item' : 'items'} deleted by ${who}, restorable from Trash for 30 days`;
    case 'items_moved': return `Items moved by ${who}`;
  }
}
export async function loadFolderActivity(folderId: string, limit = 50, ports: FolderActivityPorts = defaultPorts): Promise<ActivityView[]> {
  const epoch = accountEpoch();
  const assertCurrent = () => { if (!isCurrentAccountEpoch(epoch)) throw new StaleAccountError('Folder activity'); };
  const rows = await ports.getSharedFolderActivity(folderId, limit); assertCurrent();
  if (!rows.length) return [];
  let handle: number | null = null;
  try { handle = await ports.folderHandleFor(folderId); } catch (err) { if (isStaleAccountError(err)) throw err; }
  assertCurrent();
  const names = new Map<string, string | null>();
  const decrypt = async (envelope: string | null): Promise<string | null> => {
    if (handle === null || !envelope) return null;
    if (names.has(envelope)) return names.get(envelope)!;
    let name: string | null = null;
    try { name = await ports.sharedFolderDecryptName(handle, envelope); }
    catch (err) { if (isStaleAccountError(err)) throw err; }
    assertCurrent(); names.set(envelope, name || null); return name || null;
  };
  const result: ActivityView[] = [];
  for (const row of rows.slice(0, limit)) {
    const label = await decrypt(row.share_label_encrypted);
    const actor = await decrypt(row.actor_name_encrypted);
    assertCurrent(); result.push({ ...row, text: describeActivity(row, label, actor), label, actor });
  }
  return result;
}
export async function loadAccountFolderActivity(ports: FolderActivityPorts = defaultPorts): Promise<FolderActivityGroup[]> {
  const epoch = accountEpoch();
  const links = await ports.listFolderLinks();
  if (!isCurrentAccountEpoch(epoch)) throw new StaleAccountError('Folder activity');
  const folderIds = [...new Set([...links].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(link => link.folder_id))].slice(0, 10);
  const groups: FolderActivityGroup[] = [];
  // Bounded, sequential requests also avoid a ten-folder native key-load burst.
  for (const folderId of folderIds) {
    try {
      const rows = await loadFolderActivity(folderId, 20, ports);
      groups.push({ folderId, rows, failed: false });
    } catch (err) {
      if (isStaleAccountError(err)) throw err;
      groups.push({ folderId, rows: [], failed: true });
    }
    if (!isCurrentAccountEpoch(epoch)) throw new StaleAccountError('Folder activity');
  }
  return groups;
}
