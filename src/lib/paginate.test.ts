// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches the convention in the other src/lib/*.test.ts files).
import { describe, expect, test } from 'bun:test';
import { collectPaged, findInPages } from './paginate';

// A fake paged source: `pages[i]` is one page; the cursor is just the next page
// index as a string, so we can assert the exact cursor threading (no dup/skip).
function pagedSource(pages: number[][]) {
  const calls: (string | undefined)[] = [];
  const fetchPage = async (cursor?: string) => {
    calls.push(cursor);
    const idx = cursor === undefined ? 0 : Number(cursor);
    const items = pages[idx] ?? [];
    const nextCursor = idx + 1 < pages.length ? String(idx + 1) : null;
    return { items, nextCursor };
  };
  return { fetchPage, calls };
}

describe('collectPaged — keyset pagination loop (0739/0755)', () => {
  test('accumulates every item across pages, in order, until next_cursor is null', async () => {
    const { fetchPage, calls } = pagedSource([[1, 2], [3, 4], [5]]);
    const all = await collectPaged(fetchPage, 1000);
    expect(all).toEqual([1, 2, 3, 4, 5]);
    // First call passes no cursor; each later call passes the prior page's cursor.
    expect(calls).toEqual([undefined, '1', '2']);
  });

  test('a single page stops at the null cursor (one fetch, no dup/skip)', async () => {
    const { fetchPage, calls } = pagedSource([[1, 2, 3]]);
    expect(await collectPaged(fetchPage, 1000)).toEqual([1, 2, 3]);
    expect(calls).toEqual([undefined]);
  });

  test('enumerates PAST 200 — follows the cursor across many pages (the 0755 bug)', async () => {
    // 6 pages × 50 = 300 items (> the server's 200 default page) → all 300 walked.
    const pages = Array.from({ length: 6 }, (_, p) => Array.from({ length: 50 }, (_, i) => p * 50 + i));
    const { fetchPage, calls } = pagedSource(pages);
    const all = await collectPaged(fetchPage, 50_000);
    expect(all.length).toBe(300);
    expect(new Set(all).size).toBe(300); // no dup/skip
    expect(all[0]).toBe(0);
    expect(all[299]).toBe(299);
    expect(calls.length).toBe(6); // genuinely multi-page
  });

  test('honours the maxTotal outer bound and stops paginating early', async () => {
    // 5 pages × 100 = 500 available; cap at 250.
    const pages = Array.from({ length: 5 }, (_, p) => Array.from({ length: 100 }, (_, i) => p * 100 + i));
    const { fetchPage, calls } = pagedSource(pages);
    const all = await collectPaged(fetchPage, 250);
    expect(all.length).toBe(250);
    expect(all[0]).toBe(0);
    expect(all[249]).toBe(249);
    expect(calls.length).toBeLessThan(5); // stopped before fetching all pages
  });

  test('empty first page returns empty', async () => {
    const { fetchPage } = pagedSource([[]]);
    expect(await collectPaged(fetchPage, 1000)).toEqual([]);
  });
});

describe('findInPages — early-exit lookup across pages (0755)', () => {
  test('finds a target PAST page 1 (the truncation bug) and early-exits', async () => {
    // Target 7 is on page 3; must not stop at the capped first page, and must
    // NOT fetch page 4 once found.
    const { fetchPage, calls } = pagedSource([[1, 2], [3, 4], [5, 6, 7], [8, 9]]);
    const found = await findInPages(fetchPage, (n) => n === 7);
    expect(found).toBe(7);
    expect(calls).toEqual([undefined, '1', '2']); // stopped at page 3, never fetched page 4
  });

  test('returns undefined when no page matches (walks every page)', async () => {
    const { fetchPage, calls } = pagedSource([[1, 2], [3, 4], [5]]);
    expect(await findInPages(fetchPage, (n) => n === 99)).toBeUndefined();
    expect(calls).toEqual([undefined, '1', '2']); // exhausted the cursor
  });

  test('supports an async predicate (e.g. per-entry name decryption)', async () => {
    const { fetchPage } = pagedSource([[10, 20], [30, 40]]);
    const found = await findInPages(fetchPage, async (n) => n === 30);
    expect(found).toBe(30);
  });

  test('stops at the maxItems cap when the cursor never goes null (hostile/cyclic source)', async () => {
    // A pathological source: one item per page, cursor NEVER null → without the
    // outer bound this would loop forever. The hard ceiling below converts a
    // regression (unbounded loop) into a loud failure instead of a hung test.
    let calls = 0;
    const fetchPage = async (cursor?: string) => {
      if (++calls > 100) throw new Error('findInPages did not honour maxItems — unbounded loop');
      const idx = cursor === undefined ? 0 : Number(cursor);
      return { items: [idx], nextCursor: String(idx + 1) }; // nextCursor is NEVER null
    };
    const found = await findInPages(fetchPage, (n) => n === -1 /* never matches */, 10);
    expect(found).toBeUndefined();
    // 1 item per page × cap of 10 ⇒ stops after scanning 10 items (10 fetches).
    expect(calls).toBe(10);
  });
});
