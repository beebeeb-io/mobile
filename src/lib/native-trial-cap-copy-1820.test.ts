// @ts-nocheck
/**
 * PR #168 round 2: the native camera-backup engine shows its stop reason through
 * `accountRefusalReason` (SettingsScreen). Its 413 trial-cap copy must be the JS
 * `trialCapMessage` sentence with the server's `limit_bytes`, not a hard-coded
 * "25 GB ... until your first payment ... Manage your plan". The Swift behaviour is
 * run by scripts/test-account-refusal-detection.sh; this guard keeps the source
 * from regressing between hand runs and ties the sentence to the JS one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trialCapMessage } from './trial-refusals';

const root = join(import.meta.dir, '..', '..', 'modules', 'beebeeb-crypto', 'ios');
const engine = readFileSync(join(root, 'NativeBackupEngine.swift'), 'utf8');
const detection = readFileSync(join(root, 'AccountRefusalDetection.swift'), 'utf8');

describe('native trial-cap copy', () => {
  test('the engine has no hard-coded cap sentence and no purchase wording', () => {
    expect(engine).not.toContain('trialCapStopReasonMessage');
    expect(engine).not.toMatch(/until your first payment clears/);
    expect(engine).not.toMatch(/Manage your plan/);
  });

  test('the engine builds the message from the 413 body (limit_bytes)', () => {
    expect(engine).toContain('AccountRefusalDetection.trialCapLimitBytes(data)');
    expect(engine).toContain('AccountRefusalDetection.trialCapMessage(limitBytes:');
  });

  test('the Swift sentence template is the JS sentence, word for word', () => {
    const js = trialCapMessage(10_000_000_000);
    const [head, tail] = js.split('10 GB');
    expect(detection).toContain(head.replace(/"/g, '\\"') + '\\(formatSize(bytes))' + tail);
  });
});
