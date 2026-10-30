// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 2253 — the export path hands the share sheet
 * `<cache>/beebeeb-export/<random>/<decrypted name>` in a fresh per-export
 * folder, written through the sign-out plaintext gate, and removes that
 * folder once the sheet closes.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: Array<{ op: string; args: unknown }> = [];
const gateLabels: string[] = [];

mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: async (...args: unknown[]) => { calls.push({ op: 'mkdir', args }); },
  copyAsync: async (...args: unknown[]) => { calls.push({ op: 'copy', args }); },
  deleteAsync: async (...args: unknown[]) => { calls.push({ op: 'delete', args }); },
}));
mock.module('./plaintext-gate', () => ({
  gatedPlaintextWrite: async (label: string, uri: string, _fs: unknown, write: () => Promise<unknown>) => {
    gateLabels.push(`${label}@${uri}`);
    return write();
  },
}));

const { cachesEntryFor, isCachesPlaintextName } = await import('./caches-plaintext-registry');
const { PREVIEW_EXPORT_ROOT, prepareExportShareCopy } = await import('./export-share-copy');

const ID_NAME = '640d4f1e-c0cd-4b1e-9e54-1a2b3c4d5e6f.dng';

beforeEach(() => {
  calls.length = 0;
  gateLabels.length = 0;
});

describe('prepareExportShareCopy', () => {
  test('hands the sheet <dir>/<random>/IMG_0042.DNG for a file named IMG_0042.DNG (not the id)', async () => {
    const copy = await prepareExportShareCopy({
      sourceUri: 'file:///cache/preview/640d4f1e.dng',
      displayName: 'IMG_0042.DNG',
      idBasedName: ID_NAME,
      random: () => 0.4,
    });
    expect(copy.uri).toMatch(/^file:\/\/\/cache\/beebeeb-export\/[0-9a-z]+-[0-9a-f]{8}\/IMG_0042\.DNG$/);
    expect(copy.uri).not.toContain(ID_NAME);
    expect(copy.folderUri).toBe(copy.uri.slice(0, copy.uri.lastIndexOf('/') + 1));
    // The copy is created inside the fresh folder, gated in the plaintext registry.
    expect(calls.map((c) => c.op)).toEqual(['mkdir', 'copy']);
    expect(calls[0].args[0]).toBe(copy.folderUri);
    expect(calls[1].args[0]).toEqual({ from: 'file:///cache/preview/640d4f1e.dng', to: copy.uri });
    expect(gateLabels).toHaveLength(1);
    expect(gateLabels[0].endsWith(`@${copy.uri}`)).toBe(true);
  });

  test('keeps a name without an extension, and a multibyte name exactly', async () => {
    const noExt = await prepareExportShareCopy({ sourceUri: 'file:///a', displayName: 'README', idBasedName: 'id.bin' });
    expect(noExt.uri.endsWith('/README')).toBe(true);
    const multibyte = await prepareExportShareCopy({ sourceUri: 'file:///a', displayName: 'Überweisung März.pdf', idBasedName: 'id.pdf' });
    expect(multibyte.uri.endsWith('/Überweisung März.pdf')).toBe(true);
  });

  test('two exports of same-named files get different folders', async () => {
    const a = await prepareExportShareCopy({ sourceUri: 'file:///a', displayName: 'Report.pdf', idBasedName: 'id-a.pdf' });
    const b = await prepareExportShareCopy({ sourceUri: 'file:///b', displayName: 'Report.pdf', idBasedName: 'id-b.pdf' });
    expect(a.uri).not.toBe(b.uri);
    expect(a.folderUri).not.toBe(b.folderUri);
    expect(a.uri.endsWith('/Report.pdf')).toBe(true);
    expect(b.uri.endsWith('/Report.pdf')).toBe(true);
  });

  test('an undecryptable name falls back to today\'s id-based name', async () => {
    const copy = await prepareExportShareCopy({ sourceUri: 'file:///a', displayName: null, idBasedName: ID_NAME });
    expect(copy.uri.endsWith(`/${ID_NAME}`)).toBe(true);
  });

  test('the per-export subfolder is removed after the share sheet closes', async () => {
    const copy = await prepareExportShareCopy({ sourceUri: 'file:///a', displayName: 'IMG_0042.DNG', idBasedName: ID_NAME });
    calls.length = 0;
    await copy.cleanup();
    expect(calls).toEqual([{ op: 'delete', args: [copy.folderUri, { idempotent: true }] }]);
  });

  test('a failed copy removes the folder it just made (no orphan plaintext folder)', async () => {
    const deleted: unknown[] = [];
    await expect(prepareExportShareCopy({
      sourceUri: 'file:///a',
      displayName: 'x.txt',
      idBasedName: 'id.txt',
      fs: {
        cacheDirectory: 'file:///cache/',
        makeDirectoryAsync: async () => {},
        copyAsync: async () => { throw new Error('disk full'); },
        deleteAsync: async (...args: unknown[]) => { deleted.push(args); },
      },
    })).rejects.toThrow('disk full');
    expect(deleted).toHaveLength(1);
  });
});

describe('the export directory is a registered plaintext leaf', () => {
  test('lives in the beebeeb-export cache dir that the sign-out purge sweeps', () => {
    expect(PREVIEW_EXPORT_ROOT).toBe('file:///cache/beebeeb-export/');
    expect(cachesEntryFor('beebeeb-export')?.plaintext).toBe(true);
    expect(isCachesPlaintextName('beebeeb-export')).toBe(true);
  });
});
