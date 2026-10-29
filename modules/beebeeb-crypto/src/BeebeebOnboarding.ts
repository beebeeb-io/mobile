/**
 * JS side of the native onboarding bridge (task 1746).
 *
 * Wraps `beebeeb_core::onboarding` (task 1744: password-policy evaluator,
 * k-anonymity breach check, signup ceremony state machine) as reached through
 * UniFFI and `OnboardingBridge.swift`. ALL logic lives in core. This file only
 * gives the native integer handles a typed, disposable face, and turns native
 * `ERR_ONBOARDING_<CODE>` exceptions into a `CeremonyError` with a stable code
 * the UI branches on (never on text).
 *
 * Secret handling, honestly:
 *   - the password, the recovery phrase and the master key live in Rust memory in
 *     zeroizing buffers; JS holds an opaque integer;
 *   - the password goes through the bridge as a JS string, because the user typed
 *     it into a JS TextInput; a JS string cannot be wiped (core CLAUDE.md,
 *     "Memory"), so callers drop their references the moment the step is left;
 *   - `phrase()` returns the words once, for the phrase screen to render; the
 *     caller must drop them when leaving it;
 *   - `accountCreated()` returns the master key bytes once, to be stored by the
 *     vault code and then zeroed (`fill(0)`) by the caller.
 *   - `dispose()` calls `abandon` (wipe) before releasing the handle; call it on
 *     back, cancel and error exits.
 *
 * Nothing in here logs anything.
 */

import BeebeebCryptoModule from './BeebeebCryptoModule';

/** A machine-readable failure from the ceremony; branch on `code`, never on the message. */
export class CeremonyError extends Error {
  readonly code: string;
  constructor(code: string) {
    // A fixed sentence per code: no native text can reach a screen through here.
    super(`Onboarding step failed: ${code}`);
    this.name = 'CeremonyError';
    this.code = code;
  }
}

const NATIVE_PREFIX = 'ERR_ONBOARDING_';

/** `ERR_ONBOARDING_PASSWORD_BREACHED` -> `password_breached`; anything else -> `unavailable`. */
export function ceremonyCodeFrom(err: unknown): string {
  const raw = (err as { code?: unknown } | null)?.code;
  if (typeof raw === 'string' && raw.startsWith(NATIVE_PREFIX)) {
    return raw.slice(NATIVE_PREFIX.length).toLowerCase();
  }
  return 'unavailable';
}

async function call<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CeremonyError) throw err;
    throw new CeremonyError(ceremonyCodeFrom(err));
  }
}

/** Release is best effort: a stub that throws synchronously, or a rejected release, must not break a dispose. */
async function release(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    /* nothing to do: the handle is forgotten on this side either way */
  }
}

// ─── Password ───────────────────────────────────────────────────────────────

export type PasswordStrength = 'too_short' | 'fair' | 'good' | 'strong';
export type PasswordHint =
  | 'none'
  | 'need_more_characters'
  | 'mix_case_and_add_number_or_symbol'
  | 'mix_case'
  | 'add_number_or_symbol';

/** Result of evaluating a password against the server's policy. Contains no part of the password. */
export interface PasswordEvaluation {
  length: number;
  minLength: number;
  missingCharacters: number;
  meetsMinimum: boolean;
  hasMixedCase: boolean;
  hasNumberOrSymbol: boolean;
  strength: PasswordStrength;
  /** Meter level 1 (too short) to 4 (strong). */
  level: number;
  hint: PasswordHint;
}

/**
 * Advisory evaluation (meter and hint) for the typed password. NEVER the gate:
 * the ceremony's `setPassword` is. `minLength` is `policy.password.min_length`
 * (core clamps it up to its own floor of 12).
 */
export async function evaluatePasswordPolicy(password: string, minLength: number): Promise<PasswordEvaluation> {
  return call(() => BeebeebCryptoModule.onboardingEvaluatePassword(password, minLength));
}

// ─── Breach check ───────────────────────────────────────────────────────────

export type BreachVerdict =
  | { kind: 'clean' }
  | { kind: 'breached'; count: number }
  | { kind: 'check_failed_allowed' }
  | { kind: 'check_failed_blocked' }
  | { kind: 'not_required' };

/**
 * One k-anonymity check for one password. Core hashes and matches; the APP makes
 * the HTTP call, to our own API, sending only `prefix` (5 hex characters).
 */
export class BreachCheck {
  private id: number | null;
  /** The 5 upper-case hex characters to send to the server. */
  readonly prefix: string;

  private constructor(id: number, prefix: string) {
    this.id = id;
    this.prefix = prefix;
  }

  static async create(password: string): Promise<BreachCheck> {
    const id: number = await call(() => BeebeebCryptoModule.onboardingBreachNew(password));
    try {
      const prefix: string = await call(() => BeebeebCryptoModule.onboardingBreachPrefix(id));
      return new BreachCheck(id, prefix);
    } catch (err) {
      await release(() => BeebeebCryptoModule.onboardingBreachRelease(id));
      throw err;
    }
  }

  /** The native handle id, for `SignupCeremony.setPassword`. Throws once disposed. */
  get handleId(): number {
    if (this.id === null) throw new CeremonyError('disposed');
    return this.id;
  }

  /**
   * Record the server's answer and return the verdict. `body` is the text of a
   * 2xx answer, or null when the request failed. `requestedPrefix` MUST be the
   * prefix the request actually used: core refuses (code `breach_prefix_mismatch`)
   * a body fetched for another prefix, which would otherwise read as clean.
   */
  async evaluate(requestedPrefix: string, body: string | null, failOpen: boolean): Promise<BreachVerdict> {
    const id = this.handleId;
    return call(() => BeebeebCryptoModule.onboardingBreachEvaluate(id, requestedPrefix, body, failOpen));
  }

  async dispose(): Promise<void> {
    const id = this.id;
    this.id = null;
    if (id !== null) await release(() => BeebeebCryptoModule.onboardingBreachRelease(id));
  }
}

export function createBreachCheck(password: string): Promise<BreachCheck> {
  return BreachCheck.create(password);
}

// ─── Ceremony ───────────────────────────────────────────────────────────────

/** From the onboarding document: `policy.*` and whether the code step is required. */
export interface CeremonyConfig {
  minLength: number;
  emailVerificationRequired: boolean;
  verifyWordCount: number;
  breachCheckRequired: boolean;
  breachFailOpen: boolean;
}

export interface RegistrationFinish {
  /** The OPAQUE `RegistrationUpload` for `register-finish`. */
  upload: Uint8Array;
  x25519Public: Uint8Array;
  recoveryCheck: Uint8Array;
}

function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new CeremonyError('bad_bytes');
}

/**
 * One signup attempt. Single consumer: drive it from one flow. Call `dispose()`
 * when the flow is left.
 */
export class SignupCeremony {
  private id: number | null;

  private constructor(id: number) {
    this.id = id;
  }

  static async create(config: CeremonyConfig): Promise<SignupCeremony> {
    const id: number = await call(() =>
      BeebeebCryptoModule.onboardingCeremonyNew(
        config.minLength,
        config.emailVerificationRequired,
        config.verifyWordCount,
        config.breachCheckRequired,
        config.breachFailOpen,
      ),
    );
    return new SignupCeremony(id);
  }

  private get handle(): number {
    if (this.id === null) throw new CeremonyError('disposed');
    return this.id;
  }

  /** The server accepted the email code. */
  emailVerified(): Promise<void> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyEmailVerified(id));
  }

  /** The user changed the address after it was verified: back to the code step, secrets kept. */
  emailChanged(): Promise<void> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyEmailChanged(id));
  }

  /** `signup_ticket_invalid` at register-finish: back to the code step, password and confirmed phrase kept. */
  emailTicketInvalidated(): Promise<void> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyEmailTicketInvalidated(id));
  }

  /** A retryable register-finish failure. */
  registrationFailed(): Promise<void> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyRegistrationFailed(id));
  }

  /**
   * Validate and store the password. `breach` is the check made for THIS password,
   * after `evaluate` recorded the endpoint's answer; null when the document
   * declares no breach check. Throws `CeremonyError` with `password_mismatch`,
   * `password_too_short`, `breach_check_missing`, `breach_check_stale`,
   * `password_breached` or `breach_check_blocked`.
   */
  setPassword(password: string, confirmation: string, breach: BreachCheck | null): Promise<PasswordEvaluation> {
    const id = this.handle;
    const breachId = breach ? breach.handleId : null;
    return call(() => BeebeebCryptoModule.onboardingCeremonySetPassword(id, password, confirmation, breachId));
  }

  /** Generate the recovery phrase and master key (Argon2id, about a second). Idempotent. */
  beginPhrase(): Promise<void> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyBeginPhrase(id));
  }

  /** The phrase, space separated. Call only while rendering it; drop the reference after. */
  phrase(): Promise<string> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyPhrase(id));
  }

  /** The user confirms they saved the phrase. */
  acknowledgePhrase(): Promise<void> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyAcknowledgePhrase(id));
  }

  /** 1-based word positions to ask for, ascending, stable for this phrase. */
  async challengePositions(): Promise<number[]> {
    const id = this.handle;
    const raw: number[] = await call(() => BeebeebCryptoModule.onboardingCeremonyChallengePositions(id));
    return raw.map((n) => Number(n));
  }

  /** `answers` in `challengePositions` order. Throws `phrase_word_mismatch` / `phrase_answer_count`; retryable. */
  confirmPhrase(answers: string[]): Promise<void> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyConfirmPhrase(id, answers));
  }

  /** OPAQUE step 1: the message for `opaque/register-start`. Throws `step_not_done` until the other steps are done. */
  async startRegistration(): Promise<Uint8Array> {
    const id = this.handle;
    return bytes(await call(() => BeebeebCryptoModule.onboardingCeremonyStartRegistration(id)));
  }

  /** OPAQUE step 2, from the server's `register-start` response. */
  async finishRegistration(serverMessage: Uint8Array): Promise<RegistrationFinish> {
    const id = this.handle;
    const r = await call(() => BeebeebCryptoModule.onboardingCeremonyFinishRegistration(id, serverMessage));
    return {
      upload: bytes(r.upload),
      x25519Public: bytes(r.x25519Public),
      recoveryCheck: bytes(r.recoveryCheck),
    };
  }

  /** The pending step as the server's step id (`save_recovery_phrase` for both phrase parts), or `done`. */
  step(): Promise<string> {
    const id = this.handle;
    return call(() => BeebeebCryptoModule.onboardingCeremonyStep(id));
  }

  /**
   * The server accepted `register-finish`. Returns the master key bytes ONCE for the
   * vault code to store; the caller must `fill(0)` them afterwards.
   */
  async accountCreated(): Promise<Uint8Array> {
    const id = this.handle;
    return bytes(await call(() => BeebeebCryptoModule.onboardingCeremonyAccountCreated(id)));
  }

  /** Wipe the password, phrase and key, then forget the handle. Safe to call twice. */
  async dispose(): Promise<void> {
    const id = this.id;
    this.id = null;
    if (id !== null) await release(() => BeebeebCryptoModule.onboardingCeremonyRelease(id));
  }
}

export function createSignupCeremony(config: CeremonyConfig): Promise<SignupCeremony> {
  return SignupCeremony.create(config);
}
