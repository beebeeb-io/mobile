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
 * Round 3 (#141 Codex P1, "Purge native plaintext on cold signed-out
 * launches"): EVERY arrival on the signed-out surface runs the FULL purge
 * (`purgeAllPlaintextCaches`, what `signOut()` runs), including the native
 * registry. Round 2 ran only the decrypted-content purge when nobody had
 * signed in this process (cold launch with no session, a rejected token,
 * diagnostics → "Sign in") — but that is exactly the launch after a crash or
 * a revoked session, and the native registry holds decrypted content outside
 * `Library/Caches`: PhotoKit PNG renders (`Documents/beebeeb-photokit-cache`),
 * the File Provider's decrypted `pinned`/`temp` App Group directories, the
 * decrypted-name JSON, the thumbnail store. The next account to sign in on
 * this device would inherit all of it.
 *
 * Decision on `IncomingShares/` (the Share Extension inbox, also in the
 * native registry): PURGED too, no selective keep. The extension refuses to
 * accept anything without a session ("Sign in to Beebeeb first",
 * targets/share-extension/ShareViewController.swift:118 — it needs both the
 * master key and a session token), so a payload found at a
 * signed-out launch was dropped under a PREVIOUS session that then crashed or
 * was revoked — we cannot know which account it was meant for, and uploading
 * it into whoever signs in next is the leak Codex describes. The user can
 * share it again after signing in.
 *
 * `hadUser` survives only as the trace reason (`lastReason()`).
 *
 * `settled()` lets the sign-in path wait for a purge still running (incl. one
 * `signOut()` started directly), so a purge can never delete the NEW session's
 * first cache writes; `sessionStarted()` then reopens the plaintext gate
 * (src/lib/plaintext-gate.ts) that the purge left closed.
 */
import { plaintextGate as defaultGate, type PlaintextGate } from './plaintext-gate';

export interface SignedOutPurgeDeps {
  /** Everything signOut() purges: decrypted caches + the native registry. */
  full: () => Promise<unknown>;
  /** Plaintext-writer gate; defaults to the app-wide one. */
  gate?: Pick<PlaintextGate, 'open' | 'idle'>;
}

export type SignedOutReason = 'session-ended' | 'no-session-this-process';

export interface SignedOutPurger {
  noteUser: (signedIn: boolean) => void;
  enterSignedOut: () => Promise<void>;
  settled: () => Promise<void>;
  /** A new session was established: reopen the plaintext gate. */
  sessionStarted: () => void;
  lastReason: () => SignedOutReason | null;
}

export function createSignedOutPurger(deps: SignedOutPurgeDeps): SignedOutPurger {
  const gate = deps.gate ?? defaultGate;
  let hadUser = false;
  let reason: SignedOutReason | null = null;
  let pending: Promise<void> = Promise.resolve();

  return {
    noteUser(signedIn) {
      if (signedIn) {
        hadUser = true;
        // Safety net for any sign-in path that did not call sessionStarted().
        gate.open();
      }
    },
    enterSignedOut() {
      reason = hadUser ? 'session-ended' : 'no-session-this-process';
      hadUser = false;
      // Chain so two quick transitions never run two purges at once.
      pending = pending.then(() => deps.full()).then(() => undefined, () => undefined);
      return pending;
    },
    settled() {
      return pending.then(() => gate.idle());
    },
    sessionStarted() {
      gate.open();
    },
    lastReason: () => reason,
  };
}
