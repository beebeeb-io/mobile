// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 round 2 (#141 re-review P2-A / P2-B) — the one signed-out purge.
 * App.tsx calls noteUser(user != null) on every `user` change and
 * enterSignedOut() when the login surface shows; the wiring itself is pinned
 * in account-cleanup.test.ts. Mutation evidence: task 1593 Notes (round 2).
 */
import { describe, expect, test } from 'bun:test';
import { createSignedOutPurger } from './signed-out-purge';

function harness() {
  const calls: string[] = [];
  const purger = createSignedOutPurger({
    full: async () => { calls.push('full'); },
    leftover: async () => { calls.push('leftover'); },
  });
  return { calls, purger };
}

describe('createSignedOutPurger', () => {
  test('a session that ended (refreshAuth 401, session expired, account deleted, sign-out) → FULL purge', async () => {
    const { calls, purger } = harness();
    purger.noteUser(false); // cold start
    purger.noteUser(true); // signed in
    purger.noteUser(false); // setUser(null) from ANY call site
    await purger.enterSignedOut();
    expect(calls).toEqual(['full']);
  });

  test('nobody signed in this process (no token / rejected token / diagnostics "Sign in" / startup failure) → decrypted-content purge', async () => {
    const { calls, purger } = harness();
    purger.noteUser(false);
    await purger.enterSignedOut();
    expect(calls).toEqual(['leftover']);
  });

  test('sign in → out → in → out: each ended session gets its own full purge', async () => {
    const { calls, purger } = harness();
    await purger.enterSignedOut(); // launch
    purger.noteUser(true);
    purger.noteUser(false);
    await purger.enterSignedOut();
    purger.noteUser(true);
    purger.noteUser(false);
    await purger.enterSignedOut();
    expect(calls).toEqual(['leftover', 'full', 'full']);
  });

  test('settled() waits for a purge still running (sign-in must not race it)', async () => {
    let release;
    const purger = createSignedOutPurger({
      full: () => new Promise((r) => { release = r; }),
      leftover: async () => {},
    });
    purger.noteUser(true);
    void purger.enterSignedOut();
    let settled = false;
    void purger.settled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
  });

  test('a failing purge never rejects (sign-out must not break)', async () => {
    const purger = createSignedOutPurger({
      full: async () => { throw new Error('disk'); },
      leftover: async () => { throw new Error('disk'); },
    });
    await expect(purger.enterSignedOut()).resolves.toBeUndefined();
    await expect(purger.settled()).resolves.toBeUndefined();
  });
});
