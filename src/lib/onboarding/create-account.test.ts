// @ts-nocheck
/**
 * Task 1746: the create_account commit point. Before register-finish succeeds a
 * failure is retryable; after it, registration must never be offered again (it
 * would collide with the account that now exists).
 */
import { describe, expect, test } from 'bun:test';
import { runCreateAccount } from './create-account';
import { ActionError } from './ports';

function rig(opts = {}) {
  const log = [];
  const masterKey = new Uint8Array(32).fill(7);
  const ceremony = {
    startRegistration: async () => { log.push('startRegistration'); return new Uint8Array([1]); },
    finishRegistration: async (m) => { log.push(['finishRegistration', Array.from(m)]); return { upload: new Uint8Array([2]), x25519Public: new Uint8Array([3]), recoveryCheck: new Uint8Array([4]) }; },
    accountCreated: async () => { log.push('accountCreated'); if (opts.accountCreatedThrows) throw new Error('x'); return masterKey; },
    registrationFailed: async () => { log.push('registrationFailed'); },
    emailTicketInvalidated: async () => { log.push('emailTicketInvalidated'); },
  };
  const actions = {
    registerStart: async (i) => { log.push(['registerStart', i.email, i.ticket, i.pilotKey, Array.from(i.clientMessage)]); if (opts.startThrows) throw opts.startThrows; return new Uint8Array([9]); },
    registerFinish: async (i) => { log.push(['registerFinish', i.termsVersion, Array.from(i.upload), Array.from(i.x25519Public), Array.from(i.recoveryCheck)]); if (opts.finishThrows) throw opts.finishThrows; return { userId: 'u1' }; },
  };
  const ports = {
    actions,
    adoptVault: async (k) => { log.push(['adoptVault', k.length, k[0]]); if (opts.adoptThrows) throw new Error('vault'); return opts.adopted ?? true; },
  };
  const session = { email: 'a@beebeeb.io', pilotKey: '', ticket: 'T1' };
  return { log, masterKey, session, run: (extra = {}) => runCreateAccount({ ceremony, ports, session, termsVersion: '2026-09-29', ...extra }) };
}

describe('happy path', () => {
  test('runs the phases in order with the right inputs, hands the key over, then zeroes it', async () => {
    const r = rig();
    const out = await r.run();
    expect(out).toEqual({ kind: 'created', vaultAdopted: true });
    expect(r.log).toEqual([
      'startRegistration',
      ['registerStart', 'a@beebeeb.io', 'T1', '', [1]],
      ['finishRegistration', [9]],
      ['registerFinish', '2026-09-29', [2], [3], [4]],
      'accountCreated',
      ['adoptVault', 32, 7],
    ]);
    expect(Array.from(r.masterKey).every((b) => b === 0)).toBe(true); // wiped after the hand-over
  });

  test('reports status lines in order', async () => {
    const seen = [];
    await rig().run({ onStatus: (s) => seen.push(s) });
    expect(seen).toEqual(['Setting up account encryption', 'Generating encryption keys', 'Registering with the server', 'Securing your vault']);
  });
});

describe('before the account exists: retryable', () => {
  test('signup_ticket_invalid at register-finish returns to the code step and keeps the secrets (no registrationFailed, no key)', async () => {
    const r = rig({ finishThrows: new ActionError('signup_ticket_invalid', 'x') });
    const out = await r.run();
    expect(out).toEqual({ kind: 'ticket_invalid' });
    expect(r.log).toContain('emailTicketInvalidated');
    expect(r.log).not.toContain('registrationFailed');
    expect(r.log).not.toContain('accountCreated');
    expect(r.session.ticket).toBe('');
  });

  test('signup_ticket_invalid at register-start is the same path', async () => {
    const r = rig({ startThrows: new ActionError('signup_ticket_invalid', 'x') });
    expect((await r.run()).kind).toBe('ticket_invalid');
  });

  test('a rate limit puts the ceremony back and says so', async () => {
    const r = rig({ finishThrows: new ActionError('rate_limited', 'x', 120) });
    const out = await r.run();
    expect(out).toEqual({ kind: 'failed_before_account', rateLimited: true, code: 'rate_limited' });
    expect(r.log).toContain('registrationFailed');
    expect(r.log).not.toContain('accountCreated');
  });

  test('any other failure is retryable and never reaches the vault', async () => {
    const r = rig({ startThrows: new Error('boom') });
    const out = await r.run();
    expect(out.kind).toBe('failed_before_account');
    expect(out.rateLimited).toBe(false);
    expect(r.log).toContain('registrationFailed');
    expect(r.log.filter((l) => Array.isArray(l) && l[0] === 'adoptVault').length).toBe(0);
  });

  test('account_exists (409) is its own outcome: not retryable as "try again"', async () => {
    const r = rig({ finishThrows: new ActionError('account_exists', 'x') });
    expect(await r.run()).toEqual({ kind: 'account_exists' });
    expect(r.log).not.toContain('accountCreated');
  });
});

describe('after the account exists: never retry registration', () => {
  test('a vault that cannot adopt the key still reports created, and registrationFailed is NEVER called', async () => {
    const r = rig({ adoptThrows: true });
    const out = await r.run();
    expect(out).toEqual({ kind: 'created', vaultAdopted: false });
    expect(r.log).not.toContain('registrationFailed');
    expect(Array.from(r.masterKey).every((b) => b === 0)).toBe(true); // wiped even though adoption threw
  });

  test('a ceremony that cannot hand the key over still reports created', async () => {
    const r = rig({ accountCreatedThrows: true });
    expect(await r.run()).toEqual({ kind: 'created', vaultAdopted: false });
    expect(r.log).not.toContain('registrationFailed');
  });

  test('adoptVault returning false is created with vaultAdopted false', async () => {
    expect(await rig({ adopted: false }).run()).toEqual({ kind: 'created', vaultAdopted: false });
  });
});
