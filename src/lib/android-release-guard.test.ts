// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — `scripts/android-release-guard.sh` (spec S6, decision D15),
 * D15 amendment 2026-10-30 (lead ruling; plan "Amendment 2026-10-30 (2)").
 *
 * An Android EAS build is allowed ONLY while the Android binding and the Android content readers are
 * the last Android-verified ones: `modules/beebeeb-crypto/CORE_REV` equals the pinned rev, every file
 * in the script's ANDROID_VERIFIED_FILES hashes to its pinned sha256, and no unpinned `.so` exists.
 * The sentinel pin `unverified` (or an empty one) refuses every Android build. iOS is always allowed;
 * an unset or unknown platform fails closed; a Git LFS pointer stub is refused ("run git lfs pull");
 * there is no evidence-file unlock.
 *
 * Every test drives a script through `bash` with the `EAS_*` variables EAS sets. The LOGIC tests run
 * in a temp tree whose pins are rewritten to that tree's own hashes, so they do not depend on whether
 * Git LFS was pulled (CI's unit job checks out the .so files as pointer stubs). One test checks the
 * REAL repo state: allowed when the binaries are present, a clear LFS refusal when they are stubs.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';

// Each case shells out to the guard several times; on a loaded build host 5 s (bun's default) is too short.
setDefaultTimeout(30_000);
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/android-release-guard.sh');
const MOD = 'modules/beebeeb-crypto';
const EVIDENCE = 'docs/_qa-evidence/1943-mobile/android-m7.md';
const LFS_PREFIX = 'version https://git-lfs.github.com/spec';

/** Every EAS build profile this repo defines plus the local variants EAS accepts. */
const PROFILES = ['production', 'production-local', 'preview', 'development', 'simulator'];

/** The pinned files, parsed from the shipped script (the single source of truth). */
function pinnedFiles(script = SCRIPT): Array<{ rel: string; sha: string }> {
  const src = readFileSync(script, 'utf8');
  const block = src.match(/^ANDROID_VERIFIED_FILES="\n([\s\S]*?)\n"$/m);
  if (!block) throw new Error('ANDROID_VERIFIED_FILES block not found in the guard script');
  return block[1].split('\n').filter(Boolean).map((line) => {
    const [rel, sha] = line.trim().split(/\s+/);
    return { rel, sha };
  });
}

function scriptPin(script = SCRIPT): string {
  const m = readFileSync(script, 'utf8').match(/^ANDROID_VERIFIED_CORE_REV="([^"]*)"$/m);
  if (!m) throw new Error('ANDROID_VERIFIED_CORE_REV line not found in the guard script');
  return m[1];
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A clean env: the lane shell may carry EAS_* vars, and the test must control them. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('EAS_')) continue;
    env[key] = value;
  }
  return env;
}

/** Run a script with `bash` (no exec bit needed) and capture both streams. */
function runGuard(opts: { script?: string; args?: string[]; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(['bash', opts.script ?? SCRIPT, ...(opts.args ?? [])], {
    cwd: ROOT,
    env: { ...cleanEnv(), ...(opts.env ?? {}) },
  });
  return { code: proc.exitCode, stdout: proc.stdout?.toString() ?? '', stderr: proc.stderr?.toString() ?? '' };
}

/**
 * A refusal is not just exit 1: the guard must SAY it refused and why. An unbound variable or a
 * crash in the refusal path also exits 1, and without this check that would count as a refusal.
 */
function expectRefused(result: { code: number; stderr: string }, reason: string) {
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('REFUSED');
  expect(result.stderr).toContain(reason);
}

function expectAllowed(result: { code: number; stdout: string; stderr: string }) {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(result.stdout).toContain('allowed');
}

/**
 * A temp tree with a copy of the script and every pinned file (whatever is on disk: real binaries or
 * LFS stubs). Unless told otherwise, the copy's pins are rewritten to the tree's OWN hashes and CORE_REV,
 * so "everything matches" holds regardless of LFS; `mutate` then breaks one thing.
 */
function withTree(
  mutate: (dir: string, script: string) => void,
  run: (script: string, dir: string) => void,
  opts: { repin?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-d15-guard-'));
  try {
    const script = join(dir, 'scripts/android-release-guard.sh');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(SCRIPT, script);
    const files = [{ rel: 'CORE_REV' }, ...pinnedFiles()];
    for (const { rel } of files) {
      mkdirSync(join(dir, MOD, rel, '..'), { recursive: true });
      copyFileSync(join(ROOT, MOD, rel), join(dir, MOD, rel));
    }
    if (opts.repin !== false) {
      // Make the tree internally consistent: real-looking content for the .so files (CI has stubs),
      // then pin every file to its hash in the tree.
      for (const { rel } of pinnedFiles()) {
        if (rel.endsWith('.so')) writeFileSync(join(dir, MOD, rel), `ELF test library ${rel}\n`);
      }
      let src = readFileSync(script, 'utf8');
      for (const { rel, sha } of pinnedFiles()) {
        src = src.replace(`${rel} ${sha}`, `${rel} ${sha256(join(dir, MOD, rel))}`);
      }
      // The core-rev pin too: the logic tests must not depend on the SHIPPED pin, which 1943 M2 sets to
      // "unverified" (s3-lead's review of #247: with a shipped sentinel these tests went 8 pass / 9 fail).
      const treeRev = readFileSync(join(dir, MOD, 'CORE_REV'), 'utf8').trim();
      src = src.replace(/^ANDROID_VERIFIED_CORE_REV="[^"]*"$/m, `ANDROID_VERIFIED_CORE_REV="${treeRev}"`);
      writeFileSync(script, src);
      expect(scriptPin(script)).toBe(treeRev);
      expect(pinnedFiles(script).every(({ rel, sha }) => sha === sha256(join(dir, MOD, rel)))).toBe(true);
    }
    mutate(dir, script);
    run(script, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ANDROID_EAS = { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' };
const NOT_VERIFIED = 'not the last Android-verified binding';
const OTHER_REV = '0123456789abcdef0123456789abcdef01234567\n';
const KT = 'android/src/main/java/expo/modules/beebeebcrypto';

describe('android-release-guard.sh (task 1943 M1 / S6, D15 amendment 2026-10-30)', () => {
  test('the pinned set covers the binding, both .so files and the Android content readers', () => {
    const rels = pinnedFiles().map((p) => p.rel);
    for (const required of [
      'android/src/main/java/uniffi/beebeeb_uniffi/beebeeb_uniffi.kt',
      'android/src/main/jniLibs/arm64-v8a/libbeebeeb_uniffi.so',
      'android/src/main/jniLibs/x86_64/libbeebeeb_uniffi.so',
      `${KT}/BeebeebCryptoModule.kt`,
      `${KT}/VideoStreamer.kt`,
      `${KT}/VideoChunkMath.kt`,
      `${KT}/PreviewDownloadProgress.kt`,
      `${KT}/SharedKeyOps.kt`,
      `${KT}/SharedKeyRegistry.kt`,
      `${KT}/BeebeebCryptoHandleRegistry.kt`,
      `${KT}/NativeManualUploader.kt`,
    ]) {
      expect(rels).toContain(required);
    }
  });

  test('the REAL repo: allowed on the real binaries, a clear LFS refusal on pointer stubs', () => {
    const pin = scriptPin();
    const result = runGuard({ env: ANDROID_EAS });
    if (pin === 'unverified' || pin === '') {
      expectRefused(result, 're-armed');
      return;
    }
    const stub = pinnedFiles()
      .filter(({ rel }) => rel.endsWith('.so'))
      .some(({ rel }) => readFileSync(join(ROOT, MOD, rel)).subarray(0, LFS_PREFIX.length).toString() === LFS_PREFIX);
    if (stub) {
      expectRefused(result, 'Git LFS pointer stub');
    } else {
      expectAllowed(result);
    }
    // CI checks the .so files out as LFS stubs, so the guard refuses on the stub before it reaches the
    // reader files. Compare every NON-.so pin here directly, so a reader (or binding .kt / CORE_REV) change
    // made without setting the pin to "unverified" still turns CI red (s3-lead, #250 owner review).
    expect(readFileSync(join(ROOT, MOD, 'CORE_REV'), 'utf8').trim()).toBe(pin);
    for (const { rel, sha } of pinnedFiles().filter(({ rel }) => !rel.endsWith('.so'))) {
      expect({ rel, sha256: sha256(join(ROOT, MOD, rel)) }).toEqual({ rel, sha256: sha });
    }
  });

  test('android on a fully matching binding + readers is allowed with every profile', () => {
    withTree(() => {}, (script) => {
      for (const profile of PROFILES) {
        expectAllowed(runGuard({ script, env: { ...ANDROID_EAS, EAS_BUILD_PROFILE: profile } }));
      }
      expectAllowed(runGuard({ script, env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ANDROID' } }));
      expectAllowed(runGuard({ script, args: ['android'] }));
    });
  });

  test('android is refused when CORE_REV is not the pinned rev', () => {
    withTree(
      (dir) => writeFileSync(join(dir, MOD, 'CORE_REV'), OTHER_REV),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), NOT_VERIFIED),
    );
  });

  test('android is refused when a rebuilt .so does not match its pin (no CORE_REV bump)', () => {
    withTree(
      (dir) => writeFileSync(join(dir, MOD, 'android/src/main/jniLibs/x86_64/libbeebeeb_uniffi.so'), 'rebuilt'),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), NOT_VERIFIED),
    );
  });

  test('android is refused when the Kotlin binding changed', () => {
    withTree(
      (dir) => writeFileSync(join(dir, MOD, 'android/src/main/java/uniffi/beebeeb_uniffi/beebeeb_uniffi.kt'), '// regenerated\n'),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), NOT_VERIFIED),
    );
  });

  test('android is refused when an Android content reader changed while the pin is a real rev', () => {
    withTree(
      (dir) => {
        const p = join(dir, MOD, `${KT}/VideoStreamer.kt`);
        writeFileSync(p, readFileSync(p, 'utf8') + '\n// edited reader\n');
      },
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), NOT_VERIFIED),
    );
  });

  test('android is refused when an unpinned native library (a new ABI) is present', () => {
    withTree(
      (dir) => {
        mkdirSync(join(dir, MOD, 'android/src/main/jniLibs/armeabi-v7a'), { recursive: true });
        writeFileSync(join(dir, MOD, 'android/src/main/jniLibs/armeabi-v7a/libbeebeeb_uniffi.so'), 'v7a');
      },
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), 'unpinned native library'),
    );
  });

  test('android is refused on a Git LFS pointer stub, with the reason', () => {
    withTree(
      (dir) => writeFileSync(
        join(dir, MOD, 'android/src/main/jniLibs/arm64-v8a/libbeebeeb_uniffi.so'),
        `${LFS_PREFIX}/v1\noid sha256:00\nsize 1\n`,
      ),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), 'run git lfs pull'),
    );
  });

  test('android fails closed when CORE_REV or a pinned file is missing', () => {
    withTree(
      (dir) => rmSync(join(dir, MOD, 'CORE_REV')),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), 'CORE_REV is missing'),
    );
    withTree(
      (dir) => rmSync(join(dir, MOD, `${KT}/SharedKeyOps.kt`)),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), 'is missing'),
    );
  });

  for (const pin of ['unverified', '']) {
    test(`the re-arm pin '${pin}' refuses android even on a matching binding`, () => {
      withTree(
        (_dir, script) => {
          const src = readFileSync(script, 'utf8').replace(/^ANDROID_VERIFIED_CORE_REV="[^"]*"$/m, `ANDROID_VERIFIED_CORE_REV="${pin}"`);
          expect(src).toContain(`ANDROID_VERIFIED_CORE_REV="${pin}"`);
          writeFileSync(script, src);
        },
        (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), 're-armed'),
      );
    });
  }

  test('an evidence file cannot unlock an off-pin Android build', () => {
    withTree(
      (dir) => {
        writeFileSync(join(dir, MOD, 'CORE_REV'), OTHER_REV);
        mkdirSync(join(dir, 'docs/_qa-evidence/1943-mobile'), { recursive: true });
        writeFileSync(join(dir, EVIDENCE), '# M7 evidence — task 1943\n\n- 33 passed / 0 failed\n');
      },
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), NOT_VERIFIED),
    );
  });

  test('an exported CDPATH cannot redirect the tree the guard checks', () => {
    withTree(() => {}, (script, dir) => {
      // A decoy that `cd scripts/..` would find through CDPATH: it has no binding at all.
      const decoy = mkdtempSync(join(tmpdir(), 'bb-d15-cdpath-'));
      try {
        mkdirSync(join(decoy, 'scripts'), { recursive: true });
        const proc = Bun.spawnSync(['bash', 'scripts/android-release-guard.sh'], {
          cwd: dir,
          env: { ...cleanEnv(), ...ANDROID_EAS, CDPATH: decoy },
        });
        expectAllowed({ code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() });
      } finally {
        rmSync(decoy, { recursive: true, force: true });
      }
    });
  });

  test('the tree is resolved only AFTER the iOS exit (nothing about the tree can refuse iOS)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const iosExit = src.indexOf(`echo "android-release-guard: platform 'ios'`);
    const rootLine = src.search(/^ROOT=/m);
    expect(iosExit).toBeGreaterThan(-1);
    expect(rootLine).toBeGreaterThan(iosExit);
    expect(src).toMatch(/^ROOT="\$\(CDPATH= cd -- /m);
  });

  test('shell scripts are checked out with LF endings (a CRLF checkout breaks `set -o pipefail`)', () => {
    const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
    expect(attrs).toMatch(/^\*\.sh\s+text\s+eol=lf\s*$/m);
  });

  test('a CRLF copy of the script still allows iOS, and still refuses android (fails closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-d15-crlf-'));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      const crlf = join(dir, 'scripts/android-release-guard.sh');
      writeFileSync(crlf, readFileSync(SCRIPT, 'utf8').replace(/\n/g, '\r\n'));
      const ios = runGuard({ script: crlf, env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios' } });
      expect({ code: ios.code, out: ios.stdout.includes('allowed') }).toEqual({ code: 0, out: true });
      expect(runGuard({ script: crlf, args: ['ios'] }).code).toBe(0);
      expect(runGuard({ script: crlf, env: ANDROID_EAS }).code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the iOS exit comes before `set -euo pipefail`', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const iosExit = src.indexOf(`echo "android-release-guard: platform 'ios'`);
    const setLine = src.search(/^set -euo pipefail$/m);
    expect(iosExit).toBeGreaterThan(-1);
    expect(setLine).toBeGreaterThan(iosExit);
  });

  test('an EAS build with no EAS_BUILD_PLATFORM fails closed', () => {
    expectRefused(runGuard({ env: { EAS_BUILD: 'true' } }), 'no build platform (failing closed)');
  });

  test('an unknown EAS_BUILD_PLATFORM fails closed', () => {
    for (const platform of ['windows', 'web', 'ANDROID-PREVIEW']) {
      const result = runGuard({ env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: platform } });
      expectRefused(result, `unknown platform '${platform.toLowerCase()}' (failing closed)`);
    }
  });

  test('ios is always allowed, even when the Android binding is off-pin', () => {
    withTree(
      (dir) => writeFileSync(join(dir, MOD, 'CORE_REV'), OTHER_REV),
      (script) => {
        for (const profile of PROFILES) {
          const result = runGuard({ script, env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: profile } });
          expect({ profile, code: result.code }).toEqual({ profile, code: 0 });
        }
        expect(runGuard({ script, args: ['ios'] }).code).toBe(0);
      },
    );
  });

  test('outside an EAS build, no platform fails closed', () => {
    expectRefused(runGuard({}), 'no build platform (failing closed)');
  });
});
