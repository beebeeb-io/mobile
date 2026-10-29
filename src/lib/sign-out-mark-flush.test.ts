// @ts-nocheck — bun runs this; `bun:test` types + `import.meta.dir` are not in the Expo tsconfig.
/**
 * Task 1667 round 3 (Codex P1 "Enforce the eight-second sign-out deadline"):
 * the JS wait for the native sign-out mark flush is bounded even when the
 * native promise never settles, so `App.signOut` always reaches `logout()`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS,
  SIGN_OUT_MARK_FLUSH_NATIVE_DEADLINE_MS,
  SIGN_OUT_MARK_FLUSH_TIMEOUT_MS,
  flushMarksBeforeSignOut,
} from './sign-out-mark-flush';

const never = () => new Promise<never>(() => {});

describe('flushMarksBeforeSignOut', () => {
  test('a native call that never resolves: resolves "timeout" after timeoutMs', async () => {
    const started = Date.now();
    const result = await flushMarksBeforeSignOut(never, 60);
    const elapsed = Date.now() - started;
    expect(result).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(60 + 250);
  });

  test('with the default bound, a never-resolving native call releases sign-out by 8 s + margin', async () => {
    const started = Date.now();
    const result = await flushMarksBeforeSignOut(never);
    const elapsed = Date.now() - started;
    expect(result).toBe('timeout');
    expect(elapsed).toBeLessThan(SIGN_OUT_MARK_FLUSH_NATIVE_DEADLINE_MS + SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS + 250);
  }, 15_000);

  test('the bound is the native 8 s deadline plus a small margin', () => {
    const swift = readFileSync(
      join(import.meta.dir, '../../modules/beebeeb-crypto/ios/SignOutMarkFlush.swift'),
      'utf8',
    );
    const m = swift.match(/static let defaultDeadline: TimeInterval = (\d+(?:\.\d+)?)/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBe(SIGN_OUT_MARK_FLUSH_NATIVE_DEADLINE_MS);
    expect(SIGN_OUT_MARK_FLUSH_NATIVE_DEADLINE_MS).toBe(8_000);
    expect(SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS).toBeGreaterThan(0);
    expect(SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS).toBeLessThanOrEqual(2_000);
    expect(SIGN_OUT_MARK_FLUSH_TIMEOUT_MS).toBe(SIGN_OUT_MARK_FLUSH_NATIVE_DEADLINE_MS + SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS);
  });

  test('a native call that resolves: "done", without waiting for the timer', async () => {
    const started = Date.now();
    const result = await flushMarksBeforeSignOut(async () => ({ candidates: 2, marked: 2 }), 5_000);
    expect(result).toBe('done');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('a rejecting or throwing native call: "failed", never a rejection', async () => {
    expect(await flushMarksBeforeSignOut(() => Promise.reject(new Error('bridge')), 5_000)).toBe('failed');
    expect(
      await flushMarksBeforeSignOut(() => {
        throw new Error('sync');
      }, 5_000),
    ).toBe('failed');
  });
});
