/**
 * move-picker-folders — pure folder-tree discovery for PreviewScreen's
 * "Move to…" (task 1563 preview redesign, item 4).
 *
 * FilesScreen already has a "Move" flow (`FolderPickerModal` +
 * `buildPickerFolders` + `moveFile`), built for moving possibly-FOLDER
 * items, so it also excludes the moved items' own descendants (a folder
 * can't move into itself) and prefers the cached `sync.allNodes()` tree,
 * falling back to a flat ROOT-ONLY `listAllFiles()` when sync isn't ready.
 * Preview's ⋯ menu only ever moves a single FILE (never a folder — Preview
 * has no "open a folder" concept), so the descendant-exclusion step doesn't
 * apply, but the root-only fallback isn't good enough here: it's Preview's
 * ONLY path (no sync engine is wired into this screen at all), and a picker
 * that can't be drilled into past the root would be a materially worse
 * "Move to…" than the one FilesScreen already ships.
 *
 * `collectAllFolders` closes that gap: given a per-folder lister (the
 * caller supplies `listAllFiles` from `lib/api.ts`, kept out of this module
 * so it stays a pure, network-free unit), it walks the WHOLE folder tree
 * breadth-first — root, then every folder's children, then THEIR children —
 * so `FolderPickerModal`'s own breadcrumb drilling (which expects the full
 * flat folder list up front, not a lazy per-level fetch) has real data at
 * every depth, not just the root.
 */

import type { FileEntry } from './api';

export interface MovePickerFolderNode {
  id: string;
  name_encrypted: string;
  parent_id: string | null;
}

/** Default cap on how many folders `collectAllFolders` will discover before
 * it stops walking deeper. Guards a pathological vault (or a bug in the
 * lister) from turning "open the Move sheet" into an unbounded fetch loop —
 * no real Beebeeb vault is expected to come close to it. */
export const MOVE_PICKER_MAX_FOLDERS = 2000;

/**
 * Breadth-first walk of the vault's folder tree via a caller-supplied
 * lister (one call per level, not one call per folder pair — same shape as
 * `listAllFiles(parentId)`). Returns every folder found (never files),
 * each visited exactly once even if `listChildren` were ever to return the
 * same id twice at the same level.
 */
export async function collectAllFolders(
  listChildren: (parentId: string | null) => Promise<FileEntry[]>,
  maxFolders: number = MOVE_PICKER_MAX_FOLDERS,
): Promise<MovePickerFolderNode[]> {
  const found: MovePickerFolderNode[] = [];
  const visited = new Set<string>();
  let frontier: Array<string | null> = [null];

  while (frontier.length > 0 && found.length < maxFolders) {
    const nextFrontier: Array<string | null> = [];
    for (const parentId of frontier) {
      const children = await listChildren(parentId);
      for (const entry of children) {
        if (!entry.is_folder) continue;
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
        found.push({
          id: entry.id,
          name_encrypted: entry.name_encrypted ?? '',
          parent_id: entry.parent_id ?? null,
        });
        nextFrontier.push(entry.id);
        if (found.length >= maxFolders) break;
      }
      if (found.length >= maxFolders) break;
    }
    frontier = nextFrontier;
  }
  return found;
}

/**
 * Best-effort display name for a folder whose decrypted name failed to
 * resolve (crypto error, or a legacy plaintext name that never was a JSON
 * metadata blob) — same shape as FilesScreen's own private `displayName`
 * fallback, kept here as a named export so this module's tests can pin it
 * without duplicating the truncation rule silently.
 */
export function movePickerFolderFallbackName(node: MovePickerFolderNode): string {
  const raw = node.name_encrypted;
  if (!raw) return 'Untitled folder';
  if (raw.startsWith('{')) return 'Untitled folder';
  if (raw.length > 32) return `${raw.slice(0, 24)}...`;
  return raw;
}
