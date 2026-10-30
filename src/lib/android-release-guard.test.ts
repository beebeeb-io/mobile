// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 D15 — `scripts/android-release-guard.sh`, the structural Android build guard
 * (workspace lead ruling, 2026-10-30; plan "Amendment 2026-10-30 (2)").
 *
 * The script runs from `package.json`'s `eas-build-pre-install` hook on every EAS build. An Android
 * build is refused unless the build's `modules/beebeeb-crypto/CORE_REV` equals the pinned
 * `ANDROID_VERIFIED_CORE_REV` (the last core revision whose Android readers task 1943 M7 verified).
 * The pin may be the sentinel `unverified` (set by any PR that changes Android content readers),
 * which refuses every Android build. A missing or empty CORE_REV is refused. iOS is never refused.
 *
 * Every test copies the shipped script into a scratch repo layout with its own CORE_REV, so the
 * rule is exercised without any test-only switch in the script, and drives it through `bash` with
 * the `EAS_*` variables EAS sets.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/android-release-guard.sh');
const CORE_REV_PATH = 'modules/beebeeb-crypto/CORE_REV';
const PIN_RE = /^ANDROID_VERIFIED_CORE_REV=([0-9a-f]{40}|unverified)$/m;

/** The pin the shipped script carries. */
function shippedPin(): string {
  const m = readFileSync(SCRIPT, 'utf8').match(PIN_RE);
  if (!m) throw new Error('scripts/android-release-guard.sh has no ANDROID_VERIFIED_CORE_REV line');
  return m[1];
}

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

/**
 * Lay out a scratch repo with the shipped script (optionally with another pin) and a CORE_REV
 * (`null` = no file), run it with `bash`, capture both streams, and clean up.
 */
function runGuard(opts: {
  coreRev: string | null;
  pin?: string;
  env?: Record<string, string>;
  args?: string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-1943-guard-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    let script = readFileSync(SCRIPT, 'utf8');
    if (opts.pin !== undefined) script = script.replace(PIN_RE, `ANDROID_VERIFIED_CORE_REV=${opts.pin}`);
    writeFileSync(join(dir, 'scripts/android-release-guard.sh'), script);
    if (opts.coreRev !== null) {
      mkdirSync(join(dir, 'modules/beebeeb-crypto'), { recursive: true });
      writeFileSync(join(dir, CORE_REV_PATH), opts.coreRev);
    }
    const proc = Bun.spawnSync(['bash', join(dir, 'scripts/android-release-guard.sh'), ...(opts.args ?? [])], {
      cwd: dir,
      env: { ...cleanEnv(), ...(opts.env ?? {}) },
    });
    return {
      code: proc.exitCode,
      stdout: proc.stdout?.toString() ?? '',
      stderr: proc.stderr?.toString() ?? '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A refusal is not just exit 1: the guard must SAY it refused and why, and point at M7. An unbound
 * variable or a crash in the refusal path also exits 1, and must not count as a refusal.
 */
function expectRefused(result: { code: number; stderr: string }, reason: string) {
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('REFUSED');
  expect(result.stderr).toContain(reason);
  expect(result.stderr).toContain('M7');
}

const PIN = shippedPin();
const OTHER_REV = 'ffffffffffffffffffffffffffffffffffffffff';
const ANDROID = { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'preview' };
const PROFILES = ['production', 'production-local', 'preview', 'development', 'simulator'];

describe('android-release-guard.sh (task 1943 D15, structural)', () => {
  test('the shipped pin is a full core revision or the sentinel', () => {
    expect(PIN).toMatch(/^([0-9a-f]{40}|unverified)$/);
  });

  test('an Android build at the pinned CORE_REV is allowed, any profile', () => {
    if (PIN === 'unverified') return; // the sentinel refuses every Android build (tested below)
    for (const profile of PROFILES) {
      const result = runGuard({ coreRev: `${PIN}\n`, env: { ...ANDROID, EAS_BUILD_PROFILE: profile } });
      expect({ profile, code: result.code, stderr: result.stderr }).toEqual({ profile, code: 0, stderr: '' });
    }
  });

  test('an Android build at another CORE_REV is refused and names both revisions', () => {
    const result = runGuard({ coreRev: `${OTHER_REV}\n`, pin: 'c08defc70c35428926be6784d18ff091be6d004c', env: ANDROID });
    expectRefused(result, 'CORE_REV differs from the Android-verified revision');
    expect(result.stderr).toContain(OTHER_REV);
    expect(result.stderr).toContain('c08defc70c35428926be6784d18ff091be6d004c');
  });

  test('the sentinel pin refuses an Android build at every CORE_REV', () => {
    for (const rev of ['c08defc70c35428926be6784d18ff091be6d004c', OTHER_REV, 'unverified']) {
      const result = runGuard({ coreRev: `${rev}\n`, pin: 'unverified', env: ANDROID });
      expectRefused(result, 'Android readers changed since the last M7 verification');
    }
  });

  test('a missing CORE_REV fails closed', () => {
    expectRefused(runGuard({ coreRev: null, env: ANDROID }), 'cannot read');
  });

  test('an empty or malformed CORE_REV fails closed', () => {
    for (const bad of ['', '\n', 'not-a-rev\n', `${PIN} extra\n`]) {
      expectRefused(runGuard({ coreRev: bad, env: ANDROID }), 'not a core revision');
    }
  });

  test('iOS is allowed whatever CORE_REV and pin say', () => {
    for (const coreRev of [`${OTHER_REV}\n`, null]) {
      for (const pin of ['unverified', 'c08defc70c35428926be6784d18ff091be6d004c']) {
        const result = runGuard({ coreRev, pin, env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios' } });
        expect({ coreRev, pin, code: result.code }).toEqual({ coreRev, pin, code: 0 });
      }
    }
  });

  test('an EAS build with no platform or an unknown platform fails closed', () => {
    expectRefused(runGuard({ coreRev: `${PIN}\n`, env: { EAS_BUILD: 'true' } }), 'no build platform');
    expectRefused(
      runGuard({ coreRev: `${PIN}\n`, env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'windows' } }),
      "unknown platform 'windows'",
    );
  });

  test('an uppercase ANDROID platform follows the Android rule', () => {
    const result = runGuard({ coreRev: `${OTHER_REV}\n`, pin: 'c08defc70c35428926be6784d18ff091be6d004c', env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ANDROID' } });
    expectRefused(result, 'CORE_REV differs');
  });

  test('outside an EAS build, the positional platform uses the same rule', () => {
    expectRefused(runGuard({ coreRev: `${OTHER_REV}\n`, pin: 'c08defc70c35428926be6784d18ff091be6d004c', args: ['android'] }), 'CORE_REV differs');
    expect(runGuard({ coreRev: `${OTHER_REV}\n`, args: ['ios'] }).code).toBe(0);
    expectRefused(runGuard({ coreRev: `${PIN}\n` }), 'no build platform');
  });
});
