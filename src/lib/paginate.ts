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
