// @ts-nocheck — Bun test types are not part of the app TypeScript environment.
import { expect, test } from 'bun:test';
import { decryptNamesInBackground } from './background-name-decrypt';
const items = Array.from({ length: 25 }, (_, i) => ({ fileId: String(i), nameEncrypted: '{}' }));
const result = (name: string) => ({ name, mimeType: null, error: null });

test('25 missing names use 3 bounded native batches with a browsing yield before each', async () => {
  const calls: string[] = [];
  const applied: string[] = [];
  const count = await decryptNamesInBackground(items, async (batch) => {
    calls.push(`decrypt:${batch.length}`);
    return batch.map((item) => result(item.fileId));
  }, (item) => applied.push(item.fileId), () => false, async () => { calls.push('yield'); });
  expect(calls).toEqual(['yield', 'decrypt:12', 'yield', 'decrypt:12', 'yield', 'decrypt:1']);
  expect(count).toBe(25);
  expect(applied).toEqual(items.map((item) => item.fileId));
});

test('blur or lock during yield queues zero native work', async () => {
  let cancelled = false;
  let calls = 0;
  const count = await decryptNamesInBackground(items, async () => { calls++; return []; }, () => {}, () => cancelled, async () => { cancelled = true; });
  expect(count).toBe(0);
  expect(calls).toBe(0);
});

test('blur or account purge during native decrypt applies zero names', async () => {
  let cancelled = false;
  const applied: string[] = [];
  const count = await decryptNamesInBackground(items, async (batch) => {
    cancelled = true;
    return batch.map((item) => result(item.fileId));
  }, (item) => applied.push(item.fileId), () => cancelled, async () => {});
  expect(count).toBe(0);
  expect(applied).toEqual([]);
});

test('individual auth failures are skipped without borrowing another row name', async () => {
  const applied: string[] = [];
  expect(await decryptNamesInBackground(items.slice(0, 3), async () => [result('first'), { name: null, mimeType: null, error: 'auth' }, result('third')], (item, name) => applied.push(`${item.fileId}:${name.name}`), () => false, async () => {})).toBe(2);
  expect(applied).toEqual(['0:first', '2:third']);
});
