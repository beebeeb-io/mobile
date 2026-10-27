// @ts-nocheck
/**
 * Task 2238 (mobile) — a folder "Share link" is a snapshot bundle of the
 * folder's files, with each item's relative path as a display prefix.
 *
 * RED-first: written against the pre-2238 tree, where no folder walk exists and
 * the sheet mints a `file` share on the folder id (the guest page then dies on
 * the server's `400 cannot download a folder`). Run against that tree this file
 * fails at import time (0 pass, module not found).
 */
import { describe, expect, test } from 'bun:test';
import { FOLDER_BUNDLE_MAX_ITEMS, collectFolderBundle } from './folder-bundle';
import type { FolderBundleDeps, FolderBundleNode } from './folder-bundle';

function node(id: string, name: string, extra: Partial<FolderBundleNode> = {}): FolderBundleNode {
  return { id, name_encrypted: `enc:${name}`, is_folder: false, is_trashed: false, ...extra };
}

function treeDeps(): FolderBundleDeps & { calls: string[] } {
  const calls: string[] = [];
  const tree: Record<string, FolderBundleNode[]> = {
    root: [
      node('f-beach', 'beach.jpg'),
      node('f-holiday', 'Holiday', { is_folder: true }),
      node('f-notes', 'notes.txt'),
      node('f-old', 'old.txt', { is_trashed: true }),
      node('f-trash', 'Trashed', { is_folder: true, is_trashed: true }),
    ],
    'f-holiday': [
      node('f-2024', '2024', { is_folder: true }),
      node('f-beach-in', 'beach.jpg'),
    ],
    'f-2024': [node('f-sunset', 'sunset.png')],
  };
  return {
    calls,
    listChildren: async (folderId: string) => {
      calls.push(folderId);
      return tree[folderId] ?? [];
    },
    decryptName: async (n: FolderBundleNode) => n.name_encrypted.replace(/^enc:/, ''),
  };
}

describe('collectFolderBundle (2238)', () => {
  test('walks the whole subtree down to nested folders, deterministically', async () => {
    const scan = await collectFolderBundle('root', treeDeps());
    expect(scan.overCap).toBe(false);
    expect(scan.files.map((f) => `${f.fileId}|${f.position}|${f.name}`)).toEqual([
      'f-beach|0|beach.jpg',
      'f-sunset|1|sunset.png',
      'f-beach-in|2|beach.jpg',
      'f-notes|3|notes.txt',
    ]);
    // Bundles are flat: the same name in a subfolder is its OWN item.
    expect(scan.files.filter((f) => f.name === 'beach.jpg')).toHaveLength(2);
  });

  test('skips trashed files and never descends into a trashed folder', async () => {
    const deps = treeDeps();
    const scan = await collectFolderBundle('root', deps);
    expect(scan.files.filter((f) => f.fileId === 'f-old')).toHaveLength(0);
    expect(deps.calls.indexOf('f-trash')).toBe(-1);
  });

  test('over the cap: overCap true and stops at the cap', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => node(`f-${n}`, `${n}.txt`));
    const scan = await collectFolderBundle(
      'root',
      { listChildren: async () => many, decryptName: async (n) => n.name_encrypted.slice(4) },
      { maxItems: 3 },
    );
    expect(scan.overCap).toBe(true);
    expect(scan.files).toHaveLength(3);
    expect(FOLDER_BUNDLE_MAX_ITEMS).toBe(256);
  });

  test('an empty folder is zero files, not an error', async () => {
    const scan = await collectFolderBundle('root', {
      listChildren: async () => [],
      decryptName: async () => null,
    });
    expect(scan.files).toEqual([]);
    expect(scan.overCap).toBe(false);
  });

  test('an undecryptable name still yields an item (sorted by id)', async () => {
    const scan = await collectFolderBundle('root', {
      listChildren: async () => [node('b-id', 'b'), node('a-id', 'a')],
      decryptName: async () => null,
    });
    expect(scan.files.map((f) => f.fileId)).toEqual(['a-id', 'b-id']);
    expect(scan.files.map((f) => f.name)).toEqual([null, null]);
  });

});
