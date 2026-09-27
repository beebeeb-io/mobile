/**
 * Task 1593 (round 2, #141 re-review P2-A/P2-B) — ONE place that purges
 * decrypted plaintext whenever the app lands on its signed-out surface.
 *
 * Round 1 added a preview sweep at four `setUser(null)` call sites; the
 * re-review found three more that had none (refreshAuth's 401, the startup
 * failure fallback, the diagnostics "Sign in") and that the forced sign-outs
 * (session expired, account deleted elsewhere) only swept the preview cache.
 * Per-call-site purges are how that drifted, so App.tsx now reports two facts
 * and this module decides:
 *
 *  - `noteUser(signedIn)` — every value `user` takes.
 *  - `enterSignedOut()` — the signed-out surface (login) is now showing.
 *
 * If a user was signed in during this process since the last purge, their
 * session just ended (any cause) → the FULL purge (`purgeAllPlaintextCaches`,
 * what `signOut()` runs). Otherwise nobody signed in this process — a cold
 * launch with no session, a rejected token, diagnostics → "Sign in" — and the
 * previous session may have ended in a crash before its purge → the
 * decrypted-content purge (`purgeDecryptedCaches`), which leaves the native
 * registry's non-cache paths alone so that files shared into the app while
 * signed out (App Group `IncomingShares/`) are still there to upload after
 * sign-in.
 *
 * `settled()` lets the sign-in path wait for a purge still running, so a
 * purge can never delete the NEW session's first cache writes.
 */

export interface SignedOutPurgeDeps {
  /** A session ended: everything signOut() purges. */
  full: () => Promise<unknown>;
  /** Nobody signed in this process: decrypted content left by a previous one. */
  leftover: () => Promise<unknown>;
}

export interface SignedOutPurger {
  noteUser: (signedIn: boolean) => void;
  enterSignedOut: () => Promise<void>;
  settled: () => Promise<void>;
}

export function createSignedOutPurger(deps: SignedOutPurgeDeps): SignedOutPurger {
  let hadUser = false;
  let pending: Promise<void> = Promise.resolve();

  return {
    noteUser(signedIn) {
      if (signedIn) hadUser = true;
    },
    enterSignedOut() {
      const run = hadUser ? deps.full : deps.leftover;
      hadUser = false;
      // Chain so two quick transitions never run two purges at once.
      pending = pending.then(() => run()).then(() => undefined, () => undefined);
      return pending;
    },
    settled() {
      return pending;
    },
  };
}
