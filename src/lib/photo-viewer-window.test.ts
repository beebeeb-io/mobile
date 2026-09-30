// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  activePhotoPageIndices,
  clampPhotoIndex,
  photoPrefetchOrder,
  reconcileLoadedPages,
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

describe('reconcileLoadedPages (task 1669 Issue 1 — bounded live AVPlayer/decoded-image count)', () => {
  test('releases every loaded page that is no longer active', () => {
    const loaded = new Set([1, 2, 5]);
    const active = new Set([5, 6]);
    expect(reconcileLoadedPages(loaded, active)).toEqual([1, 2]);
  });

  test('releases nothing when every loaded page is still active', () => {
    const loaded = new Set([4, 5]);
    const active = new Set([4, 5, 6]);
    expect(reconcileLoadedPages(loaded, active)).toEqual([]);
  });

  test(
    'a full scroll through a 200-item library, releasing every inactive page ' +
      'after each step, never leaves more than one page loaded at once — the ' +
      'AVPlayer/decoded-image resource bound the 08:41 jetsam kill (build 229, ' +
      '14 live AVPlayer instances) violated',
    () => {
      const total = 200;
      // radius=0, matching `activePhotoPageIndexes` in PreviewScreen.tsx —
      // exactly one page is "active" (shouldLoadFull) at a time.
      const radius = 0;
      let loaded = new Set<number>();
      let maxLoaded = 0;

      for (let i = 0; i < total; i += 1) {
        const active = activePhotoPageIndices(i, total, radius);
        // Page i becomes the current page and loads its full resource —
        // this mirrors `PhotoPage`'s decrypt effect firing once
        // `shouldLoadFull` turns true.
        loaded.add(i);
        // The fix under test: release every page that fell out of the
        // active window. Without this step (the pre-fix behavior —
        // `PhotoPage` never cleared `uri` when `shouldLoadFull` turned
        // false) `loaded` only ever grows, and `maxLoaded` reaches `total`.
        for (const index of reconcileLoadedPages(loaded, active)) {
          loaded.delete(index);
        }
        maxLoaded = Math.max(maxLoaded, loaded.size);
      }

      expect(maxLoaded).toBe(1);
      expect(loaded.size).toBe(1);
    },
  );
});
