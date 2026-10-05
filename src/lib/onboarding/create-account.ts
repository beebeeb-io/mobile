/**
 * The create_account sequence (task 1746), pulled out of the React step so the
 * commit point is testable without a renderer. Port of the web's
 * `create-account.ts` (task 1745).
 *
 * Two phases with a hard line between them:
 *
 *   1. BEFORE the account exists: register-start, the OPAQUE finish in core,
 *      register-finish. A failure here stored nothing, so the ceremony is put
 *      back (`registrationFailed`) and the person may try again or start over.
 *
 *   2. AFTER register-finish succeeded the account AND a session exist on the
 *      server, and the session token is already stored. A later failure (the
 *      ceremony's key hand-over, the vault) must NEVER call `registrationFailed`
 *      or offer "try again": a second registration collides with the account that
 *      now exists. The caller refreshes auth either way; if the vault did not
 *      adopt the key the app shows "Vault locked" and asks for the recovery
 *      phrase the person just wrote down.
 */

import type { SignupCeremony } from '../../../modules/beebeeb-crypto/src/BeebeebOnboarding';
import { ActionError, type SignupPorts } from './ports';

export interface CreateAccountSession {
  email: string;
  pilotKey: string;
  ticket: string;
}

export type CreateAccountOutcome =
  /**
   * The account exists. `vaultAdopted` false means the vault did not adopt the key:
   * refresh auth anyway and let "Vault locked" ask for the recovery phrase.
   */
  | { kind: 'created'; vaultAdopted: boolean }
  /** The email-code ticket expired before register-finish: back to the code step. */
  | { kind: 'ticket_invalid' }
  /** The address gained an account between the code and the finish (409 account_exists, ticket kept). */
  | { kind: 'account_exists' }
  /** Nothing was stored. Retry or start over is safe. */
  | { kind: 'failed_before_account'; rateLimited: boolean; code: string };

export interface CreateAccountDeps {
  ceremony: Pick<
    SignupCeremony,
    'startRegistration' | 'finishRegistration' | 'accountCreated' | 'registrationFailed' | 'emailTicketInvalidated'
  >;
  ports: Pick<SignupPorts, 'actions' | 'adoptVault'>;
  session: CreateAccountSession;
  /** `policy.terms.version`: the version the person was shown and accepted. */
  termsVersion: string;
  onStatus?: (status: string) => void;
}

export async function runCreateAccount(deps: CreateAccountDeps): Promise<CreateAccountOutcome> {
  const { ceremony, ports, session: s } = deps;
  const status = deps.onStatus ?? (() => {});

  // Phase 1: the account does not exist yet.
  try {
    status('Setting up account encryption');
    const clientMessage = await ceremony.startRegistration();
    const serverMessage = await ports.actions.registerStart({
      email: s.email,
      ticket: s.ticket,
      pilotKey: s.pilotKey,
      clientMessage,
    });
    status('Generating encryption keys');
    const fin = await ceremony.finishRegistration(serverMessage);
    status('Registering with the server');
    await ports.actions.registerFinish({
      email: s.email,
      ticket: s.ticket,
      pilotKey: s.pilotKey,
      termsVersion: deps.termsVersion,
      upload: fin.upload,
      x25519Public: fin.x25519Public,
      recoveryCheck: fin.recoveryCheck,
    });
  } catch (err) {
    const code = err instanceof ActionError ? err.code : 'unknown';
    if (code === 'signup_ticket_invalid') {
      // Spec 5.9: back to the code step, keep the confirmed phrase and the typed
      // password (core keeps them across emailTicketInvalidated).
      try {
        await ceremony.emailTicketInvalidated();
      } catch {
        /* the ceremony will refuse create_account until the code is redone anyway */
      }
      s.ticket = '';
      return { kind: 'ticket_invalid' };
    }
    if (code === 'account_exists') {
      return { kind: 'account_exists' };
    }
    try {
      await ceremony.registrationFailed();
    } catch {
      /* not in a retryable state; the error line tells the person */
    }
    return { kind: 'failed_before_account', rateLimited: code === 'rate_limited', code };
  }

  // Phase 2: the account and a session exist. Commit point passed.
  let masterKey: Uint8Array | null = null;
  try {
    status('Securing your vault');
    masterKey = await ceremony.accountCreated();
    const adopted = await ports.adoptVault(masterKey);
    return { kind: 'created', vaultAdopted: adopted === true };
  } catch {
    return { kind: 'created', vaultAdopted: false };
  } finally {
    masterKey?.fill(0);
  }
}
