// Task 1539 (finding 4 follow-up, Codex P2, PR #109 review) — shared
// decision for discarding a stale passphrase-verification completion.
//
// Bug: SharedViewScreen's `handleVerifyPassphrase` captured `token` in its
// closure and applied whatever `verifySharePassphrase()` resolved with
// unconditionally. If the route's `token` param changes while a
// verification request is still in flight — the SAME screen instance
// re-rendering for a DIFFERENT share deep link, exactly the re-navigation
// case the adjacent metadata effect already guards with its own
// `cancelled` local — the stale response could still land and overwrite
// the new share's freshly-reset state (`info`/`verifyError`/`verifying`)
// with the OLD share's verified metadata. Same cancellation pattern as
// that effect, just needed across a callback boundary (a `useCallback`
// outside the effect) instead of inside one, so it is exposed here as a
// pure, directly-testable decision rather than inlined at the call site.

/**
 * Whether a verification response requested for `requestToken` should be
 * discarded because the screen has since moved on to a different
 * `currentToken` (e.g. a second share deep link arrived before the first
 * request resolved).
 */
export function isStaleShareVerification(requestToken: string, currentToken: string): boolean {
  return requestToken !== currentToken;
}
