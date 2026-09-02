// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  countMatchesElsewhere,
  matchesSearchFilterKind,
  mergeRankedSearchResults,
  splitForHighlight,
  SEARCH_FILTER_KINDS,
} from './search-filter';

const ALL_CATEGORIES = ['folder', 'image', 'pdf', 'audio', 'video', 'doc', 'file'] as const;

describe('search filter kinds', () => {
  test('all matches every category', () => {
    for (const category of ALL_CATEGORIES) {
      expect(matchesSearchFilterKind(category, 'all')).toBe(true);
    }
  });

  test('folders matches only the folder category', () => {
    expect(matchesSearchFilterKind('folder', 'folders')).toBe(true);
    for (const category of ALL_CATEGORIES.filter((c) => c !== 'folder')) {
      expect(matchesSearchFilterKind(category, 'folders')).toBe(false);
    }
  });

  test('photos matches only the image category', () => {
    expect(matchesSearchFilterKind('image', 'photos')).toBe(true);
    for (const category of ALL_CATEGORIES.filter((c) => c !== 'image')) {
      expect(matchesSearchFilterKind(category, 'photos')).toBe(false);
    }
  });

  test('videos matches only the video category', () => {
    expect(matchesSearchFilterKind('video', 'videos')).toBe(true);
    for (const category of ALL_CATEGORIES.filter((c) => c !== 'video')) {
      expect(matchesSearchFilterKind(category, 'videos')).toBe(false);
    }
  });

  test('documents catches pdf/doc/audio/file — the four buckets with no capsule of their own', () => {
    for (const category of ['pdf', 'doc', 'audio', 'file'] as const) {
      expect(matchesSearchFilterKind(category, 'documents')).toBe(true);
    }
    expect(matchesSearchFilterKind('folder', 'documents')).toBe(false);
    expect(matchesSearchFilterKind('image', 'documents')).toBe(false);
    expect(matchesSearchFilterKind('video', 'documents')).toBe(false);
  });

  test('every declared capsule kind is a real matcher branch', () => {
    for (const { value } of SEARCH_FILTER_KINDS) {
      expect(() => matchesSearchFilterKind('file', value)).not.toThrow();
    }
  });
});

describe('mergeRankedSearchResults', () => {
  type Item = { id: string; category: 'image' | 'video' | 'doc' };
  const categoryOf = (i: Item) => i.category;

  test('preserves the vault index relevance order — regression for a real bug', () => {
    // The FIRST 1338b draft ran `applySortOrder` over this merged list,
    // which silently re-sorted a relevance-ranked result by the ambient
    // browsing sortOrder (date-desc by default) — the best match could sink
    // to last. This function has no sort concept at all: feeding it a
    // deliberately date-losing rank order and asserting that order survives
    // verbatim is the regression test.
    const vaultResults: Item[] = [
      { id: 'best-match-but-oldest', category: 'doc' },
      { id: 'second-match', category: 'doc' },
      { id: 'worst-match-but-newest', category: 'doc' },
    ];
    const merged = mergeRankedSearchResults(vaultResults, [], categoryOf, 'all');
    expect(merged.map((m) => m.id)).toEqual([
      'best-match-but-oldest',
      'second-match',
      'worst-match-but-newest',
    ]);
  });

  test('appends local fallback matches after the ranked vault results, deduped by id', () => {
    const vaultResults: Item[] = [{ id: 'a', category: 'doc' }, { id: 'b', category: 'doc' }];
    const localFallback: Item[] = [{ id: 'b', category: 'doc' }, { id: 'c', category: 'doc' }];
    const merged = mergeRankedSearchResults(vaultResults, localFallback, categoryOf, 'all');
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  test('applies the kind filter as a pure subtraction that does not reorder survivors', () => {
    const vaultResults: Item[] = [
      { id: 'doc-1', category: 'doc' },
      { id: 'image-1', category: 'image' },
      { id: 'doc-2', category: 'doc' },
      { id: 'video-1', category: 'video' },
    ];
    const merged = mergeRankedSearchResults(vaultResults, [], categoryOf, 'documents');
    expect(merged.map((m) => m.id)).toEqual(['doc-1', 'doc-2']);
  });
});

describe('search match highlighting', () => {
  test('returns null for an empty or blank query', () => {
    expect(splitForHighlight('Invoice-2026-081.pdf', '')).toBeNull();
    expect(splitForHighlight('Invoice-2026-081.pdf', '   ')).toBeNull();
  });

  test('returns null when the query does not appear in the name', () => {
    expect(splitForHighlight('Invoice-2026-081.pdf', 'zzz')).toBeNull();
  });

  test('splits case-insensitively around a match at the start of the name', () => {
    expect(splitForHighlight('Invoice-2026-081.pdf', 'inv')).toEqual({
      before: '',
      match: 'Inv',
      after: 'oice-2026-081.pdf',
    });
  });

  test('finds a match in the middle of the name, preserving original casing', () => {
    expect(splitForHighlight('summer-Clip-final.mov', 'clip')).toEqual({
      before: 'summer-',
      match: 'Clip',
      after: '-final.mov',
    });
  });

  test('highlights only the first occurrence when the query repeats', () => {
    expect(splitForHighlight('photo-photo-final.jpg', 'photo')).toEqual({
      before: '',
      match: 'photo',
      after: '-photo-final.jpg',
    });
  });

  test('non-ASCII casing does not shift the match — regression for a real bug', () => {
    // Turkish İ (U+0130) lowercases to "i̇" (i + combining dot above, TWO
    // UTF-16 units), which used to shift every index found via
    // `name.toLowerCase().indexOf(query.toLowerCase())` out from under the
    // original (shorter) string. The buggy implementation returned
    // `match: 'rip.'` here instead of 'Trip'.
    expect(splitForHighlight('İstanbul Trip.pdf', 'Trip')).toEqual({
      before: 'İstanbul ',
      match: 'Trip',
      after: '.pdf',
    });
  });

  test('a query containing regex metacharacters is treated as a literal string', () => {
    expect(splitForHighlight('Q1 (draft).pdf', '(draft)')).toEqual({
      before: 'Q1 ',
      match: '(draft)',
      after: '.pdf',
    });
  });
});

describe('countMatchesElsewhere', () => {
  const entries = [
    { id: 'in-folder-doc', category: 'doc' as const },
    { id: 'elsewhere-doc', category: 'doc' as const },
    { id: 'elsewhere-image', category: 'image' as const },
    { id: 'elsewhere-video', category: 'video' as const },
  ];
  const visibleIds = new Set(['in-folder-doc']);

  test('counts only matches outside the visible set when kind is "all"', () => {
    expect(countMatchesElsewhere(entries, visibleIds, 'all')).toBe(3);
  });

  test('respects the active filter capsule — regression for a real bug', () => {
    // The hint used to count every elsewhere-match regardless of which
    // capsule was selected, so it could promise "2 matches elsewhere" while
    // the active "Photos" filter would only ever show 1 of them.
    expect(countMatchesElsewhere(entries, visibleIds, 'photos')).toBe(1);
    expect(countMatchesElsewhere(entries, visibleIds, 'videos')).toBe(1);
    expect(countMatchesElsewhere(entries, visibleIds, 'documents')).toBe(1);
    expect(countMatchesElsewhere(entries, visibleIds, 'folders')).toBe(0);
  });

  test('a visible match never counts as elsewhere, in any kind', () => {
    expect(countMatchesElsewhere(entries, visibleIds, 'documents')).not.toBe(2);
  });
});
