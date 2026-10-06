/**
 * Beebeeb API client.
 *
 * Talks to the configured Rust backend.
 * All file data is encrypted ciphertext -- the server never sees plaintext.
 */

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import { clearCachedFileIndex } from './file-index-cache';
import { clearCachedBilling } from './billing-cache';
import { collectPaged, findInPages } from './paginate';
import { rateLimitedFetch } from './rate-limited-fetch';
import { isNativeUploadAvailable, planUploadChunksNative, uploadChunksNative } from '../../modules/beebeeb-crypto';
import { assertNativeUploadEncryptedUnderSessionId, nativeProgressToUploadProgress, parseNativeUploadError, resumeStateMatchesNativePlan, uploadChunksNativeTracked } from './native-upload-bridge';
import { getDeviceId } from './sync-client';
import { deviceIdHeader } from './upload-device-header';
import { setAnnouncement, clearAnnouncement } from './announcement-context';
import { isTrialRefusalCode, trialCapMessage, trialRefusalMessage } from './trial-refusals';
import { ACCOUNT_LAPSED_ERROR, PLAN_REQUIRED_ERROR, TRIAL_CANCELLED_READ_ONLY_ERROR, TRIAL_ENDED_ERROR, gateForRefusalCode, getCurrentAccountGate, readOnlyUploadMessage } from './account-state';
import { resolveWebAppUrl } from './web-links';
import { ONBOARDING_SCHEMA_HEADER, isOnboardingErrorCode, sameOriginPath } from './onboarding/wire';
import { describeApiEnvironment, type ApiEnvironment } from './api-environment';
export type { ApiEnvironment, ApiEnvironmentKind } from './api-environment';
import { normalizeNotificationPreferences, type NotificationPreferences } from './notification-prefs';
// Task 1594 fix 4: the unlocked key's owner, sent on authenticated mutations.
import { expectedUserHeaders, isMutatingMethod } from './expected-user';
// Task 1589 — recognizing a swept v2 upload session + the typed error for a
// second sweep in a row. Shared by the JS chunk loop and the native path.
import { isUploadSessionGone, UploadRestartFailedError } from './upload-session-reinit';
// Re-exported so `api.ts` (the common import surface for upload callers —
// FilesScreen, backup-context, text-file-save) can catch it without a second
// import.
export { UploadRestartFailedError } from './upload-session-reinit';

// API target. Override at build time with EXPO_PUBLIC_API_URL or via
// expoConfig.extra.apiUrl (e.g. through eas.json env or app.config.ts).
// Development builds default to a local API; release/TestFlight builds default
// to production so they never silently point at localhost.
function resolveBaseUrl(): string {
  const configured =
    (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
    process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured;

  if (__DEV__) {
    if (Platform.OS === 'android') return 'http://10.0.2.2:3001';
    return 'http://localhost:3001';
  }
  return 'https://api.beebeeb.io';
}

const BASE_URL = resolveBaseUrl();
const TOKEN_KEY = 'beebeeb_session_token';
const DEVICE_CONFIRMATION_SECRET_KEY = 'beebeeb_device_confirmation_secret';

const MOBILE_IOS_BACKUP_CLIENT_SESSION_KEY = 'beebeeb_mobile_ios_backup_client_session_id';
const MOBILE_IOS_BACKUP_SESSION_NAME = 'iPhone Camera Roll Backup';

const API_ENVIRONMENT = describeApiEnvironment(BASE_URL);

console.info(
  `[Beebeeb] API environment: ${API_ENVIRONMENT.label} (${API_ENVIRONMENT.baseUrl})`,
);

/** Base URL for raw fetch / SSE callers that bypass `request()`. */
export function getApiUrl(): string {
  return BASE_URL;
}

/** Runtime API environment for QA/debug surfaces. */
export function getApiEnvironment(): ApiEnvironment {
  return API_ENVIRONMENT;
}

/**
 * The web app for this build (task 1037). Uses `extra.appUrl` /
 * `EXPO_PUBLIC_APP_URL` when set, otherwise derives it from the API URL (see
 * `web-links.ts` `resolveWebAppUrl`).
 */
export function getWebAppUrl(): string {
  return resolveWebAppUrl({
    configuredAppUrl:
      (Constants.expoConfig?.extra as { appUrl?: string } | undefined)?.appUrl ??
      process.env.EXPO_PUBLIC_APP_URL,
    apiUrl: BASE_URL,
  });
}

// expo-secure-store has no web implementation — fall back to localStorage so
// the dev preview works in a browser. Native targets always use SecureStore.
const tokenStore = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

// ---------------------------------------------------------------------------
// Session-expired callback (registered by AuthProvider)
// ---------------------------------------------------------------------------

type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler | null = null;

/** Register a callback invoked when the server returns 401 (token expired). */
export function registerSessionExpiredHandler(fn: SessionExpiredHandler): void {
  onSessionExpired = fn;
}

// ---------------------------------------------------------------------------
// Account-deleted callback (registered by AuthProvider) — task 1405
// ---------------------------------------------------------------------------

/**
 * Fired when `request()` sees a 403 `account_deleted` on a call that carried
 * a live session (an already-signed-in device whose account got deleted
 * elsewhere — web, another device, or an admin action). The login-time path
 * (password/OPAQUE, `auth=false`) does NOT go through this handler — those
 * calls throw `AccountDeletedError` directly to the caller (LoginScreen),
 * which is already showing an error surface. This handler exists for the
 * surprise case: a screen open on a now-deleted account. Mirrors
 * `registerSessionExpiredHandler` above.
 */
type AccountDeletedHandler = (deletedAt: string, shredAfter: string) => void;
let onAccountDeleted: AccountDeletedHandler | null = null;

export function registerAccountDeletedHandler(fn: AccountDeletedHandler): void {
  onAccountDeleted = fn;
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let cachedDeviceConfirmationSecret: string | null | undefined;
let sessionGeneration = 0;

export async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  const generationAtStart = sessionGeneration;
  const token = await tokenStore.get(TOKEN_KEY);
  if (generationAtStart === sessionGeneration) {
    cachedToken = token;
  }
  return token;
}

export async function setToken(token: string): Promise<void> {
  sessionGeneration += 1;
  cachedToken = token;
  await tokenStore.set(TOKEN_KEY, token);
  await BeebeebCrypto.mirrorSessionToAppGroup(token, BASE_URL).catch(() => false);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const Native = requireOptionalNativeModule('ThumbnailService') as {
      setApiCredentials?: (baseURL: string, token: string) => Promise<void>;
    } | null;
    await Native?.setApiCredentials?.(getApiUrl(), token);
  } catch {
    // best-effort
  }
}

export async function clearToken(): Promise<void> {
  sessionGeneration += 1;
  cachedToken = null;
  cachedDeviceConfirmationSecret = null;
  // Task 1531 [P1] (round 5 delta security review): clear the native
  // App-Group mirror FIRST, before any JS-side token store removal.
  // `mirrorSessionToAppGroup(null, null)` is what unbinds
  // `NativeBackupEngine.currentAccountId` (see the CLEAR branch in
  // BeebeebCryptoModule.swift). Corrected (round 6, finding N1): that CLEAR
  // branch does NOT drop the cached master-key handle — it only writes
  // `currentAccountId = nil` via the plain property setter, which never
  // touches `masterKeyHandle`. The handle is released separately, by
  // `NativeBackupEngine.stop()` (called from `disablePhotoBackup()` /
  // `teardownAllBackup()` in the sign-out path — see `stopBackupEngines()`,
  // backup-context.tsx) or by `clearAccountAndPurgeStaged()`/`bindAccount()`.
  // If the process is killed mid sign-out, the ORIGINAL order (native
  // clear last) could leave the JS token store already cleared while the
  // native token/account mirror still held the outgoing account's — this
  // order can only ever leave native cleared while JS still holds the old
  // token, which every caller of `clearToken` already treats as "signed
  // out" and will call again on the next launch/retry.
  await BeebeebCrypto.mirrorSessionToAppGroup(null, null).catch(() => false);
  await tokenStore.remove(TOKEN_KEY);
  await tokenStore.remove(DEVICE_CONFIRMATION_SECRET_KEY);
  await clearCachedFileIndex().catch(() => {});
  // Task 1601, root cause 4 — same per-account cache-cleanup slot as the
  // file-index cache above: covers ordinary sign-out (logout() calls
  // clearToken()), a forced 401 sign-out (refreshAuth()'s catch), and an
  // account switch (sign-out then a different sign-in) alike.
  await clearCachedBilling().catch(() => {});
  await tokenStore.remove(MOBILE_IOS_BACKUP_CLIENT_SESSION_KEY);
  await BeebeebCrypto.mirrorBackupClientSession(null).catch(() => false);
}

/** Fast check: is there a stored session token? */
export async function hasToken(): Promise<boolean> {
  return (await getToken()) !== null;
}

async function getDeviceConfirmationSecret(): Promise<string | null> {
  if (cachedDeviceConfirmationSecret !== undefined) return cachedDeviceConfirmationSecret;
  cachedDeviceConfirmationSecret = await tokenStore.get(DEVICE_CONFIRMATION_SECRET_KEY);
  return cachedDeviceConfirmationSecret;
}

async function setSessionCredentials(token: string, deviceConfirmationSecret?: string): Promise<void> {
  await setToken(token);
  cachedDeviceConfirmationSecret = deviceConfirmationSecret ?? null;
  if (deviceConfirmationSecret) {
    await tokenStore.set(DEVICE_CONFIRMATION_SECRET_KEY, deviceConfirmationSecret);
  } else {
    await tokenStore.remove(DEVICE_CONFIRMATION_SECRET_KEY);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  /**
   * Machine-readable error code from the server response body's `error` field
   * (e.g. `object_budget_exceeded`, `quota_exceeded`). Set when the server
   * returns a structured `{ error, message }` payload. Callers branch on this
   * instead of pattern-matching the human-readable `message`, which can change
   * without notice. Optional + additive — existing `(status, message)` callers
   * are unaffected.
   */
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /**
     * Seconds until the server will accept the request again — parsed from a
     * 429's `Retry-After` header (task 1591). Undefined when absent.
     */
    public retryAfterSeconds?: number,
    /**
     * Task 1605 — true only for a 413 `quota_exceeded` hit against the
     * never-paid-trial 25 GB cap (server's additive `is_trial_cap`), never
     * the account's real plan quota. Undefined for every other error.
     */
    public isTrialCap?: boolean,
    /**
     * Task 1820 — the cap the server enforced (`limit_bytes` on a 413
     * `quota_exceeded`), so a trial-cap message names the real number: 10 GB for
     * a no-card trial, 25 GB for the older mandated one.
     */
    public limitBytes?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * "about 45 seconds" / "about 3 minutes" / "about 1 hour" — rounded UP so the
 * user never retries too early (task 1591).
 */
export function formatRetryAfter(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `about ${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.ceil(m / 60);
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}

/** Parse a `Retry-After` header value (delta-seconds or HTTP date) to seconds. */
export function retryAfterSecondsFromHeader(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - nowMs) / 1000));
  return undefined;
}

/**
 * Thrown by `opaqueLoginFinish` / `login` when the user has 2FA enabled and
 * the server returns `{ requires_2fa: true, partial_token }` instead of a
 * session token. Caller must navigate to TwoFactorChallenge with this
 * partial_token and call `completeTwoFactor` after the user enters their code.
 */
export class TwoFactorRequiredError extends Error {
  constructor(public partialToken: string) {
    super('two_factor_required');
    this.name = 'TwoFactorRequiredError';
  }
}

/**
 * Thrown by `request()` on any 403 `{"error":"account_deleted",...}` body —
 * password login, OPAQUE login-finish, and any authenticated call against a
 * session whose account was soft-deleted (server task 1403). Carries both
 * RFC3339 dates from the server so the UI never has to guess or hardcode the
 * 30-day retention window.
 */
export class AccountDeletedError extends Error {
  constructor(public deletedAt: string, public shredAfter: string) {
    super('account_deleted');
    this.name = 'AccountDeletedError';
  }
}

/**
 * Exact copy for the account_deleted state (task 1405, mirrors web task 1404
 * verbatim). Dates are formatted in the device locale, date only — no time
 * fragment, matching the web copy so the same account tells the same story
 * on every client.
 */
export function formatAccountDeletedMessage(deletedAt: string, shredAfter: string): string {
  const dateOnly = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return `This account was deleted on ${dateOnly(deletedAt)}. Its encrypted data will be shredded on ${dateOnly(shredAfter)}. We can't recover it.`;
}

/**
 * HTTP status phrases that leak into `err.message` when a response body is
 * not the server's JSON error shape (`{"error": <statusText>}`) — never show
 * them verbatim (task 1709).
 */
const HTTP_STATUS_PHRASES = new Set([
  'unauthorized',
  'forbidden',
  'not found',
  'bad request',
  'conflict',
  'gone',
  'too many requests',
  'payload too large',
  'request timeout',
  'unprocessable entity',
  'internal server error',
  'not implemented',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'method not allowed',
  'payment required',
]);

/**
 * Task 1709 — decide whether a message is honest user-facing prose or a raw
 * internal fragment that must never reach the UI: bare machine codes
 * ("account_suspended", "key_binding_conflict"), lowercase internal
 * fragments ("invalid base64 client_message"), HTTP status words
 * ("forbidden", "Internal Server Error"), "404 …" prefixes, JSON dumps, or
 * huge internal detail blobs. Short plain sentences (client-authored copy
 * and the server's human `message` fields) pass unchanged. Mirrors the web
 * client's `looksUserFriendly` heuristic (repos/web/src/lib/user-friendly-error.ts).
 */
function looksUserFacing(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (m.length > 200) return false;
  if (m.startsWith('{') || m.startsWith('[')) return false;
  if (/^\d{3}\b/.test(m)) return false;
  if (HTTP_STATUS_PHRASES.has(m.toLowerCase())) return false;
  // One or more all-lowercase tokens with no sentence punctuation: a machine
  // code or internal fragment, not prose.
  if (!/[.!?]/.test(m) && /^(?:[a-z0-9_.:-]+(?:\s|$))+$/.test(m)) return false;
  return true;
}

/**
 * Show `message` only when it passes the prose check; anything else gets
 * `fallback`. Task 1709.
 */
function displayFor(message: string | undefined, fallback: string): string {
  return message && looksUserFacing(message) ? message : fallback;
}

/** Return a human-friendly message for common API errors. */
export function friendlyError(err: unknown): string {
  if (err instanceof AccountDeletedError) {
    return formatAccountDeletedMessage(err.deletedAt, err.shredAfter);
  }
  // Task 1709 — typed client errors are mapped explicitly so their authored
  // copy is the ONLY thing these classes can ever put on screen.
  if (err instanceof NativeCryptoUnavailableError) {
    return 'A required security component is missing. Update or reinstall the app to sign in.';
  }
  if (err instanceof IncorrectPasswordError) {
    return 'Incorrect password. Please try again.';
  }
  if (err instanceof ApiError) {
    // Typed quota errors come back with a machine-readable `code` so we don't
    // pattern-match the human message. Branch on these first, before the
    // generic status handling swallows them (server task 0670).
    if (err.code === 'object_budget_exceeded') {
      // Object-COUNT cap — distinct from the byte/storage quota below.
      return 'File limit reached. This account has hit its maximum number of files — delete some files or contact support to raise the limit.';
    }
    // Task 1037: an account without a plan is refused with 409
    // plan_required / account_lapsed, and has quota 0 by design. Say it is
    // read-only instead of "Storage full" or the raw server text.
    // Task 1820 (server 1755): the no-card trial's typed refusals. Mapped by code to
    // sentences that offer nothing to buy; the server's own wording for several of
    // them says "choose a plan" / "Subscribe" and must never reach this binary.
    const trialRefusal = trialRefusalMessage(err.code) ?? trialRefusalMessage(err.message);
    if (trialRefusal) return trialRefusal;
    const refusal = gateForRefusalCode(err.code, getCurrentAccountGate());
    const readOnly = refusal ? readOnlyUploadMessage(refusal) : null;
    if (readOnly) return readOnly;
    if (err.code === 'quota_exceeded') {
      // Task 1605 — the 25 GB TRIAL cap, not the account's real plan quota.
      // No purchase call to action here (task 1400, App Review 3.1.1(a)) —
      // same informational tone as PLAN_MANAGEMENT_NOTE, never a button/link.
      if (err.isTrialCap) {
        return trialCapMessage(err.limitBytes);
      }
      return 'Storage full. Free up space or upgrade your plan to keep uploading.';
    }
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 401) {
      // The message is set by the caller's path: login/signup => "Wrong email or password",
      // authenticated requests => "Session expired".
      return err.message || 'Session expired. Please sign in again.';
    }
    // Task 1709 — account-state codes that reach the client WITHOUT a human
    // `message` field (403 `{"error":"account_suspended"}` from the server's
    // auth extractor, or a stale server sending the bare code). Map them to
    // the honest copy; where the server does send its own sentence, that
    // passes through below unchanged.
    if (err.code === 'account_suspended' || err.message === 'account_suspended') {
      return 'This account has been suspended. Contact support if you believe this is a mistake.';
    }
    if (err.code === 'account_disabled' || err.message === 'account_disabled') {
      return 'This account has been disabled. Contact support if you believe this is in error.';
    }
    if (err.code === 'email_unverified' || err.message === 'email_unverified') {
      return 'Verify your email address to upload, share, or receive files. Check your inbox or request a new link.';
    }
    if (err.code === 'key_binding_conflict' || err.message === 'key_binding_conflict') {
      return 'This account already has a different recovery phrase or sharing key bound. Log out and back in, then try again — if this persists, contact support.';
    }
    if (err.status === 403) {
      // A 403 always means the request was refused, so the status line is an
      // honest fallback for both a missing and a machine-shaped message.
      return displayFor(err.message, "You don't have permission to do that.");
    }
    if (err.status === 404) return displayFor(err.message, 'Not found.');
    if (err.status === 409) {
      // A 409 is NOT always a name conflict (e.g. "upload already completed"),
      // so a machine-shaped or missing message gets the generic line rather
      // than guessing a cause.
      return displayFor(err.message, 'Something went wrong. Please try again.');
    }
    if (err.status === 422) {
      // A 422 means the request itself failed validation — the status line is
      // honest for both a missing and a machine-shaped message.
      return displayFor(err.message, 'Invalid input. Please check your details.');
    }
    if (err.status === 429) {
      if (err.retryAfterSeconds != null && err.retryAfterSeconds > 0) {
        return `Too many attempts. Try again in ${formatRetryAfter(err.retryAfterSeconds)}.`;
      }
      return 'Too many requests. Wait a moment, then try again.';
    }
    // 503 = service-side unavailability (storage pools, DB, S3 backend). Server emits
    // "all storage pools are full or unavailable" for the StorageUnavailable variant;
    // either way, the user just needs to retry shortly.
    if (err.status === 503) return 'Storage is temporarily unavailable. Please try again in a moment.';
    return displayFor(err.message, 'Something went wrong. Please try again.');
  }
  if (err instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  if (err instanceof Error) {
    // Task 1709 — a plain Error's message may be raw native (UniFFI) error
    // text; only honest prose reaches the screen.
    return err.message && looksUserFacing(err.message)
      ? err.message
      : 'Something went wrong. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}

export interface RequestAuthSnapshot {
  generation: number;
  token: string | null;
}

interface RequestHeaders {
  headers: Record<string, string>;
  authSnapshot: RequestAuthSnapshot | null;
}

function isCurrentSessionSnapshot(snapshot: RequestAuthSnapshot): boolean {
  return sessionGeneration === snapshot.generation && cachedToken === snapshot.token;
}

/**
 * Task 1594 round 3 (Codex T2/T5/T6): capture the session BEFORE a direct
 * (non-`request()`) authenticated call starts — an upload's init/chunk/
 * complete sequence, or `search-index.ts`'s index PUT. Mirrors `headers()`'s
 * own inline `{ generation, token }` capture, exposed so every caller that
 * bypasses `request()` can guard its own later 409 the same way `request()`
 * guards its 401/409/403 handling against a stale in-flight request.
 */
export async function captureRequestAuthSnapshot(): Promise<RequestAuthSnapshot> {
  const generation = sessionGeneration;
  const token = await getToken();
  return { generation, token };
}

/**
 * Task 1594 round 3 (Codex T2/T5/T6): end the CURRENT session the same way
 * `request()`'s 409 `account_mismatch` branch does (above) — but ONLY if
 * `snapshot` (captured at the CALLER's own start, via
 * `captureRequestAuthSnapshot`) is still the live session.
 *
 * F5 (lead crypto review of #143 round 2, BLOCK): the round-2 fix cleared the
 * token unconditionally on any 409 `account_mismatch` from an upload. A long
 * upload started under account A that survives a sign-out/sign-in to B has
 * already sent every request under B's now-current key/session by the time a
 * LATE response comes back; if the server evaluates that stale request and
 * answers `account_mismatch` (A's expected-user header against B's session),
 * tearing down unconditionally would sign B back out for a mismatch that was
 * never B's problem. `snapshot == null` still tears down unconditionally —
 * used only where no meaningful "start" exists to snapshot against.
 */
export async function endSessionForAccountMismatch(snapshot: RequestAuthSnapshot | null): Promise<void> {
  if (snapshot == null || isCurrentSessionSnapshot(snapshot)) {
    await clearToken();
    onSessionExpired?.();
  }
}

/**
 * Task 1594 round 2 (F5) / round 3 (T2, T5): the SAME 409 `account_mismatch`
 * → session-end handling `request()` runs (above), for the raw-`fetch`/
 * `FileSystem.uploadAsync` upload paths that bypass `request()` entirely
 * (chunk PUTs, simple uploads — `expectedUserHeaders()` is already attached
 * to their requests; only the RESPONSE side was never wired to react to a
 * 409 the same way). `authSnapshot` is captured by the caller at the
 * UPLOAD's own start (`captureRequestAuthSnapshot()`) — see
 * `endSessionForAccountMismatch` for why an unconditional teardown is wrong
 * here. Always throws; never returns.
 */
async function throwUploadError(
  status: number,
  err: { error?: string; message?: string; is_trial_cap?: boolean; limit_bytes?: number },
  fallbackMessage: string,
  authSnapshot: RequestAuthSnapshot,
): Promise<never> {
  if (status === 409 && err.error === 'account_mismatch') {
    await endSessionForAccountMismatch(authSnapshot);
    throw new ApiError(409, err.message ?? 'This session does not match the account of the vault key on this device.', 'account_mismatch');
  }
  throw new ApiError(status, err.message ?? err.error ?? fallbackMessage, err.error, undefined, err.is_trial_cap, typeof err.limit_bytes === 'number' ? err.limit_bytes : undefined);
}

async function headers(auth = true, extra?: Record<string, string>): Promise<RequestHeaders> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  let authSnapshot: RequestAuthSnapshot | null = null;
  if (auth) {
    const generation = sessionGeneration;
    const token = await getToken();
    authSnapshot = { generation, token };
    if (token) h['Authorization'] = `Bearer ${token}`;
  }
  if (extra) Object.assign(h, extra);
  return { headers: h, authSnapshot };
}

// Writer-provenance (task 1436, the mobile half of 1392): the app version the
// server records on every object_versions row it writes (server PR #23 / task
// 1369). Mirrors the existing Constants.expoConfig?.version usage in
// device-registration.ts / SettingsScreen.tsx — no new dependency.
const MOBILE_CLIENT_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/**
 * Task 1578 (for 1580): `X-Beebeeb-Device-Id` on upload init + complete, so the
 * server knows which device wrote a version. Best-effort — see
 * `upload-device-header.ts`.
 */
function uploadDeviceHeader(): Promise<Record<string, string>> {
  return deviceIdHeader(getDeviceId)
}

function mobileClientHeaders(): Record<string, string> | undefined {
  if (Platform.OS === 'ios') return { 'X-Beebeeb-Client': 'mobile-ios', 'X-Beebeeb-Client-Version': MOBILE_CLIENT_VERSION };
  if (Platform.OS === 'android') return { 'X-Beebeeb-Client': 'mobile-android', 'X-Beebeeb-Client-Version': MOBILE_CLIENT_VERSION };
  return undefined;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let res: Response;
  let authSnapshot: RequestAuthSnapshot | null = null;
  try {
    const requestHeaders = await headers(auth, extraHeaders);
    authSnapshot = requestHeaders.authSnapshot;
    // Task 1594 fix 4 (server 1554): name the account the unlocked master key
    // belongs to on every authenticated MUTATION, so the server refuses (409
    // account_mismatch) a write whose session is not that account. Mutations
    // only, exactly like web (packages/shared/src/api/request.ts).
    if (auth && isMutatingMethod(method)) Object.assign(requestHeaders.headers, expectedUserHeaders());
    res = await rateLimitedFetch(`${BASE_URL}${path}`, {
      method,
      headers: requestHeaders.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 401) {
    // Only treat 401s on authenticated calls as session expiry — a 401 from
    // /auth/login or /auth/signup means "wrong credentials" and should NOT
    // trigger sign-out.
    if (auth) {
      // Only treat as session expiry when a token was actually attached — a
      // 401 on an auth=true call that went out with no token (snapshot.token
      // null) must not falsely fire onSessionExpired/clearToken.
      if (authSnapshot && authSnapshot.token != null && isCurrentSessionSnapshot(authSnapshot)) {
        await clearToken();
        onSessionExpired?.();
      }
      throw new ApiError(401, 'Session expired');
    }
    throw new ApiError(401, 'Wrong email or password.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));

    // 403 account_deleted (server task 1403): a typed body carrying both
    // retention dates, distinct from the generic 401 wrong-credentials path
    // above (anti-enumeration is unaffected — the server only returns this
    // AFTER credentials are proven, on login-finish, never on login-start).
    if (
      res.status === 403 &&
      err.error === 'account_deleted' &&
      typeof err.deleted_at === 'string' &&
      typeof err.shred_after === 'string'
    ) {
      // An authenticated call (auth=true) whose CURRENT session belongs to
      // the now-deleted account: clear the token and notify AuthProvider so
      // it can sign out locally and stash the notice for LoginScreen — the
      // same current-session-snapshot guard as the 401 branch above, so a
      // stale in-flight request from a since-replaced session can't fire a
      // spurious sign-out.
      if (auth && authSnapshot && authSnapshot.token != null && isCurrentSessionSnapshot(authSnapshot)) {
        await clearToken();
        onAccountDeleted?.(err.deleted_at, err.shred_after);
      }
      throw new AccountDeletedError(err.deleted_at, err.shred_after);
    }

    // Task 1594 fix 4 / server 1554: the server refused a mutation because the
    // unlocked key's owner (X-Beebeeb-Expected-User) is not this session's
    // user. The key/session pairing is wrong — end the local session the same
    // way a 401 does (web locks the key and routes to login) so the next
    // sign-in re-runs the key-ownership check. Same current-session guard as
    // the 401 branch above.
    if (res.status === 409 && err.error === 'account_mismatch') {
      if (auth && authSnapshot && authSnapshot.token != null && isCurrentSessionSnapshot(authSnapshot)) {
        await clearToken();
        onSessionExpired?.();
      }
      throw new ApiError(409, err.message ?? 'This session does not match the account of the vault key on this device.', 'account_mismatch');
    }

    // Task 1540 finding 7: prefer the server's human-readable `message` over
    // the machine `error` code when both are present — e.g. billing_read_only
    // / billing_suspended (error.rs) always send both, and a 403 on this path
    // (check_billing_state, reached from any upload/file-mutation attempt)
    // was surfacing the literal code string "billing_read_only" to the user
    // instead of the actionable sentence. Falls back to `err.error` when no
    // `message` field exists (e.g. the plain BadRequest("upload already
    // completed") body only ever sends `error`), so no existing caller that
    // reads `.message` loses data — see FilesScreen.tsx's `/upload already
    // completed/i.test(err.message)` regex, unaffected by this reorder.
    throw new ApiError(
      res.status,
      err.message ?? err.error ?? res.statusText,
      // Task 1037/1605: keep the machine code for the account-refusal 409s
      // (share creation) so friendlyError() and callers can recognise them.
      // Other bodies stay code-less, as before.
      err.error === PLAN_REQUIRED_ERROR ||
        err.error === ACCOUNT_LAPSED_ERROR ||
        err.error === TRIAL_CANCELLED_READ_ONLY_ERROR ||
        err.error === TRIAL_ENDED_ERROR ||
        isTrialRefusalCode(err.error) ||
        isOnboardingErrorCode(err.error)
        ? err.error
        : undefined,
      res.status === 429 ? retryAfterSecondsFromHeader(res.headers.get('Retry-After')) : undefined,
    );
  }

  // Read server-sent announcement header (percent-encoded UTF-8 string).
  const announcementHeader = res.headers.get('x-beebeeb-announcement');
  if (announcementHeader) {
    try {
      setAnnouncement(decodeURIComponent(announcementHeader));
    } catch {
      setAnnouncement(announcementHeader);
    }
  } else {
    clearAnnouncement();
  }

  // 204 No Content (and other empty bodies) have nothing to parse — return
  // undefined so callers typed `Promise<void>` (e.g. deleteClientSession)
  // don't reject on an empty res.json().
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthResponse {
  user_id: string;
  session_token: string;
  salt: string;
  device_confirmation_secret?: string;
}

export interface User {
  user_id: string;
  email: string;
  email_verified: boolean;
  created_at: string;
  /** `/api/v1/auth/me` always includes this (COALESCE'd false when no TOTP
   *  row exists yet — `routes/auth.rs::me`) — never optional/undefined. Read
   *  by SettingsScreen/TwoFactorSetupScreen to decide the 2FA entry point
   *  (task 1610) instead of unconditionally routing an already-enabled
   *  account into a bare setup call. */
  totp_enabled: boolean;
}

// Account creation is web-only since task 1037: "Create account" points to
// the web app (see web-links.ts). The signup / email-code / OPAQUE
// registration calls that lived here were removed with SignupScreen.

export async function login(email: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse & { requires_2fa?: boolean; partial_token?: string }>(
    'POST',
    '/api/v1/auth/login',
    { email, password },
    false,
    mobileClientHeaders(),
  );
  // Server returns { requires_2fa, partial_token } when TOTP is enabled.
  // In that case we don't have a session yet — caller navigates to the 2FA
  // challenge screen.
  if (data.requires_2fa) {
    const partial = data.partial_token;
    if (typeof partial !== 'string' || partial.length === 0) {
      throw new ApiError(500, 'Server signalled requires_2fa without a partial token');
    }
    throw new TwoFactorRequiredError(partial);
  }
  if (typeof data.session_token !== 'string' || data.session_token.length === 0) {
    throw new ApiError(500, 'Server returned no session token');
  }
  await setSessionCredentials(data.session_token, data.device_confirmation_secret);
  return data;
}

export async function logout(): Promise<void> {
  await request('POST', '/api/v1/auth/logout');
  await clearToken();
}

export async function getMe(): Promise<User> {
  return request<User>('GET', '/api/v1/auth/me');
}

// ---------------------------------------------------------------------------
// Key ownership (task 1594) — prove a master key belongs to THIS account.
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/auth/verify-recovery-check` (server `routes/recovery.rs`
 * `verify_recovery_check`): a constant-time compare of `recovery_check`
 * (base64 `HMAC-SHA256(master_key, "beebeeb-recovery-check")`, the value
 * signup stored) against the SESSION's account. Resolves on a match; throws
 * `ApiError(400, 'invalid_recovery_phrase')` on a mismatch — and ALSO when the
 * account has no stored check (legacy, task 0875), which the caller must
 * disambiguate. Same request web sends (`recovery-validation.ts`). Only the
 * HMAC leaves the device — never the key or the phrase.
 */
export async function verifyRecoveryCheck(recoveryCheckB64: string): Promise<void> {
  await request<{ valid: boolean }>('POST', '/api/v1/auth/verify-recovery-check', {
    recovery_check: recoveryCheckB64,
  });
}

/**
 * `GET /api/v1/auth/public-key/{user_id}` — the account's X25519 public key
 * (base64), set once at signup from the real master key (server 1554 made it
 * set-once). `null` when the account has none (404).
 */
export async function getUserPublicKey(userId: string): Promise<string | null> {
  try {
    const res = await request<{ user_id: string; public_key: string }>(
      'GET',
      `/api/v1/auth/public-key/${encodeURIComponent(userId)}`,
    );
    return typeof res.public_key === 'string' && res.public_key.length > 0 ? res.public_key : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * `POST /api/v1/auth/recovery-check` — sets the account's `recovery_check`
 * ONLY if it is currently NULL (server set-once-if-absent, task 0875). Call it
 * only with a key already PROVEN to be the account's.
 */
export async function setRecoveryCheckIfAbsent(recoveryCheckB64: string): Promise<{ updated: boolean }> {
  return request<{ updated: boolean }>('POST', '/api/v1/auth/recovery-check', {
    recovery_check: recoveryCheckB64,
  });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('POST', '/api/v1/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export interface ConfirmActionResponse {
  confirmation_token: string;
  expires_at: string;
}

/** Thrown when /auth/confirm rejects the password — distinct from session expiry. */
export class IncorrectPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'IncorrectPasswordError';
  }
}

/**
 * Thrown by `confirmAction` when the server rejects step-up because the
 * current session is too old (>15 min for OPAQUE-only accounts). Re-typing
 * the password cannot fix this — the user must log out and log back in to
 * mint a fresh session before retrying the destructive action.
 */
export class SessionTooOldForConfirmationError extends Error {
  constructor(
    message = 'For security, please log out and log back in before performing this action.',
  ) {
    super(message);
    this.name = 'SessionTooOldForConfirmationError';
  }
}

/**
 * Step-up re-auth: exchange the user's password for a short-lived
 * confirmation token. Destructive endpoints require it via the
 * X-Confirm-Token header.
 *
 * OPAQUE-first (task 0856): the password is proven to the server via the
 * authenticated confirm-opaque-start/finish round-trip, so it never crosses the
 * wire in plaintext. Mirrors the web client's confirmAction (web src/lib/api.ts).
 * Legacy Argon2-only accounts (no opaque_password_file) get a distinguishable
 * 409 { opaque_unavailable: true } from confirm-opaque-start and transparently
 * fall back to the plaintext /auth/confirm path (confirmActionPlaintext).
 *
 * The signature and the two thrown error types (IncorrectPasswordError,
 * SessionTooOldForConfirmationError) are unchanged, so every step-up caller
 * (confirm-action.ts, Trash, delete, BiometricLockScreen, …) is untouched.
 *
 * Uses direct fetches (not `request()`) because a 401 on confirm-opaque-FINISH
 * means "wrong password," not "session expired" — there we must NOT clear the
 * token or trigger sign-out, so a typo on step-up just lets the user retry. A
 * 401 on confirm-opaque-START is different: the password is not proven until
 * finish, so a start 401 is an expired session and IS handled as a sign-out.
 */
export async function confirmAction(password: string): Promise<ConfirmActionResponse> {
  const token = await getToken();
  if (!token) {
    // No session at all — surface as session expiry through the normal path.
    onSessionExpired?.();
    throw new ApiError(401, 'Session expired');
  }

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // 1. OPAQUE login start (native) — yields the client CredentialRequest message
  //    plus the opaque client state we round-trip into finish. The username arg
  //    is cosmetic (the native bridge ignores it; the server binds the credential
  //    to the caller's own account server-side), so pass an empty string.
  const loginStart = await BeebeebCrypto.opaqueLoginStart('', password);

  // 2. Authenticated POST to confirm-opaque-start. Direct fetch (not request())
  //    so a 409 (legacy-account fallback) is handled inline. A 401 here is an
  //    expired session (the password is not proven until finish) → re-auth.
  let startRes: Response;
  try {
    startRes = await rateLimitedFetch(`${BASE_URL}/api/v1/auth/confirm-opaque-start`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ client_message: uint8ToBase64(loginStart.message) }),
    });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  // 3. Legacy Argon2-only account (no opaque_password_file) → distinguishable
  //    409 { opaque_unavailable: true }. Fall back to the plaintext path, which
  //    still works for these accounts (incl. the session-freshness fallback).
  if (startRes.status === 409) {
    const body = (await startRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.opaque_unavailable === true) {
      return confirmActionPlaintext(password, token);
    }
    // Some other 409 — surface it rather than silently swallowing.
    throw new ApiError(
      startRes.status,
      (body.message ?? body.error ?? startRes.statusText) as string,
    );
  }

  // A 401 on confirm-opaque-start is a dead/expired session, NOT a wrong
  // password: the password is only proven at confirm-opaque-finish, never at
  // start (start just runs server_login_start to mint a challenge). The only
  // 401 source here is the authenticated AuthUser extractor rejecting the
  // bearer token (or a per-account lockout, which the rest of the app likewise
  // surfaces as a sign-out). Re-authenticate instead of showing a misleading
  // "wrong password"/generic error: clear the stale token and fire
  // onSessionExpired, mirroring request()'s session-expiry path.
  if (startRes.status === 401) {
    await clearToken();
    onSessionExpired?.();
    throw new ApiError(401, 'Session expired');
  }

  if (!startRes.ok) {
    const body = (await startRes
      .json()
      .catch(() => ({ error: startRes.statusText }))) as Record<string, unknown>;
    throw new ApiError(
      startRes.status,
      (body.message ?? body.error ?? startRes.statusText) as string,
    );
  }

  const startBody = (await startRes.json()) as {
    server_message: string;
    server_state: string;
    ksf_version: number;
  };

  // 4. OPAQUE login finish (native), threading the account's KSF version so the
  //    client stretches with the matching KSF (0 = legacy Identity, 1 = Argon2id
  //    — forwarded from the server, never hardcoded). A WRONG password fails
  //    HERE, client-side, when finish verifies the server MAC; map that to the
  //    same "Incorrect password" UX as the 401 / plaintext paths.
  let loginFinishMessage: Uint8Array;
  try {
    const loginFinish = await BeebeebCrypto.opaqueLoginFinish(
      loginStart.state,
      base64ToUint8(startBody.server_message),
      password,
      // Defend against a stale server omitting ksf_version (mirror the login
      // flow's guard): default to 1 (Argon2id), the current registration KSF.
      typeof startBody.ksf_version === 'number' ? startBody.ksf_version : 1,
    );
    loginFinishMessage = loginFinish.message;
  } catch (_err) {
    throw new IncorrectPasswordError();
  }

  // 5. Authenticated POST to confirm-opaque-finish with the finish client message
  //    + the round-tripped server state. Direct fetch for the same reason as start.
  let finishRes: Response;
  try {
    finishRes = await rateLimitedFetch(`${BASE_URL}/api/v1/auth/confirm-opaque-finish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        client_message: uint8ToBase64(loginFinishMessage),
        server_state: startBody.server_state,
      }),
    });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  if (finishRes.status === 401) {
    // OPAQUE finish 401 = wrong password (a password-guess oracle). Same UX as
    // the client-side finish failure above. (Session-too-old does not arise on
    // the OPAQUE finish — that fallback lives only on the plaintext path.)
    throw new IncorrectPasswordError();
  }
  if (!finishRes.ok) {
    const body = (await finishRes
      .json()
      .catch(() => ({ error: finishRes.statusText }))) as Record<string, unknown>;
    throw new ApiError(
      finishRes.status,
      (body.message ?? body.error ?? finishRes.statusText) as string,
    );
  }
  return finishRes.json() as Promise<ConfirmActionResponse>;
}

/**
 * Legacy plaintext step-up fallback (`POST /api/v1/auth/confirm`). Kept intact
 * for Argon2-only accounts with no OPAQUE credential — those return
 * 409 { opaque_unavailable: true } from confirm-opaque-start. The password
 * leaves the device here; that is the documented, account-specific exception
 * OPAQUE cannot yet cover.
 *
 * Direct fetch (not request()) so a 401 — the user mistyping their password
 * during step-up — does NOT clear the token and bounce them to sign-in. The
 * session_too_old_for_confirmation → SessionTooOldForConfirmationError mapping
 * is preserved (this freshness check lives only on the plaintext path).
 */
async function confirmActionPlaintext(
  password: string,
  token: string,
): Promise<ConfirmActionResponse> {
  let res: Response;
  try {
    res = await rateLimitedFetch(`${BASE_URL}/api/v1/auth/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ password }),
    });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 401) {
    // Two distinct 401s are possible here:
    //   - "session_too_old_for_confirmation": session is OK but older than the
    //     step-up freshness window — re-typing the password cannot fix it.
    //   - everything else: the password was wrong.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.error === 'session_too_old_for_confirmation') {
      throw new SessionTooOldForConfirmationError(
        (body.message as string | undefined) ?? undefined,
      );
    }
    throw new IncorrectPasswordError();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Task 1540 continuation (PR #108): prefer the server's human-readable
    // `message` over the machine `error` code, same as request() (finding
    // 7) — this direct-fetch path had the two swapped.
    throw new ApiError(res.status, err.message ?? err.error ?? res.statusText);
  }
  return res.json() as Promise<ConfirmActionResponse>;
}

export type DeviceOwnerConfirmationMethod = 'biometric' | 'device_passcode' | 'device_owner';

export async function confirmDeviceOwnerAction(params: {
  platform: 'ios' | 'android';
  method: DeviceOwnerConfirmationMethod;
}): Promise<ConfirmActionResponse> {
  const deviceConfirmationSecret = await getDeviceConfirmationSecret();
  if (!deviceConfirmationSecret) {
    throw new ApiError(403, 'Sign in again once to enable device confirmation for Trash.');
  }
  const client = params.platform === 'ios' ? 'mobile-ios' : 'mobile-android';
  return request<ConfirmActionResponse>(
    'POST',
    '/api/v1/auth/confirm-device-owner',
    {
      ...params,
      device_confirmation_secret: deviceConfirmationSecret,
    },
    true,
    { 'X-Beebeeb-Client': client },
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FileEntry {
  id: string;
  name_encrypted: string;
  /**
   * @deprecated The plaintext mime_type column has been dropped server-side.
   * The server no longer populates this field; the local cache may still
   * fill it in client-side from the decrypted metadata blob (see
   * decryptFileMetadata) so existing screens that fall back to file.mime_type
   * keep working until they migrate to the decrypted value.
   */
  mime_type?: string | null;
  size_bytes: number;
  is_folder: boolean;
  is_uploading?: boolean;
  chunk_count: number;
  created_at: string;
  updated_at: string;
  version_number?: number;
  storage_pool_id?: string | null;
  /** Parent folder ID — null when the entry lives at the root. Populated by
   * /api/v1/files/all-images so the Photos screen can tag iOS-backup origin. */
  parent_id?: string | null;
  /** Active share count — populated by the server when shares exist on the entry. */
  share_count?: number;
  /** True when a thumbnail blob has been uploaded for this file. */
  has_thumbnail?: boolean;
  /**
   * Decoded byte length of the encrypted thumbnail (base64 → bytes), or
   * null/undefined when no thumbnail exists. Surfaced by the server (task
   * 0553) so the bulk-backfill worker can identify "degraded" thumbnails
   * (those uploaded under the pre-0552 50 KB cap) without re-downloading
   * each blob.
   */
  thumbnail_bytes?: number | null;
  /**
   * Blurhash placeholder string (~25 bytes, base83 encoded 4x3 colour grid).
   * Unencrypted by design — see task 0552 for the privacy argument. The
   * client renders this as an immediate gradient before either PhotoKit or
   * the encrypted-blob path resolves.
   */
  blurhash?: string | null;
  is_starred?: boolean;
  /** True when the file is an image or video (set at upload time). */
  is_media?: boolean;
  // ── File-request uploads (0643) ──
  // Set only for files that arrived through a file request. When all three are
  // present the file is decrypted via the request-key path (openRequestUpload)
  // rather than the normal master-key-derived per-file key. See
  // src/lib/file-request-crypto.ts.
  /** The file request this upload satisfies (UUID), or null for normal files. */
  file_request_id?: string | null;
  /** Uploader's ephemeral X25519 public key (base64), used to recover C. */
  sender_ephemeral_pubkey?: string | null;
  /** Content key C sealed to the request key (base64). */
  wrapped_content_key?: string | null;
}

/**
 * Map a storage pool ID to a human-readable physical location.
 * Beebeeb stores files across multiple European data centers — users
 * can see exactly where each file lives.
 */
export interface StorageLocation {
  label: string;
  flag: string;
  shortCode: string;
}

export function storageLocation(poolId: string | null | undefined): StorageLocation {
  if (!poolId) return { label: 'Europe', flag: '', shortCode: '' };
  return { label: 'Europe', flag: '', shortCode: '' };
}

/**
 * Trust-display location for the encryption details panel.
 * Always names the city + provider — the brand voice rule.
 */
export interface TrustLocation {
  region: string; // "Europe"
  city: string;
  provider: string;
}

export function trustLocation(poolId: string | null | undefined): TrustLocation {
  if (!poolId) return { region: 'Europe', city: 'EU region', provider: 'Beebeeb network' };
  return { region: 'Europe', city: 'EU region', provider: 'Beebeeb network' };
}

export interface ListFilesResponse {
  files: FileEntry[];
  /** Opaque keyset cursor for the next page; null/absent on the last page (task 0739). */
  next_cursor?: string | null;
}

export interface FileIndexResponse {
  hash: string;
  changed: boolean;
  count: number;
  files?: FileEntry[];
}

export async function createFolder(name: string, parentId?: string, folderId?: string): Promise<FileEntry> {
  return request<FileEntry>('POST', '/api/v1/files/folder', {
    name_encrypted: name,
    parent_id: parentId ?? null,
    folder_id: folderId,
  });
}

export const FILE_LIST_HARD_CAP = 50_000;

/**
 * One keyset page of a folder listing (task 0739). `cursor` is opaque — pass back
 * whatever the prior page returned, never parse it. The server keeps
 * `next_cursor: null` on the last page (absent/garbled cursor → first page).
 */
export async function listFilesPage(opts: {
  parentId?: string;
  trashed?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ files: FileEntry[]; next_cursor: string | null }> {
  const params = new URLSearchParams();
  if (opts.parentId) params.set('parent_id', opts.parentId);
  if (opts.trashed) params.set('trashed', 'true');
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const qs = params.toString();
  const data = await request<ListFilesResponse>('GET', `/api/v1/files${qs ? `?${qs}` : ''}`);
  return { files: data.files, next_cursor: data.next_cursor ?? null };
}

/**
 * First page only (≤ server default of 200) — preserved for existence checks
 * where the cap is irrelevant. Anything that RENDERS or ITERATES a folder must
 * use `listAllFiles`, or it silently truncates at 200 (task 0755).
 */
export async function listFiles(parentId?: string, trashed = false): Promise<FileEntry[]> {
  return (await listFilesPage({ parentId, trashed })).files;
}

/**
 * Follow `next_cursor` to enumerate a folder IN FULL, past the server's 200-item
 * default page (task 0755). Bounded by `maxTotal` (default `FILE_LIST_HARD_CAP`).
 */
export async function listAllFiles(
  parentId?: string,
  options?: { trashed?: boolean; maxTotal?: number },
): Promise<FileEntry[]> {
  return collectPaged<FileEntry>(
    async (cursor) => {
      const page = await listFilesPage({ parentId, trashed: options?.trashed, cursor });
      return { items: page.files, nextCursor: page.next_cursor };
    },
    options?.maxTotal ?? FILE_LIST_HARD_CAP,
    'listAllFiles',
  );
}

/**
 * Find the FIRST child of `parentId` matching `match`, following the keyset
 * cursor and EARLY-EXITING on the first hit (task 0755). Use for by-name/by-id
 * lookups (e.g. backup folder/manifest resolution) where a single capped page
 * would silently miss a target past page 1 — causing duplicate folders/manifests
 * — but decrypting the entire vault to find one entry would be wasteful.
 */
export async function findFile(
  parentId: string | undefined,
  match: (f: FileEntry) => boolean | Promise<boolean>,
  options?: { trashed?: boolean },
): Promise<FileEntry | undefined> {
  return findInPages<FileEntry>(
    async (cursor) => {
      const page = await listFilesPage({ parentId, trashed: options?.trashed, cursor });
      return { items: page.files, nextCursor: page.next_cursor };
    },
    match,
  );
}

export async function getFile(id: string): Promise<FileEntry> {
  return request<FileEntry>('GET', `/api/v1/files/${id}`);
}

/**
 * Task 1578 — `POST /api/v1/files/:id/upload/abandon` (server task 1571):
 * clears an in-flight version upload (`files.is_uploading`) and makes the
 * previous completed version current again. Owner-scoped server-side.
 */
export async function abandonFileUpload(id: string): Promise<void> {
  await request<unknown>('POST', `/api/v1/files/${id}/upload/abandon`);
}

/**
 * Task 1563 — the authoritative CURRENT `version_number` for a file.
 *
 * `GET /api/v1/files/:id` does NOT select `version_number` at all (confirmed
 * by reading the server's `get_file` handler, `files.rs`) — `FileEntry.
 * version_number` on that response is always `undefined` in practice, even
 * though the TYPE marks it optional as if it might sometimes be present.
 * The text editor's conflict-retry path ("Save as new version") needs a
 * TRUE current version to retry against, not a stale client-side guess, so
 * it goes through this — the EXISTING `/versions` endpoint (no new server
 * endpoint), whose `current_version` field IS the live `files.version_number`
 * column (`versions.rs`, `current_version: i32 = SELECT version_number FROM files …`).
 */
export async function getFileCurrentVersion(id: string): Promise<number> {
  const data = await request<{ file_id: string; current_version: number }>(
    'GET',
    `/api/v1/files/${id}/versions`,
  );
  return data.current_version;
}

/**
 * Task 1563 (preview redesign, item 5 — the Info sheet's version list).
 * The full version history for a file: same `/versions` endpoint
 * `getFileCurrentVersion` already reads, just keeping the `versions` array
 * this time instead of discarding it. Each entry is the union of the V1
 * (`file_versions`) and V2 (`object_versions`) snapshot models — see the
 * server's `list_versions` handler (`beebeeb-api/src/routes/versions.rs`) —
 * both tagged with a `source` field; both restorable. No device/platform
 * name is returned by either model, so the client cannot show "from iPhone"
 * / "from web" next to a version (see DEVIATIONS.md).
 */
export interface FileVersionEntry {
  id: string;
  version_number: number;
  size_bytes: number;
  chunk_count: number;
  created_at: string;
  source: 'object_version' | 'file_version';
}

export async function listFileVersions(id: string): Promise<FileVersionEntry[]> {
  const data = await request<{ file_id: string; current_version: number; versions: FileVersionEntry[] }>(
    'GET',
    `/api/v1/files/${id}/versions`,
  );
  return data.versions ?? [];
}

/**
 * GET /api/v1/files/index — whole-vault metadata index with a stable hash.
 * If `hash` still matches, the server returns `changed: false` without files.
 */
export async function getFileIndex(hash?: string): Promise<FileIndexResponse> {
  const path = hash
    ? `/api/v1/files/index?hash=${encodeURIComponent(hash)}`
    : '/api/v1/files/index';

  return request<FileIndexResponse>('GET', path);
}

/**
 * GET /api/v1/files/media — every non-trashed media file owned by the user.
 * Falls back to the legacy all-images endpoint for older servers.
 */
export async function getAllImages(): Promise<FileEntry[]> {
  try {
    const data = await request<ListFilesResponse>('GET', '/api/v1/files/media');
    return data.files;
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 405)) {
      throw err;
    }
  }

  const data = await request<ListFilesResponse>('GET', '/api/v1/files/all-images');
  return data.files;
}

/**
 * Legacy 4 MB fallback — used as the initial chunk size before v2 protocol
 * negotiation. The server's v2 init response provides the actual chunk size
 * from the adaptive ladder (beebeeb-types::plan_chunks). This constant only
 * applies when v2 negotiation fails or is unavailable.
 */
const CHUNK_SIZE = 4 * 1024 * 1024;
const MOBILE_UPLOAD_CHUNK_SIZE_CAP_BYTES = 16 * 1024 * 1024;
const MOBILE_UPLOAD_CHUNK_PAUSE_MS = 250;
const MOBILE_UPLOAD_NAME_PATCH_MAX_ATTEMPTS = 3;
const SIMPLE_UPLOAD_THRESHOLD = 5 * 1024 * 1024; // 5 MB — below this, use simple upload

function uploadPaceDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MOBILE_UPLOAD_CHUNK_PAUSE_MS));
}

function bytesToBlob(bytes: Uint8Array): Blob {
  const copy = bytes.slice();
  return new Blob([copy.buffer as ArrayBuffer], { type: 'application/octet-stream' });
}

async function putBinaryBytes(url: string, token: string | null, bytes: Uint8Array, foregroundTransfer = false): Promise<{
  ok: boolean;
  status: number;
  error: () => Promise<{ error?: string }>;
}> {
  const headers = { Authorization: `Bearer ${token}`, ...expectedUserHeaders(), 'Content-Type': 'application/octet-stream' };
  if (Platform.OS !== 'web' && FileSystem.cacheDirectory) {
    const chunkUri = `${FileSystem.cacheDirectory}beebeeb-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    try {
      await FileSystem.writeAsStringAsync(chunkUri, uint8ToBase64(bytes), {
        encoding: FileSystem.EncodingType.Base64,
      });
      const res = await FileSystem.uploadAsync(url, chunkUri, {
        httpMethod: 'PUT',
        headers,
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        // Task 1578: expo-file-system's default is a BACKGROUND URLSession,
        // whose tasks iOS may defer. Interactive saves opt into FOREGROUND.
        ...(foregroundTransfer ? { sessionType: FileSystem.FileSystemSessionType.FOREGROUND } : {}),
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        error: async () => {
          try { return JSON.parse(res.body) as { error?: string }; } catch { return { error: res.body }; }
        },
      };
    } finally {
      FileSystem.deleteAsync(chunkUri, { idempotent: true }).catch(() => {});
    }
  }

  const res = await rateLimitedFetch(url, {
    method: 'PUT',
    headers,
    body: bytesToBlob(bytes),
  });
  return {
    ok: res.ok,
    status: res.status,
    error: async () => res.json().catch(() => ({ error: res.statusText })),
  };
}

export interface UploadProgress {
  phase: 'preparing' | 'uploading' | 'finalizing';
  chunksTotal: number;
  chunksUploaded: number;
  bytesTotal: number;
  bytesUploaded: number;
  chunkSizeBytes?: number;
  /** Measured on-device encryption throughput (task 1301) — bytes/sec over the encrypt calls so far. */
  cryptoBytesPerSec?: number;
  uploadSessionId?: string;
  protocol?: 'v1' | 'v2';
}

export async function uploadFile(
  metadata: { name_encrypted: string; parent_id?: string; mime_type?: string; size_bytes: number },
  fileBlob: Blob,
  onProgress?: (progress: UploadProgress) => void,
): Promise<FileEntry> {
  if (fileBlob.size <= SIMPLE_UPLOAD_THRESHOLD) {
    return uploadFileSimple(metadata, fileBlob, onProgress);
  }
  return uploadFileChunked(metadata, fileBlob, onProgress);
}

async function uploadFileSimple(
  metadata: { name_encrypted: string; parent_id?: string; mime_type?: string; size_bytes: number },
  fileBlob: Blob,
  onProgress?: (progress: UploadProgress) => void,
): Promise<FileEntry> {
  onProgress?.({ phase: 'uploading', chunksTotal: 1, chunksUploaded: 0, bytesTotal: fileBlob.size, bytesUploaded: 0 });

  // Task 1594 round 3 (T5): snapshot the session at this upload's own start —
  // see `endSessionForAccountMismatch`.
  const authSnapshot = await captureRequestAuthSnapshot();
  const token = authSnapshot.token;
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('chunk_0', fileBlob);

  const res = await rateLimitedFetch(`${BASE_URL}/api/v1/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...expectedUserHeaders() },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Task 1594 round 2 (F5) / round 3 (T5): route account_mismatch the same
    // as request(), guarded against a session that has since moved on.
    await throwUploadError(res.status, err, res.statusText, authSnapshot);
  }

  onProgress?.({ phase: 'finalizing', chunksTotal: 1, chunksUploaded: 1, bytesTotal: fileBlob.size, bytesUploaded: fileBlob.size });
  return res.json() as Promise<FileEntry>;
}

/**
 * Encrypted chunked upload.
 *
 * Differs from the plain `uploadFileChunked` in two ways:
 * 1. Negotiates the upload session/chunk size with storage-v2 when available,
 *    then falls back to the legacy client-planned upload endpoints.
 * 2. Accepts pre-encrypted binary chunks (nonce || ciphertext, each as
 *    Uint8Array) rather than plain Blob slices.
 *
 * `sizeBytes` must be the total **ciphertext** size, not the plaintext size.
 * For AES-256-GCM the overhead is deterministic: 12 (nonce) + 16 (auth tag)
 * = 28 bytes per chunk, so `ciphertextSize = plaintextSize + chunkCount × 28`.
 */
export async function uploadEncryptedChunked(params: {
  fileId: string                // client-generated UUID, sent to server
  nameEncrypted: string | ((fileId: string) => Promise<string>) // JSON {cipher_suite, nonce: byte[], ciphertext: byte[]}
  v2InitNameEncrypted?: string  // Existing encrypted name for replacement uploads
  parentId?: string
  mimeType?: string
  isMedia?: boolean
  /** Original creation date (ISO 8601) for camera roll backups. */
  createdAt?: string
  plaintextSizeBytes: number
  resumeKey?: string
  /**
   * Task 1685 — written once per attempt into the per-file resume pointer so a
   * post-crash placeholder row can re-run this exact attempt
   * (api.ts → getUploadResumeForFile). `mimeType` is the CALLER's mime (it
   * feeds the resumeKey hash and must round-trip exactly). Absent → no pointer.
   */
  resumeMeta?: { sourceUri: string; name: string; mimeType?: string | null }
  onProgress?: (p: UploadProgress) => void
  /** Called once per chunk index — must return nonce||ciphertext bytes */
  readEncryptedChunk: (index: number, chunkSizeBytes: number, fileId: string) => Promise<Uint8Array>
  /**
   * Task 1563 (text editor Save) — explicit, id-based version-replace with
   * an optimistic-concurrency guard. When present, `fileId` is sent to the
   * server as `file_id` (not just used locally for key derivation) and
   * `baseVersionNumber` rides along as `base_version_number`: the server
   * 409s (`ApiError.status === 409`) if the file's current version has
   * moved on since the caller read it. Every other caller leaves this
   * unset and keeps today's byte-match-on-`v2InitNameEncrypted` behavior.
   */
  versionReplace?: { fileId: string; baseVersionNumber: number }
  /**
   * Task 1578 — send chunk PUTs over a FOREGROUND URLSession instead of the
   * expo-file-system default BACKGROUND one. For an upload the user is
   * actively waiting on (the text editor's Save): background-session tasks
   * run in `nsurlsessiond` and iOS may defer them, which left the editor's
   * Save spinner running on device. Every other caller keeps the default.
   */
  foregroundTransfer?: boolean
  /**
   * Task 1683f — trash-cancels-in-flight: aborting this signal stops the JS
   * chunk loop at the next chunk boundary (before the next PUT). Threading
   * comes from `encryptedUpload`'s `signal` option.
   */
  signal?: AbortSignal
}): Promise<FileEntry> {
  const {
    fileId,
    nameEncrypted,
    v2InitNameEncrypted,
    parentId,
    mimeType,
    isMedia,
    createdAt,
    plaintextSizeBytes,
    resumeKey,
    resumeMeta,
    onProgress,
    readEncryptedChunk,
    versionReplace,
    foregroundTransfer,
    signal,
  } = params
  // Task 1594 round 3 (T5): snapshot the session at this upload's own start —
  // see `endSessionForAccountMismatch`. Threaded into `initUploadV2` and
  // `finalizeUpload` below, plus every direct throwUploadError call here.
  const authSnapshot = await captureRequestAuthSnapshot()
  const token = authSnapshot.token
  const resolveNameEncrypted = async (id: string) =>
    typeof nameEncrypted === 'function' ? nameEncrypted(id) : nameEncrypted

  let protocol: 'v1' | 'v2' = 'v1'
  let serverFileId = fileId
  let uploadSessionId: string | undefined
  let chunkSizeBytes = CHUNK_SIZE
  let chunkCount = Math.max(1, Math.ceil(plaintextSizeBytes / CHUNK_SIZE))
  let startChunkIndex = 0
  let initialNameEncrypted = v2InitNameEncrypted ?? await resolveNameEncrypted(fileId)
  // Task 1589: the server's recommended heartbeat cadence for the CURRENT
  // session (set on every (re-)init; a resumed-from-storage session has no
  // fresh value, so it falls back to a conservative default).
  let heartbeatIntervalSecs = DEFAULT_HEARTBEAT_INTERVAL_SECS
  // Task 1599 followup 4: the sibling `lease_seconds` from the same (re-)init
  // response — the ceiling `startUploadHeartbeatPulse` clamps against.
  let leaseSeconds: number | undefined

  const resumeState = resumeKey ? await loadUploadResumeState(resumeKey) : null
  if (
    resumeState?.protocol === 'v2' &&
    resumeState.plaintextSizeBytes === plaintextSizeBytes &&
    resumeState.parentId === (parentId ?? null) &&
    resumeState.mimeType === (mimeType ?? null)
  ) {
    protocol = 'v2'
    serverFileId = resumeState.fileId
    uploadSessionId = resumeState.uploadSessionId ?? undefined
    chunkSizeBytes = resumeState.chunkSizeBytes
    chunkCount = resumeState.chunkCount
    startChunkIndex = Math.min(resumeState.lastUploadedChunkIndex + 1, chunkCount)
  } else {
    const v2Init = await initUploadV2({
      token,
      authSnapshot,
      fileName: initialNameEncrypted,
      fileSizeBytes: plaintextSizeBytes,
      parentId,
      isMedia,
      createdAt,
      fileId: versionReplace?.fileId,
      baseVersionNumber: versionReplace?.baseVersionNumber,
    })
    if (v2Init) {
      protocol = 'v2'
      serverFileId = v2Init.file_id
      uploadSessionId = v2Init.upload_session_id
      chunkSizeBytes = v2Init.chunk_size_bytes
      chunkCount = v2Init.chunk_count
      heartbeatIntervalSecs = v2Init.heartbeat_interval_secs ?? DEFAULT_HEARTBEAT_INTERVAL_SECS
      leaseSeconds = v2Init.lease_seconds

      if (chunkSizeBytes <= 0 || chunkSizeBytes > MOBILE_UPLOAD_CHUNK_SIZE_CAP_BYTES) {
        protocol = 'v1'
        serverFileId = fileId
        uploadSessionId = undefined
        chunkSizeBytes = CHUNK_SIZE
        chunkCount = Math.max(1, Math.ceil(plaintextSizeBytes / CHUNK_SIZE))
      }
    }
  }

  const sizeBytes = plaintextSizeBytes + chunkCount * 28

  onProgress?.({
    phase: 'preparing',
    chunksTotal: chunkCount,
    chunksUploaded: startChunkIndex,
    bytesTotal: sizeBytes,
    bytesUploaded: estimateUploadedBytes(startChunkIndex, chunkSizeBytes, plaintextSizeBytes),
    chunkSizeBytes,
    uploadSessionId,
    protocol,
  })

  // ── Step 1: Init — register the file/upload session ────────────────────
  if (protocol === 'v1') {
    initialNameEncrypted = await resolveNameEncrypted(fileId)
    const initRes = await rateLimitedFetch(`${BASE_URL}/api/v1/files/upload/init`, {
      method: 'POST',
      // Writer-provenance headers (task 1436) — this call creates the
      // object_versions row the server records them on.
      headers: { Authorization: `Bearer ${token}`, ...expectedUserHeaders(), 'Content-Type': 'application/json', ...mobileClientHeaders(), ...(await uploadDeviceHeader()) },
      body: JSON.stringify({
        file_id: fileId,
        name_encrypted: initialNameEncrypted,
        parent_id: parentId ?? null,
        // MIME type is encrypted inside name_encrypted; the server has no
        // plaintext mime_type column to store it in.
        is_media: isMedia ?? false,
        // Server expects PLAINTEXT size — `sizeBytes` (= plaintext + chunkCount*28)
        // is only used for progress reporting (total encrypted bytes in flight).
        size_bytes: plaintextSizeBytes,
        chunk_count: chunkCount,
        created_at: createdAt ?? null,
      }),
    })
    if (!initRes.ok) {
      const err = (await initRes.json().catch(() => ({ error: initRes.statusText }))) as { error?: string; message?: string }
      // Task 1594 round 2 (F5) / round 3 (T5): route account_mismatch the
      // same as request(), guarded against a session that has since moved on.
      await throwUploadError(initRes.status, err, initRes.statusText, authSnapshot)
    }
    const init = (await initRes.json()) as { file_id: string }
    serverFileId = init.file_id
  }

  // Task 1685 — one persist closure for the whole JS attempt (initial, per-chunk
  // and post-re-init saves all had the identical shape), which ALSO records the
  // per-file resume pointer exactly once per (fileId, resumeKey).
  const persistResume = (lastUploadedChunkIndex: number): void => {
    saveUploadResumeStateSoon(resumeKey, {
      protocol,
      fileId: serverFileId,
      uploadSessionId: uploadSessionId ?? null,
      chunkSizeBytes,
      chunkCount,
      plaintextSizeBytes,
      parentId: parentId ?? null,
      mimeType: mimeType ?? null,
      lastUploadedChunkIndex,
    })
    saveUploadResumeIndexEntrySoon(serverFileId, resumeKey, resumeMeta, {
      parentId,
      plaintextSizeBytes,
    })
  }
  persistResume(startChunkIndex - 1)

  // ── Steps 2+3: upload every chunk, then complete ────────────────────────
  // Task 1589: extracted so a swept v2 session (404, or the legacy 400 "not
  // writable: expired") can be recovered by re-initing the SAME file id and
  // re-running this from chunk 0, at most once per attempt.
  const runChunksAndComplete = async (fromIndex: number): Promise<FileEntry> => {
    let bytesUploaded = estimateUploadedBytes(fromIndex, chunkSizeBytes, plaintextSizeBytes)
    for (let i = fromIndex; i < chunkCount; i++) {
      // Task 1683f: trash aborted this upload — stop BEFORE the next PUT (the
      // abort also trips any fetch inside putBinaryBytes mid-flight).
      if (signal?.aborted) throw new DOMException('Upload cancelled.', 'AbortError')
      const encBytes = await readEncryptedChunk(i, chunkSizeBytes, serverFileId)

      const chunkPath = protocol === 'v2' && uploadSessionId
        ? `/api/v1/uploads/${uploadSessionId}/chunks/${i}`
        : `/api/v1/files/${serverFileId}/chunks/${i}`
      const chunkRes = await putBinaryBytes(`${BASE_URL}${chunkPath}`, token, encBytes, foregroundTransfer === true)
      if (!chunkRes.ok) {
        const err = (await chunkRes.error()) as { error?: string; message?: string }
        // Task 1589: the lease sweeper reclaimed this session mid-upload —
        // signal the re-init wrapper below instead of failing outright.
        if (protocol === 'v2' && isUploadSessionGone(chunkRes.status, err)) {
          throw new UploadSessionGoneSignal(chunkRes.status, err)
        }
        // Task 1594 round 2 (F5) / round 3 (T2, T5): a 409 account_mismatch
        // here ends the local session the same way request()'s own 409 handler
        // does — guarded against a session that has since moved on — the
        // machine code otherwise still reaches friendlyError() via
        // throwUploadError's fallback throw (e.g. object_budget_exceeded).
        await throwUploadError(chunkRes.status, err, `Chunk ${i} failed`, authSnapshot)
      }

      bytesUploaded += encBytes.length
      persistResume(i)
      onProgress?.({
        phase: 'uploading',
        chunksTotal: chunkCount,
        chunksUploaded: i + 1,
        bytesTotal: sizeBytes,
        bytesUploaded,
        chunkSizeBytes,
        uploadSessionId,
        protocol,
      })
      if (i + 1 < chunkCount) {
        await uploadPaceDelay()
      }
    }

    onProgress?.({
      phase: 'finalizing',
      chunksTotal: chunkCount,
      chunksUploaded: chunkCount,
      bytesTotal: sizeBytes,
      bytesUploaded: sizeBytes,
      chunkSizeBytes,
      uploadSessionId,
      protocol,
    })

    return finalizeUpload({ protocol, serverFileId, uploadSessionId, token, authSnapshot, resolveNameEncrypted, initialNameEncrypted, resumeKey })
  }

  // Task 1589: a heartbeat while a v2 upload is active covers the GAP between
  // requests (pacing, encrypt time, a background pause the process survives)
  // — the in-flight renewal on the server already covers one chunk's own
  // streaming time. Stopped on every exit path (success, re-init, failure).
  let stopHeartbeat = protocol === 'v2' && uploadSessionId
    ? startUploadHeartbeatPulse(uploadSessionId, token, heartbeatIntervalSecs, leaseSeconds)
    : (): void => {}

  try {
    try {
      return await runChunksAndComplete(startChunkIndex)
    } catch (err) {
      if (!(err instanceof UploadSessionGoneSignal) || protocol !== 'v2') throw err

      // One bounded re-init: same file id, restart from chunk 0. Never a
      // second time in this call — a second sweep is a typed error.
      stopHeartbeat()
      await clearUploadResumeState(resumeKey)
      let reinit: UploadV2InitResponse | null
      try {
        reinit = await initUploadV2WithRetry({
          token,
          authSnapshot,
          fileName: initialNameEncrypted,
          fileSizeBytes: plaintextSizeBytes,
          parentId,
          isMedia,
          createdAt,
          fileId: serverFileId, // takeover: server recreates/reverts under the SAME id
          baseVersionNumber: versionReplace?.baseVersionNumber,
        })
      } catch {
        reinit = null
      }
      if (!reinit || reinit.file_id !== serverFileId) {
        // Could not re-init (5xx exhausted, or a 404/405 — v2 unexpectedly
        // unavailable mid-upload), OR the server violated the takeover
        // contract (task 1589: a re-init MUST hand back the SAME file id —
        // the already-staged chunks and name were encrypted under the
        // original one; task 1599 followup 1). Either way, never adopt the
        // response — surface the ORIGINAL session-gone failure, shaped
        // exactly as it would have been without this recovery path.
        return await throwUploadError(err.status, err.body, 'Upload session expired', authSnapshot)
      }

      uploadSessionId = reinit.upload_session_id
      chunkSizeBytes = reinit.chunk_size_bytes
      chunkCount = reinit.chunk_count
      heartbeatIntervalSecs = reinit.heartbeat_interval_secs ?? DEFAULT_HEARTBEAT_INTERVAL_SECS
      leaseSeconds = reinit.lease_seconds
      persistResume(-1)
      stopHeartbeat = startUploadHeartbeatPulse(uploadSessionId, token, heartbeatIntervalSecs, leaseSeconds)

      try {
        return await runChunksAndComplete(0)
      } catch (err2) {
        if (err2 instanceof UploadSessionGoneSignal) {
          await clearUploadResumeState(resumeKey)
          throw new UploadRestartFailedError()
        }
        throw err2
      }
    }
  } finally {
    stopHeartbeat()
  }
}

/**
 * Step 3 of both upload paths: tell the server the session is complete, then
 * (v2) bind the encrypted name to the server-assigned file id and clear the
 * resume state. Shared by the JS chunk loop and the native streaming path.
 */
async function finalizeUpload(params: {
  protocol: 'v1' | 'v2'
  serverFileId: string
  uploadSessionId?: string
  token: string | null
  authSnapshot: RequestAuthSnapshot
  resolveNameEncrypted: (fileId: string) => Promise<string>
  initialNameEncrypted: string
  resumeKey?: string
}): Promise<FileEntry> {
  const { protocol, serverFileId, uploadSessionId, token, authSnapshot, resolveNameEncrypted, initialNameEncrypted, resumeKey } = params
  const completePath = protocol === 'v2' && uploadSessionId
    ? `/api/v1/uploads/${uploadSessionId}/complete`
    : `/api/v1/files/${serverFileId}/upload/complete`
  const completeRes = await rateLimitedFetch(`${BASE_URL}${completePath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...expectedUserHeaders(), 'Content-Type': 'application/json', ...(await uploadDeviceHeader()) },
    body: JSON.stringify({}),
  })
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({ error: completeRes.statusText })) as { error?: string; message?: string }
    // Task 1589: the lease sweeper reclaimed this session between the last
    // chunk PUT and complete — signal the caller's re-init path instead of
    // surfacing a generic failure. v1 has no session/lease, so this only
    // ever applies to v2.
    if (protocol === 'v2' && isUploadSessionGone(completeRes.status, err)) {
      throw new UploadSessionGoneSignal(completeRes.status, err)
    }
    // Task 1594 round 2 (F5) / round 3 (T5): route account_mismatch the same
    // as request(), guarded against a session that has since moved on.
    await throwUploadError(completeRes.status, err, 'Finalize failed', authSnapshot)
  }
  const completed = await completeRes.json() as FileEntry
  let shouldClearResumeState = true
  if (protocol === 'v2') {
    const finalNameEncrypted = await resolveNameEncrypted(serverFileId)
    if (finalNameEncrypted !== initialNameEncrypted) {
      const patched = await patchCompletedUploadNameEncrypted(serverFileId, finalNameEncrypted)
      if (patched) {
        completed.name_encrypted = finalNameEncrypted
      } else {
        shouldClearResumeState = false
      }
    }
  }
  if (shouldClearResumeState) {
    clearUploadResumeStateSoon(resumeKey)
    // Task 1685 — the upload is complete: drop the per-file resume pointer so
    // the row never offers a resume that has nothing to resume.
    forgetUploadResumeSoon(serverFileId)
  }
  return completed
}

/**
 * Native streaming upload (task 1310, iOS).
 *
 * Same wire protocol as `uploadEncryptedChunked` (storage-v2 session), but the
 * file is read, encrypted and PUT by the Swift engine — plaintext never enters
 * the JS heap and progress is byte-level instead of one tick per chunk. JS
 * still owns init, resume state, complete and the encrypted-name patch.
 *
 * Resolves to `null` when the native engine is not in this build or the server
 * has no v2 session endpoint, so the caller can fall back to the JS loop.
 * Server/transport failures throw `ApiError` exactly like the JS path.
 */
export async function uploadEncryptedFileNative(params: {
  masterKeyHandleId: number
  fileId: string
  inputUri: string
  nameEncrypted: string | ((fileId: string) => Promise<string>)
  v2InitNameEncrypted?: string
  parentId?: string
  isMedia?: boolean
  createdAt?: string
  plaintextSizeBytes: number
  resumeKey?: string
  /** Task 1685 — per-file resume pointer payload; see uploadEncryptedChunked. */
  resumeMeta?: { sourceUri: string; name: string; mimeType?: string | null }
  onProgress?: (p: UploadProgress) => void
  /**
   * Task 1683f — trash-cancels-in-flight: forwarded into the native bridge's
   * existing signal surface (uploadChunksNativeTracked → uploadChunksNative),
   * whose abort listener calls cancelUploadNative.
   */
  signal?: AbortSignal
}): Promise<FileEntry | null> {
  // Task 1683c: Android now ships the same native upload engine (Kotlin port
  // of the iOS one — modules/beebeeb-crypto/android .../NativeManualUploader.kt),
  // so the platform gate collapses onto the capability check: the functions
  // are only present when the native build exposes them, and a stale Android
  // native build without them still falls back to the JS loop via `null`.
  if (!isNativeUploadAvailable()) return null
  const {
    masterKeyHandleId, fileId, inputUri, nameEncrypted, v2InitNameEncrypted,
    parentId, isMedia, createdAt, plaintextSizeBytes, resumeKey, resumeMeta, onProgress, signal,
  } = params
  // Task 1594 round 3 (T5): snapshot the session at this upload's own start —
  // see `endSessionForAccountMismatch`.
  const authSnapshot = await captureRequestAuthSnapshot()
  const token = authSnapshot.token
  if (!token) throw new ApiError(401, 'Not signed in')
  const resolveNameEncrypted = async (id: string) =>
    typeof nameEncrypted === 'function' ? nameEncrypted(id) : nameEncrypted

  const plan = planUploadChunksNative(plaintextSizeBytes)
  if (!(plan.chunkSizeBytes > 0) || !(plan.chunkCount > 0)) return null

  const initialNameEncrypted = v2InitNameEncrypted ?? await resolveNameEncrypted(fileId)
  const resumeState = resumeKey ? await loadUploadResumeState(resumeKey) : null

  let serverFileId: string
  let uploadSessionId: string
  let startChunkIndex = 0
  // Task 1589: the server's recommended heartbeat cadence for the CURRENT
  // session; a resumed-from-storage session has no fresh value.
  let heartbeatIntervalSecs = DEFAULT_HEARTBEAT_INTERVAL_SECS
  // Task 1599 followup 4: the sibling `lease_seconds` from the same (re-)init
  // response — the ceiling `startUploadHeartbeatPulse` clamps against.
  let leaseSeconds: number | undefined
  if (resumeState && resumeStateMatchesNativePlan(resumeState, { plaintextSizeBytes, parentId, ...plan })) {
    serverFileId = resumeState.fileId
    uploadSessionId = resumeState.uploadSessionId as string
    startChunkIndex = Math.min(resumeState.lastUploadedChunkIndex + 1, plan.chunkCount)
  } else {
    const v2Init = await initUploadV2({
      token,
      authSnapshot,
      fileName: initialNameEncrypted,
      fileSizeBytes: plaintextSizeBytes,
      parentId,
      isMedia,
      createdAt,
      chunkSizeBytes: plan.chunkSizeBytes,
      chunkCount: plan.chunkCount,
    })
    if (!v2Init) return null
    if (v2Init.chunk_size_bytes !== plan.chunkSizeBytes || v2Init.chunk_count !== plan.chunkCount) {
      throw new ApiError(500, 'Server changed the upload chunk plan', 'chunk_plan_mismatch')
    }
    serverFileId = v2Init.file_id
    uploadSessionId = v2Init.upload_session_id
    heartbeatIntervalSecs = v2Init.heartbeat_interval_secs ?? DEFAULT_HEARTBEAT_INTERVAL_SECS
    leaseSeconds = v2Init.lease_seconds
  }

  const sizeBytes = plaintextSizeBytes + plan.chunkCount * 28
  onProgress?.({
    phase: 'preparing',
    chunksTotal: plan.chunkCount,
    chunksUploaded: startChunkIndex,
    bytesTotal: sizeBytes,
    bytesUploaded: estimateUploadedBytes(startChunkIndex, plan.chunkSizeBytes, plaintextSizeBytes),
    chunkSizeBytes: plan.chunkSizeBytes,
    uploadSessionId,
    protocol: 'v2',
  })

  const persistResume = (lastUploadedChunkIndex: number) => {
    saveUploadResumeStateSoon(resumeKey, {
      protocol: 'v2',
      fileId: serverFileId,
      uploadSessionId,
      chunkSizeBytes: plan.chunkSizeBytes,
      chunkCount: plan.chunkCount,
      plaintextSizeBytes,
      parentId: parentId ?? null,
      mimeType: null,
      lastUploadedChunkIndex,
    })
    // Task 1685 — recorded once per (fileId, resumeKey); the per-chunk calls
    // that follow are memoized no-ops.
    saveUploadResumeIndexEntrySoon(serverFileId, resumeKey, resumeMeta, {
      parentId,
      plaintextSizeBytes,
    })
  }
  persistResume(startChunkIndex - 1)
  let lastPersistedChunk = startChunkIndex - 1

  // Task 1589: extracted so a swept v2 session (404, or the legacy 400 "not
  // writable: expired") — surfaced from the native bridge as an `ApiError`
  // via `nativeUploadErrorToApiError`, or from `finalizeUpload`'s complete
  // call as `UploadSessionGoneSignal` — can be recovered by re-initing the
  // SAME file id and re-running this from chunk 0, at most once per attempt.
  const runNativeAttempt = async (fromIndex: number): Promise<FileEntry> => {
    // The id the bridge will derive the AES file key from — fed straight into
    // the request object below (never aliased through a second binding), so
    // `uploadChunksNativeTracked`'s outcome and the belt-and-braces check that
    // reads it are checking the id the call was ACTUALLY made with.
    let nativeOutcome: Awaited<ReturnType<typeof uploadChunksNativeTracked>>
    try {
      nativeOutcome = await uploadChunksNativeTracked(
        uploadChunksNative,
        {
          handleId: masterKeyHandleId,
          apiUrl: BASE_URL,
          token,
          fileId: serverFileId,
          inputUri,
          uploadSessionId,
          chunkSizeBytes: plan.chunkSizeBytes,
          chunkCount: plan.chunkCount,
          startChunkIndex: fromIndex,
        },
        {
          onProgress: (ev) => {
            onProgress?.(nativeProgressToUploadProgress(ev, { chunkSizeBytes: plan.chunkSizeBytes, uploadSessionId }))
            const completedIndex = ev.chunksUploaded - 1
            if (completedIndex > lastPersistedChunk) {
              lastPersistedChunk = completedIndex
              persistResume(completedIndex)
            }
          },
          // Task 1683f: trash aborts the engine mid-flight (the bridge's abort
          // listener calls cancelUploadNative).
          signal,
        },
      )
    } catch (err) {
      const apiErr = nativeUploadErrorToApiError(err)
      if (apiErr instanceof ApiError && isUploadSessionGone(apiErr.status, { message: apiErr.message, error: apiErr.code })) {
        throw new UploadSessionGoneSignal(apiErr.status, { message: apiErr.message, error: apiErr.code })
      }
      throw apiErr
    }

    // Belt and braces (task 1351): never complete an upload whose encryption
    // id and session id have drifted apart — the native bridge can't tell us
    // itself, so this is the last checkpoint before the file is marked done.
    // `nativeOutcome.encryptedUnderFileId` is read off the SAME params object
    // actually forwarded to the bridge (`uploadChunksNativeTracked`,
    // native-upload-bridge.ts) — a real assertion against the call, not a
    // comparison of two names for the same untouched value.
    try {
      assertNativeUploadEncryptedUnderSessionId(nativeOutcome.encryptedUnderFileId, serverFileId)
    } catch (err) {
      throw new ApiError(
        500,
        err instanceof Error ? err.message : 'Native upload encrypted under an id that does not match its upload session',
        'native_upload_id_mismatch',
      )
    }

    onProgress?.({
      phase: 'finalizing',
      chunksTotal: plan.chunkCount,
      chunksUploaded: plan.chunkCount,
      bytesTotal: sizeBytes,
      bytesUploaded: sizeBytes,
      chunkSizeBytes: plan.chunkSizeBytes,
      uploadSessionId,
      protocol: 'v2',
    })
    return finalizeUpload({
      protocol: 'v2', serverFileId, uploadSessionId, token, authSnapshot, resolveNameEncrypted, initialNameEncrypted, resumeKey,
    })
  }

  // Task 1589: heartbeat while this native transfer is in flight. The JS
  // event loop keeps running timers while awaiting the native bridge's
  // promise, so this fires normally even though the whole file transfers in
  // one native call.
  let stopHeartbeat = startUploadHeartbeatPulse(uploadSessionId, token, heartbeatIntervalSecs, leaseSeconds)

  try {
    try {
      return await runNativeAttempt(startChunkIndex)
    } catch (err) {
      if (!(err instanceof UploadSessionGoneSignal)) throw err

      // One bounded re-init: same file id + same native chunk plan, restart
      // from chunk 0. Never a second time in this call.
      stopHeartbeat()
      await clearUploadResumeState(resumeKey)
      let reinit: UploadV2InitResponse | null
      try {
        reinit = await initUploadV2WithRetry({
          token,
          authSnapshot,
          fileName: initialNameEncrypted,
          fileSizeBytes: plaintextSizeBytes,
          parentId,
          isMedia,
          createdAt,
          chunkSizeBytes: plan.chunkSizeBytes,
          chunkCount: plan.chunkCount,
          fileId: serverFileId, // takeover: server recreates/reverts under the SAME id
        })
      } catch {
        reinit = null
      }
      if (
        !reinit
        || reinit.chunk_size_bytes !== plan.chunkSizeBytes
        || reinit.chunk_count !== plan.chunkCount
        // task 1599 followup 1: the takeover contract is the SAME file id —
        // the native transfer would otherwise encrypt/upload under a server
        // id that never matches the name/key material staged for this asset.
        || reinit.file_id !== serverFileId
      ) {
        // Could not re-init cleanly (5xx exhausted, 404/405, the server's
        // plan drifted from the native plan, or a file-id mismatch). Surface
        // the ORIGINAL session-gone failure, shaped as it would be without
        // this recovery.
        return await throwUploadError(err.status, err.body, 'Upload session expired', authSnapshot)
      }

      uploadSessionId = reinit.upload_session_id
      heartbeatIntervalSecs = reinit.heartbeat_interval_secs ?? DEFAULT_HEARTBEAT_INTERVAL_SECS
      leaseSeconds = reinit.lease_seconds
      lastPersistedChunk = -1
      persistResume(-1)
      stopHeartbeat = startUploadHeartbeatPulse(uploadSessionId, token, heartbeatIntervalSecs, leaseSeconds)

      try {
        return await runNativeAttempt(0)
      } catch (err2) {
        if (err2 instanceof UploadSessionGoneSignal) {
          await clearUploadResumeState(resumeKey)
          throw new UploadRestartFailedError()
        }
        throw err2
      }
    }
  } finally {
    stopHeartbeat()
  }
}

/** Rebuild the `ApiError` the JS chunk loop would have thrown for the same server reply. */
function nativeUploadErrorToApiError(err: unknown): unknown {
  if (err instanceof ApiError) return err
  const envelope = parseNativeUploadError(err instanceof Error ? err.message : String(err))
  if (!envelope) return err
  return new ApiError(envelope.status, envelope.message, envelope.code)
}

async function patchCompletedUploadNameEncrypted(serverFileId: string, finalNameEncrypted: string): Promise<boolean> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MOBILE_UPLOAD_NAME_PATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      await request('PATCH', `/api/v1/files/${serverFileId}`, { name_encrypted: finalNameEncrypted })
      return true
    } catch (err) {
      lastError = err
      if (attempt < MOBILE_UPLOAD_NAME_PATCH_MAX_ATTEMPTS) {
        await uploadPaceDelay()
      }
    }
  }

  console.warn('[upload] final encrypted filename patch failed after retries', {
    serverFileId,
    attempts: MOBILE_UPLOAD_NAME_PATCH_MAX_ATTEMPTS,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  })
  return false
}

interface UploadV2InitResponse {
  file_id: string;
  upload_session_id: string;
  chunk_size_bytes: number;
  chunk_count: number;
  /**
   * Task 1589 — the session's lease (server PR #120) and the server's own
   * recommended heartbeat cadence (lease / 3). Optional so a server response
   * from before #120 (or one that omits the fields) still parses; callers
   * fall back to `DEFAULT_HEARTBEAT_INTERVAL_SECS`.
   */
  lease_seconds?: number;
  heartbeat_interval_secs?: number;
}

/**
 * Task 1589 — internal control-flow signal: a v2 chunk PUT or complete came
 * back 404 (or the legacy 400 "not writable: expired"), meaning the lease
 * sweeper reclaimed this session. Caught only by the two upload paths below,
 * which re-init the SAME file id and restart from chunk 0, at most once per
 * attempt. Never surfaced to a caller outside this file — `throwUploadError`
 * is still what every OTHER failure goes through.
 */
class UploadSessionGoneSignal extends Error {
  constructor(public status: number, public body: { error?: string; message?: string }) {
    super(body.message ?? body.error ?? 'upload session gone')
    this.name = 'UploadSessionGoneSignal'
  }
}

/** Conservative fallback when a server response omits `heartbeat_interval_secs` (pre-1589). */
const DEFAULT_HEARTBEAT_INTERVAL_SECS = 90

/**
 * Task 1599 followup 4 — never trust the server's `heartbeat_interval_secs`
 * verbatim. A FLOOR of 15s stops a buggy or compromised server from making
 * the client hammer the heartbeat endpoint (e.g. a returned `0`). A CEILING
 * of `leaseSeconds / 2` stops an interval close to (or past) the lease from
 * letting the lease expire between two heartbeats even when nothing else
 * went wrong. The ceiling wins when the two conflict (a very short lease) —
 * a heartbeat that undershoots the floor is safer than one that can outlive
 * its own lease. `leaseSeconds` is omitted (or <= 0) for a pre-1589 server
 * response that has no lease concept yet; only the floor applies then.
 */
const MIN_HEARTBEAT_INTERVAL_SECS = 15

export function clampHeartbeatIntervalSecs(intervalSecs: number, leaseSeconds?: number): number {
  const floored = Math.max(MIN_HEARTBEAT_INTERVAL_SECS, intervalSecs)
  if (leaseSeconds === undefined || leaseSeconds <= 0) return floored
  return Math.min(floored, leaseSeconds / 2)
}

/**
 * Task 1589 — renew a v2 upload session's lease directly (server PR #120,
 * `POST /uploads/{id}/heartbeat`), for the GAP between two requests on the
 * same session: pacing between chunks, a background suspension the process
 * survives, a slow encrypt. The in-flight body of a single chunk PUT already
 * renews its own lease server-side while it streams — this covers everything
 * else. Best-effort by design: a failed heartbeat is logged and swallowed,
 * never thrown — a missed renewal just means the NEXT chunk/complete may see
 * a 404 and go through the re-init path below, which is exactly the recovery
 * this task adds. Keeps sending `X-Beebeeb-Expected-User` (task 1594/#143),
 * same as every other authenticated mutation.
 */
async function sendUploadHeartbeat(uploadSessionId: string, token: string | null): Promise<void> {
  const res = await rateLimitedFetch(`${BASE_URL}/api/v1/uploads/${uploadSessionId}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...expectedUserHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    // Not thrown: a heartbeat is a best-effort renewal, not part of the
    // upload's own success/failure path (mirrors the desktop client's
    // "heartbeat during limiter sleeps" recommendation in the 1589 audit).
    console.warn('[upload] heartbeat rejected', { uploadSessionId, status: res.status })
  }
}

/**
 * Starts a best-effort heartbeat timer for an active v2 upload session.
 * Returns a function that stops it — every caller MUST call it in a
 * `finally`, on both the success and the failure path, so a completed or
 * abandoned upload never leaves a timer running.
 */
function startUploadHeartbeatPulse(uploadSessionId: string, token: string | null, intervalSecs: number, leaseSeconds?: number): () => void {
  const intervalMs = clampHeartbeatIntervalSecs(intervalSecs, leaseSeconds) * 1000
  const timer = setInterval(() => {
    sendUploadHeartbeat(uploadSessionId, token).catch((err) => {
      console.warn('[upload] heartbeat failed (best-effort)', {
        uploadSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, intervalMs)
  return () => clearInterval(timer)
}

/**
 * Task 1589 — bounded 5xx retry for a RE-INIT's own init call, same id every
 * time (mirrors the CLI's `STORED_ID_INIT_RETRIES` for the identical
 * situation, PR #50): a 5xx does not prove the stored/explicit file id is
 * unusable, so it is retried with backoff rather than treated as "give up" or
 * "fall back to a different id". Any 4xx (404/409/etc.) is NOT retried here —
 * it is returned/thrown as-is for the caller to interpret.
 */
const REINIT_MAX_RETRIES = 3
const REINIT_BACKOFF_BASE_MS = 150

async function initUploadV2WithRetry(
  params: Parameters<typeof initUploadV2>[0],
): Promise<UploadV2InitResponse | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await initUploadV2(params)
    } catch (err) {
      const retryable = err instanceof ApiError && err.status >= 500 && err.status < 600
      if (!retryable || attempt >= REINIT_MAX_RETRIES) throw err
      await new Promise((resolve) => setTimeout(resolve, REINIT_BACKOFF_BASE_MS * 2 ** attempt))
    }
  }
}

async function initUploadV2(params: {
  token: string | null;
  authSnapshot: RequestAuthSnapshot;
  fileName: string;
  fileSizeBytes: number;
  parentId?: string;
  isMedia?: boolean;
  createdAt?: string;
  /** Client chunk plan; defaults to the JS loop's fixed 4 MiB layout. */
  chunkSizeBytes?: number;
  chunkCount?: number;
  /**
   * Task 1563 — explicit version-replace target (text editor Save). Distinct
   * from the existing name-byte-match replace path (`v2InitNameEncrypted`):
   * this passes the file's own id straight through as `file_id`, paired
   * with `baseVersionNumber` for the server's optimistic-concurrency check
   * (beebeeb-api.md: "Version-replace by file_id … base_version_number …
   * A stale base_version_number → 409"). Omitted by every OTHER caller —
   * purely additive; JSON.stringify drops both when undefined, so no
   * existing request body changes shape.
   */
  fileId?: string;
  baseVersionNumber?: number;
}): Promise<UploadV2InitResponse | null> {
  const chunkSizeBytes = params.chunkSizeBytes ?? CHUNK_SIZE
  const chunkCount = params.chunkCount ?? Math.max(1, Math.ceil(params.fileSizeBytes / CHUNK_SIZE))
  const res = await rateLimitedFetch(`${BASE_URL}/api/v1/uploads/init`, {
    method: 'POST',
    // Writer-provenance headers (task 1436) — this call creates the
    // object_versions row the server records them on.
    headers: { Authorization: `Bearer ${params.token}`, ...expectedUserHeaders(), 'Content-Type': 'application/json', ...mobileClientHeaders(), ...(await uploadDeviceHeader()) },
    body: JSON.stringify({
      file_id: params.fileId,
      file_name: params.fileName,
      file_size_bytes: params.fileSizeBytes,
      parent_id: params.parentId ?? null,
      // MIME type is encrypted inside name_encrypted; the server has no
      // plaintext mime_type column.
      is_media: params.isMedia ?? false,
      profile: 'mobile',
      chunk_size_bytes: chunkSizeBytes,
      chunk_count: chunkCount,
      created_at: params.createdAt ?? null,
      base_version_number: params.baseVersionNumber,
    }),
  })
  if (res.status === 404 || res.status === 405) return null
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string; message?: string }
    // Task 1594 round 2 (F5) / round 3 (T5): route account_mismatch the same
    // as request(), guarded against a session that has since moved on.
    await throwUploadError(res.status, err, res.statusText, params.authSnapshot)
  }
  const data = await res.json() as UploadV2InitResponse
  return {
    file_id: data.file_id,
    upload_session_id: data.upload_session_id,
    chunk_size_bytes: data.chunk_size_bytes,
    chunk_count: data.chunk_count,
    lease_seconds: data.lease_seconds,
    heartbeat_interval_secs: data.heartbeat_interval_secs,
  }
}

interface UploadResumeState {
  protocol: 'v1' | 'v2';
  fileId: string;
  uploadSessionId: string | null;
  chunkSizeBytes: number;
  chunkCount: number;
  plaintextSizeBytes: number;
  parentId: string | null;
  mimeType: string | null;
  lastUploadedChunkIndex: number;
}

const uploadResumeStoreKey = (resumeKey: string) => `beebeeb_upload_resume_${resumeKey}`

/**
 * Task 1683f — the index that makes resume state enumerable. SecureStore has
 * no listing API, so every `saveUploadResumeState` writes the active key into
 * `beebeeb_upload_resume_index` (a JSON string[]), every clear removes it, and
 * the sign-out sweep (account-cleanup.ts → sweepAllUploadResumeStates) walks
 * the index — today those keys survive sign-out AND account switches
 * (cross-account leak). A malformed index self-heals by starting empty (the
 * next save rewrites it).
 */
const RESUME_INDEX_KEY = 'beebeeb_upload_resume_index'

async function readResumeIndex(): Promise<string[]> {
  try {
    const raw = await tokenStore.get(RESUME_INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k): k is string => typeof k === 'string')
  } catch {
    return []
  }
}

async function writeResumeIndex(keys: string[]): Promise<void> {
  await tokenStore.set(RESUME_INDEX_KEY, JSON.stringify(keys))
}

async function addToResumeIndex(resumeKey: string): Promise<void> {
  const keys = await readResumeIndex()
  if (!keys.includes(resumeKey)) keys.push(resumeKey)
  await writeResumeIndex(keys).catch(() => {})
}

async function removeFromResumeIndex(resumeKey: string): Promise<void> {
  const keys = await readResumeIndex()
  if (!keys.includes(resumeKey)) return
  await writeResumeIndex(keys.filter((k) => k !== resumeKey)).catch(() => {})
}

/**
 * Task 1683f — sign-out sweep: delete every indexed resume key + the index
 * itself. Best-effort per key; never throws (sign-out must not break).
 */
export async function sweepAllUploadResumeStates(): Promise<void> {
  const keys = await readResumeIndex().catch(() => [])
  await Promise.all(
    keys.map((k) => tokenStore.remove(uploadResumeStoreKey(k)).catch(() => {})),
  )
  await tokenStore.remove(RESUME_INDEX_KEY).catch(() => {})
}

// ── Task 1683f: trash-cancels-in-flight — a fileId→AbortController registry
// covering BOTH upload engines. Trash (FilesScreen) calls `abortUploadForFile
// (fileId)`; the controller's signal aborts the native bridge call (its
// existing options.signal surface) and makes the JS chunk loop stop at the
// next chunk boundary. Registry entries are removed when the upload settles.
const uploadAbortRegistry = new Map<string, AbortController>()

/** Task 1683f — encrypted-upload registers the engine run per fileId so the
 * trash action can reach it (`abortUploadForFile`); an optional caller signal
 * forwards into the same controller. */
export function registerUploadAbort(fileId: string, external?: AbortSignal): AbortSignal {
  const existing = uploadAbortRegistry.get(fileId)
  existing?.abort(new Error('superseded'))
  const controller = new AbortController()
  // A caller-provided signal (encryptedUpload's `signal` option) forwards into
  // the registered controller, so BOTH the caller's signal and a later trash
  // call (`abortUploadForFile`) abort the same engine run.
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', () => controller.abort(), { once: true })
  }
  uploadAbortRegistry.set(fileId, controller)
  return controller.signal
}

function settleUploadAbort(fileId: string, signal: AbortSignal | undefined): void {
  if (!signal) return
  for (const [id, controller] of uploadAbortRegistry) {
    if (controller.signal === signal) uploadAbortRegistry.delete(id)
  }
}

/** Task 1683f — the engine call site (encrypted-upload) settles its registry entry. */
export function settleUploadSignal(fileId: string, signal: AbortSignal | undefined): void {
  settleUploadAbort(fileId, signal)
}

/** Trash/batch-trash calls this: abort the in-flight engine for a file, if any.
 * One-shot: the entry is removed here (the engine's own settle is a no-op
 * afterwards), so a repeated trash call reports `false`. */
export function abortUploadForFile(fileId: string): boolean {
  const controller = uploadAbortRegistry.get(fileId)
  if (!controller) return false
  uploadAbortRegistry.delete(fileId)
  controller.abort()
  return true
}

// ── Task 1685: durable resume VISIBILITY ─────────────────────────────────────
// The primary resume state is keyed by hash(parentId|uri|name|mime|size) —
// uncomputable after a relaunch, when neither the uri nor the name are known.
// A second, per-file record (`beebeeb_upload_resume_file_<fileId>`, one
// SecureStore read for a tapped placeholder row) stores everything needed to
// re-run the interrupted attempt: the resumeKey itself plus the original
// sourceUri/name/parent/mime/size. expo-secure-store cannot enumerate keys, so
// lookup MUST be by fileId — which is exactly what the FilesScreen tap has.

export interface UploadResumeInfo {
  /** The server file id — the same id the placeholder row carries. */
  fileId: string;
  /** The primary resume-state key this entry points at. */
  resumeKey: string;
  /** Local file URI the interrupted attempt was reading from. */
  sourceUri: string;
  /** Plaintext filename of the interrupted attempt. */
  name: string;
  parentId: string | null;
  mimeType: string | null;
  plaintextSizeBytes: number;
}

const uploadResumeFileKey = (fileId: string) => `beebeeb_upload_resume_file_${fileId}`

// One write per (fileId, resumeKey) attempt — the per-chunk persist calls
// otherwise fire on every chunk, and SecureStore writes are Keychain writes.
const resumeIndexWritten = new Set<string>();

function saveUploadResumeIndexEntrySoon(
  fileId: string | undefined,
  resumeKey: string | undefined,
  meta: { sourceUri?: string; name?: string; mimeType?: string | null } | undefined,
  info: { parentId?: string | null; plaintextSizeBytes: number },
): void {
  if (!fileId || !resumeKey || !meta?.sourceUri || !meta.name) return;
  const memoKey = `${fileId}:${resumeKey}`;
  if (resumeIndexWritten.has(memoKey)) return;
  resumeIndexWritten.add(memoKey);
  const entry: UploadResumeInfo = {
    fileId,
    resumeKey,
    sourceUri: meta.sourceUri,
    name: meta.name,
    parentId: info.parentId ?? null,
    // The CALLER's mime type (encryptedUpload's opts.mimeType), NOT the
    // chunked-level one (always undefined there — MIME is encrypted inside
    // name_encrypted). The re-run hashes this value into the resumeKey, so it
    // must round-trip exactly or the resume state is never found.
    mimeType: meta.mimeType ?? null,
    plaintextSizeBytes: info.plaintextSizeBytes,
  };
  void tokenStore.set(uploadResumeFileKey(fileId), JSON.stringify(entry)).catch(() => {});
}

/** Resume pointer for a pending-upload row, or null (never throws). */
export async function getUploadResumeForFile(fileId: string): Promise<UploadResumeInfo | null> {
  if (!fileId) return null;
  try {
    const raw = await tokenStore.get(uploadResumeFileKey(fileId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UploadResumeInfo;
    if (!parsed || typeof parsed !== 'object' || !parsed.sourceUri || !parsed.resumeKey) {
      await tokenStore.remove(uploadResumeFileKey(fileId)).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the resume pointer (upload completed / placeholder discarded). */
export async function forgetUploadResume(fileId: string): Promise<void> {
  if (!fileId) return;
  await tokenStore.remove(uploadResumeFileKey(fileId)).catch(() => {});
  // Also drop this fileId's once-per-attempt memo entries: a LATER attempt of
  // the same file (same inputs → same resumeKey — e.g. a version-replace
  // retry) must be able to re-record the pointer after it was forgotten, or a
  // mid-upload failure of that retry would surface as unresumable.
  const prefix = `${fileId}:`;
  for (const memoKey of Array.from(resumeIndexWritten)) {
    if (memoKey.startsWith(prefix)) resumeIndexWritten.delete(memoKey);
  }
}

function forgetUploadResumeSoon(fileId: string | undefined): void {
  if (!fileId) return;
  void forgetUploadResume(fileId);
}

async function loadUploadResumeState(resumeKey: string): Promise<UploadResumeState | null> {
  const raw = await tokenStore.get(uploadResumeStoreKey(resumeKey))
  if (!raw) return null
  try {
    return JSON.parse(raw) as UploadResumeState
  } catch {
    await tokenStore.remove(uploadResumeStoreKey(resumeKey))
    return null
  }
}

async function saveUploadResumeState(resumeKey: string | undefined, state: UploadResumeState): Promise<void> {
  if (!resumeKey) return
  await tokenStore.set(uploadResumeStoreKey(resumeKey), JSON.stringify(state))
  // Task 1683f: keep the index in sync so the sign-out sweep can enumerate.
  await addToResumeIndex(resumeKey)
}

// Exported for encrypted-upload.ts (task 1683f): the abort listener clears the
// persisted resume state the moment trash aborts the in-flight engine.
export async function clearUploadResumeState(resumeKey: string | undefined): Promise<void> {
  if (!resumeKey) return
  await tokenStore.remove(uploadResumeStoreKey(resumeKey))
  await removeFromResumeIndex(resumeKey)
}

function saveUploadResumeStateSoon(resumeKey: string | undefined, state: UploadResumeState): void {
  void saveUploadResumeState(resumeKey, state).catch(() => {})
}

function clearUploadResumeStateSoon(resumeKey: string | undefined): void {
  void clearUploadResumeState(resumeKey).catch(() => {})
}

function estimateUploadedBytes(chunksUploaded: number, chunkSizeBytes: number, plaintextSizeBytes: number): number {
  if (chunksUploaded <= 0) return 0
  const plaintextUploaded = Math.min(plaintextSizeBytes, chunksUploaded * chunkSizeBytes)
  return plaintextUploaded + chunksUploaded * 28
}

async function uploadFileChunked(
  metadata: { name_encrypted: string; parent_id?: string; mime_type?: string; size_bytes: number },
  fileBlob: Blob,
  onProgress?: (progress: UploadProgress) => void,
): Promise<FileEntry> {
  // Task 1594 round 3 (T5): snapshot the session at this upload's own start —
  // see `endSessionForAccountMismatch`.
  const authSnapshot = await captureRequestAuthSnapshot();
  const token = authSnapshot.token;
  const totalSize = fileBlob.size;
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);

  onProgress?.({ phase: 'preparing', chunksTotal: chunkCount, chunksUploaded: 0, bytesTotal: totalSize, bytesUploaded: 0 });

  // Step 1: Init upload — server creates the file record
  // MIME type is encrypted inside name_encrypted; the server has no
  // plaintext mime_type column.
  const initRes = await rateLimitedFetch(`${BASE_URL}/api/v1/files/upload/init`, {
    method: 'POST',
    // Writer-provenance headers (task 1436) — this call creates the
    // object_versions row the server records them on.
    headers: { Authorization: `Bearer ${token}`, ...expectedUserHeaders(), 'Content-Type': 'application/json', ...mobileClientHeaders(), ...(await uploadDeviceHeader()) },
    body: JSON.stringify({
      name_encrypted: metadata.name_encrypted,
      parent_id: metadata.parent_id ?? null,
      size_bytes: metadata.size_bytes,
      chunk_count: chunkCount,
    }),
  });
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({ error: initRes.statusText }));
    // Task 1594 round 2 (F5) / round 3 (T5): route account_mismatch the same
    // as request(), guarded against a session that has since moved on.
    await throwUploadError(initRes.status, err, initRes.statusText, authSnapshot);
  }
  const { file_id } = (await initRes.json()) as { file_id: string; chunk_count: number };

  // Step 2: Upload each chunk sequentially
  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunk = fileBlob.slice(start, end);

    const chunkRes = await rateLimitedFetch(`${BASE_URL}/api/v1/files/${file_id}/chunks/${i}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, ...expectedUserHeaders(), 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    if (!chunkRes.ok) {
      const err = await chunkRes.json().catch(() => ({ error: chunkRes.statusText }));
      // Task 1594 round 2 (F5) / round 3 (T5): see the sibling chunk-upload
      // path above.
      await throwUploadError(chunkRes.status, err, `Chunk ${i} upload failed`, authSnapshot);
    }

    onProgress?.({
      phase: 'uploading',
      chunksTotal: chunkCount,
      chunksUploaded: i + 1,
      bytesTotal: totalSize,
      bytesUploaded: end,
    });
    if (i + 1 < chunkCount) {
      await uploadPaceDelay();
    }
  }

  // Step 3: Complete upload — server finalizes the file
  onProgress?.({ phase: 'finalizing', chunksTotal: chunkCount, chunksUploaded: chunkCount, bytesTotal: totalSize, bytesUploaded: totalSize });

  const completeRes = await rateLimitedFetch(`${BASE_URL}/api/v1/files/${file_id}/upload/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...expectedUserHeaders(), 'Content-Type': 'application/json', ...(await uploadDeviceHeader()) },
    body: JSON.stringify({}),
  });
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({ error: completeRes.statusText }));
    // Task 1594 round 2 (F5) / round 3 (T5): route account_mismatch the same
    // as request(), guarded against a session that has since moved on.
    await throwUploadError(completeRes.status, err, 'Failed to finalize upload', authSnapshot);
  }
  return completeRes.json() as Promise<FileEntry>;
}

export type ThumbnailVariant = 'small' | 'medium' | 'large';

/** Returns the authenticated thumbnail endpoint URL for a file. */
export function thumbnailUrl(fileId: string, variant: ThumbnailVariant = 'medium'): string {
  const suffix = variant === 'medium' ? '' : `/${variant}`;
  return `${BASE_URL}/api/v1/files/${fileId}/thumbnail${suffix}`;
}

/**
 * Upload a thumbnail blob for a file. Server caps payloads at 512KB.
 * Best-effort: callers should fire-and-forget so a failed thumbnail
 * never blocks the upload success flow.
 *
 * `blurhash`, when provided, is attached as a query param so the server
 * can store it on `files.blurhash` in the same DB write (task 0552).
 * Only the medium variant carries a blurhash — the placeholder is
 * variant-agnostic.
 */
export async function uploadThumbnail(
  fileId: string,
  bytes: Uint8Array,
  variant: ThumbnailVariant = 'medium',
  blurhash?: string | null,
): Promise<void> {
  // Task 1594 round 3 (T5): snapshot the session at this upload's own start —
  // see `endSessionForAccountMismatch`.
  const authSnapshot = await captureRequestAuthSnapshot();
  const token = authSnapshot.token;
  let url = thumbnailUrl(fileId, variant);
  if (blurhash && variant === 'medium') {
    url += `?blurhash=${encodeURIComponent(blurhash)}`;
  }
  const res = await putBinaryBytes(url, token, bytes);
  if (!res.ok) {
    const err = await res.error().catch(() => ({ error: undefined }));
    // Task 1594 round 2 (F5) / round 3 (T5): route account_mismatch the same
    // as request(), guarded against a session that has since moved on.
    await throwUploadError(res.status, { error: err.error, message: undefined }, `Thumbnail upload failed (HTTP ${res.status})`, authSnapshot);
  }
}

/**
 * GET /api/v1/files/photo-backup/identifiers — task 0552.
 * Returns the full file_id → local_identifier map for the authenticated
 * user. The mobile client uses this to short-circuit thumbnail rendering
 * for camera-roll-backed photos.
 */
export async function fetchPhotoBackupIdentifierMap(): Promise<Record<string, string>> {
  const data = await request<{ identifiers?: Record<string, string> }>(
    'GET',
    '/api/v1/files/photo-backup/identifiers',
  );
  return data.identifiers ?? {};
}

/**
 * POST /api/v1/files/:fileId/photo-backup/clear-association — Plan A.
 *
 * Scoped to (user_id, device_id, file_id). The server uses the
 * X-Beebeeb-Device-Id header to delete only this device's association,
 * leaving other devices' associations for the same file intact.
 *
 * Called by `local-identifier-map.ts:removeLocalIdentifier` when the native
 * ThumbnailService reports a PhotoKit miss via `onAssociationCleared`.
 *
 * Depends on Plan A: `clear_photo_backup_association` handler in
 * `repos/server/beebeeb-api/src/routes/files.rs`.
 */
export async function photoBackupClearAssociation(fileId: string): Promise<void> {
  const deviceId = await getDeviceId();
  await request<void>(
    'POST',
    `/api/v1/files/${fileId}/photo-backup/clear-association`,
    {},
    true,
    { 'X-Beebeeb-Device-Id': deviceId },
  );
}

export async function downloadFile(id: string): Promise<Response> {
  const token = await getToken();
  const res = await rateLimitedFetch(`${BASE_URL}/api/v1/files/${id}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, 'Download failed');
  }
  return res;
}

export async function deleteFile(id: string): Promise<void> {
  await request('DELETE', `/api/v1/files/${id}`);
}

export interface BulkTrashResult {
  trashed: string[];
  already_trashed: string[];
  missing: string[];
}

export async function trashFiles(ids: string[]): Promise<BulkTrashResult> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    return { trashed: [], already_trashed: [], missing: [] };
  }

  try {
    return await request<BulkTrashResult>('POST', '/api/v1/files/trash', { ids: uniqueIds });
  } catch (err) {
    if (err instanceof ApiError && [400, 404, 405].includes(err.status)) {
      // Legacy fallback: no bulk endpoint, so delete each file individually.
      // Reconcile per-item with allSettled — a single failure must not abandon
      // the rest of the batch (Promise.all) nor let us claim the whole batch was
      // trashed. Report exactly which ids landed (trashed), which were already
      // gone (404 -> missing, matching the bulk endpoint's contract), and which
      // genuinely failed (also surfaced as missing so callers refresh/retry).
      const settled = await Promise.allSettled(uniqueIds.map((id) => deleteFile(id)));
      const trashed: string[] = [];
      const missing: string[] = [];
      const hardErrors: unknown[] = [];
      settled.forEach((outcome, i) => {
        const id = uniqueIds[i];
        if (outcome.status === 'fulfilled') {
          trashed.push(id);
        } else if (outcome.reason instanceof ApiError && outcome.reason.status === 404) {
          missing.push(id);
        } else {
          missing.push(id);
          hardErrors.push(outcome.reason);
        }
      });
      // Nothing succeeded and every failure was a real error (e.g. offline / 5xx):
      // surface it instead of masking an outage as "some items already gone".
      if (trashed.length === 0 && hardErrors.length === uniqueIds.length) {
        throw hardErrors[0];
      }
      return { trashed, already_trashed: [], missing };
    }
    throw err;
  }
}

export async function renameFile(id: string, newName: string): Promise<void> {
  await request('PATCH', `/api/v1/files/${id}`, { name_encrypted: newName });
}

export async function moveFile(fileId: string, newParentId: string | null): Promise<void> {
  await request('PATCH', `/api/v1/files/${fileId}`, { parent_id: newParentId });
}

export async function restoreFile(id: string): Promise<void> {
  await request('POST', `/api/v1/files/${id}/restore`);
}

export async function permanentDeleteFile(id: string, confirmToken?: string): Promise<void> {
  await request(
    'DELETE',
    `/api/v1/files/${id}/permanent`,
    undefined,
    true,
    confirmToken ? { 'X-Confirm-Token': confirmToken } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Proof of Existence
// ---------------------------------------------------------------------------

/**
 * A timestamp-verifiable proof that a specific file existed at a specific moment,
 * without revealing the file's content. The server stores `hash` (SHA-256 of the
 * encrypted blob) + `timestamp`; anyone with the `proofId` can verify both later.
 */
export interface ProofOfExistence {
  hash: string;
  timestamp: string;
  proofId: string;
}

export async function createProofOfExistence(fileId: string): Promise<ProofOfExistence> {
  return request<ProofOfExistence>('POST', `/api/v1/files/${fileId}/proof`);
}

export async function getProofOfExistence(fileId: string): Promise<ProofOfExistence | null> {
  try {
    return await request<ProofOfExistence>('GET', `/api/v1/files/${fileId}/proof`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export interface Share {
  id: string;
  token: string;
  url: string;
  expires_at: string | null;
  max_opens: number | null;
  /** True when the share was created in double-encrypted mode. */
  double_encrypted?: boolean;
}

/** Rich share link item returned by `GET /api/v1/shares/mine`. */
export interface MyShareLink {
  id: string;
  file_id: string;
  token: string;
  url: string;
  expires_at: string | null;
  max_opens: number | null;
  open_count: number;
  download_count: number;
  last_opened_at: string | null;
  has_passphrase: boolean;
  revoked: boolean;
  created_at: string;
  /**
   * 0709 A+ owner-recoverable blobs (base64). Present for shares created with
   * the owner-recoverable flow; NULL for legacy / pre-0709 shares (incl. older
   * mobile-created links) — those are genuinely unrecoverable, so the UI offers
   * "revoke & recreate" rather than fabricating a link. The server stores these
   * opaque and never unwraps them.
   */
  owner_wrapped_key?: string | null;
  owner_wrapped_token?: string | null;
  file: {
    name_encrypted: string;
    size_bytes: number;
    /** @deprecated dropped server-side — always undefined now. */
    mime_type?: string | null;
  };
}

export interface ShareCreateOpts {
  expires_in_hours?: number;
  max_opens?: number;
  passphrase?: string;
  /**
   * Double-encrypted mode: base64(nonce(12) || AES-256-GCM-ciphertext(48)) = 80 chars.
   * When set, the server stores this opaque blob. The client key K_c lives only in
   * the URL fragment (#key=…) and is never sent to the server.
   */
  wrapped_file_key?: string;
  /**
   * 0709 A+ owner-recoverable share (all-or-nothing with the two wrapped blobs):
   * a client-generated raw token — URL-safe-no-pad base64 of 20 random bytes
   * (27 chars). The server validates + hashes it and uses it instead of
   * generating one. Omit all three for a legacy server-generated token; sending
   * only some of the three is a typed 400. Wire format matches the web client.
   */
  token?: string;
  /** base64(AES-256-GCM(masterKey, K_c)) — lets the OWNER re-copy a working link. */
  owner_wrapped_key?: string;
  /** base64(AES-256-GCM(masterKey, tokenUtf8)) — the raw token, wrapped for re-copy. */
  owner_wrapped_token?: string;
}

export async function createShare(
  fileId: string,
  opts?: ShareCreateOpts,
): Promise<Share> {
  return request<Share>('POST', '/api/v1/shares', { file_id: fileId, ...opts });
}

export async function listMyShares(): Promise<MyShareLink[]> {
  const data = await request<{ shares: MyShareLink[] }>('GET', '/api/v1/shares/mine');
  return data.shares ?? [];
}

/** One of the owner's active-key link shares of a file (`GET /api/v1/shares/by-file/:id`). */
export interface FileShareLink {
  id: string;
  created_at?: string;
  expires_at?: string | null;
}

/**
 * Task 1592 — the owner's link shares of ONE file (key present; the server
 * does not filter expired ones — see `countActiveShareLinks`). 404 when the
 * caller does not own the file.
 */
export async function listFileShareLinks(fileId: string): Promise<FileShareLink[]> {
  const data = await request<{ shares?: FileShareLink[] }>('GET', `/api/v1/shares/by-file/${fileId}`);
  return data.shares ?? [];
}

export interface SharingContact {
  user_id: string;
  email: string;
  username?: string | null;
  display_name?: string | null;
  x25519_public_key?: string | null;
}

export async function resolveSharingContact(query: string): Promise<SharingContact | null> {
  const data = await request<{ contact: SharingContact | null }>(
    'GET',
    `/api/v1/contacts/resolve?query=${encodeURIComponent(query)}`,
  );
  return data.contact ?? null;
}

export interface ShareInfo {
  token: string;
  /**
   * The file's encrypted metadata envelope (`{cipher_suite, nonce,
   * ciphertext}` under the FILE key) — the field the server actually sends on
   * GET /shares/:token and POST /shares/:token/verify. Decrypt with
   * `decryptShareFileName` (src/lib/share-file-name.ts).
   */
  name_encrypted?: string | null;
  /** Legacy client-side spelling the server never sends; read only as a fallback. */
  file_name_encrypted?: string;
  size_bytes?: number;
  mime_type?: string | null;
  sender_email?: string;
  expires_at?: string | null;
  /**
   * True when the share is passphrase-gated and the passphrase has not yet
   * been verified for this screen instance. The server's ONLY spelling for
   * this field is `requires_passphrase` (`repos/server/.../shares.rs`) — task
   * 1539 (finding 4): the client used to declare `passphrase_required`, a
   * field the server never sends, so the gate silently never rendered and
   * `/download` 401'd with no passphrase UI anywhere in the app.
   */
  requires_passphrase?: boolean;
  is_folder?: boolean;
  /**
   * True when the share was created in double-encrypted mode.
   * The #key= fragment in the URL holds K_c (not the file key directly).
   * The server stores an opaque wrapped_file_key blob.
   */
  double_encrypted?: boolean;
  /**
   * Base64-encoded wrapped file key (60 bytes: 12-byte AES-GCM nonce ||
   * 48-byte ciphertext). Only present when `double_encrypted` is true —
   * the recipient unwraps it with K_c (from the URL fragment) to recover
   * the actual file key.
   */
  wrapped_file_key?: string;
  /** Number of encrypted chunks the file was split into at upload. */
  chunk_count?: number;
}

/** Fetch public share metadata by token — no auth required. */
export async function getShareByToken(token: string): Promise<ShareInfo> {
  return request<ShareInfo>('GET', `/api/v1/shares/${token}`, undefined, false);
}

/**
 * Task 1539 (finding 4): every 401 the shares routes return — missing
 * `X-Share-Passphrase` header (shares.rs:1223-1227/1400s) or a wrong one
 * (`check_passphrase_with_lockout`'s `Err(ApiError::Unauthorized)`,
 * shares.rs:1975) — serializes to the SAME generic body,
 * `{"error":"unauthorized"}` (error.rs:668). Both call sites below forwarded
 * that raw string straight to the user (SharedViewScreen's catch only
 * rewrites `/CryptoError/i`), so a wrong or missing passphrase literally
 * showed the word "unauthorized". Every other status this function can see
 * (404/410/403/429/500) already carries a real, specific server message, so
 * this only remaps 401 — the one status shares.rs uses exclusively for the
 * passphrase gate.
 */
function shareAuthErrorMessage(status: number, rawMessage: string): string {
  if (status === 401) return 'Incorrect passphrase. Check it and try again.';
  return rawMessage;
}

/**
 * Verify a share's passphrase and, on success, receive the full share
 * metadata the server withholds until the passphrase is confirmed (the GET
 * above returns only `{id, share_type, requires_passphrase: true,
 * expires_at}` for a gated share — no name, size, or wrapped key). Mirrors
 * the web client's `verifySharePassphrase` (`repos/web/src/lib/api.ts`) and
 * the server's `POST /api/v1/shares/:token/verify`. Public endpoint — no
 * auth header required.
 */
export async function verifySharePassphrase(token: string, passphrase: string): Promise<ShareInfo> {
  let res: Response;
  try {
    res = await rateLimitedFetch(`${BASE_URL}/api/v1/shares/${token}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // message-over-error precedence matches task 1540's convention (PR #108,
    // request()/downloadSharedFileBlob) — see the comment there.
    const raw = err.message ?? err.error ?? `Passphrase verification failed: ${res.status}`;
    throw new ApiError(res.status, shareAuthErrorMessage(res.status, raw));
  }
  return res.json() as Promise<ShareInfo>;
}

/**
 * Download the raw encrypted bytes of a shared file. Public endpoint — no
 * auth header required. The optional passphrase is forwarded as
 * `X-Share-Passphrase` for passphrase-protected shares.
 *
 * Returns the encrypted body plus authoritative chunk metadata from the
 * response headers. Callers feed these into `decryptEncryptedBytes` along
 * with the file key derived from the share's URL fragment.
 */
export async function downloadSharedFileBlob(
  token: string,
  passphrase?: string,
): Promise<{
  encryptedBytes: Uint8Array;
  chunkCount: number | null;
  chunkSize: number | null;
  originalSize: number | null;
}> {
  const headers: Record<string, string> = {};
  if (passphrase) headers['X-Share-Passphrase'] = passphrase;

  let res: Response;
  try {
    res = await rateLimitedFetch(`${BASE_URL}/api/v1/shares/${token}/download`, { headers });
  } catch (_err) {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Task 1540 continuation (PR #108): prefer the server's human-readable
    // `message` over the machine `error` code, same as request() (finding
    // 7) — this direct-fetch path had the two swapped. Task 1539 (finding
    // 4): still remap 401 specifically — shares.rs's ONLY message for a 401
    // here is the generic `"unauthorized"`, which is neither field's fault
    // to prefer, so shareAuthErrorMessage still overrides it either way.
    const raw = err.message ?? err.error ?? `Share download failed: ${res.status}`;
    throw new ApiError(res.status, shareAuthErrorMessage(res.status, raw));
  }

  const arrayBuf = await res.arrayBuffer();
  const encryptedBytes = new Uint8Array(arrayBuf);

  const parseHeaderInt = (name: string): number | null => {
    const v = res.headers.get(name);
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  return {
    encryptedBytes,
    chunkCount: parseHeaderInt('X-Chunk-Count'),
    chunkSize: parseHeaderInt('X-Chunk-Size'),
    originalSize: parseHeaderInt('X-Original-Size'),
  };
}

// ---------------------------------------------------------------------------
// Share invites
// ---------------------------------------------------------------------------

export interface ShareInvite {
  id: string;
  file_id: string;
  sender_id: string;
  recipient_email: string;
  status: string;
  created_at: string;
  claimed_at?: string;
  approved_at?: string;
  file_name_encrypted?: string;
  sender_email?: string;
  sender_public_key?: string;
  recipient_public_key?: string;
  can_reshare?: boolean;
  expires_at?: string | null;
  size_bytes?: number;
  is_folder?: boolean;
  chunk_count?: number;
  mime_type?: string;
  encrypted_file_key?: string;
  is_folder_share?: boolean;
  encrypted_folder_key?: string;
  encrypted_owner_folder_key?: string;
}

export interface CreateInviteResponse {
  invite_id: string;
  status: string;
  recipient_public_key?: string | null;
  is_folder_share?: boolean;
}

export async function createInvite(
  fileId: string,
  recipientEmail: string,
): Promise<CreateInviteResponse> {
  return request<CreateInviteResponse>('POST', '/api/v1/shares/invites', {
    file_id: fileId,
    recipient_email: recipientEmail,
  });
}

export async function approveInvite(inviteId: string, encryptedFileKey: string): Promise<void> {
  await request('POST', `/api/v1/shares/invites/${inviteId}/approve`, {
    encrypted_file_key: encryptedFileKey,
  });
}

export async function getIncomingInvites(): Promise<ShareInvite[]> {
  const data = await request<{ invites: ShareInvite[] }>('GET', '/api/v1/shares/invites/incoming');
  return data.invites ?? [];
}

export async function getSentInvites(): Promise<ShareInvite[]> {
  const data = await request<{ invites: ShareInvite[] }>('GET', '/api/v1/shares/invites/sent');
  return data.invites ?? [];
}

// ---------------------------------------------------------------------------
// Folder presence (collaborators currently viewing a folder)
// ---------------------------------------------------------------------------

export interface PresenceUser {
  id: string;
  email: string;
  initials: string;
}

/**
 * Returns the list of users currently active in a shared folder.
 * The endpoint is best-effort — returns an empty list if it is unavailable
 * (e.g. server has not been upgraded yet, or the folder is not shared).
 */
export async function getFolderPresence(folderId: string): Promise<PresenceUser[]> {
  return request<PresenceUser[]>('GET', `/api/v1/files/${folderId}/presence`).catch(() => []);
}

// ---------------------------------------------------------------------------
// Storage usage
// ---------------------------------------------------------------------------

export interface StorageUsage {
  used_bytes: number;
  plan_limit_bytes: number;
  plan_name: string;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  return request<StorageUsage>('GET', '/api/v1/files/usage');
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function getPreference(key: string): Promise<string | null> {
  try {
    const data = await request<{ key: string; value: string }>('GET', `/api/v1/preferences/${key}`);
    return data.value ?? null;
  } catch {
    return null;
  }
}

export async function setPreference(key: string, value: string): Promise<void> {
  await request('PUT', `/api/v1/preferences/${key}`, { value });
}

// ---------------------------------------------------------------------------
// Billing / subscription
// ---------------------------------------------------------------------------

export interface Subscription {
  plan: string;
  billing_cycle: string | null;
  seats?: number;
  region?: string;
  status: string;
  current_period_end: string | null;
  /**
   * Set only while `status === 'trialing'` (server `trial.rs::start_trial`).
   * Equal to `current_period_end` for a trialing row today, but carried
   * separately so a trial-specific UI (task 1540) doesn't have to assume
   * that equality holds forever.
   */
  trial_ends_at?: string | null;
  is_mock?: boolean;
  quota_bytes?: number;
  used_bytes?: number;
  /**
   * Additive field (task 1601, server half) — the plan this user is
   * ENTITLED to right now, with subscription status already applied
   * (`'cancelled'` → `'free'`, `'cancelling'` → the paid plan, …). Absent on
   * older server responses mid-rollout — `effective-plan.ts`'s
   * `effectivePlan()` derives the same value client-side when it's missing.
   * Never read `.plan` directly to decide what to show a user; read
   * `effectivePlan(subscription)` instead.
   */
  effective_plan?: string | null;
  /**
   * Additive fields (task 1037, server half). Older servers leave them out,
   * which reads as `ok` / null / false. See `account-state.ts`.
   *  - `account_state`: `ok` | `needs_plan` | `lapsed`.
   *  - `data_deletion_at`: set only for `lapsed`.
   *  - `trial_auto_converts`: a trialing row with a payment mandate that
   *    becomes the paid plan by itself at `trial_ends_at`.
   * For `needs_plan` and `lapsed`, `effective_plan` is `'none'`.
   */
  account_state?: string | null;
  data_deletion_at?: string | null;
  trial_auto_converts?: boolean | null;
  /**
   * Additive fields (task 1605, server PR #129). See account-state.ts's
   * `AccountStateFields` doc for `uploads_blocked_at`/`access_until`.
   *  - `trial_storage_cap_bytes`: non-null only while an active mandated
   *    trial (`trial_auto_converts: true`) has never had a successful
   *    charge — the quota is capped at this many bytes (25 GB) until then.
   *    No in-app action to raise it early (task 1400, App Review 3.1.1(a) —
   *    no IAP): informational only, same as every other plan fact on this
   *    screen. See DEVIATIONS.md → "Task 1605".
   */
  uploads_blocked_at?: string | null;
  access_until?: string | null;
  trial_storage_cap_bytes?: number | null;
}

export async function getSubscription(): Promise<Subscription | null> {
  try {
    const data = await request<{ subscription?: Subscription | null } | Subscription>('GET', '/api/v1/billing/subscription');
    if (Object.prototype.hasOwnProperty.call(data, 'subscription')) {
      return (data as { subscription?: Subscription | null }).subscription ?? null;
    }
    return data as Subscription;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface Region {
  region: string;
  operator: string;
  jurisdiction: string;
  /** The default pool's city ("Falkenstein") — the server's documented
   * source for "stored in {city}" (server routes/health.rs `region`). */
  city?: string | null;
}

export async function getRegion(): Promise<Region> {
  return request<Region>('GET', '/api/v1/region', undefined, false);
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/** Returns the authenticated download URL for use with expo-file-system. */
export function getDownloadUrl(id: string): string {
  return `${BASE_URL}/api/v1/files/${id}/download`;
}

// ---------------------------------------------------------------------------
// Base64 helpers for binary transport
// ---------------------------------------------------------------------------

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// OPAQUE authentication
// ---------------------------------------------------------------------------

export interface OpaqueLoginStartResult {
  state: Uint8Array;
  serverMessage: Uint8Array;
  serverState: string;
  /**
   * The account's OPAQUE KSF version, forwarded by /opaque/login-start.
   * 0 = legacy Identity KSF (no client stretch), 1 = Argon2id. Must be passed
   * to opaqueLoginFinish so the WASM/UniFFI finish stretches with the matching
   * KSF — otherwise a v0 (legacy) account's fresh login fails.
   */
  ksf_version: number;
}

export interface OpaqueLoginResult {
  sessionToken: string;
}

/** Sentinel thrown when OPAQUE can't run because the native crypto module is absent. */
export class NativeCryptoUnavailableError extends Error {
  readonly code = 'NATIVE_CRYPTO_UNAVAILABLE' as const;
  constructor(method: string) {
    super(`Native crypto module not available — cannot run ${method}. Use plain auth fallback.`);
    this.name = 'NativeCryptoUnavailableError';
  }
}

/**
 * Round 1 of OPAQUE login.
 * Throws ApiError with status 404 when server does not support OPAQUE — caller
 * should fall back to the legacy /auth/login endpoint.
 * Throws NativeCryptoUnavailableError when running in Expo Go without the
 * native module — caller should fall back to plain login().
 */
export async function opaqueLoginStart(email: string, password: string): Promise<OpaqueLoginStartResult> {
  if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueLoginStart');
  let state: Uint8Array;
  let message: Uint8Array;
  try {
    ({ state, message } = await BeebeebCrypto.opaqueLoginStart(email, password));
  } catch (err) {
    if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueLoginStart');
    // Task 1709 — the raw native (UniFFI) error text is internal and must not
    // reach the sign-in screen. login-start never validates the password (the
    // server mints a decoy challenge even for unknown emails), so this is
    // never a wrong-password case — surface an honest client-side line.
    throw new ApiError(500, 'Sign-in could not start. Please try again in a moment.');
  }
  let data: { server_message: string; server_state: string; ksf_version: number };
  try {
    data = await request<{ server_message: string; server_state: string; ksf_version: number }>(
      'POST',
      '/api/v1/opaque/login-start',
      { email, client_message: uint8ToBase64(message) },
      false,
    );
  } catch (err) {
    throw err;
  }
  return {
    state,
    serverMessage: base64ToUint8(data.server_message),
    serverState: data.server_state,
    // Default to 1 (Argon2id) if a stale server omits the field, matching the
    // current client KSF — only a v0 account needs the explicit 0.
    ksf_version: typeof data.ksf_version === 'number' ? data.ksf_version : 1,
  };
}

/**
 * Round 2 of OPAQUE login.
 * Returns the session token. The OPAQUE session key is not the vault key;
 * the vault key must come from the 12-word recovery phrase or keychain.
 */
export async function opaqueLoginFinish(
  email: string,
  password: string,
  state: Uint8Array,
  serverMessage: Uint8Array,
  serverState: string,
  ksfVersion: number,
): Promise<OpaqueLoginResult> {
  if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueLoginFinish');
  let message: Uint8Array;
  try {
    ({ message } = await BeebeebCrypto.opaqueLoginFinish(state, serverMessage, password, ksfVersion));
  } catch (err) {
    if (!BeebeebCrypto.isNativeAvailable) throw new NativeCryptoUnavailableError('opaqueLoginFinish');
    // Task 1709 — a WRONG password fails HERE, client-side, when the native
    // finish verifies the server MAC; the raw UniFFI error text is internal.
    // Map to the same 401 copy the server paths produce — exactly what
    // confirmAction does for its own native finish (IncorrectPasswordError
    // precedent). login-finish never reports anything else the user could
    // act on differently.
    throw new ApiError(401, 'Wrong email or password.');
  }
  let data: {
    session_token?: string;
    device_confirmation_secret?: string;
    requires_2fa?: boolean;
    partial_token?: string;
  };
  try {
    data = await request<{
      session_token?: string;
      device_confirmation_secret?: string;
      requires_2fa?: boolean;
      partial_token?: string;
    }>(
      'POST',
      '/api/v1/opaque/login-finish',
      {
        email,
        client_message: uint8ToBase64(message),
        server_state: serverState,
      },
      false,
      mobileClientHeaders(),
    );
  } catch (err) {
    throw err;
  }
  // Server returns { requires_2fa, partial_token } when TOTP is enabled.
  // In that case we don't have a session yet — caller navigates to the 2FA
  // challenge screen.
  if (data.requires_2fa) {
    const partial = data.partial_token;
    if (typeof partial !== 'string' || partial.length === 0) {
      throw new ApiError(500, 'Server signalled requires_2fa without a partial token');
    }
    throw new TwoFactorRequiredError(partial);
  }
  if (typeof data.session_token !== 'string' || data.session_token.length === 0) {
    throw new ApiError(500, 'Server returned no session token');
  }
  await setSessionCredentials(data.session_token, data.device_confirmation_secret);
  return { sessionToken: data.session_token };
}

/**
 * Complete 2FA challenge. Exchanges the partial_token from a `requires_2fa`
 * response (from either legacy login or opaque login-finish) for a real
 * session token. Server endpoint: POST /api/v1/auth/2fa/verify.
 *
 * `code` is either the 6-digit TOTP code OR a backup code. Server treats
 * both the same way — try TOTP first, fall back to backup code list.
 */
export async function completeTwoFactor(
  partialToken: string,
  code: string,
): Promise<{ sessionToken: string }> {
  let data: { user_id: string; session_token: string; salt?: string };
  try {
    data = await request<{ user_id: string; session_token: string; salt?: string }>(
      'POST',
      '/api/v1/auth/2fa/verify',
      { partial_token: partialToken, code },
      false,
      mobileClientHeaders(),
    );
  } catch (err) {
    // This is an auth=false call, so request() maps a 401 to the login copy
    // ("Wrong email or password."). Here a 401 means the TOTP/backup code was
    // wrong or expired — surface code-specific copy for the 2FA screen.
    if (err instanceof ApiError && err.status === 401) {
      throw new ApiError(401, 'Incorrect or expired code. Try again.');
    }
    throw err;
  }
  if (typeof data.session_token !== 'string' || data.session_token.length === 0) {
    throw new ApiError(500, 'Server returned no session token');
  }
  // No device_confirmation_secret on the 2FA path — server doesn't issue
  // one. Trash device-owner auth will require a re-confirmation later.
  await setSessionCredentials(data.session_token, undefined);
  return { sessionToken: data.session_token };
}

// ---------------------------------------------------------------------------
// Onboarding document + native signup (task 1746)
// Spec: docs/specs/2026-10-04-backend-driven-onboarding.md sections 5.2, 5.9
// ---------------------------------------------------------------------------

/**
 * Headers every onboarding / signup call carries. `X-Beebeeb-Onboarding-Schema`
 * is what lets a store build past the 403 `signup_web_only` product gate once the
 * server's matrix row for `mobile-ios` is `native` (spec 5.8 rule 8); an old build
 * without it keeps getting the 403. Self-declared, so a product gate, not a
 * security control: account creation is protected by the ticket, limiter and
 * pilot gate on the server regardless.
 */
function onboardingHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(mobileClientHeaders() ?? {}),
    ...(Platform.OS === 'ios' ? { 'X-Beebeeb-Client-OS': 'ios' } : {}),
    'X-Beebeeb-Onboarding-Schema': ONBOARDING_SCHEMA_HEADER,
    ...(extra ?? {}),
  };
}

/**
 * `GET /api/v1/onboarding`. Optional Bearer: without a session the server answers
 * the `pre_account` form, with one the `account` form. Returns the raw JSON; the
 * tolerant parser in `./onboarding/parse` decides what it means. Throws ApiError
 * (404 on an old server: the caller falls back to the legacy account-state logic,
 * spec 5.8 rule 6).
 */
export async function fetchOnboardingRaw(signedIn: boolean): Promise<unknown> {
  return request<unknown>('GET', '/api/v1/onboarding', undefined, signedIn, onboardingHeaders());
}

/** Pilot access key header, only when the document says one is required. */
function pilotHeader(pilotKey?: string): Record<string, string> | undefined {
  return pilotKey ? { 'X-Beebeeb-Pilot-Key': pilotKey } : undefined;
}

/**
 * `POST /api/v1/auth/signup/email-start`. Answers 202 identically for every
 * address (anti-enumeration): a new address is mailed an 8-digit code, an existing
 * one a "you already have an account" notice. The client cannot tell which, so it
 * must never try to (spec 5.9).
 */
export async function signupEmailStart(email: string, pilotKey?: string): Promise<void> {
  await request<unknown>('POST', '/api/v1/auth/signup/email-start', { email }, false, onboardingHeaders(pilotHeader(pilotKey)));
}

/** `POST /api/v1/auth/signup/email-verify`: the code for a single-use `signup_ticket`. */
export async function signupEmailVerify(email: string, code: string): Promise<string> {
  const data = await request<{ signup_ticket?: string }>('POST', '/api/v1/auth/signup/email-verify', { email, code }, false, onboardingHeaders());
  if (typeof data?.signup_ticket !== 'string' || data.signup_ticket.length === 0) {
    throw new ApiError(500, 'Server returned no signup ticket');
  }
  return data.signup_ticket;
}

/** `POST /api/v1/opaque/register-start`: OPAQUE round 1, from the ceremony. Returns the server message. */
export async function signupRegisterStart(input: {
  email: string;
  ticket: string;
  clientMessage: Uint8Array;
  pilotKey?: string;
}): Promise<Uint8Array> {
  const data = await request<{ server_message: string }>(
    'POST',
    '/api/v1/opaque/register-start',
    { email: input.email, client_message: uint8ToBase64(input.clientMessage), signup_ticket: input.ticket },
    false,
    onboardingHeaders(pilotHeader(input.pilotKey)),
  );
  return base64ToUint8(data.server_message);
}

/**
 * `POST /api/v1/opaque/register-finish`: OPAQUE round 2 with the D12 recovery
 * binding and the Terms version shown. 201 creates the account AND a session,
 * which is stored here exactly like a login. `403 signup_ticket_invalid` (expired
 * or spent ticket) is `ApiError.code`; the caller returns to the code step.
 */
export async function signupRegisterFinish(input: {
  email: string;
  ticket: string;
  termsVersion: string;
  upload: Uint8Array;
  x25519Public: Uint8Array;
  recoveryCheck: Uint8Array;
  pilotKey?: string;
}): Promise<{ userId: string; sessionToken: string }> {
  const data = await request<{ user_id: string; session_token: string; device_confirmation_secret?: string }>(
    'POST',
    '/api/v1/opaque/register-finish',
    {
      email: input.email,
      client_message: uint8ToBase64(input.upload),
      x25519_public_key: uint8ToBase64(input.x25519Public),
      recovery_check: uint8ToBase64(input.recoveryCheck),
      signup_ticket: input.ticket,
      terms_version: input.termsVersion,
    },
    false,
    onboardingHeaders(pilotHeader(input.pilotKey)),
  );
  if (typeof data?.session_token !== 'string' || data.session_token.length === 0) {
    throw new ApiError(500, 'Server returned no session token');
  }
  await setSessionCredentials(data.session_token, data.device_confirmation_secret);
  return { userId: data.user_id, sessionToken: data.session_token };
}

/** `POST /api/v1/auth/verify-email`: the account-stage `verify_email` step. */
export async function verifyAccountEmail(code: string): Promise<void> {
  await request<unknown>('POST', '/api/v1/auth/verify-email', { code });
}

/** `POST /api/v1/auth/resend-verification`: a fresh code for the account-stage `verify_email` step (3 per hour). */
export async function resendAccountVerification(): Promise<void> {
  await request<unknown>('POST', '/api/v1/auth/resend-verification');
}

/** `POST /api/v1/account/terms-acceptance`: the account-stage `accept_terms` step (task 1740). */
export async function acceptTermsVersion(version: string): Promise<void> {
  await request<unknown>('POST', '/api/v1/account/terms-acceptance', { version });
}

const BREACH_TIMEOUT_MS = 6000;
const BREACH_MAX_BODY_BYTES = 256 * 1024;

/**
 * The one HTTP call the breach check leaves to the host: `GET` the same-origin
 * `policy.password.breach_check.endpoint` with the 5-hex-character prefix (never
 * the password, never the rest of the digest), to Beebeeb's own API. Returns the
 * response text of a 2xx answer, or null on ANY failure; core treats null as an
 * outage and applies the document's `fail_open`. A body over 256 KiB is an outage.
 */
export async function fetchBreachRange(endpointTemplate: string, prefix: string): Promise<string | null> {
  const path = sameOriginPath(endpointTemplate);
  if (!path || !/^[0-9A-F]{5}$/.test(prefix)) return null;
  const url = `${BASE_URL}${path.replace('{prefix}', prefix)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BREACH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: onboardingHeaders() });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > BREACH_MAX_BODY_BYTES) return null;
    const text = await res.text();
    return text.length > BREACH_MAX_BODY_BYTES ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Sync engine (CRDT op log + SSE)
// Spec: docs/superpowers/specs/2026-05-02-crdt-sync-engine-design.md
// ---------------------------------------------------------------------------

export interface SyncNode {
  id: string;
  name_encrypted: string;
  parent_id: string | null;
  is_folder: boolean;
  is_uploading?: boolean;
  size_bytes: number;
  /** @deprecated dropped server-side — always undefined now. */
  mime_type?: string | null;
  content_hash: string | null;
  version_number: number;
  has_thumbnail: boolean;
  storage_pool_id: string | null;
  is_trashed: boolean;
  is_starred: boolean;
  chunk_count?: number;
  created_at: string;
  updated_at: string;
}

export interface SyncOp {
  seq_id: number;
  op_type: string;
  client_op_id?: string;
  payload: Record<string, unknown>;
  device_id?: string;
  created_at: string;
}

export interface SyncSnapshot {
  seq_id: number;
  nodes: SyncNode[];
}

export interface SubmittedSyncOp {
  client_op_id: string;
  op_type: string;
  payload: Record<string, unknown>;
  device_id?: string;
}

export interface SyncOpsResult {
  applied: { seq_id: number; client_op_id: string }[];
  rejected: {
    client_op_id: string;
    reason: string;
    winning_op?: { op_type: string; payload: Record<string, unknown> };
  }[];
}

export interface StreamTokenResponse {
  stream_token: string;
  expires_at: string;
}

export async function getSnapshot(): Promise<SyncSnapshot> {
  return request<SyncSnapshot>('GET', '/api/v1/sync/snapshot');
}

export async function getSyncOps(since: number): Promise<SyncOp[]> {
  const data = await request<{ ops: SyncOp[] }>(
    'GET',
    `/api/v1/sync/ops?since=${encodeURIComponent(String(since))}`,
  );
  return data.ops ?? [];
}

export async function submitSyncOps(ops: SubmittedSyncOp[]): Promise<SyncOpsResult> {
  return request<SyncOpsResult>('POST', '/api/v1/sync/ops', { ops });
}

export async function getStreamToken(): Promise<StreamTokenResponse> {
  return request<StreamTokenResponse>('POST', '/api/v1/sync/stream-token');
}

export interface UploadStatus {
  file_id: string;
  chunk_count: number;
  uploaded_chunks: number[];
  missing_chunks: number[];
  is_uploading: boolean;
}

export async function getUploadStatus(fileId: string): Promise<UploadStatus> {
  return request<UploadStatus>('GET', `/api/v1/files/${encodeURIComponent(fileId)}/upload/status`);
}

// ---------------------------------------------------------------------------
// Photo backup
// ---------------------------------------------------------------------------

/** Ask the server which of these local identifiers have NOT been backed up yet. */
export async function photoBackupCheck(
  identifiers: string[],
): Promise<{ needs_backup: string[] }> {
  return request<{ needs_backup: string[] }>(
    'POST',
    '/api/v1/files/photo-backup/check',
    { identifiers },
  );
}

/** Mark a local asset as successfully backed up and link it to the uploaded file. */
export async function photoBackupMark(
  identifier: string,
  fileId: string,
): Promise<void> {
  await request<void>(
    'POST',
    '/api/v1/files/photo-backup/mark',
    { local_identifier: identifier, file_id: fileId },
  );
}

export interface PhotoBackupStats {
  backed_up: number;
  total_estimated: number;
  last_backup_at?: string | null;
  total_size_bytes?: number;
}

/** Get overall photo-backup progress stats for the current user. */
export async function photoBackupStats(): Promise<PhotoBackupStats> {
  const data = await request<{
    total_backed_up?: number;
    backed_up?: number;
    total_estimated?: number;
    last_backup_at?: string | null;
    total_size_bytes?: number;
  }>('GET', '/api/v1/files/photo-backup/stats');

  return {
    backed_up: data.backed_up ?? data.total_backed_up ?? 0,
    total_estimated: data.total_estimated ?? 0,
    last_backup_at: data.last_backup_at,
    total_size_bytes: data.total_size_bytes,
  };
}

/**
 * Fetch all backed-up local identifiers, paginated (1000 per page).
 * Client diffs against local camera roll — replaces batch checking.
 */
export async function photoBackupListIds(): Promise<Set<string>> {
  const allIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const params = new URLSearchParams({ limit: '1000' });
    if (cursor) params.set('cursor', cursor);

    const data = await request<{
      ids: string[];
      has_more: boolean;
      next_cursor: string | null;
    }>('GET', `/api/v1/files/photo-backup/ids?${params}`);

    for (const id of data.ids) allIds.add(id);

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return allIds;
}

// ─── Push notification registration ──────────────────────────────────────────

/** POST /api/v1/notifications/register-device */
export async function registerDeviceToken(params: {
  token: string;
  platform: 'ios' | 'android';
  device_id: string;
  /** Canonical client_devices UUID — links this push token to the device row so
   * "forget device" cascades it and per-device mute works. Optional: server
   * backfills by (user_id, platform) when absent. */
  client_device_id?: string;
}): Promise<void> {
  await request<void>('POST', '/api/v1/notifications/register-device', params);
}

/** DELETE /api/v1/notifications/unregister-device */
export async function unregisterDeviceToken(deviceId: string): Promise<void> {
  await request<void>('DELETE', '/api/v1/notifications/unregister-device', { device_id: deviceId });
}

// ─── Notification preferences ─────────────────────────────────────────────────

export type MobileNotificationPreferences = NotificationPreferences;

/** GET /api/v1/notifications/preferences — missing keys fall back to the
 * mobile defaults (`file_updated` OFF, task 1578). */
export async function getNotificationPreferences(): Promise<MobileNotificationPreferences> {
  const response = await request<MobileNotificationPreferences | { preferences: MobileNotificationPreferences }>(
    'GET',
    '/api/v1/notifications/preferences',
  );
  return normalizeNotificationPreferences('preferences' in response ? response.preferences : response);
}

/** PUT /api/v1/notifications/preferences */
export async function setNotificationPreferences(
  prefs: MobileNotificationPreferences,
): Promise<MobileNotificationPreferences> {
  const response = await request<MobileNotificationPreferences | { preferences: MobileNotificationPreferences }>(
    'PUT',
    '/api/v1/notifications/preferences',
    prefs,
  );
  return normalizeNotificationPreferences('preferences' in response ? response.preferences : response);
}

// ─── Privacy / DSAR (spec 025) ────────────────────────────────────────────────

export interface TrackingPreference {
  tracking_opted_in: boolean;
  opted_in_at: string | null;
  opted_out_at: string | null;
}

/** GET /api/v1/me/tracking */
export async function getTrackingPreference(): Promise<TrackingPreference> {
  return request<TrackingPreference>('GET', '/api/v1/me/tracking');
}

/** PUT /api/v1/me/tracking */
export async function setTrackingPreference(optedIn: boolean): Promise<TrackingPreference> {
  return request<TrackingPreference>('PUT', '/api/v1/me/tracking', { opted_in: optedIn });
}

export interface DataExportRequest {
  export_id: string;
  status: string;
  estimated_seconds?: number;
  download_url?: string;
}

export interface DataExportStatus {
  export_id: string;
  status: string;
  file_count?: number;
  total_bytes?: number;
  download_url?: string;
  expires_at?: string;
}

/** POST /api/v1/me/data-export */
export async function requestDataExport(): Promise<DataExportRequest> {
  return normalizeDataExportUrl(await request<DataExportRequest>('POST', '/api/v1/me/data-export'));
}

/** GET /api/v1/me/data-export/:id */
export async function getDataExportStatus(exportId: string): Promise<DataExportStatus> {
  return normalizeDataExportUrl(await request<DataExportStatus>('GET', `/api/v1/me/data-export/${exportId}`));
}

function normalizeDataExportUrl<T extends { download_url?: string }>(data: T): T {
  if (data.download_url && !data.download_url.startsWith('http')) {
    return { ...data, download_url: `${BASE_URL}${data.download_url}` };
  }
  return data;
}

/** POST /api/v1/me/freeze */
export async function freezeAccount(): Promise<{ frozen: boolean }> {
  return request<{ frozen: boolean }>('POST', '/api/v1/me/freeze');
}

/** POST /api/v1/me/unfreeze */
export async function unfreezeAccount(): Promise<{ frozen: boolean }> {
  return request<{ frozen: boolean }>('POST', '/api/v1/me/unfreeze');
}

export interface DeleteAccountResponse {
  message: string;
  /** ISO-8601 timestamp — when the encrypted blobs are permanently shredded. */
  shred_after: string;
}

/**
 * DELETE /api/v1/auth/account — permanent, irreversible account deletion
 * (task 1399, App Review 5.1.1(v)). Mirrors the web client's
 * `deleteAccountPermanently` (`repos/web/src/lib/api.ts`) byte-for-byte:
 * the server requires the literal string `"DELETE"` as `confirmation` AND a
 * step-up `X-Confirm-Token` (see `confirmAction`/`requestConfirmation`) — a
 * request with either missing/wrong is rejected by the server (400/403)
 * before anything is mutated. Never send this without a confirmation token
 * from a caller-verified password.
 */
export async function deleteAccountPermanently(
  confirmation: string,
  confirmToken: string,
): Promise<DeleteAccountResponse> {
  return request<DeleteAccountResponse>(
    'DELETE',
    '/api/v1/auth/account',
    { confirmation },
    true,
    { 'X-Confirm-Token': confirmToken },
  );
}

// ─── Plans + billing checkout ─────────────────────────────────────────────────

export interface Plan {
  id: string;
  name: string;
  price_eur: number;
  price_yearly_eur: number;
  storage_bytes: number;
  storage_label: string;
  features: string[];
  is_active?: boolean;
}

/** GET /api/v1/billing/plans */
export async function getPlans(): Promise<Plan[]> {
  try {
    const data = await request<{ plans?: Plan[] } | Plan[]>('GET', '/api/v1/billing/plans');
    if (Array.isArray(data)) return data;
    if (Array.isArray((data as { plans?: Plan[] }).plans)) return (data as { plans: Plan[] }).plans;
    return [];
  } catch {
    return [];
  }
}

// Billing checkout + management moved to the web (app.beebeeb.io/settings/billing)
// when billing migrated off Stripe to Mollie — the mobile app no longer creates
// checkout/portal sessions itself (task 0958).

// ─── Data residency (task 0051) ───────────────────────────────────────────────

export interface AvailableRegion {
  continent: string;
  display_name: string;
  city?: string;
  example_city?: string;
  provider: string;
  is_default: boolean;
}

/** GET /api/v1/regions — every live storage region (public, no auth).
 * Server (`routes/regions.rs::list_regions`) returns a bare JSON array, not
 * `{regions: [...]}`. */
export async function getAvailableRegions(): Promise<AvailableRegion[]> {
  return request<AvailableRegion[]>('GET', '/api/v1/regions', undefined, false);
}

/** GET /api/v1/me/region — user's preferred region + available list */
export async function getUserRegion(): Promise<{
  preferred_region: string | null;
  available_regions: AvailableRegion[];
}> {
  return request<{ preferred_region: string | null; available_regions: AvailableRegion[] }>(
    'GET', '/api/v1/me/region',
  );
}

/** PUT /api/v1/me/region — set preferred region */
export async function setUserRegion(continent: string): Promise<{ preferred_region: string }> {
  return request<{ preferred_region: string }>(
    'PUT', '/api/v1/me/region', { preferred_region: continent },
  );
}

// ─── TOTP 2FA ─────────────────────────────────────────────────────────────────

export interface TotpSetup {
  secret: string;
  qr_uri: string;
  backup_codes: string[];
}

/**
 * POST /api/v1/auth/2fa/setup — generate secret + backup codes.
 *
 * Body {} (not empty): request() always sets Content-Type: application/json,
 * and axum's Option<Json<SetupRequest>> on the server rejects a JSON-typed
 * EMPTY body with 400 ("EOF while parsing") — the 1297 wizard dead-end.
 *
 * When the account already has 2FA ON, the server requires step-up before
 * replacing the live secret (`routes/totp.rs` `setup_step_up_validated_if_required`
 * — task 1610): either the current TOTP/backup code as `opts.code`, or a
 * step-up `X-Confirm-Token` (from `requestConfirmation()`, `confirm-action.ts`)
 * as `opts.confirmToken`. Calling this bare against an enabled account 403s
 * `confirmation_required` — callers MUST gate on `User.totp_enabled` first
 * and offer one of the two paths for "set up again", never call it bare.
 */
export async function setupTotp(opts?: { code?: string; confirmToken?: string }): Promise<TotpSetup> {
  const body = opts?.code ? { code: opts.code } : {};
  const extraHeaders = opts?.confirmToken ? { 'X-Confirm-Token': opts.confirmToken } : undefined;
  return request<TotpSetup>('POST', '/api/v1/auth/2fa/setup', body, true, extraHeaders);
}

/** POST /api/v1/auth/2fa/enable — verify code and activate TOTP */
export async function enableTotp(code: string): Promise<void> {
  await request('POST', '/api/v1/auth/2fa/enable', { code });
}

/** POST /api/v1/auth/2fa/disable — verify code and remove TOTP */
export async function disableTotp(code: string): Promise<void> {
  await request('POST', '/api/v1/auth/2fa/disable', { code });
}

// ---------------------------------------------------------------------------
// Clients & Sessions (backup confidence system)
// ---------------------------------------------------------------------------

export interface ClientDevice {
  id: string;
  hostname: string;
  platform: string;
  bb_version: string | null;
  last_seen: string;
  created_at: string;
  session_count?: number;
}

export interface ClientSession {
  id: string;
  device_id?: string;
  device_hostname?: string;
  device_platform?: string;
  name: string;
  session_type: string;
  local_path: string | null;
  remote_path: string;
  status: string;
  heartbeat_interval_secs: number;
  alert_after_missed: number;
  created_at: string;
  last_heartbeat: string | null;
  files_synced: number | null;
  files_total: number | null;
  bytes_synced: number | null;
  bytes_total: number | null;
  heartbeat_status: string | null;
  current_file: string | null;
  speed_bps?: number | null;
}

/** GET /api/v1/clients/devices */
export async function listClientDevices(): Promise<{ devices: ClientDevice[] }> {
  return request<{ devices: ClientDevice[] }>('GET', '/api/v1/clients/devices');
}

/** GET /api/v1/clients/sessions */
export async function listClientSessions(): Promise<{ sessions: ClientSession[] }> {
  return request<{ sessions: ClientSession[] }>('GET', '/api/v1/clients/sessions');
}

/** DELETE /api/v1/clients/sessions/:id — forget a sync/backup session (server returns 204). */
export async function deleteClientSession(id: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/clients/sessions/${id}`);
}

/** POST /api/v1/clients/devices — register or update this device */
export async function registerClientDevice(body: {
  hostname: string;
  platform: string;
  bb_version: string;
  push_token?: string;
}): Promise<ClientDevice> {
  return request<ClientDevice>('POST', '/api/v1/clients/devices', body);
}

export interface CreateClientSessionBody {
  device_id: string;
  name: string;
  session_type: 'sync' | 'backup' | 'mount' | 'webdav';
  local_path?: string | null;
  remote_path: string;
  heartbeat_interval_secs?: number;
  alert_after_missed?: number;
}

/** POST /api/v1/clients/sessions — create a sync/backup client session. */
export async function createClientSession(body: CreateClientSessionBody): Promise<ClientSession> {
  return request<ClientSession>('POST', '/api/v1/clients/sessions', body);
}

/**
 * Create or reuse the mobile iOS camera-roll backup session.
 *
 * This is intentionally JS-owned: JS knows the registered client device id and
 * persists the server session id, while native only receives the opaque id for
 * best-effort heartbeat emission.
 */
export async function ensureMobileIosBackupClientSession(deviceId: string): Promise<string | null> {
  const cached = await tokenStore.get(MOBILE_IOS_BACKUP_CLIENT_SESSION_KEY);

  let sessions: { sessions: ClientSession[] };
  try {
    sessions = await listClientSessions();
  } catch {
    // Avoid duplicate backup sessions when the list endpoint is unavailable,
    // and do not reuse a cached id that we cannot validate still exists.
    // Telemetry setup is best-effort and can retry on the next backup start.
    return null;
  }

  if (cached) {
    const cachedSession = sessions.sessions.find((session) => session.id === cached);
    if (
      cachedSession?.device_id === deviceId &&
      cachedSession.session_type === 'backup' &&
      cachedSession.name === MOBILE_IOS_BACKUP_SESSION_NAME &&
      cachedSession.status !== 'stopped'
    ) {
      return cached;
    }
    await tokenStore.remove(MOBILE_IOS_BACKUP_CLIENT_SESSION_KEY);
  }

  const existing = sessions.sessions.find((session) => (
    session.device_id === deviceId &&
    session.session_type === 'backup' &&
    session.name === MOBILE_IOS_BACKUP_SESSION_NAME &&
    session.status !== 'stopped'
  ));
  if (existing?.id) {
    await tokenStore.set(MOBILE_IOS_BACKUP_CLIENT_SESSION_KEY, existing.id);
    return existing.id;
  }

  const created = await createClientSession({
    device_id: deviceId,
    name: MOBILE_IOS_BACKUP_SESSION_NAME,
    session_type: 'backup',
    local_path: 'Camera Roll',
    remote_path: '/Backups/Camera Roll',
    heartbeat_interval_secs: 30,
    alert_after_missed: 4,
  });
  await tokenStore.set(MOBILE_IOS_BACKUP_CLIENT_SESSION_KEY, created.id);
  return created.id;
}

/** Clear the locally remembered iOS backup session id and native mirror. */
export async function clearMobileIosBackupClientSession(): Promise<void> {
  await tokenStore.remove(MOBILE_IOS_BACKUP_CLIENT_SESSION_KEY);
  await BeebeebCrypto.mirrorBackupClientSession(null).catch(() => false);
}

// ─── File requests (0643) ─────────────────────────────────────────────────────
//
// File requests are the inverse of sharing: an account-less link anyone can use
// to upload files INTO the owner's encrypted vault. The owner creates the
// request here; uploads happen via the web `/r/:token` page (the universal
// uploader — native in-app upload is out of scope for this pass). Mirrors the
// web client (repos/web/src/lib/api.ts).

/** A file request owned by the current user. */
export interface FileRequest {
  id: string;
  title: string;
  description: string | null;
  token: string | null;
  /** R_priv wrapped under the owner's master key (base64, opaque). Used to
   *  rebuild R_pub for the "copy link" action. */
  wrapped_private_key: string | null;
  wrap_nonce: string | null;
  target_folder_id: string | null;
  max_files: number;
  max_total_bytes: number | null;
  files_received: number;
  total_bytes_received: number;
  expires_at: string | null;
  closed: boolean;
  closed_at: string | null;
  created_at: string;
  /** `APP_URL/r/<token>` — the client appends `#<R_pub>` to share. */
  request_url: string | null;
}

export interface CreateFileRequestParams {
  title: string;
  description?: string;
  target_folder_id?: string;
  max_files?: number;
  max_total_bytes?: number;
  expires_in_secs?: number;
  /** R_priv wrapped under the master key (base64). */
  wrapped_private_key: string;
  /** GCM nonce used to wrap R_priv (base64). */
  wrap_nonce: string;
}

export interface CreateFileRequestResult {
  id: string;
  token: string;
  target_folder_id: string | null;
  max_files: number;
  max_total_bytes: number | null;
  files_received: number;
  total_bytes_received: number;
  expires_at: string | null;
  closed: boolean;
  created_at: string;
  request_url: string | null;
}

/** POST /api/v1/file-requests — create a request. Returns the token + caps. */
export async function createFileRequest(params: CreateFileRequestParams): Promise<CreateFileRequestResult> {
  return request<CreateFileRequestResult>('POST', '/api/v1/file-requests', params);
}

/** GET /api/v1/file-requests — the owner's requests (incl. wrapped key for link rebuild). */
export async function listFileRequests(): Promise<{ file_requests: FileRequest[] }> {
  return request<{ file_requests: FileRequest[] }>('GET', '/api/v1/file-requests');
}

/** POST /api/v1/file-requests/:id/close — stop accepting new uploads (received files kept). */
export async function closeFileRequest(id: string): Promise<{ id: string; closed: boolean; closed_at: string | null }> {
  return request<{ id: string; closed: boolean; closed_at: string | null }>(
    'POST',
    `/api/v1/file-requests/${id}/close`,
  );
}
