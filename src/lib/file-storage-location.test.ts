// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1919 review (mobile#178, P1): the Encryption details sheet is opened
// from a CRDT-backed row (`syncNodeToFileEntry`), which carries no
// `storage_location`. With several live datacenters the default city is
// withheld, so without a fetch a file in another datacenter read "Europe". The sheet now
// reads the file's own location from GET /api/v1/files/:id.
import { describe, expect, mock, test } from 'bun:test';

mock.module('./api', () => ({
  getFile: async () => {
    throw new Error('default fetcher must not be used in these tests');
  },
}));

const { loadFileStorageLocation } = await import('./file-storage-location');

const hel = { region: 'hel1', city: 'Helsinki', provider: 'x' };

describe('loadFileStorageLocation (task 1919 review)', () => {
  test('a row without a per-file location is completed from GET /files/:id', async () => {
    const calls: string[] = [];
    const loc = await loadFileStorageLocation({ id: 'f1' }, async (id) => {
      calls.push(id);
      return { storage_location: hel };
    });
    expect(calls).toEqual(['f1']);
    expect(loc).toEqual(hel);
  });

  test('a row that already names its city is not refetched', async () => {
    let calls = 0;
    const loc = await loadFileStorageLocation({ id: 'f2', storage_location: hel }, async () => {
      calls += 1;
      return { storage_location: null };
    });
    expect(calls).toBe(0);
    expect(loc).toEqual(hel);
  });

  test('a placeless per-file value ("Unknown") is refetched, not trusted', async () => {
    const loc = await loadFileStorageLocation(
      { id: 'f3', storage_location: { city: 'Unknown' } },
      async () => ({ storage_location: hel }),
    );
    expect(loc).toEqual(hel);
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
