/**
 * zip-tree — RN-free projection of a flat zip entry list into a navigable
 * folder tree (task 0779). Kept import-free so it's unit-testable under bun
 * (the ZipRenderer that consumes it pulls in JSZip + react-native, which bun
 * can't parse — same reasoning as transfer-crypto, task 0675).
 */

export interface ZipEntry {
  path: string;
  name: string;
  isFolder: boolean;
  uncompressedSize: number;
  modifiedAt: Date | null;
  ext: string;
}

export type ZipRow =
  | { kind: 'folder'; name: string; fileCount: number }
  | { kind: 'file'; entry: ZipEntry };

/**
 * macOS resource-fork noise that should be hidden from the listing: the
 * `__MACOSX/` shadow tree and `._*` AppleDouble sidecars (anywhere in the path).
 */
export function isMacOsNoise(path: string): boolean {
  return path.startsWith('__MACOSX/') || path === '__MACOSX' || /(^|\/)\._/.test(path);
}

/**
 * Immediate children at a folder prefix ('' = root, 'Ai-iris/' = inside
 * Ai-iris). Folders are derived from BOTH explicit dir entries AND the implied
 * parents of deeper files, so navigation works whether or not the archive stored
 * directory entries. Folders first (with a descendant-file count), then files,
 * each sorted A→Z.
 */
export function levelRows(entries: ZipEntry[], prefix: string): ZipRow[] {
  const folderFileCounts = new Map<string, number>();
  const files: ZipEntry[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (rest === '') continue; // the prefix folder's own dir entry
    const slash = rest.indexOf('/');
    if (slash === -1) {
      if (e.isFolder) {
        if (!folderFileCounts.has(rest)) folderFileCounts.set(rest, 0);
      } else {
        files.push(e);
      }
    } else {
      const folder = rest.slice(0, slash);
      folderFileCounts.set(folder, (folderFileCounts.get(folder) ?? 0) + (e.isFolder ? 0 : 1));
    }
  }
  const folders: ZipRow[] = [...folderFileCounts.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ kind: 'folder', name, fileCount: folderFileCounts.get(name) ?? 0 }));
  const fileRows: ZipRow[] = files
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ kind: 'file', entry }));
  return [...folders, ...fileRows];
}
