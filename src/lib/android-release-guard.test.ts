// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — `scripts/android-release-guard.sh` (spec S6, decision D15).
 *
 * D15 amendment 2026-10-30 (lead ruling): an Android EAS build is allowed ONLY while the Android
 * binding is the last Android-verified one: `modules/beebeeb-crypto/CORE_REV` equals the pinned
 * rev AND the Kotlin binding and both `.so` files hash to their pinned sha256. Any binding bump
 * (a new CORE_REV or rebuilt artifacts) re-arms the guard without anyone having to remember;
 * the reviewed M7 PR moves the pins. The sentinel pin `unverified` (or an empty one) refuses every
 * Android build: how a PR that changes the Android readers without a binding bump re-arms it. iOS is always allowed; an
 * unset or unknown platform fails closed. There is no evidence-file unlock.
 *
 * Every test drives the shipped script through `bash` with the `EAS_*` variables EAS sets.
 * Tests that need a different binding copy the script plus the pinned files into a temp tree.
 */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/android-release-guard.sh');
const EVIDENCE = 'docs/_qa-evidence/1943-mobile/android-m7.md';

/** Every EAS build profile this repo defines plus the local variants EAS accepts. */
const PROFILES = ['production', 'production-local', 'preview', 'development', 'simulator'];

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

/** Run the shipped script with `bash` (no exec bit needed) and capture both streams. */
function runGuard(opts: { script?: string; args?: string[]; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(['bash', opts.script ?? SCRIPT, ...(opts.args ?? [])], {
    cwd: ROOT,
    env: { ...cleanEnv(), ...(opts.env ?? {}) },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
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


const BINDING_FILES = [
  'modules/beebeeb-crypto/CORE_REV',
  'modules/beebeeb-crypto/android/src/main/java/uniffi/beebeeb_uniffi/beebeeb_uniffi.kt',
  'modules/beebeeb-crypto/android/src/main/jniLibs/arm64-v8a/libbeebeeb_uniffi.so',
  'modules/beebeeb-crypto/android/src/main/jniLibs/x86_64/libbeebeeb_uniffi.so',
];

/** A temp tree holding a copy of the script and the pinned binding files, for mutation cases. */
function withTree(mutate: (dir: string) => void, run: (script: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-d15-guard-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(SCRIPT, join(dir, 'scripts/android-release-guard.sh'));
    for (const rel of BINDING_FILES) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      copyFileSync(join(ROOT, rel), join(dir, rel));
    }
    mutate(dir);
    run(join(dir, 'scripts/android-release-guard.sh'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ANDROID_EAS = { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' };

const ANDROID_REASON = 'not the last Android-verified binding';
const NO_PLATFORM_REASON = 'no build platform (failing closed)';

describe('android-release-guard.sh (task 1943 M1 / S6, D15 amendment 2026-10-30)', () => {
  test('android at the pinned, Android-verified binding is allowed with every profile', () => {
    for (const profile of PROFILES) {
      const result = runGuard({ env: { ...ANDROID_EAS, EAS_BUILD_PROFILE: profile } });
      expect({ profile, code: result.code, err: result.stderr }).toEqual({ profile, code: 0, err: '' });
    }
  });

  test('android is refused when CORE_REV is not the pinned rev', () => {
    withTree(
      (dir) => writeFileSync(join(dir, BINDING_FILES[0]), '0123456789abcdef0123456789abcdef01234567\n'),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), ANDROID_REASON),
    );
  });

  test('android is refused when a rebuilt .so does not match its pin (no CORE_REV bump)', () => {
    withTree(
      (dir) => writeFileSync(join(dir, BINDING_FILES[2]), 'rebuilt binary'),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), ANDROID_REASON),
    );
  });

  test('android is refused when the Kotlin binding changed', () => {
    withTree(
      (dir) => writeFileSync(join(dir, BINDING_FILES[1]), '// regenerated\n'),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), ANDROID_REASON),
    );
  });

  test('android fails closed when CORE_REV is missing', () => {
    withTree(
      (dir) => rmSync(join(dir, BINDING_FILES[0])),
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), ANDROID_REASON),
    );
  });

  for (const pin of ['unverified', '']) {
    test(`the re-arm pin '${pin}' refuses android even at the current binding`, () => {
      withTree(
        (dir) => {
          const p = join(dir, 'scripts/android-release-guard.sh');
          const src = readFileSync(p, 'utf8').replace(/^ANDROID_VERIFIED_CORE_REV="[0-9a-f]*"$/m, `ANDROID_VERIFIED_CORE_REV="${pin}"`);
          expect(src).toContain(`ANDROID_VERIFIED_CORE_REV="${pin}"`);
          writeFileSync(p, src);
        },
        (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), 're-armed'),
      );
    });
  }

  test('an EAS build with no EAS_BUILD_PLATFORM fails closed', () => {
    const result = runGuard({ env: { EAS_BUILD: 'true' } });
    expectRefused(result, NO_PLATFORM_REASON);
  });

  test('an unknown EAS_BUILD_PLATFORM fails closed', () => {
    for (const platform of ['windows', 'web', 'ANDROID-PREVIEW']) {
      const result = runGuard({ env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: platform } });
      expectRefused(result, `unknown platform '${platform.toLowerCase()}' (failing closed)`);
    }
  });

  test('ios under an EAS build is allowed with any profile', () => {
    for (const profile of PROFILES) {
      const result = runGuard({
        env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: profile },
      });
      expect({ profile, code: result.code }).toEqual({ profile, code: 0 });
    }
  });

  test('an uppercase ANDROID platform follows the android rule (refused off-pin)', () => {
    withTree(
      (dir) => writeFileSync(join(dir, BINDING_FILES[0]), '0123456789abcdef0123456789abcdef01234567\n'),
      (script) => expectRefused(runGuard({ script, env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ANDROID' } }), ANDROID_REASON),
    );
  });

  test('outside an EAS build, the positional platform uses the same rule', () => {
    expect(runGuard({ args: ['android'] }).code).toBe(0);
    expect(runGuard({ args: ['ios'] }).code).toBe(0);
    withTree(
      (dir) => writeFileSync(join(dir, BINDING_FILES[0]), '0123456789abcdef0123456789abcdef01234567\n'),
      (script) => expectRefused(runGuard({ script, args: ['android'] }), ANDROID_REASON),
    );
  });

  test('outside an EAS build, no platform fails closed', () => {
    expectRefused(runGuard({}), NO_PLATFORM_REASON);
  });

  test('an evidence file cannot unlock an off-pin Android build', () => {
    withTree(
      (dir) => {
        writeFileSync(join(dir, BINDING_FILES[0]), '0123456789abcdef0123456789abcdef01234567\n');
        mkdirSync(join(dir, 'docs/_qa-evidence/1943-mobile'), { recursive: true });
        writeFileSync(
          join(dir, EVIDENCE),
          ['# M7 evidence — task 1943', '', '## Android M7 evidence', '', '- 33 passed / 0 failed', ''].join('\n'),
        );
      },
      (script) => expectRefused(runGuard({ script, env: ANDROID_EAS }), ANDROID_REASON),
    );
  });
});
