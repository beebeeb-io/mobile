// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1919 review (mobile#178, P1), by COUNTRY since task 2050: the Encryption
// details sheet is opened from a CRDT-backed row (`syncNodeToFileEntry`), which
// carries no `storage_location`. Without a fetch a file read "Europe". The sheet
// reads the file's own country from GET /api/v1/files/:id. A city is never read.
import { describe, expect, mock, test } from 'bun:test';

mock.module('./api', () => ({
  getFile: async () => {
    throw new Error('default fetcher must not be used in these tests');
  },
}));

const { loadFileStorageLocation } = await import('./file-storage-location');

const fi = { country: 'Finland', country_code: 'FI' };

describe('loadFileStorageLocation (task 1919 review, task 2050)', () => {
  test('a row without a per-file location is completed from GET /files/:id', async () => {
    const calls: string[] = [];
    const loc = await loadFileStorageLocation({ id: 'f1' }, async (id) => {
      calls.push(id);
      return { storage_location: fi };
    });
    expect(calls).toEqual(['f1']);
    expect(loc).toEqual(fi);
  });

  test('a row that already names its country is not refetched', async () => {
    let calls = 0;
    const loc = await loadFileStorageLocation({ id: 'f2', storage_location: fi }, async () => {
      calls += 1;
      return { storage_location: null };
    });
    expect(calls).toBe(0);
    expect(loc).toEqual(fi);
  });

  test('a placeless per-file value ("Unknown") is refetched, not trusted', async () => {
    const loc = await loadFileStorageLocation(
      { id: 'f3', storage_location: { country: 'Unknown' } },
      async () => ({ storage_location: fi }),
    );
    expect(loc).toEqual(fi);
  });

  test('a row that carries only the deprecated city has no country: it is refetched, the city is never trusted', async () => {
    let calls = 0;
    const loc = await loadFileStorageLocation(
      { id: 'f3b', storage_location: { city: 'Helsinki' } },
      async () => {
        calls += 1;
        return { storage_location: fi };
      },
    );
    expect(calls).toBe(1);
    expect(loc).toEqual(fi);
  });

  test('a failed fetch or a server with no per-file location yields null (caller falls back)', async () => {
    expect(
      await loadFileStorageLocation({ id: 'f4' }, async () => {
        throw new Error('offline');
      }),
    ).toBeNull();
    expect(await loadFileStorageLocation({ id: 'f5' }, async () => ({ storage_location: null }))).toBeNull();
    expect(await loadFileStorageLocation({ id: 'f6' }, async () => ({}))).toBeNull();
  });
});
