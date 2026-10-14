/**
 * Side-effect ports for the native signup flow (task 1746).
 *
 * The flow is pure plumbing between the onboarding document and these ports, so a
 * unit test, a fixture screen and the real signup all drive the same logic. Three
 * kinds of side effect exist:
 *
 *   - `SignupActions`: server calls (email code, OPAQUE register, terms, verify);
 *   - `CeremonyPorts`: the core ceremony over UniFFI (password policy, breach gate,
 *     phrase, OPAQUE). Never re-implemented in TypeScript;
 *   - `fetchBreachBody`: the one HTTP call core leaves to the host, to our own API
 *     (k-anonymity prefix only), never a third party.
 *
 * Pure module: duck-types the API error instead of importing `api.ts`, so tests
 * need no native mocks.
 */

import type { BreachCheck, CeremonyConfig, PasswordEvaluation, SignupCeremony } from '../../../modules/beebeeb-crypto/src/BeebeebOnboarding';

/** Machine-readable failure from a port; the UI branches on `code`, never on text. */
export class ActionError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;
  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface ApiErrorLike {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  retryAfterSeconds?: unknown;
}

/**
 * An API failure as an `ActionError`. `status 0` is "could not reach the server",
 * 429 is `rate_limited`, a server machine code (`signup_ticket_invalid`, ...) is
 * kept, anything else gets `fallbackCode`.
 */
export function toActionError(err: unknown, fallbackCode: string): ActionError {
  if (err instanceof ActionError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as ApiErrorLike;
  const retry = typeof e.retryAfterSeconds === 'number' ? e.retryAfterSeconds : null;
  const message = typeof e.message === 'string' ? e.message : 'request failed';
  if (e.status === 0) return new ActionError('network', message, retry);
  if (e.status === 429) return new ActionError('rate_limited', message, retry);
  if (typeof e.code === 'string' && e.code.length > 0) return new ActionError(e.code, message, retry);
  return new ActionError(fallbackCode, message, retry);
}

export interface SignupActions {
  /** Answers identically for every address (anti-enumeration, spec 5.9). Resolves on 202. */
  emailStart(email: string, pilotKey: string): Promise<void>;
  /** Resolves with the single-use signup ticket. Rejects with `rate_limited` or `wrong_code`. */
  emailVerify(email: string, code: string): Promise<string>;
  /** OPAQUE round 1. Resolves with the server message bytes. */
  registerStart(input: { email: string; ticket: string; pilotKey: string; clientMessage: Uint8Array }): Promise<Uint8Array>;
  /** OPAQUE round 2. Rejects `signup_ticket_invalid` when the ticket expired (-> back to the code step). */
  registerFinish(input: {
    email: string;
    ticket: string;
    pilotKey: string;
    termsVersion: string;
    upload: Uint8Array;
    x25519Public: Uint8Array;
    recoveryCheck: Uint8Array;
  }): Promise<{ userId: string }>;
}

export interface CeremonyPorts {
  create(config: CeremonyConfig): Promise<SignupCeremony>;
  breach(password: string): Promise<BreachCheck>;
  /** Advisory live evaluation (meter and hint) from core. Never the gate: `setPassword` is. */
  evaluate(password: string, minLength: number): Promise<PasswordEvaluation>;
}

export interface SignupPorts {
  actions: SignupActions;
  ceremony: CeremonyPorts;
  fetchBreachBody: (endpoint: string, prefix: string) => Promise<string | null>;
  /**
   * The account exists and the session is stored. Hand the vault the new master
   * key (the caller zeroes it afterwards). Resolves true when the vault adopted
   * it; false means the vault did not unlock here and the person will be asked
   * for the recovery phrase they just wrote down (honest degraded path).
   */
  adoptVault: (masterKey: Uint8Array) => Promise<boolean>;
}
