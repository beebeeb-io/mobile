// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { matchesSearchFilterKind, splitForHighlight, SEARCH_FILTER_KINDS } from './search-filter';

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
});
