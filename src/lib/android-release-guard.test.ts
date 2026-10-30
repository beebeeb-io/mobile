// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — `scripts/android-release-guard.sh` (spec S6, decision D15).
 *
 * Android ships nothing until task 1943 M7 passes. The script runs from `package.json`'s
 * `eas-build-pre-install` hook on every EAS build and refuses EVERY Android build, any
 * profile. It fails closed: inside an EAS build (any `EAS_BUILD*` variable set) only
 * `EAS_BUILD_PLATFORM=ios` is allowed; `android`, an unset platform and an unknown platform
 * are all refused. There is no evidence-file unlock — the PR that records M7's evidence
 * removes the hook from `eas-build-pre-install`, reviewed.
 *
 * Every test drives the shipped script through `bash` with the `EAS_*` variables EAS sets,
 * and one test copies the script's directory and plants a complete M7 evidence file next to
 * it to prove no repo file can unlock the guard.
 */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const ANDROID_REASON = 'an Android build';
const NO_PLATFORM_REASON = 'no build platform (failing closed)';

describe('android-release-guard.sh (task 1943 M1 / S6)', () => {
  for (const profile of PROFILES) {
    test(`android under an EAS build is refused with profile ${profile}`, () => {
      const result = runGuard({
        env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: profile },
      });
      expectRefused(result, ANDROID_REASON);
    });
  }

  test('android is refused under an EAS build with no profile at all', () => {
    const result = runGuard({ env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' } });
    expectRefused(result, ANDROID_REASON);
  });

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

  test('an uppercase ANDROID platform is still refused', () => {
    const result = runGuard({ env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ANDROID' } });
    expectRefused(result, ANDROID_REASON);
  });

  test('outside an EAS build, the positional platform uses the same rule', () => {
    expectRefused(runGuard({ args: ['android'] }), ANDROID_REASON);
    expect(runGuard({ args: ['ios'] }).code).toBe(0);
  });

  test('outside an EAS build, no platform fails closed', () => {
    expectRefused(runGuard({}), NO_PLATFORM_REASON);
  });

  test('an evidence file in the script directory cannot unlock an Android build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-1943-guard-'));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      copyFileSync(SCRIPT, join(dir, 'scripts/android-release-guard.sh'));
      mkdirSync(join(dir, 'docs/_qa-evidence/1943-mobile'), { recursive: true });
      writeFileSync(
        join(dir, EVIDENCE),
        ['# M7 evidence — task 1943', '', '## Android M7 evidence', '', '- 33 passed / 0 failed', ''].join('\n'),
      );
      const result = runGuard({
        script: join(dir, 'scripts/android-release-guard.sh'),
        env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' },
      });
      expectRefused(result, ANDROID_REASON);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
