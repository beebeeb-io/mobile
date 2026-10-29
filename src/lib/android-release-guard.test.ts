// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — `scripts/android-release-guard.sh` (spec S6, decision D15).
 *
 * The script runs from `package.json`'s `eas-build-pre-install` hook on every EAS build and
 * refuses an Android **release** build (a `production*` profile, or an `internal`/`production`
 * submit track) while `docs/_qa-evidence/1943-mobile/android-m7.md` is absent. M7 writes that
 * file when the emulator cells and the device KAT have run, so no Android build reaches a
 * tester on a core whose Android side is unproven.
 *
 * Driven through the real script with a throwaway `BB_GUARD_ROOT`, so the test proves the
 * shipped behaviour rather than a copy of its logic.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts/android-release-guard.sh');
const EVIDENCE = 'docs/_qa-evidence/1943-mobile/android-m7.md';

/** A clean env: the lane shell may carry EAS_* vars, and the test must control them. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('EAS_') || key === 'BEEBEEB_ANDROID_TRACK' || key === 'BB_GUARD_ROOT') continue;
    env[key] = value;
  }
  return env;
}

function runGuard(extra: Record<string, string>, withEvidence: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'bb-1943-guard-'));
  mkdirSync(join(root, 'docs/_qa-evidence/1943-mobile'), { recursive: true });
  if (withEvidence) writeFileSync(join(root, EVIDENCE), '# M7 evidence\n');
  const proc = Bun.spawnSync(['bash', SCRIPT], {
    cwd: ROOT,
    env: { ...cleanEnv(), BB_GUARD_ROOT: root, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

describe('android-release-guard.sh (task 1943 M1 / S6)', () => {
  test('androidReleaseIsRefusedUntilM7Evidence', () => {
    const result = runGuard({ EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'production' }, false);
    expect(result.code).toBe(1);
    expect(result.output).toContain(EVIDENCE);
  });

  test('anAndroidInternalTrackBuildIsRefusedUntilM7Evidence', () => {
    const result = runGuard(
      { EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'production', EAS_SUBMIT_TRACK: 'internal' },
      false,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(EVIDENCE);
  });

  test('anAndroidReleaseBuildIsAllowedOnceTheEvidenceExists', () => {
    const result = runGuard({ EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'production' }, true);
    expect(result.code).toBe(0);
  });

  test('anIosBuildIsNeverRefused', () => {
    const result = runGuard({ EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: 'production' }, false);
    expect(result.code).toBe(0);
  });

  test('aNonReleaseAndroidProfileIsNotRefused', () => {
    const result = runGuard({ EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'development' }, false);
    expect(result.code).toBe(0);
  });
});
