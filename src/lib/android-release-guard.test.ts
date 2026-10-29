// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — `scripts/android-release-guard.sh` (spec S6, decision D15).
 *
 * The script runs from `package.json`'s `eas-build-pre-install` hook on every EAS build and
 * refuses EVERY Android build — cloud or `--local`, any profile — while
 * `docs/_qa-evidence/1943-mobile/android-m7.md` is missing or does not carry M7's recorded
 * results. `preview` is an installable APK for testers, and the spec says no Android build
 * reaches a tester before M7. iOS is never refused.
 *
 * Driven through the real script with a throwaway `BB_GUARD_ROOT`, so the test proves the
 * shipped behaviour rather than a copy of its logic. Each row of the table is a separate
 * test: narrowing the guard to one profile turns the other profiles' "refused" rows red.
 *
 * The evidence root is reachable only in test mode: `BB_GUARD_ROOT` is honoured when
 * `BB_GUARD_TEST=1` and no `EAS_BUILD*` variable is set, so a real EAS build can never be
 * pointed at a different evidence file.
 *
 * Capture note: this harness pipes the script's output through a tiny wrapper that redirects
 * to a file. On this Mac a `bun test` child writing straight into a pipe comes back with no
 * output and a bogus exit code, while a file redirect returns both faithfully.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/android-release-guard.sh');
const EVIDENCE = 'docs/_qa-evidence/1943-mobile/android-m7.md';

/** Every EAS build profile this repo defines plus the local variants EAS accepts. */
const PROFILES = ['production', 'production-local', 'preview', 'development', 'simulator'];

/** What M7 must have recorded for the guard to unlock. */
const VALID_EVIDENCE = [
  '# M7 evidence — task 1943',
  '',
  '## Android M7 evidence',
  '',
  '- `connectedDebugAndroidTest`: 33 passed / 0 failed',
  '',
].join('\n');

/** Placeholders that must NOT unlock the guard. */
const INVALID_EVIDENCE = {
  empty: '',
  headingOnly: ['# M7 evidence', '', '## Android M7 evidence', ''].join('\n'),
  placeholder: ['## Android M7 evidence', '', 'TBD', ''].join('\n'),
  passedWithoutANumber: ['## Android M7 evidence', '', 'passed', ''].join('\n'),
  numberWithoutTheHeading: ['# M7 evidence', '', '- 33 passed / 0 failed', ''].join('\n'),
};

/** A clean env: the lane shell may carry EAS_* vars, and the test must control them. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('EAS_')) continue;
    if (key === 'BB_GUARD_ROOT' || key === 'BB_GUARD_TEST' || key === 'BEEBEEB_ANDROID_TRACK') continue;
    env[key] = value;
  }
  return env;
}

function runGuard(opts: {
  evidence?: string | null;
  args?: string[];
  env?: Record<string, string>;
  testMode?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'bb-1943-guard-'));
  const outFile = join(root, 'guard-output.txt');
  const wrapper = join(root, 'run-guard.sh');
  try {
    mkdirSync(join(root, 'docs/_qa-evidence/1943-mobile'), { recursive: true });
    if (opts.evidence != null) writeFileSync(join(root, EVIDENCE), opts.evidence);
    writeFileSync(wrapper, '#!/usr/bin/env bash\n"$@" >"$BB_GUARD_OUT" 2>&1\n');
    chmodSync(wrapper, 0o755);

    const env: Record<string, string> = { ...cleanEnv(), BB_GUARD_ROOT: root, BB_GUARD_OUT: outFile };
    if (opts.testMode !== false) env.BB_GUARD_TEST = '1';
    Object.assign(env, opts.env ?? {});

    const proc = Bun.spawnSync([wrapper, SCRIPT, ...(opts.args ?? [])], {
      cwd: ROOT,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return {
      code: proc.exitCode,
      output: readFileSync(outFile, 'utf8'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('android-release-guard.sh (task 1943 M1 / S6)', () => {
  // (platform × profile × evidence state) — every Android profile behaves the same, and iOS
  // is never refused with or without evidence.
  for (const profile of PROFILES) {
    test(`android/${profile} is refused when the M7 evidence is absent`, () => {
      const result = runGuard({ args: ['android', profile] });
      expect(result.code).toBe(1);
      expect(result.output).toContain(EVIDENCE);
    });

    test(`android/${profile} is refused when the evidence is only a placeholder`, () => {
      for (const [name, body] of Object.entries(INVALID_EVIDENCE)) {
        const result = runGuard({ args: ['android', profile], evidence: body });
        expect({ name, code: result.code }).toEqual({ name, code: 1 });
      }
    });

    test(`android/${profile} is allowed with valid M7 evidence`, () => {
      const result = runGuard({ args: ['android', profile], evidence: VALID_EVIDENCE });
      expect(result.code).toBe(0);
    });

    test(`ios/${profile} is never refused`, () => {
      const withoutEvidence = runGuard({ args: ['ios', profile] });
      const withEvidence = runGuard({ args: ['ios', profile], evidence: VALID_EVIDENCE });
      expect({ without: withoutEvidence.code, with: withEvidence.code }).toEqual({ without: 0, with: 0 });
    });
  }

  test('a build with no platform at all is not an Android build', () => {
    expect(runGuard({ args: [] }).code).toBe(0);
  });

  test('the evidence content check needs the heading and a passed line with a number', () => {
    for (const [name, body] of Object.entries(INVALID_EVIDENCE)) {
      const result = runGuard({ args: ['android', 'production'], evidence: body });
      expect({ name, code: result.code }).toEqual({ name, code: 1 });
    }
    expect(runGuard({ args: ['android', 'production'], evidence: VALID_EVIDENCE }).code).toBe(0);
  });

  test('BB_GUARD_ROOT is ignored outside test mode', () => {
    const result = runGuard({ args: ['android', 'production'], evidence: VALID_EVIDENCE, testMode: false });
    expect(result.code).toBe(1);
    expect(result.output).toContain('ignoring BB_GUARD_ROOT');
  });

  test('BB_GUARD_ROOT is ignored while an EAS_BUILD* variable is set', () => {
    const result = runGuard({
      args: ['android', 'production'],
      evidence: VALID_EVIDENCE,
      env: { EAS_BUILD_PLATFORM: 'android' },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('ignoring BB_GUARD_ROOT');
  });
});
