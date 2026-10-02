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
    const result = await purgeCachesPlaintext({
      cacheDirectory: 'file:///cache/',
      readDirectoryAsync: async () => present,
      deleteAsync: async (uri) => { deleted.push(uri); },
    });
    // True counts (task 1683d): removed lists the names whose delete resolved.
    expect(result.removed.sort()).toEqual([...present.slice(0, 15)].sort());
    expect(result.failed).toEqual([]);
    expect(deleted.sort()).toEqual(present.slice(0, 15).map((n) => `file:///cache/${n}`).sort());
  });

  test('a doomed entry whose delete throws counts as FAILED, not removed (true counts)', async () => {
    const result = await purgeCachesPlaintext({
      cacheDirectory: 'file:///cache/',
      readDirectoryAsync: async () => ['preview', 'beebeeb-photo-cache'],
      deleteAsync: async (uri) => {
        if (uri.endsWith('preview')) throw new Error('ebusy');
      },
    });
    expect(result.removed).toEqual(['beebeeb-photo-cache']);
    expect(result.failed).toEqual(['preview']);
  });

  test('never throws (sign-out must not break)', async () => {
    await expect(purgeCachesPlaintext({
      cacheDirectory: 'file:///cache/',
      readDirectoryAsync: async () => { throw new Error('io'); },
      deleteAsync: async () => {},
    })).resolves.toEqual({ removed: [], failed: [] });
    await expect(purgeCachesPlaintext({
      cacheDirectory: 'file:///cache/',
      readDirectoryAsync: async () => ['preview'],
      deleteAsync: async () => { throw new Error('io'); },
    })).resolves.toEqual({ removed: [], failed: ['preview'] });
  });
});

describe('writers that must delete their own copy', () => {
  const files = readFileSync(join(SRC, 'screens/FilesScreen.tsx'), 'utf8');
  test('the pre-upload photo copy (upload-*) is deleted after the upload + thumbnails, and on failure', () => {
    expect(files).toMatch(/\]\)\.then\(\(\) => discardUploadCacheCopy\(copyUri, asset\.uri\)\);/);
    expect(files).toMatch(/\} catch \(err\) \{\s*if \(uploadUri\) void discardUploadCacheCopy\(uploadUri, asset\.uri\);/);
  });
});

describe('task 1593 round 3 — every plaintext writer goes through the purge gate', () => {
  // A registered plaintext writer that does not take a lease from
  // lib/plaintext-gate.ts can write AFTER the sign-out sweep (#141 Codex P1).
  const writers = cachesWriters();
  test('every file that writes a registered plaintext Library/Caches path imports plaintext-gate', () => {
    const offenders = [];
    const checked = new Set();
    for (const w of writers) {
      const entry = w.example ? cachesEntryFor(w.example) : null;
      if (!entry?.plaintext) continue;
      if (/cleanup only/.test(entry.writer)) continue; // deletes, never writes
      const file = w.where.replace(/:\d+$/, '');
      checked.add(file);
      const src = readFileSync(join(SRC, file), 'utf8');
      if (!/from '[./]*(?:lib\/)?plaintext-gate'/.test(src)) {
        offenders.push(w.where);
      }
    }
    // The scan must have checked the known writers, or it proves nothing.
    expect(checked.size).toBeGreaterThanOrEqual(12);
    expect(offenders).toEqual([]);
  });

  test('the JS writers of the NATIVE plaintext registry are gated too (thumbnails, names)', () => {
    for (const f of ['lib/thumbnail-cache.ts', 'lib/name-cache.ts']) {
      expect(readFileSync(join(SRC, f), 'utf8')).toMatch(/gatedPlaintextWrite\(/);
    }
  });
});

describe('task 1593 round 4 (P2-3) — the File Provider NAME cache writer is gated too', () => {
  // Round 3's "every writer imports plaintext-gate" check above only scans
  // `${FileSystem.cacheDirectory}…` / `${cacheDir}…` literals, so it never
  // looked at `<AppGroup>/file-provider-cache.sqlite` — a decrypted-name
  // cache written straight through the native bridge
  // (`BeebeebCrypto.syncFileProviderCache`), not through expo-file-system at
  // all. That gap is exactly how P1-1 (file-provider-mount.ts) shipped
  // ungated: a per-file import check would have passed for a file that never
  // imports `FileSystem` in the first place. This scans for the underlying
  // native call SITE BY SITE instead of trusting a whole-file import.
  //
  // Task 1593 round 5 (P2-5) — the literal `.syncFileProviderCache(` only
  // matches a direct dotted call with the paren on the SAME line. It misses
  // a destructured import calling the bare identifier (`syncFileProviderCache(`,
  // no leading dot), bracket access (`['syncFileProviderCache']`), and a
  // call broken across lines with the `(` on the next one
  // (`.syncFileProviderCache\n  (args)`). Matching the bare identifier with
  // word boundaries instead catches all of those; it is not fooled by a
  // narrower substring the way `.syncFileProviderCache(` was.
  const NATIVE_CALL_RE = /\bsyncFileProviderCache\b/;
  const GATED_WRAPPER = 'lib/file-provider-mount.ts';
  // The generated bridge module itself (the plain pass-through the wrapper
  // calls into) is not a "writer" — it has no gate to skip.
  const BRIDGE_DEFINITION = 'modules/beebeeb-crypto/src/BeebeebCrypto.ts';

  function nativeFileProviderCacheCallSites() {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (NATIVE_CALL_RE.test(line)) found.push(`${rel}:${i + 1}`);
      });
    }
    // The bridge module itself lives one level up from `SRC` (src/lib/..) —
    // `sourceFiles(SRC)` never walks there, so it can't appear in `found`;
    // scan it too so a NEW direct caller anywhere can't hide by defining its
    // own pass-through next to the bridge.
    const bridgePath = join(SRC, '..', BRIDGE_DEFINITION);
    readFileSync(bridgePath, 'utf8').split('\n').forEach((line, i) => {
      if (NATIVE_CALL_RE.test(line)) found.push(`../${BRIDGE_DEFINITION}:${i + 1}`);
    });
    return found;
  }

  test('the scan finds the real call site (a scan that matches nothing proves nothing)', () => {
    const sites = nativeFileProviderCacheCallSites();
    expect(sites.some((s) => s.startsWith(`${GATED_WRAPPER}:`))).toBe(true);
  });

  test('EVERY call site is the one gated wrapper — no bypass writes the native name cache directly', () => {
    const offenders = nativeFileProviderCacheCallSites()
      .filter((s) => !s.startsWith(`${GATED_WRAPPER}:`) && !s.startsWith(`../${BRIDGE_DEFINITION}:`));
    expect(offenders).toEqual([]);
  });

  test('the gated wrapper actually takes a lease around the native call', () => {
    const src = readFileSync(join(SRC, GATED_WRAPPER), 'utf8');
    expect(src).toMatch(/from '\.\/plaintext-gate'/);
    // Task 1593 round 5 (P2-6) — this used to check `withPlaintextLease(`
    // appears ANYWHERE in the file, which a lease taken around some other,
    // unrelated function would also satisfy. Scope it to the actual writer's
    // body: `syncDecryptedEntriesToFileProvider`, the ONE JS call site of the
    // native `syncFileProviderCache` per this describe block's own scan
    // above.
    const start = src.indexOf('export async function syncDecryptedEntriesToFileProvider');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/withPlaintextLease\(/);
  });

  test('the BFS walk (populateFileProviderCache) holds its OWN lease for the whole walk, not just per push', () => {
    const src = readFileSync(join(SRC, GATED_WRAPPER), 'utf8');
    const start = src.indexOf('export async function populateFileProviderCache');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/plaintextGate\.acquire\(/);
    // Checked before a folder push AND again after the async decrypt span.
    expect((body.match(/lease\.valid/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/lease\.release\(\)/);
  });
});
