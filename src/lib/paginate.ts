/**
 * Follow an opaque `next_cursor` until the source reports the last page (or a
 * safety cap is hit), accumulating every item in order. The cursor is a black
 * box — we only ever pass back whatever the previous page returned, never parse
 * it (task 0739 keyset pagination). `fetchPage(undefined)` fetches the first page.
 *
 * `maxTotal` is an outer bound so a pathological or hostile listing can't loop
 * unbounded or exhaust memory; on hitting it we stop and warn (the caller decides
 * whether a truncated set is acceptable for its use).
 *
 * Mirrors repos/web/src/lib/paginate.ts (task 0755 — same loop, shared core logic).
 */
export async function collectPaged<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxTotal: number,
  label = 'collectPaged',
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    cursor = nextCursor ?? undefined;
    if (all.length >= maxTotal) {
      if (cursor) {
        console.warn(`[${label}] hit ${maxTotal}-item cap — listing truncated`);
      }
      return all.slice(0, maxTotal);
    }
  } while (cursor);
  return all;
}

/**
 * Walk pages following `next_cursor`, returning the FIRST item the (possibly
 * async) predicate matches — stopping immediately on match (early-exit). Use for
 * by-name/by-id LOOKUPS where scanning/decrypting the whole vault would be
 * wasteful (task 0755). Returns `undefined` if no page matches before the cursor
 * is exhausted. A truncated single-page lookup would silently miss a target past
 * page 1 — this never does.
 *
 * `maxItems` is an outer bound (mirrors collectPaged's `maxTotal`) so a
 * pathological or hostile listing whose `next_cursor` never goes null can't loop
 * unbounded; on scanning that many items without a match we stop and warn,
 * returning `undefined`.
 */
export async function findInPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  match: (item: T) => boolean | Promise<boolean>,
  maxItems = 50_000,
): Promise<T | undefined> {
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const { items, nextCursor } = await fetchPage(cursor);
    for (const item of items) {
      if (await match(item)) return item;
      if (++scanned >= maxItems) {
        console.warn(`[findInPages] scanned ${maxItems} items without a match — stopping`);
        return undefined;
      }
    }
    cursor = nextCursor ?? undefined;
  } while (cursor);
  return undefined;
}
