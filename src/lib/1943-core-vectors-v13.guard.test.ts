// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — the vendored core vector bundle (spec §2, plan M1).
 *
 * The native KATs cannot run in this lane (the iOS one needs a simulator, the Android one an
 * emulator), so this is the runnable half of the vendoring: it pins the exact bytes of core
 * `f8ee8e4`'s `test-vectors/vectors.json` in both bundles, checks the version and every family's
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

/** `shasum -a 256` of core `f8ee8e4:test-vectors/vectors.json`. */
const EXPECTED_SHA256 = '71fb633774fcb13d7cca0613603282ea47ab77e265abd09b3a2ec189689c1464';
const EXPECTED_VERSION = 13;

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
  invite_owner_copy_v1: 1,
  folder_custody_v1: 1,
  link_owner_key_v1: 1,
  link_owner_token_v1: 1,
  folder_child_file_v1: 1,
  folder_child_folder_v1: 1,
  owner_wrapped_file_key: 1,
  owner_wrapped_folder_key: 1,
  folder_wrapped_file_key: 1,
  upper_repair_v1: 1,
  upper_repair_split_v1: 1,
  client_meta_device_hostname: 1,
  client_meta_session_paths: 1,
  client_meta_padding_buckets: 1,
};

const TOTAL_ROWS = Object.values(EXPECTED_FAMILIES).reduce((sum, rows) => sum + rows, 0);

const CORE_DIR = resolve(ROOT, '../core');
const CORE_REV = readFileSync(join(ROOT, 'modules/beebeeb-crypto/CORE_REV'), 'utf8').trim();
const CORE_PRESENT = existsSync(CORE_DIR);

/** The pinned revision is only comparable when the sibling core clone actually has it. */
function coreHasPinnedRevision(): boolean {
  if (!CORE_PRESENT) return false;
  return Bun.spawnSync(['git', '-C', CORE_DIR, 'cat-file', '-e', CORE_REV]).exitCode === 0;
}

const HAVE_CORE_REV = coreHasPinnedRevision();
if (!CORE_PRESENT) {
  console.log(
    '[1943] skipping the sibling-core byte comparison: ../core is absent; the vendored bytes are pinned by sha256 only',
  );
} else if (!HAVE_CORE_REV) {
  console.log(
    `[1943] skipping the sibling-core byte comparison: git -C ../core cat-file -e ${CORE_REV} failed (revision not fetched); the vendored bytes are pinned by sha256 only`,
  );
}

/**
 * Run a command and capture stdout and stderr separately through files. On this Mac a
 * `bun test` child writing straight into a pipe comes back with no output, while a file
 * redirect returns it faithfully. Both streams come back as Buffers so the comparison is
 * byte-exact.
 */
function runCaptured(argv: string[], opts: { cwd?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-1943-git-'));
  const outFile = join(dir, 'out.bin');
  const errFile = join(dir, 'err.bin');
  const wrapper = join(dir, 'run.sh');
  try {
    writeFileSync(wrapper, '#!/usr/bin/env bash\n"$@" >"$BB_CAPTURE_OUT" 2>"$BB_CAPTURE_ERR"\n');
    chmodSync(wrapper, 0o755);
    const proc = Bun.spawnSync([wrapper, ...argv], {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, BB_CAPTURE_OUT: outFile, BB_CAPTURE_ERR: errFile },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return { code: proc.exitCode, stdout: readFileSync(outFile), stderr: readFileSync(errFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse a native family-count table. Anchors on the table DECLARATION (the header prose also
 * names it), skips comment lines, and stops at the declaration's closing bracket — so a
 * commented-out row disappears from the parsed table instead of matching inside a comment.
 */
function familiesFromNativeTable(source: string, declaration: string): Record<string, number> {
  const lines = source.split('\n');
  const declarationRe = new RegExp(`\\b(?:let|val)\\s+${declaration}\\b`);
  const start = lines.findIndex((line) => declarationRe.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  if (start < 0) throw new Error(`native table declaration '${declaration}' not found`);
  const entries: Record<string, number> = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(']') || trimmed.startsWith(')')) break;
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const match of line.matchAll(/"([a-z0-9_]+)"(?:\s*,\s*|\s+to\s+)(\d+)/g)) {
      entries[match[1]] = Number(match[2]);
    }
  }
  return entries;
}

/** Line number (1-based) of a character offset, for failure messages a human can act on. */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

/**
 * Blank out comments and string literals, keeping every offset and newline in place.
 *
 * The chunk-v2 helpers are read as text, so a call name mentioned in a doc comment or a
 * message string ("`finish()` takes the handle's state, so `versionId()` MUST be read FIRST")
 * must never be mistaken for a call. Line comments, nested block comments (both Kotlin and Swift allow nesting), escaped
 * strings and Kotlin `"""` raw strings are handled. Neither file has a char literal, so `'`
 * outside a string is left alone.
 */
function maskCommentsAndStrings(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      let depth = 0;
      let j = i;
      while (j < source.length) {
        if (source.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (source.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    const triple = source.slice(i, i + 3);
    if (triple === '"""') {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? source.length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, source.length);
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * The body of the innermost brace block that contains `needle`, with the opening and closing
 * braces included. `masked` is the masked form (same offsets as `source`), so brace counting
 * never sees a brace inside a comment or a string.
 */
function enclosingBlock(masked: string, needleIndex: number): { start: number; text: string } {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < needleIndex; i++) {
    if (masked[i] === '{') {
      depth++;
      open = i;
    } else if (masked[i] === '}') {
      depth--;
      if (depth < 0) throw new Error(`unbalanced '}' before the needle at offset ${needleIndex}`);
    }
  }
  if (open < 0 || depth === 0) throw new Error(`no enclosing block for the needle at offset ${needleIndex}`);
  let close = -1;
  let inner = 1;
  for (let i = open + 1; i < masked.length; i++) {
    if (masked[i] === '{') inner++;
    else if (masked[i] === '}' && --inner === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error(`unclosed block opened at offset ${open}`);
  return { start: open, text: masked.slice(open, close + 1) };
}

/**
 * Every reason the chunk-v2 helper in `source` reads its decryptor's version id after
 * `finish()`. Empty means the order is right.
 *
 * `finish()` takes the handle's state, so `versionId()` must be read first — after `finish()`
 * every call throws "handle has been cleared", which on Android turned the version-id
 * assertion into a per-family exception instead of a recorded failure (fixed in 6b8ec28b).
 */
function versionIdOrderProblems(label: string, source: string): string[] {
  const masked = maskCommentsAndStrings(source);
  const needle = masked.indexOf('ChunkDecryptorHandle.forPush(');
  if (needle < 0) return [`${label}: no ChunkDecryptorHandle.forPush( call found`];
  const { start: bodyStart, text: body } = enclosingBlock(masked, needle);
  const assigned = /(?:val|let|var)\s+(\w+)\s*=\s*(?:try\s+)?ChunkDecryptorHandle\.forPush\(/.exec(body);
  if (!assigned) return [`${label}: the chunk-v2 helper does not bind the ChunkDecryptorHandle.forPush result to a name`];
  const decryptor = assigned[1];
  const versionIdRe = new RegExp(`\\b${decryptor}\\.versionId\\(\\)`, 'g');
  const finishRe = new RegExp(`\\b${decryptor}\\.finish\\(\\)`, 'g');
  const versionIdAt = [...body.matchAll(versionIdRe)].map((match) => match.index ?? 0);
  const finishAt = [...body.matchAll(finishRe)].map((match) => match.index ?? 0);
  const problems: string[] = [];
  if (versionIdAt.length === 0) problems.push(`${label}: never calls ${decryptor}.versionId()`);
  if (finishAt.length === 0) problems.push(`${label}: never calls ${decryptor}.finish()`);
  for (const versionId of versionIdAt) {
    for (const finish of finishAt) {
      if (versionId >= finish) {
        const order =
          `reads ${decryptor}.versionId() at line ${lineOf(source, bodyStart + versionId)} ` +
          `AFTER ${decryptor}.finish() at line ${lineOf(source, bodyStart + finish)} — ` +
          `finish() clears the handle, so the version id must be read first`;
        problems.push(`${label}: ${order}`);
      }
    }
  }
  return problems;
}

/** The chunk-v2 KAT source under test; a test-only override lets the red run read the old bytes. */
const KOTLIN_KAT_UNDER_TEST = process.env.BB_1943_KOTLIN_KAT_UNDER_TEST
  ? resolve(process.env.BB_1943_KOTLIN_KAT_UNDER_TEST)
  : join(ROOT, KOTLIN_KAT);

describe('vendored core vectors (task 1943 M1)', () => {
  test('bothBundlesCarryTheVectorsByteForByte', () => {
    const ios = readFileSync(join(ROOT, IOS_VECTORS));
    const android = readFileSync(join(ROOT, ANDROID_VECTORS));
    expect(android.equals(ios)).toBe(true);
    expect(createHash('sha256').update(ios).digest('hex')).toBe(EXPECTED_SHA256);
    expect(createHash('sha256').update(android).digest('hex')).toBe(EXPECTED_SHA256);
  });

  test('theVendoredFileIsVersion13', () => {
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
    expect(familiesFromNativeTable(swift, 'expectedFamilyRowCounts')).toEqual(EXPECTED_FAMILIES);
    expect(familiesFromNativeTable(kotlin, 'EXPECTED_FAMILY_ROW_COUNTS')).toEqual(EXPECTED_FAMILIES);
  });

  test('bothNativeKatsCarryTheVersionIdNegativeAndIsolateTheV2Families', () => {
    const swift = readFileSync(join(ROOT, SWIFT_KAT), 'utf8');
    const kotlin = readFileSync(join(ROOT, KOTLIN_KAT), 'utf8');
    // Round 4: the version binding is asserted by its own negative, not only by a positive
    // `versionId()` comparison, and a throw in one chunk-v2 family must not stop the next one.
    expect({ path: SWIFT_KAT, negative: /func testV2DecryptRefusesAnotherVersionId\(/.test(swift) }).toEqual({
      path: SWIFT_KAT,
      negative: true,
    });
    expect({ path: KOTLIN_KAT, negative: /fun v2DecryptRefusesAnotherVersionId\(/.test(kotlin) }).toEqual({
      path: KOTLIN_KAT,
      negative: true,
    });
    expect({ path: SWIFT_KAT, isolated: swift.includes('XCTContext.runActivity') }).toEqual({
      path: SWIFT_KAT,
      isolated: true,
    });
    expect({ path: KOTLIN_KAT, isolated: kotlin.includes('failures.isEmpty()') }).toEqual({
      path: KOTLIN_KAT,
      isolated: true,
    });
  });

  test('theAndroidV2HelperReadsVersionIdBeforeFinish', () => {
    // The v2 KAT bug of 6b8ec28b cannot be shown red on this host: the Android binding needs the
    // UniFFI .so in an emulator. The order it depends on is textual, so assert it here instead —
    // same helper shape on both platforms, so the Swift mirror is checked too.
    const problems = [
      ...versionIdOrderProblems(
        'Android CoreVectorsKATTest.kt',
        readFileSync(KOTLIN_KAT_UNDER_TEST, 'utf8'),
      ),
      ...versionIdOrderProblems('Swift CoreVectorsKATTests.swift', readFileSync(join(ROOT, SWIFT_KAT), 'utf8')),
    ];
    expect(problems).toEqual([]);
  });

  test.skipIf(!HAVE_CORE_REV)('theVendoredBytesMatchCoreAtThePinnedRevision', () => {
    const proc = runCaptured(['git', '-C', CORE_DIR, 'show', `${CORE_REV}:test-vectors/vectors.json`]);
    expect({ code: proc.code, stderr: proc.stderr.toString() }).toEqual({ code: 0, stderr: '' });
    expect(proc.stdout.equals(readFileSync(join(ROOT, IOS_VECTORS)))).toBe(true);
  });
});
