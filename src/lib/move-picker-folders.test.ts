// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 (preview redesign, item 4) — pure folder-tree discovery for
// "Move to…". No react-native dependency, no module mocking needed.
import { describe, expect, test } from 'bun:test';
import { collectAllFolders, movePickerFolderFallbackName } from './move-picker-folders';
import type { FileEntry } from './api';

function entry(partial: Partial<FileEntry> & { id: string; is_folder: boolean; parent_id?: string | null }): FileEntry {
  return {
    name_encrypted: '',
    size_bytes: 0,
    chunk_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    parent_id: null,
    ...partial,
  } as FileEntry;
}

describe('collectAllFolders', () => {
  test('walks the full tree breadth-first: root folders, then their children, then grandchildren', async () => {
    // root: [Work (folder), notes.txt (file)]
    // Work: [Contracts (folder), invoice.pdf (file)]
    // Contracts: [2026 (folder)]
    // 2026: []
    const byParent: Record<string, FileEntry[]> = {
      root: [
        entry({ id: 'work', is_folder: true, parent_id: null, name_encrypted: 'Work' }),
        entry({ id: 'notes', is_folder: false, parent_id: null, name_encrypted: 'notes.txt' }),
      ],
      work: [
        entry({ id: 'contracts', is_folder: true, parent_id: 'work', name_encrypted: 'Contracts' }),
        entry({ id: 'invoice', is_folder: false, parent_id: 'work', name_encrypted: 'invoice.pdf' }),
      ],
      contracts: [
        entry({ id: '2026', is_folder: true, parent_id: 'contracts', name_encrypted: '2026' }),
      ],
      '2026': [],
    };
    const calls: Array<string | null> = [];
    const listChildren = async (parentId: string | null) => {
      calls.push(parentId);
      return byParent[parentId ?? 'root'] ?? [];
    };

    const folders = await collectAllFolders(listChildren);

    expect(folders.map((f) => f.id).sort()).toEqual(['2026', 'contracts', 'work']);
    // Files (notes, invoice) never appear.
    expect(folders.some((f) => f.id === 'notes' || f.id === 'invoice')).toBe(false);
    // Visited breadth-first: root, then work's level, then contracts' level.
    expect(calls).toEqual([null, 'work', 'contracts', '2026']);
    // parent_id is carried through, not dropped or renamed.
    const contracts = folders.find((f) => f.id === 'contracts');
    expect(contracts?.parent_id).toBe('work');
  });

  test('visits each folder id exactly once even if the lister repeats one', async () => {
    let rootCalls = 0;
    const listChildren = async (parentId: string | null) => {
      if (parentId === null) {
        rootCalls += 1;
        // A misbehaving lister returning the same folder twice in one page.
        return [
          entry({ id: 'dup', is_folder: true, parent_id: null, name_encrypted: 'Dup' }),
          entry({ id: 'dup', is_folder: true, parent_id: null, name_encrypted: 'Dup' }),
        ];
      }
      return [];
    };

    const folders = await collectAllFolders(listChildren);
    expect(rootCalls).toBe(1);
    expect(folders.length).toBe(1);
  });

  test('stops discovering new folders once maxFolders is hit, instead of walking forever', async () => {
    // A deep chain: f0 -> f1 -> f2 -> ... each with exactly one child folder.
    const listChildren = async (parentId: string | null) => {
      const depth = parentId === null ? 0 : Number(parentId.slice(1)) + 1;
      return [entry({ id: `f${depth}`, is_folder: true, parent_id: parentId, name_encrypted: `Folder ${depth}` })];
    };

    const folders = await collectAllFolders(listChildren, 5);
    expect(folders.length).toBe(5);
  });
});

describe('movePickerFolderFallbackName', () => {
  test('a JSON-encrypted-metadata blob (starts with "{") falls back to a generic label, not raw ciphertext', () => {
    expect(movePickerFolderFallbackName({ id: 'a', parent_id: null, name_encrypted: '{"v":1,"ct":"..."}' }))
      .toBe('Untitled folder');
  });

  test('a short legacy plaintext name is returned as-is', () => {
    expect(movePickerFolderFallbackName({ id: 'a', parent_id: null, name_encrypted: 'Contracts' }))
      .toBe('Contracts');
  });

  test('a long legacy plaintext name is truncated with an ellipsis', () => {
    const long = 'A'.repeat(40);
    const out = movePickerFolderFallbackName({ id: 'a', parent_id: null, name_encrypted: long });
    expect(out).toBe(`${'A'.repeat(24)}...`);
  });

  test('an empty name falls back to a generic label', () => {
    expect(movePickerFolderFallbackName({ id: 'a', parent_id: null, name_encrypted: '' }))
      .toBe('Untitled folder');
  });
});
