// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  buildFolderParentMap,
  isAncestorExcluded,
  filterByExcludedFolders,
  filterByExcludedFoldersDirect,
  mediaCountByFolder,
} from './photo-library-filter';

// Index shape: Music/ → Album/ → cover.jpg ; root camera roll photo at top level.
const index = [
  { id: 'music', is_folder: true, parent_id: null },
  { id: 'album', is_folder: true, parent_id: 'music' },
  { id: 'roll', is_folder: true, parent_id: null },
  { id: 'cover', is_folder: false, parent_id: 'album' },
  { id: 'song', is_folder: false, parent_id: 'album' },
  { id: 'selfie', is_folder: false, parent_id: 'roll' },
  { id: 'loose', is_folder: false, parent_id: null },
];

const candidates = [
  { id: 'cover', parent_id: 'album' },
  { id: 'selfie', parent_id: 'roll' },
  { id: 'loose', parent_id: null },
];

describe('buildFolderParentMap', () => {
  test('maps only folder rows to their parent', () => {
    const map = buildFolderParentMap(index);
    expect(map.get('album')).toBe('music');
    expect(map.get('music')).toBe(null);
    expect(map.has('cover')).toBe(false); // not a folder
  });
});

describe('filterByExcludedFolders (transitive)', () => {
  test('empty exclusion set returns everything', () => {
    expect(filterByExcludedFolders(index, candidates, [])).toEqual(candidates);
  });

  test('direct exclusion hides the cover in its own folder', () => {
    const result = filterByExcludedFolders(index, candidates, ['album']);
    expect(result.map((e) => e.id)).toEqual(['selfie', 'loose']);
  });

  test('transitive exclusion: excluding Music hides the nested album cover', () => {
    const result = filterByExcludedFolders(index, candidates, ['music']);
    expect(result.map((e) => e.id)).toEqual(['selfie', 'loose']);
  });

  test('excluding the camera roll hides only the selfie', () => {
    const result = filterByExcludedFolders(index, candidates, ['roll']);
    expect(result.map((e) => e.id)).toEqual(['cover', 'loose']);
  });

  test('root-level (parent_id null) media is never excluded by a folder id', () => {
    const result = filterByExcludedFolders(index, candidates, ['music', 'roll', 'album']);
    expect(result.map((e) => e.id)).toEqual(['loose']);
  });
});

describe('isAncestorExcluded cycle guard', () => {
  test('does not loop forever on a cyclic parent chain', () => {
    const cyclic = [
      { id: 'a', is_folder: true, parent_id: 'b' },
      { id: 'b', is_folder: true, parent_id: 'a' },
    ];
    const parentById = buildFolderParentMap(cyclic);
    // 'a'/'b' form a cycle; an unrelated excluded id must terminate, not hang.
    expect(isAncestorExcluded('a', new Set(['zzz']), parentById)).toBe(false);
    expect(isAncestorExcluded('a', new Set(['b']), parentById)).toBe(true);
  });
});

describe('filterByExcludedFoldersDirect (legacy fallback)', () => {
  test('only the direct parent is honoured (no ancestry)', () => {
    // 'cover' parent is 'album'; excluding 'music' does NOT hide it on the
    // legacy path because there is no folder tree to walk.
    expect(filterByExcludedFoldersDirect(candidates, ['music']).map((e) => e.id)).toEqual([
      'cover',
      'selfie',
      'loose',
    ]);
    expect(filterByExcludedFoldersDirect(candidates, ['album']).map((e) => e.id)).toEqual([
      'selfie',
      'loose',
    ]);
  });
});

describe('mediaCountByFolder', () => {
  test('attributes each media file to every ancestor folder', () => {
    const counts = mediaCountByFolder(index, candidates);
    // cover → album + music ; selfie → roll ; loose → (root, no folder)
    expect(counts.get('album')).toBe(1);
    expect(counts.get('music')).toBe(1);
    expect(counts.get('roll')).toBe(1);
    expect(counts.has('loose')).toBe(false);
  });
});
