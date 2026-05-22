// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  activePhotoPageIndices,
  clampPhotoIndex,
  photoPrefetchOrder,
} from './photo-viewer-window';

describe('photo viewer window helpers', () => {
  test('keeps only the current page and direct neighbors active', () => {
    expect([...activePhotoPageIndices(3, 8)]).toEqual([2, 3, 4]);
    expect([...activePhotoPageIndices(0, 8)]).toEqual([0, 1]);
    expect([...activePhotoPageIndices(7, 8)]).toEqual([6, 7]);
  });

  test('prefetches current, next, previous, then wider neighbors', () => {
    expect(photoPrefetchOrder(3, 8, 2)).toEqual([3, 4, 2, 5, 1]);
    expect(photoPrefetchOrder(0, 4, 2)).toEqual([0, 1, 2]);
    expect(photoPrefetchOrder(3, 4, 2)).toEqual([3, 2, 1]);
  });

  test('clamps invalid route indices to available photos', () => {
    expect(clampPhotoIndex(-4, 5)).toBe(0);
    expect(clampPhotoIndex(9, 5)).toBe(4);
    expect(clampPhotoIndex(2, 5)).toBe(2);
    expect(clampPhotoIndex(2, 0)).toBe(0);
  });
});
