// @ts-nocheck
/**
 * Task 2033 (TestFlight 240 launch crash, Option A): the camera-roll manifest
 * (`Documents/SQLite/beebeeb-backup.db`) has ONE SQLite copy per process,
 * expo-sqlite's.
 *
 * Build 240 had two. The engine's `import SQLite3` bound the vanilla
 * `sqlite3_*` that the Rust core's static library exports (3.46.0), and JS ran
 * on expo-sqlite's own copy (`exsqlite3_*`, 3.50.3). The second copy's first
 * open truncated `-shm` under the first copy's mapping (SIGBUS, "cluster_pagein
 * past EOF"), and neither copy saw the other's locks (both held BEGIN
 * IMMEDIATE at once). `scripts/swift-tests/manifest-shm-two-copies-test.swift`
 * proves the behaviour; this guard keeps the wiring from drifting back:
 *
 * - every manifest Swift file binds expo's copy through `import ManifestSQLite`
 *   and never names a bare `sqlite3_*` function (one missed call site would
 *   silently bring a second copy back);
 * - the set of manifest files is closed: nothing else binds expo's copy or
 *   builds the manifest path, and no file on the other copy (`import SQLite3`)
 *   calls into the manifest code with its own statements (PhotoBackupManager
 *   used `BackupManifestStore.bindText` on its own database until task 2033);
 * - no extension target compiles a manifest file (an extension does not link
 *   ExpoSQLite);
 * - the pod and the Swift test runner use the same module map, which points at
 *   the header of the amalgamation ExpoSQLite compiles;
 * - both sides wait for each other's write lock (same busy timeout).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const IOS = join(ROOT, 'modules/beebeeb-crypto/ios');

export const MANIFEST_FILES = [
  'BackupManifestHandle.swift',
  'BackupManifestStore.swift',
  'ManifestWriteFence.swift',
  'NativeBackupEngine.swift',
];

/** Manifest-code entry points that take a raw connection or statement. */
const MANIFEST_API = /\b(BackupManifestStore|BackupManifestHandle|FencedManifestWrites|manifestHandle)\b/;

/** `sqlite3_*` type names expo's header keeps unrenamed (no symbol behind them). */
const SHARED_TYPE_NAMES = new Set(['sqlite3_destructor_type', 'sqlite3_int64', 'sqlite3_uint64']);

/**
 * Swift source with comments and string literals blanked out (newlines kept,
 * so line numbers still match). Handles nested block comments, escapes and
 * multi-line `"""` literals.
 */
export function swiftCode(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('/*', i)) {
      let depth = 0;
      while (i < src.length) {
        if (src.startsWith('/*', i)) { depth += 1; i += 2; continue; }
        if (src.startsWith('*/', i)) { depth -= 1; i += 2; if (depth === 0) break; continue; }
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    if (src.startsWith('"""', i)) {
      i += 3;
      while (i < src.length && !src.startsWith('"""', i)) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 3;
      out += '""';
      continue;
    }
    if (src[i] === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Bare `sqlite3_*` names in code (calls and function references), minus shared type names. */
export function bareSqliteNames(src: string): string[] {
  const code = swiftCode(src);
  const out: string[] = [];
  const re = /(?<![A-Za-z0-9_])sqlite3_[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (SHARED_TYPE_NAMES.has(m[0])) continue;
    out.push(`line ${lineOf(code, m.index)}: ${m[0]}`);
  }
  return out;
}

export function imports(src: string): string[] {
  const re = /^[ \t]*(?:@\w+[ \t]+)*import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?([A-Za-z0-9_.]+)/gm;
  return [...swiftCode(src).matchAll(re)].map((m) => m[1]);
}

function swiftFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...swiftFilesUnder(p));
    else if (entry.name.endsWith('.swift')) out.push(p);
  }
  return out;
}

const nativeSwift = [
  ...swiftFilesUnder(IOS),
  ...swiftFilesUnder(join(ROOT, 'targets')),
  ...['ios/Beebeeb', 'ios/BeebeebShare', 'ios/BeebeebWidget', 'ios/BeebeebFileProvider']
    .map((d) => join(ROOT, d))
    .filter((d) => existsSync(d))
    .flatMap((d) => swiftFilesUnder(d)),
];
const rel = (p: string) => p.slice(ROOT.length + 1);
const read = (p: string) => readFileSync(p, 'utf8');

describe('task 2033: the manifest Swift files bind expo-sqlite\'s copy only', () => {
  test('each manifest file imports ManifestSQLite and never SQLite3', () => {
    for (const f of MANIFEST_FILES) {
      const mods = imports(read(join(IOS, f)));
      expect({ f, manifestSQLite: mods.includes('ManifestSQLite') }).toEqual({ f, manifestSQLite: true });
      expect({ f, sqlite3: mods.includes('SQLite3') }).toEqual({ f, sqlite3: false });
    }
  });

  test('no manifest file names a bare sqlite3_* function (calls or references)', () => {
    const offenders = MANIFEST_FILES.flatMap((f) => bareSqliteNames(read(join(IOS, f))).map((o) => `${f} ${o}`));
    expect(offenders).toEqual([]);
    // Not vacuous: the manifest files really call expo's copy.
    const calls = MANIFEST_FILES.reduce(
      (n, f) => n + (swiftCode(read(join(IOS, f))).match(/\bexsqlite3_[a-z0-9_]+\(/g) ?? []).length,
      0,
    );
    expect(calls).toBeGreaterThanOrEqual(300);
  });

  test('the set is closed: only manifest files bind expo\'s copy or build the manifest path', () => {
    const outside: string[] = [];
    for (const p of nativeSwift) {
      const name = p.split('/').pop();
      if (MANIFEST_FILES.includes(name) && rel(p) === `modules/beebeeb-crypto/ios/${name}`) continue;
      const src = read(p);
      if (imports(src).includes('ManifestSQLite')) outside.push(`${rel(p)} imports ManifestSQLite`);
      if (/\bexsqlite3_/.test(swiftCode(src))) outside.push(`${rel(p)} calls exsqlite3_*`);
      if (/appendingPathComponent\(\s*"beebeeb-backup\.db"/.test(src)) outside.push(`${rel(p)} builds the manifest path`);
    }
    expect(outside).toEqual([]);
    expect(nativeSwift.length).toBeGreaterThan(20);
  });

  test('no file on the other copy (import SQLite3) calls into the manifest code', () => {
    const offenders: string[] = [];
    let sqlite3Files = 0;
    for (const p of nativeSwift) {
      const src = read(p);
      if (!imports(src).includes('SQLite3')) continue;
      sqlite3Files += 1;
      const code = swiftCode(src);
      const m = MANIFEST_API.exec(code);
      if (m) offenders.push(`${rel(p)} line ${lineOf(code, m.index)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
    // PhotoBackupManager, ThumbnailQueueDB, BeebeebCryptoModule,
    // PlaintextStorageProtection, the File Provider's CacheManager.
    expect(sqlite3Files).toBeGreaterThanOrEqual(5);
  });

  test('no extension target compiles a manifest file (extensions do not link ExpoSQLite)', () => {
    const pbx = read(join(ROOT, 'ios/Beebeeb.xcodeproj/project.pbxproj'));
    const plugins = swiftlessPluginSources();
    for (const f of MANIFEST_FILES) {
      expect({ f, pbxproj: pbx.includes(f) }).toEqual({ f, pbxproj: false });
      expect({ f, plugins: plugins.some((s) => s.includes(f)) }).toEqual({ f, plugins: false });
    }
  });
});

function swiftlessPluginSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) out.push(read(p));
    }
  };
  walk(join(ROOT, 'plugins'));
  return out;
}

describe('task 2033: the pod and the Swift test runner use one module map', () => {
  const modulemapPath = join(IOS, 'ManifestSQLite/module.modulemap');
  const modulemap = read(modulemapPath);

  test('the module map points at the header of the amalgamation ExpoSQLite compiles', () => {
    expect(modulemap).toMatch(/module ManifestSQLite \[system\] \{/);
    const header = /header "([^"]+)"/.exec(modulemap)?.[1];
    expect(header).toBe('../../../../node_modules/expo-sqlite/vendor/sqlite3/sqlite3.h');
    const headerPath = resolve(dirname(modulemapPath), header);
    expect(headerPath).toBe(join(ROOT, 'node_modules/expo-sqlite/vendor/sqlite3/sqlite3.h'));
    expect(existsSync(headerPath)).toBe(true);
    const h = read(headerPath);
    expect(h).toMatch(/SQLITE_API int exsqlite3_open_v2\(/);
    expect(h).toMatch(/SQLITE_API int exsqlite3_step\(/);
    // ExpoSQLite copies this vendor dir (not sqlcipher) and compiles it unless
    // libSQL or SQLCipher is switched on; either would change the copy JS uses.
    const expoPodspec = read(join(ROOT, 'node_modules/expo-sqlite/ios/ExpoSQLite.podspec'));
    expect(expoPodspec).toMatch(/vendor_src = useSQLCipher \? 'sqlcipher' : 'sqlite3'/);
    const props = JSON.parse(read(join(ROOT, 'ios/Podfile.properties.json')));
    expect(props['expo.sqlite.useSQLCipher']).not.toBe('true');
    expect(props['expo.sqlite.useLibSQL']).not.toBe('true');
  });

  test('BeebeebCrypto depends on ExpoSQLite and puts the module map on its Swift include path', () => {
    const podspec = read(join(IOS, 'BeebeebCrypto.podspec'));
    expect(podspec).toMatch(/s\.dependency 'ExpoSQLite'/);
    expect(podspec).toMatch(/'SWIFT_INCLUDE_PATHS' => '\$\(inherited\) "\$\(PODS_TARGET_SRCROOT\)\/ManifestSQLite"'/);
  });

  test('the Swift test runner compiles with the same module map and links expo\'s amalgamation', () => {
    const runner = read(join(ROOT, 'scripts/swift-ci/run-swift-tests.sh'));
    expect(runner).toMatch(/MANIFEST_SQLITE_INCLUDE=modules\/beebeeb-crypto\/ios\/ManifestSQLite\n/);
    expect(runner).toMatch(/EXPO_SQLITE_SRC=node_modules\/expo-sqlite\/vendor\/sqlite3\/sqlite3\.c\n/);
    expect(runner).toMatch(/flags\+=\(-I "\$MANIFEST_SQLITE_INCLUDE"\)/);
  });
});

describe('task 2033: both sides wait for the other\'s write lock', () => {
  test('the engine connection and JS use the same busy timeout, set before anything else', () => {
    const handle = read(join(IOS, 'BackupManifestHandle.swift'));
    const swiftMs = Number(/static let busyTimeoutMs: Int32 = ([0-9_]+)/.exec(handle)?.[1].replace(/_/g, ''));
    const db = read(join(ROOT, 'src/services/BackupDatabase.ts'));
    const jsMs = Number(/export const MANIFEST_BUSY_TIMEOUT_MS = (\d+);/.exec(db)?.[1]);
    expect(swiftMs).toBeGreaterThan(0);
    expect(jsMs).toBe(swiftMs);
    // The open sets it before the first statement on the connection.
    const open = handle.slice(handle.indexOf('func openIfClosed()'));
    expect(open.indexOf('exsqlite3_busy_timeout(opened, Self.busyTimeoutMs)')).toBeGreaterThan(0);
    expect(open.indexOf('exsqlite3_busy_timeout(opened, Self.busyTimeoutMs)'))
      .toBeLessThan(open.indexOf('PRAGMA journal_mode = WAL'));
    // JS: the first statement of migrate.
    const migrate = db.slice(db.indexOf('async function migrate('));
    expect(migrate).toMatch(/execAsync\(`\s*PRAGMA busy_timeout = \$\{MANIFEST_BUSY_TIMEOUT_MS\};\s*PRAGMA journal_mode = WAL;/);
  });
});

describe('red-proof: the checks see what they guard', () => {
  test('a seeded bare call, function reference or import is flagged; comments and strings are not', () => {
    expect(bareSqliteNames('let n = exsqlite3_step(stmt)\n')).toEqual([]);
    expect(bareSqliteNames('let n = sqlite3_step(stmt)\n')).toEqual(['line 1: sqlite3_step']);
    expect(bareSqliteNames('let f: Step = sqlite3_step\n').length).toBe(1);
    expect(bareSqliteNames('x\n  if sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK {}\n')).toEqual(['line 2: sqlite3_exec']);
    expect(bareSqliteNames('// sqlite3_step in a comment\n/* sqlite3_exec /* nested */ */\nlet s = "sqlite3_open"\n')).toEqual([]);
    expect(bareSqliteNames('let t = unsafeBitCast(-1, to: sqlite3_destructor_type.self)\n')).toEqual([]);
    expect(imports('import Foundation\nimport SQLite3\n')).toEqual(['Foundation', 'SQLite3']);
    expect(imports('@_exported import SQLite3\n')).toEqual(['SQLite3']);
    expect(imports('// import SQLite3\n')).toEqual([]);
    expect(imports('import struct Foundation.URL\n')).toEqual(['Foundation.URL']);
  });

  test('the shipped files would fail if one call site went back to the bare copy', () => {
    const store = read(join(IOS, 'BackupManifestStore.swift'));
    const seeded = store.replace('exsqlite3_finalize(', 'sqlite3_finalize(');
    expect(seeded).not.toBe(store);
    expect(bareSqliteNames(seeded).length).toBe(1);
    expect(MANIFEST_API.test(swiftCode('BackupManifestStore.bindText(stmt, 1, key)'))).toBe(true);
  });
});
