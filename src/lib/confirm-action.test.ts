// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches every other *.test.ts(x) file in this repo).
//
// Task 1610, Issue 2 round 2 — confirm-action.ts's own business logic,
// independent of the sheet that renders it (`ConfirmActionPrompt.test.tsx`
// covers that half). Three things this file locks down:
//
//   1. No prompter mounted → `requestConfirmation()` resolves `null` and
//      NEVER calls `confirmAction` at all — fail-closed, no bypass, even by
//      accident (a caller that ignored the `null` and tried to use it as a
//      token would find there was never a network call to have proven
//      anything).
//   2. `attempt(password)` (what the registered prompter drives on each
//      submit) maps `confirmAction`'s three outcomes — success, wrong
//      password, session-too-old — plus any other thrown error, onto the
//      typed `ConfirmAttemptOutcome` the sheet renders from. None of this
//      goes through `Alert` any more — this file's mocked `react-native`
//      doesn't even define `Alert`, so an accidental reintroduction would
//      throw at call time, not silently pass.
//   3. The request handed to the prompter carries the given (or default)
//      title/message verbatim.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
class IncorrectPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'IncorrectPasswordError';
  }
}
class SessionTooOldForConfirmationError extends Error {
  constructor(message = 'For security, please log out and log back in before performing this action.') {
    super(message);
    this.name = 'SessionTooOldForConfirmationError';
  }
}

let confirmActionImpl: (password: string) => Promise<{ confirmation_token: string; expires_at: string }>;

mock.module('./api', () => ({
  ApiError,
  IncorrectPasswordError,
  SessionTooOldForConfirmationError,
  confirmAction: (password: string) => confirmActionImpl(password),
  friendlyError: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
}));

const { registerConfirmPrompter, requestConfirmation } = await import('./confirm-action');

beforeEach(() => {
  registerConfirmPrompter(null);
  confirmActionImpl = async () => {
    throw new Error('confirmActionImpl not configured for this test');
  };
});

describe('requestConfirmation — no prompter mounted (fail closed)', () => {
  test('resolves null and never calls confirmAction — no bypass', async () => {
    let confirmActionCalls = 0;
    confirmActionImpl = async () => {
      confirmActionCalls += 1;
      return { confirmation_token: 'should-never-happen', expires_at: '' };
    };
    const token = await requestConfirmation({ title: 'x', message: 'y' });
    expect(token).toBeNull();
    expect(confirmActionCalls).toBe(0);
  });
});

describe('requestConfirmation — hands the prompter the given/default title+message', () => {
  test('custom title/message pass through verbatim', async () => {
    let seen: { title: string; message: string } | null = null;
    registerConfirmPrompter(async (req) => {
      seen = { title: req.title, message: req.message };
      return null;
    });
    await requestConfirmation({ title: 'Confirm account deletion', message: 'Enter your password.' });
    expect(seen).toEqual({ title: 'Confirm account deletion', message: 'Enter your password.' });
  });

  test('default title/message when omitted', async () => {
    let seen: { title: string; message: string } | null = null;
    registerConfirmPrompter(async (req) => {
      seen = { title: req.title, message: req.message };
      return null;
    });
    await requestConfirmation();
    expect(seen.title).toBe('Confirm with password');
    expect(seen.message).toBe('Re-enter your password to authorize this action.');
  });

  test("the prompter's own resolution is what requestConfirmation resolves to", async () => {
    registerConfirmPrompter(async () => 'confirm-token-abc');
    await expect(requestConfirmation()).resolves.toBe('confirm-token-abc');
  });
});

describe('attempt() outcome mapping — the retry loop the sheet drives', () => {
  async function attemptOf(password: string) {
    let captured: ((password: string) => Promise<unknown>) | null = null;
    registerConfirmPrompter(async (req) => {
      captured = req.attempt;
      return null;
    });
    await requestConfirmation();
    if (!captured) throw new Error('attempt() was never captured');
    return captured(password);
  }

  test('success: confirmAction resolves → { ok: true, token }', async () => {
    confirmActionImpl = async (password) => {
      expect(password).toBe('hunter2');
      return { confirmation_token: 'tok-123', expires_at: '2099-01-01T00:00:00Z' };
    };
    const outcome = await attemptOf('hunter2');
    expect(outcome).toEqual({ ok: true, token: 'tok-123' });
  });

  test('wrong password: IncorrectPasswordError → retryable, in-app message, never Alert', async () => {
    confirmActionImpl = async () => {
      throw new IncorrectPasswordError();
    };
    const outcome = await attemptOf('wrong');
    expect(outcome).toEqual({ ok: false, retry: true, message: 'Incorrect password. Please try again.' });
  });

  test('session too old: SessionTooOldForConfirmationError → fatal, "Please log out and back in"', async () => {
    confirmActionImpl = async () => {
      throw new SessionTooOldForConfirmationError();
    };
    const outcome = await attemptOf('correct-but-stale-session');
    expect(outcome).toEqual({
      ok: false,
      retry: false,
      title: 'Please log out and back in',
      message: 'For security, this action requires a fresh login. Your data is safe.',
    });
  });

  test('any other error: fatal, "Confirmation failed", friendlyError(err) as the message', async () => {
    confirmActionImpl = async () => {
      throw new ApiError(500, 'boom');
    };
    const outcome = await attemptOf('x');
    expect(outcome).toEqual({ ok: false, retry: false, title: 'Confirmation failed', message: 'boom' });
  });
});

// ── Source-text guard: the permanent, RED-provable lock that the iOS
// `Alert.prompt` / Android-only naming never comes back. ──────────────────
describe('confirm-action.ts — source guards (task 1610, Issue 2 round 2)', () => {
  const src = readFileSync(new URL('./confirm-action.ts', import.meta.url), 'utf-8');

  test('no Platform import/branch and no react-native Alert import — no native fallback left', () => {
    expect(src).not.toContain('Platform');
    expect(src).not.toMatch(/from 'react-native'/);
    expect(src).not.toMatch(/\bAlert\.(alert|prompt)\(/);
  });

  test('the registration function is platform-neutral, not the old Android-only name', () => {
    expect(src).toContain('export function registerConfirmPrompter(');
    expect(src).not.toContain('registerAndroidConfirmPrompter');
    expect(src).not.toContain('androidPrompter');
  });
});
