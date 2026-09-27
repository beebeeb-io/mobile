// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 round 2 (#141 re-review P2-E) — every Library/Caches writer is in
 * ONE registry, and the purge removes exactly the plaintext entries.
 * Mutation evidence: task 1593 Notes (round 2).
 */
import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

mock.module('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/' }));
const { CACHES_REGISTRY, cachesEntryFor, isCachesPlaintextName, purgeCachesPlaintext } = await import('./caches-plaintext-registry');
const { sharedCacheFileName } = await import('./share-file-name');

const SRC = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'caches-plaintext-registry.ts') out.push(p);
  }
  return out;
}

/**
 * Every `${FileSystem.cacheDirectory}<literal>…` / `${cacheDir}<literal>…`
 * path in the app source, with the literal name right after the directory.
 * A path whose name is fully dynamic must carry a
 * `// caches-registry: example=<name>` marker on the line above.
 */
function cachesWriters() {
  const found = [];
  const pathRe = /\$\{\s*(?:FileSystem\.cacheDirectory|cacheDir)(?:\s*\?\?\s*'')?\s*\}([^`$]*)/g;
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(pathRe)) {
        const literal = m[1];
        const marker = /caches-registry: example=(\S+)/.exec(lines[i - 1] ?? '')?.[1] ?? null;
        found.push({ where: `${relative(SRC, file)}:${i + 1}`, literal, example: literal || marker });
      }
    });
  }
  return found;
}

describe('the Library/Caches writer registry', () => {
  const writers = cachesWriters();

  test('the scan actually finds the writers (a scan that matches nothing proves nothing)', () => {
    expect(writers.length).toBeGreaterThanOrEqual(20);
    const wheres = writers.map((w) => w.where).join('\n');
    for (const f of ['lib/photo-cache.ts', 'lib/native-decrypt.ts', 'lib/thumbnail.ts', 'screens/SharedViewScreen.tsx', 'components/preview/ZipRenderer.tsx', 'lib/raw-extract.ts', 'screens/FilesScreen.tsx']) {
      expect(wheres).toContain(f);
    }
  });

  test('EVERY writer into Library/Caches has a registry entry', () => {
    const unregistered = writers
      .filter((w) => !w.example || !cachesEntryFor(w.example))
      .map((w) => `${w.where} → "${w.literal}"`);
    expect(unregistered).toEqual([]);
  });

  test('the decrypted-content writers from the re-review are registered as plaintext', () => {
    for (const name of [
      'beebeeb-photo-cache', // P1-A photo-cache.ts
      'preview',
      'shared_tok_report.pdf', // SharedViewScreen
      'thumb_source_abc_x.jpg', // thumbnail.ts repair
      'zip-extract', // ZipRenderer
      'beebeeb-export', // FilesScreen Save to Files
      'upload-abc-IMG_1.jpg',
      'new-abc',
      'beebeeb-scan-abc.pdf',
      '0e6a0b53-2b83-4d86-8c85-2b8d3c7a0a11_photo.jpg', // legacy PreviewScreen copy
    ]) {
      expect(isCachesPlaintextName(name)).toBe(true);
    }
  });

  test('sharedCacheFileName always yields a registered (shared_) name', () => {
    const name = sharedCacheFileName({}, { name: 'Secret plan.pdf', mimeType: 'application/pdf' }, 'tok123');
    expect(name.startsWith('shared_')).toBe(true);
    expect(isCachesPlaintextName(name)).toBe(true);
    expect(isCachesPlaintextName(sharedCacheFileName({}, null, 'tok123'))).toBe(true);
  });

  test('ciphertext / system entries are not plaintext', () => {
    for (const name of ['beebeeb-upload-1-x.bin', 'beebeeb-welcome-1.md', 'beebeeb-plaintext-audit.json', 'io.beebeeb.app', 'com.apple.nsurlsessiond', 'Snapshots']) {
      expect(isCachesPlaintextName(name)).toBe(false);
    }
    expect(CACHES_REGISTRY.every((e) => e.contains.length > 0 && e.writer.length > 0)).toBe(true);
  });
});

describe('purgeCachesPlaintext', () => {
  test('deletes every registered plaintext entry and nothing else', async () => {
    const present = [
      'preview', 'beebeeb-photo-cache', 'zip-extract', 'beebeeb-export', 'shared_tok_a.pdf',
      'thumb_source_1_a.jpg', 'upload-1-a.jpg', 'new-1', 'beebeeb-photos-1.zip', 'beebeeb-scan-1.pdf',
      'beebeeb-data-export-1.zip', 'beebeeb-proof-1.txt', 'device_manifest_1.json', 'beebeeb-transfer', 'Plan.pdf.beebeeb.enc',
      // must survive:
      'io.beebeeb.app', 'com.apple.nsurlsessiond', 'beebeeb-upload-1.bin', 'beebeeb-welcome-1.md', 'beebeeb-plaintext-audit.json',
    ];
    const deleted = [];
    const removed = await purgeCachesPlaintext({
      cacheDirectory: 'file:///cache/',
      readDirectoryAsync: async () => present,
      deleteAsync: async (uri) => { deleted.push(uri); },
    });
    expect(removed.length).toBe(15);
    expect(deleted.sort()).toEqual(present.slice(0, 15).map((n) => `file:///cache/${n}`).sort());
  });

  test('never throws (sign-out must not break)', async () => {
    await expect(purgeCachesPlaintext({
      cacheDirectory: 'file:///cache/',
      readDirectoryAsync: async () => { throw new Error('io'); },
      deleteAsync: async () => {},
    })).resolves.toEqual([]);
    await expect(purgeCachesPlaintext({
      cacheDirectory: 'file:///cache/',
      readDirectoryAsync: async () => ['preview'],
      deleteAsync: async () => { throw new Error('io'); },
    })).resolves.toEqual(['preview']);
  });
});

describe('writers that must delete their own copy', () => {
  const files = readFileSync(join(SRC, 'screens/FilesScreen.tsx'), 'utf8');
  test('the pre-upload photo copy (upload-*) is deleted after the upload + thumbnails, and on failure', () => {
    expect(files).toMatch(/\]\)\.then\(\(\) => discardUploadCacheCopy\(copyUri, asset\.uri\)\);/);
    expect(files).toMatch(/\} catch \(err\) \{\s*if \(uploadUri\) void discardUploadCacheCopy\(uploadUri, asset\.uri\);/);
  });
});
