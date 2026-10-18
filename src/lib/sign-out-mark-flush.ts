/**
 * Task 1667 round 3 (Codex P1 "Enforce the eight-second sign-out deadline").
 *
 * `App.signOut` sends the camera-roll backup marks the server does not have
 * yet BEFORE `logout()` revokes the session. The native flush is bounded by a
 * hard 8 s deadline (`SignOutMarkFlush.defaultDeadline`,
 * modules/beebeeb-crypto/ios/SignOutMarkFlush.swift); this bounds the JS wait
 * as well, so sign-out goes on even if the native promise never settles (a
 * bridge that never answers, an engine stuck before it reaches the flush).
 * What the flush did not mark is kept by the sign-out reset for this
 * account's next sign-in on this device.
 */

/** Mirrors `SignOutMarkFlush.defaultDeadline` (8 s). */
export const SIGN_OUT_MARK_FLUSH_NATIVE_DEADLINE_MS = 8_000;
/** Bridge and scheduling slack on top of the native deadline. */
export const SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS = 1_500;
export const SIGN_OUT_MARK_FLUSH_TIMEOUT_MS =
  SIGN_OUT_MARK_FLUSH_NATIVE_DEADLINE_MS + SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS;

export type SignOutMarkFlushResult = 'done' | 'failed' | 'timeout';

/**
 * Runs `flush` and resolves after it settles or after `timeoutMs`, whichever
 * comes first. Never rejects; a synchronous throw counts as 'failed'.
 */
export async function flushMarksBeforeSignOut(
  flush: () => Promise<unknown>,
  timeoutMs: number = SIGN_OUT_MARK_FLUSH_TIMEOUT_MS,
): Promise<SignOutMarkFlushResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SignOutMarkFlushResult>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const settled = Promise.resolve()
    .then(flush)
    .then(
      (): SignOutMarkFlushResult => 'done',
      (): SignOutMarkFlushResult => 'failed',
    );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
