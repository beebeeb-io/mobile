// @ts-nocheck
// Task 1539 (finding 4 follow-up, Codex P2, PR #109 review) — discard a
// passphrase-verification completion whose token is no longer current.
//
// RED on this branch pre-fix: `src/lib/share-verify-gate.ts` does not exist
// yet, so this whole file fails at module resolution:
//   error: Cannot find module './share-verify-gate' from
//   ".../src/lib/share-verify-gate.test.ts"
// See the task Notes for the pasted failure.
import { describe, expect, test } from 'bun:test';
import { isStaleShareVerification } from './share-verify-gate';

describe('isStaleShareVerification', () => {
  test('the request token matches the token the screen currently shows — not stale, apply it', () => {
    expect(isStaleShareVerification('tok-A', 'tok-A')).toBe(false);
  });

  test('the screen has since moved on to a DIFFERENT share deep link while this request was in flight — stale, discard it', () => {
    // This is the exact bug: SharedViewScreen re-renders (not remounts) for
    // a new `token` route param, resets `info`/`verifyError`/`verifying`,
    // but a stale in-flight verifySharePassphrase() call for the OLD token
    // could still resolve and overwrite that fresh state with the wrong
    // share's metadata.
    expect(isStaleShareVerification('tok-A', 'tok-B')).toBe(true);
  });
});
