/**
 * Step-up re-auth helper for destructive operations.
 *
 * Prompts the user for their password, exchanges it for a short-lived
 * confirmation token via `confirmAction`, and returns the token (or `null`
 * if the user cancelled). Every surface (the password field, a wrong-
 * password re-prompt, a fatal error) is the app's own in-app sheet — never
 * a native `Alert`.
 *
 * There is no platform branch here any more (task 1610, Issue 2 round 2):
 * `<ConfirmActionPrompt />` (mounted once near the root in App.tsx) is
 * registered on iOS and Android alike via `registerConfirmPrompter`. A
 * native `Alert.prompt` presentation is asynchronous/animated; pairing it
 * with an immediate caller-side navigation was exactly the class of bug
 * that caused the Issue 2 black screen (see TwoFactorSetupScreen.tsx's
 * `handleDisabled` comment) — moving iOS onto the same sheet-driven
 * contract as Android, with the resolve ordering enforced by
 * `ConfirmActionPrompt` itself (its promise resolves only once the sheet's
 * close animation has actually finished, from `BottomSheet`'s
 * `onDismissed`), removes that whole class here too, not just papers over
 * the one call site that surfaced it.
 */

import {
  confirmAction,
  friendlyError,
  IncorrectPasswordError,
  SessionTooOldForConfirmationError,
} from './api';

/** One attempt's outcome, reported back to the registered prompter. */
export type ConfirmAttemptOutcome =
  | { ok: true; token: string }
  /** Wrong password — the sheet stays open, shows `message` in place, and
   *  lets the user try again without a new prompt/close-reopen cycle. */
  | { ok: false; retry: true; message: string }
  /** Not retryable (session too old, or anything else `confirmAction` can
   *  throw) — the sheet shows `title` + `message` in place of the password
   *  field; the only way out is to dismiss it. */
  | { ok: false; retry: false; title: string; message: string };

export interface ConfirmPromptRequest {
  title: string;
  message: string;
  /** Called with the password the user typed each time they submit. Never
   *  called more than once concurrently — the sheet waits for one attempt
   *  to settle before allowing the next. */
  attempt: (password: string) => Promise<ConfirmAttemptOutcome>;
}

/** Resolves once the user has cancelled, dismissed a fatal error, or a
 *  successful attempt's sheet has FULLY closed — never before (see the
 *  header comment on resolve ordering). Resolves to the confirmation token
 *  on success, `null` otherwise. */
export type ConfirmPrompter = (request: ConfirmPromptRequest) => Promise<string | null>;

let prompter: ConfirmPrompter | null = null;

/** Registered by `<ConfirmActionPrompt />` so this module can drive it —
 *  on every platform; there is no native fallback any more. */
export function registerConfirmPrompter(fn: ConfirmPrompter | null): void {
  prompter = fn;
}

/**
 * Prompt the user to re-enter their password, exchange it for a
 * confirmation token, and return the token. Returns `null` on cancel, on a
 * non-recoverable error (already shown in-app by the sheet itself), or when
 * no prompter is mounted at all.
 *
 * On wrong password, the sheet re-prompts IN PLACE so the user can correct
 * a typo without re-triggering the destructive action; that retry loop now
 * lives inside the sheet (via `attempt`), not here, so a wrong password
 * never closes and reopens the prompt.
 */
export async function requestConfirmation(opts?: {
  title?: string;
  message?: string;
}): Promise<string | null> {
  const title = opts?.title ?? 'Confirm with password';
  const message = opts?.message ?? 'Re-enter your password to authorize this action.';

  if (!prompter) {
    // No prompter mounted — fail closed. There is no native fallback left
    // to show a message with, so we simply never hand back a confirmation
    // token: every caller treats a `null` exactly like a cancel and the
    // destructive/step-up action never proceeds. Never a silent bypass.
    return null;
  }

  return prompter({
    title,
    message,
    attempt: async (password: string): Promise<ConfirmAttemptOutcome> => {
      try {
        const { confirmation_token } = await confirmAction(password);
        return { ok: true, token: confirmation_token };
      } catch (err) {
        if (err instanceof IncorrectPasswordError) {
          return { ok: false, retry: true, message: 'Incorrect password. Please try again.' };
        }
        if (err instanceof SessionTooOldForConfirmationError) {
          return {
            ok: false,
            retry: false,
            title: 'Please log out and back in',
            message: 'For security, this action requires a fresh login. Your data is safe.',
          };
        }
        return { ok: false, retry: false, title: 'Confirmation failed', message: friendlyError(err) };
      }
    },
  });
}
