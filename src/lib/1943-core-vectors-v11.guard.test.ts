// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — the vendored core vector bundle (spec §2, plan M1).
 *
 * The native KATs cannot run in this lane (the iOS one needs a simulator, the Android one an
 * emulator), so this is the runnable half of the vendoring: it pins the exact bytes of core
 * `c08defc7`'s `test-vectors/vectors.json` in both bundles, checks the version and every family's
 * row count, and proves no stale copy and no stale project reference survives.
 *
 * The vendored file has a STABLE name, `core-vectors.json`; the version and the sha256 pinned
 * here are what guard its content.
 *
 * Refresh procedure:
 * 1. From the mobile repo root: `git -C ../core show $(cat modules/beebeeb-crypto/CORE_REV):test-vectors/vectors.json`
 *    (when `../core` is absent, fetch `CORE_REV` into a scratch clone first) — write that over
 *    `targets/native-tests/Vectors/core-vectors.json` and copy it to the Android bundle.
 * 2. `shasum -a 256` both copies and update `EXPECTED_SHA256`.
 * 3. If core bumped the version or changed a family, update `EXPECTED_VERSION` and
 *    `EXPECTED_FAMILIES`; both native KATs pin the same numbers and this test compares their
 *    tables with this one.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

const IOS_VECTORS = 'targets/native-tests/Vectors/core-vectors.json';
const ANDROID_VECTORS = 'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.json';
const SWIFT_KAT = 'targets/native-tests/CoreVectorsKATTests.swift';
const KOTLIN_KAT = 'modules/beebeeb-crypto/android/src/androidTest/java/expo/modules/beebeebcrypto/CoreVectorsKATTest.kt';
const STALE = [
  'targets/native-tests/Vectors/core-vectors.v11.json',
  'targets/native-tests/Vectors/core-vectors.v10.json',
  'targets/native-tests/Vectors/core-vectors.v4.json',
  'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v11.json',
  'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v10.json',
  'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v4.json',
];

/** `shasum -a 256` of core `c08defc7:test-vectors/vectors.json`. */
const EXPECTED_SHA256 = '11f7522056d0c12eff92d2f37a5fa6975ce460cf36899e3a6a92f3455a4d754a';
const EXPECTED_VERSION = 11;

/** Every family core ships at this revision, with the number of rows it carries. */
const EXPECTED_FAMILIES: Record<string, number> = {
  master_key_from_password: 1,
  file_key_derivation: 1,
  chunk_encrypt_decrypt: 1,
  x25519_identity_keypair: 1,
  x25519_share_key_exchange: 1,
  recovery_check: 1,
  envelope_serialization: 1,
  recovery_phrase_roundtrip: 1,
  metadata_encrypt_decrypt: 1,
  file_request_seal_open: 1,
  share_key_wrap: 1,
  thumbnail_encrypt: 1,
  chunk_v2_stream: 1,
  chunk_v2_single_frame: 1,
  metadata_v2_name: 1,
  metadata_v2_name_filekey: 1,
  metadata_v1_name_filekey: 1,
  folder_key_id: 1,
  shared_folder_index_key: 1,
  combine_folder_link_key: 1,
  key_wrap_v1: 1,
  folder_link_passphrase: 1,
  folder_link_passphrase_nfd: 1,
  folder_custody_v1: 1,
  link_owner_key_v1: 1,
  link_owner_token_v1: 1,
  folder_child_file_v1: 1,
  folder_child_folder_v1: 1,
  owner_wrapped_file_key: 1,
  owner_wrapped_folder_key: 1,
  folder_wrapped_file_key: 1,
};

const TOTAL_ROWS = Object.values(EXPECTED_FAMILIES).reduce((sum, rows) => sum + rows, 0);

const CORE_DIR = resolve(ROOT, '../core');
const CORE_REV = readFileSync(join(ROOT, 'modules/beebeeb-crypto/CORE_REV'), 'utf8').trim();
const HAVE_CORE = existsSync(CORE_DIR);
if (!HAVE_CORE) {
  console.log(
    '[1943] skipping the sibling-core byte comparison: ../core is absent; the vendored bytes are pinned by sha256 only',
  );
}

/**
 * Run a command and capture its output through a file. On this Mac a `bun test` child writing
 * straight into a pipe comes back with no output, while a file redirect returns it faithfully.
 */
function runCaptured(argv: string[], opts: { cwd?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-1943-git-'));
  const outFile = join(dir, 'out.txt');
  const wrapper = join(dir, 'run.sh');
  try {
    writeFileSync(wrapper, '#!/usr/bin/env bash\n"$@" >"$BB_CAPTURE_OUT" 2>&1\n');
    chmodSync(wrapper, 0o755);
    const proc = Bun.spawnSync([wrapper, ...argv], {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, BB_CAPTURE_OUT: outFile },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return { code: proc.exitCode, output: readFileSync(outFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function familiesFromNativeTable(source: string, start: string, stop: string): Record<string, number> {
  const from = source.indexOf(start);
  const table = source.slice(from, source.indexOf(stop, from));
  const entries: Record<string, number> = {};
  for (const match of table.matchAll(/"([a-z0-9_]+)"(?:\s*,\s*|\s+to\s+)(\d+)/g)) {
    entries[match[1]] = Number(match[2]);
  }
  return entries;
}

describe('vendored core vectors (task 1943 M1)', () => {
  test('bothBundlesCarryTheVectorsByteForByte', () => {
    const ios = readFileSync(join(ROOT, IOS_VECTORS));
    const android = readFileSync(join(ROOT, ANDROID_VECTORS));
    expect(android.equals(ios)).toBe(true);
    expect(createHash('sha256').update(ios).digest('hex')).toBe(EXPECTED_SHA256);
    expect(createHash('sha256').update(android).digest('hex')).toBe(EXPECTED_SHA256);
  });

  test('theVendoredFileIsVersion11', () => {
    const root = JSON.parse(readFileSync(join(ROOT, IOS_VECTORS), 'utf8')) as {
      version: number;
      vectors: { name: string }[];
    };
    expect(root.version).toBe(EXPECTED_VERSION);
  });

  test('everyFamilyIsPresentWithItsRowCount', () => {
    const root = JSON.parse(readFileSync(join(ROOT, IOS_VECTORS), 'utf8')) as {
      vectors: { name: string }[];
    };
    const counts: Record<string, number> = {};
    for (const vector of root.vectors) counts[vector.name] = (counts[vector.name] ?? 0) + 1;
    expect(Object.keys(counts).sort()).toEqual(Object.keys(EXPECTED_FAMILIES).sort());
    for (const [family, rows] of Object.entries(EXPECTED_FAMILIES)) {
      expect({ family, rows: counts[family] }).toEqual({ family, rows });
    }
    expect(root.vectors.length).toBe(TOTAL_ROWS);
  });

  test('noStaleVectorCopySurvives', () => {
    for (const path of STALE) expect({ path, exists: existsSync(join(ROOT, path)) }).toEqual({ path, exists: false });
  });

  test('theProjectAndThePrebuildPluginPointAtTheStableName', () => {
    const files = [
      'ios/Beebeeb.xcodeproj/project.pbxproj',
      'plugins/native-tests/withNativeTestTargets.js',
      'plugins/lib/xctest-target.js',
      'scripts/check-prebuild-test-targets.sh',
      'scripts/kat-ios.sh',
    ];
    for (const path of files) {
      const text = readFileSync(join(ROOT, path), 'utf8');
      expect({ path, stable: text.includes('core-vectors.json') }).toEqual({ path, stable: true });
      expect({ path, versioned: /core-vectors\.v\d+\.json/.test(text) }).toEqual({ path, versioned: false });
    }
  });

  test('bothNativeKatsLoadTheStableNameAndPinItsSha', () => {
    for (const path of [SWIFT_KAT, KOTLIN_KAT]) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect({ path, stable: source.includes('core-vectors.json') }).toEqual({ path, stable: true });
      expect({ path, versioned: /core-vectors\.v\d+\.json/.test(source) }).toEqual({ path, versioned: false });
      expect({ path, sha: source.includes(EXPECTED_SHA256) }).toEqual({ path, sha: true });
    }
  });

  test('bothNativeKatsPinTheVersionExactly', () => {
    const swift = readFileSync(join(ROOT, SWIFT_KAT), 'utf8');
    const kotlin = readFileSync(join(ROOT, KOTLIN_KAT), 'utf8');
    expect(swift.match(/private static let expectedVersion = (\d+)/)?.[1]).toBe(String(EXPECTED_VERSION));
    expect(kotlin.match(/private const val EXPECTED_VERSION = (\d+)/)?.[1]).toBe(String(EXPECTED_VERSION));
  });

  test('bothNativeKatsFamilyTablesMatchThisTest', () => {
    const swift = readFileSync(join(ROOT, SWIFT_KAT), 'utf8');
    const kotlin = readFileSync(join(ROOT, KOTLIN_KAT), 'utf8');
    expect(familiesFromNativeTable(swift, 'expectedFamilyRowCounts', '\n    ]')).toEqual(EXPECTED_FAMILIES);
    expect(familiesFromNativeTable(kotlin, 'EXPECTED_FAMILY_ROW_COUNTS', '\n        )')).toEqual(EXPECTED_FAMILIES);
  });

  test.skipIf(!HAVE_CORE)('theVendoredBytesMatchCoreAtThePinnedRevision', () => {
    const proc = runCaptured(['git', '-C', CORE_DIR, 'show', `${CORE_REV}:test-vectors/vectors.json`]);
    expect({ code: proc.code, output: proc.code === 0 ? '' : proc.output }).toEqual({ code: 0, output: '' });
    expect(proc.output).toBe(readFileSync(join(ROOT, IOS_VECTORS), 'utf8'));
  });
});
