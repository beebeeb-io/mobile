// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 round 2 (#141 re-review P2-A / P2-B) + round 3 (#141 Codex P1
 * "Purge native plaintext on cold signed-out launches") — the one signed-out
 * purge. App.tsx calls noteUser(user != null) on every `user` change and
 * enterSignedOut() when the login surface shows; the wiring itself is pinned
 * in account-cleanup.test.ts. Mutation evidence: task 1593 Notes.
 */
import { describe, expect, test } from 'bun:test';
import { createPlaintextGate } from './plaintext-gate';
import { createSignedOutPurger } from './signed-out-purge';

function harness() {
  const calls: string[] = [];
  const gate = createPlaintextGate();
  const purger = createSignedOutPurger({
    // Stands in for purgeAllPlaintextCaches: decrypted caches + the NATIVE registry.
    full: async () => { calls.push('decrypted-caches', 'native-registry'); },
    gate,
  });
  return { calls, purger, gate };
}

describe('createSignedOutPurger', () => {
  test('a session that ended (refreshAuth 401, session expired, account deleted, sign-out) → FULL purge', async () => {
    const { calls, purger } = harness();
    purger.noteUser(false); // cold start
    purger.noteUser(true); // signed in
    purger.noteUser(false); // setUser(null) from ANY call site
    await purger.enterSignedOut();
    expect(calls).toEqual(['decrypted-caches', 'native-registry']);
    expect(purger.lastReason()).toBe('session-ended');
  });

  test('round 3: a COLD signed-out launch (crash / revoked token / no token) also runs the NATIVE plaintext purge', async () => {
    const { calls, purger } = harness();
    purger.noteUser(false); // nobody signed in this process
    await purger.enterSignedOut();
    expect(calls).toContain('native-registry');
    expect(purger.lastReason()).toBe('no-session-this-process');
  });

  test('sign in → out → in → out: every arrival purges fully', async () => {
    const { calls, purger } = harness();
    await purger.enterSignedOut(); // launch
    purger.noteUser(true);
    purger.noteUser(false);
    await purger.enterSignedOut();
    purger.noteUser(true);
    purger.noteUser(false);
    await purger.enterSignedOut();
    expect(calls.filter((c) => c === 'native-registry').length).toBe(3);
  });

  test('settled() waits for a purge still running (sign-in must not race it)', async () => {
    let release;
    const purger = createSignedOutPurger({
      full: () => new Promise((r) => { release = r; }),
      gate: createPlaintextGate(),
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

  test('settled() also waits for a gate purge signOut() started directly', async () => {
    const gate = createPlaintextGate();
    const purger = createSignedOutPurger({ full: async () => {}, gate });
    let release;
    const direct = gate.purge(() => new Promise((r) => { release = r; }));
    let settled = false;
    void purger.settled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    release();
    await direct;
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
  });

  test('sessionStarted() reopens the plaintext gate the purge left closed', async () => {
    const { purger, gate } = harness();
    await gate.purge(async () => {});
    expect(gate.isOpen()).toBe(false);
    purger.sessionStarted();
    expect(gate.isOpen()).toBe(true);
  });

  test('a failing purge never rejects (sign-out must not break)', async () => {
    const purger = createSignedOutPurger({
      full: async () => { throw new Error('disk'); },
      gate: createPlaintextGate(),
    });
    await expect(purger.enterSignedOut()).resolves.toBeUndefined();
    await expect(purger.settled()).resolves.toBeUndefined();
  });
});
