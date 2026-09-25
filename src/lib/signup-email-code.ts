/**
 * Task 1551 — mobile mirror of web PR #79 (`repos/web/src/lib/signup-email-code.ts`,
 * `repos/web/src/components/signup-email-code-step.tsx`) and server task 1525
 * (final contract: server #95 head 3c5f706).
 *
 * Pure decision/formatting/state-machine functions for the "check your inbox"
 * email-code step that now precedes the recovery-phrase/password steps of
 * signup. Kept dependency-free (no react-native, no expo, no import from
 * `./api`) on purpose — this repo's `bun run test` gives every file its own
 * process (see mobile CLAUDE.md "Tests"), and a pure module needs no native
 * module mocking to unit test, unlike `./api` itself.
 */

// ---------------------------------------------------------------------------
// Code sanitizing / formatting
// ---------------------------------------------------------------------------

/** The server's code length (`beebeeb-api::routes::auth::generate_verification_code`
 * — widened 6→8 digits, task 1525's server-side "Deviation flagged" note).
 * Deliberately NOT the same length as the existing 2FA `SixDigitInput` (6) —
 * a different code, a different purpose, a different server-side generator. */
export const EMAIL_CODE_LENGTH = 8;

/**
 * Strip everything but digits and clip to `maxLength`. Used on every
 * keystroke AND on paste — a pasted code often carries surrounding
 * whitespace, dashes, or text copied along with it from the email ("Your
 * code: 12345678"), so this is deliberately permissive about the input shape
 * as long as the digits themselves are intact and in order.
 */
export function sanitizeCode(raw: string, maxLength: number = EMAIL_CODE_LENGTH): string {
  return raw.replace(/\D/g, '').slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Error classification — duck-typed against `{status, message}`, NOT
// `instanceof ApiError`. `./api.ts` pulls in the full native-module tree
// (expo-secure-store, expo-file-system, the beebeeb-crypto native module,
// …), so importing it here just to do an `instanceof` check would drag this
// otherwise-pure file's tests back into full native-mock scaffolding for no
// real benefit — every `ApiError` already has `.status`/`.message` as own
// properties, so structural typing is exactly as correct at runtime.
// ---------------------------------------------------------------------------

interface HttpLikeError {
  status?: number;
  message?: string;
}

function isHttpLikeError(err: unknown): err is HttpLikeError {
  return typeof err === 'object' && err !== null && 'status' in err;
}

/**
 * Whether `err` means "this server predates task 1525 and has no
 * `/signup/email-start` route at all" — the capability-detection signal
 * `SignupScreen` uses to skip the code step entirely and fall back to the
 * pre-1551 flow (go straight to the password step, no ticket) rather than
 * showing a code screen a stale server can never satisfy. Every OTHER error
 * (400 bad email, 429 rate limited, network failure, 5xx) means the route
 * DOES exist — the failure is surfaced on-screen instead (mirrors web's
 * `isLegacyFallbackError`).
 */
export function isLegacyFallbackError(err: unknown): boolean {
  return isHttpLikeError(err) && err.status === 404;
}

/**
 * Whether `err` is the server's `403 {"error":"signup_ticket_invalid",
 * "message":"Verify your email again to get a new signup link."}` — a
 * previously-valid ticket was rejected on register-start/finish (expired
 * mid-flow, wrong email, already consumed).
 *
 * Verified directly against a live server (task 1551 lane, local smoke test
 * against server #95 head 3c5f706): the 403 body carries BOTH `error` and a
 * human-readable `message`. Mobile's generic `request()` helper (`api.ts`)
 * does `err.message ?? err.error ?? res.statusText` and has no separate
 * `.code` field (unlike web's `ApiError`, and unlike several *other*,
 * upload-specific fetch call sites in this same file that already thread
 * `err.error` through as `.code` — `request()` itself does not), so the
 * machine-readable `"signup_ticket_invalid"` string never reaches the thrown
 * `ApiError` at all once the server sends a `message` alongside it — it's
 * fully shadowed. Checking `.message` for the literal code string (this
 * function's first version) therefore never matches in practice; that was
 * an unverified assumption caught precisely by running against a real server
 * instead of only mocks. Not fixed by widening `request()` itself (that's
 * a shared helper every other caller in this file also goes through, and a
 * broader change needs its own scoped verification this task doesn't cover)
 * — scoped instead to what THIS check can safely know: a 403 from
 * register-start/register-finish, in the ticket-carrying call this task
 * adds, realistically only means the ticket. The one other theoretical 403
 * on these routes (`pilot_key_required`, `BB_REQUIRE_PILOT_KEY`) has no
 * mobile caller at all — mobile never sends a pilot key — so if that gate
 * were ever turned on, EVERY mobile signup would already 403 unconditionally
 * for an unrelated reason, and bouncing to the code step is a no-worse
 * fallback than showing the raw error. Flagged, not silently narrowed.
 */
export function isTicketInvalidError(err: unknown): boolean {
  return isHttpLikeError(err) && err.status === 403;
}

// ---------------------------------------------------------------------------
// Step machine
// ---------------------------------------------------------------------------

export type SignupStep = 'email' | 'code' | 'password';

export interface SignupFlowState {
  step: SignupStep;
  /** The email address the current step (code or password) is for. Empty
   * until EMAIL_START_SUCCESS / EMAIL_START_LEGACY_FALLBACK sets it. */
  email: string;
  /** The signup_ticket from a successful code verification. Undefined for
   * the legacy (404) path — the server ignores signup_ticket entirely when
   * BB_SIGNUP_EMAIL_CODE is off, so omitting it is always harmless. */
  ticket?: string;
  /** True once email-start has 404'd against a server that predates task
   * 1525 — register calls never carry a ticket for the rest of this flow,
   * and "Wrong email? Go back" / resend are not applicable (there's no code
   * step to go back to). */
  legacyFlow: boolean;
  /** Set once, when the password step's register call bounces back to the
   * code step because the ticket was rejected (expired/consumed mid-flow).
   * Cleared on every other transition. */
  codeStepError?: string;
}

export const initialSignupFlowState: SignupFlowState = {
  step: 'email',
  email: '',
  ticket: undefined,
  legacyFlow: false,
  codeStepError: undefined,
};

export type SignupFlowEvent =
  | { type: 'EMAIL_START_SUCCESS'; email: string }
  | { type: 'EMAIL_START_LEGACY_FALLBACK'; email: string }
  | { type: 'CODE_VERIFIED'; ticket: string }
  | { type: 'WRONG_EMAIL' }
  | { type: 'TICKET_REJECTED'; message: string };

/**
 * Pure reducer driving `SignupScreen`'s step. No side effects, no network —
 * the screen makes the API calls and dispatches the outcome as an event.
 */
export function signupFlowReducer(state: SignupFlowState, event: SignupFlowEvent): SignupFlowState {
  switch (event.type) {
    case 'EMAIL_START_SUCCESS':
      return { ...state, step: 'code', email: event.email, legacyFlow: false, ticket: undefined, codeStepError: undefined };
    case 'EMAIL_START_LEGACY_FALLBACK':
      return { ...state, step: 'password', email: event.email, legacyFlow: true, ticket: undefined, codeStepError: undefined };
    case 'CODE_VERIFIED':
      return { ...state, step: 'password', ticket: event.ticket, codeStepError: undefined };
    case 'WRONG_EMAIL':
      return { ...state, step: 'email', ticket: undefined, codeStepError: undefined };
    case 'TICKET_REJECTED':
      return { ...state, step: 'code', ticket: undefined, codeStepError: event.message };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Ticket threading into API request bodies
// ---------------------------------------------------------------------------

/**
 * Appends `signup_ticket` to a request body when a ticket is present, as a
 * plain body field (never a header — mirrors the server's own
 * `RegisterFinishReq::signup_ticket` doc comment: chosen so no CORS
 * `Access-Control-Allow-Headers` change is needed, and mobile has no CORS
 * concern either way but the wire shape must match). `api.ts` uses this in
 * `signup()`, `opaqueRegistrationStart()`, and `opaqueRegistrationFinish()`
 * so the body-shape logic itself is unit-testable without mocking fetch.
 */
export function withSignupTicket<T extends Record<string, unknown>>(
  body: T,
  signupTicket?: string,
): T & { signup_ticket?: string } {
  return signupTicket ? { ...body, signup_ticket: signupTicket } : body;
}
