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
const { PREVIEW_EXPORT_ROOT, prepareExportShareCopy, assertExportTargetInsideFolder } = await import('./export-share-copy');
const { exportFileName } = await import('./export-file-name');

// The path a file-system layer opens for a `file://` URI: like NSURL /
// android.net.Uri, a `?` starts the query and a `#` the fragment, and the
// path is percent-decoded. Deliberately NOT the module's own decoder.
const openedPath = (uri: string) => decodeURIComponent(new URL(uri).pathname);

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
    // Round 2 (mobile#254 review): the name is percent-encoded in the URI;
    // the file the file-system layer writes (the decoded path) has it exactly.
    expect(multibyte.uri.endsWith(`/${encodeURIComponent('Überweisung März.pdf')}`)).toBe(true);
    expect(openedPath(multibyte.uri).endsWith('/Überweisung März.pdf')).toBe(true);
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

// Round 2 (mobile#254 review, P1): a hostile shared-file name is path syntax
// once the file-system layer percent-decodes the target URI. Every name below
// must land in the per-export folder, as one file, and nowhere else.
const HOSTILE_NAMES = [
  '..%2F..%2Fx',
  '%2e%2e%2f%2e%2e%2fescape.txt',
  '../../../Documents/x.pdf',
  '..\\..\\x.txt',
  'a#b?c.txt',
  '100%.txt',
  '%00nul.txt',
  'invoice\u202Efdp.exe',
  'pho\u200Bto.jpg',
  'line\u2028break.txt',
  'CON.txt',
  'a<b>c|d*e"f:g.txt',
  '%2F',
  '/',
  '..',
];

describe('round 2: a hostile name never leaves the per-export folder', () => {
  for (const name of HOSTILE_NAMES) {
    test(`${JSON.stringify(name)} lands inside beebeeb-export/<random>/ as one file`, async () => {
      const copy = await prepareExportShareCopy({ sourceUri: 'file:///cache/preview/p.bin', displayName: name, idBasedName: 'id.bin' });
      const folderPath = openedPath(copy.folderUri);
      const targetPath = openedPath(copy.uri);
      expect(folderPath.startsWith('/cache/beebeeb-export/')).toBe(true);
      expect(targetPath.startsWith(folderPath)).toBe(true);
      const leaf = targetPath.slice(folderPath.length);
      // The file opened is the file named: nothing cut off at a `?` or `#`.
      expect(leaf).toBe(exportFileName(name, 'id.bin'));
      expect(leaf.length).toBeGreaterThan(0);
      expect(leaf).not.toContain('/');
      expect(leaf).not.toContain('\\');
      expect(leaf === '.' || leaf === '..').toBe(false);
      // Decoding once more (a layer that decodes twice) still stays inside.
      expect(decodeURIComponent(leaf)).not.toContain('/');
      // Saves on any filesystem, and shows what it is in the share sheet.
      expect(leaf).not.toMatch(/[<>:"|?*%#]/);
      expect(leaf).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(leaf).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i);
      expect(calls.find((c) => c.op === 'copy')?.args[0]).toEqual({ from: 'file:///cache/preview/p.bin', to: copy.uri });
    });
  }

  test('the containment check refuses a target outside its folder', () => {
    expect(() => assertExportTargetInsideFolder('file:///cache/beebeeb-export/r/..%2Fx', 'file:///cache/beebeeb-export/r/', '../x')).toThrow();
    expect(() => assertExportTargetInsideFolder('file:///cache/beebeeb-export/r/a%2Fb', 'file:///cache/beebeeb-export/r/', 'a_b')).toThrow();
    expect(() => assertExportTargetInsideFolder('file:///cache/beebeeb-export/r/a_b', 'file:///cache/beebeeb-export/r/', 'a_b')).not.toThrow();
  });
});

describe('the export directory is a registered plaintext leaf', () => {
  test('lives in the beebeeb-export cache dir that the sign-out purge sweeps', () => {
    expect(PREVIEW_EXPORT_ROOT).toBe('file:///cache/beebeeb-export/');
    expect(cachesEntryFor('beebeeb-export')?.plaintext).toBe(true);
    expect(isCachesPlaintextName('beebeeb-export')).toBe(true);
  });
});
