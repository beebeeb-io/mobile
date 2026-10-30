/** C0 listing interface. Attribution is explicit; request uploads keep their own key path. */
export interface TreeNode {
  id: string; parent_id?: string | null; is_trashed?: boolean; trashed_at?: string | null;
  file_request_id?: string | null; acted_via_share_id?: string | null; uploaded_by?: string | null;
  owner_wrapped_file_key?: string | number[] | null;
}
let nodes = new Map<string, TreeNode>();
export function ingestTree(rows: TreeNode[]): void { nodes = new Map(rows.map(row => [row.id, { ...nodes.get(row.id), ...row }])); }
export function parentOf(id: string): string | null { return nodes.get(id)?.parent_id ?? null; }
export function treeNode(id: string): TreeNode | undefined { return nodes.get(id); }
export function isForeignSharedFile(id: string, accountId: string | null): boolean {
  const row = nodes.get(id);
  return !!row && !row.file_request_id && (!!row.acted_via_share_id || (!!row.uploaded_by && row.uploaded_by !== accountId) || !!row.owner_wrapped_file_key);
}
/**
 * The ids a batch name decrypt may hand to the owner resolver: everything this
 * account owns. A row the tree marks foreign is excluded, so its table key (or
 * its table-key failure) stays final — SF-0002's shared-folder boundary.
 */
export function nonForeignFileIds(items: { fileId: string }[], accountId: string | null): string[] {
  return items.filter(item => !isForeignSharedFile(item.fileId, accountId)).map(item => item.fileId);
}
export function ancestorsOf(id: string, maxDepth = 32): string[] {
  const out: string[] = [], seen = new Set([id]); let parent = parentOf(id);
  while (parent && !seen.has(parent) && out.length < Math.min(32, maxDepth)) { seen.add(parent); out.push(parent); parent = parentOf(parent); }
  return out;
}
export function subtreeIds(rootId: string): string[] {
  const children = new Map<string, TreeNode[]>();
  for (const row of nodes.values()) if (row.parent_id) { const list = children.get(row.parent_id) ?? []; list.push(row); children.set(row.parent_id, list); }
  const out: string[] = [], seen = new Set([rootId]), queue = [rootId];
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
    if (seen.has(child.id) || child.is_trashed || child.trashed_at || child.file_request_id) continue;
    seen.add(child.id); out.push(child.id); queue.push(child.id);
  }
  return out;
}
export function clearTree(): void { nodes.clear(); }
