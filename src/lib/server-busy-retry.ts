/**
 * Task 1870 — retry a `429 server_busy` after the server's `Retry-After`.
 *
 * The server holds one process-wide byte budget for every handler that buffers
 * a whole request body in memory (`POST /files/upload`, `PUT /index`; server
 * task 1786 part A). When that budget stays full the request is answered
 *
 *     429  Retry-After: N  {"error":"server_busy","retry_after":N}
 *
 * without the body having been read. That is a "try again in a moment", not a
 * failure — so the client waits and re-sends, a few times, before it surfaces
 * the error it always surfaced.
 *
 * What this does NOT retry (it keeps today's behaviour):
 *   - `429 {"error":"upload_rate_limited"}` — the per-user / per-link limit,
 *     a policy window that a 1–30 s wait does not clear;
 *   - any other 429 (the generic per-IP limiter) and any 5xx / network error.
 *
 * `send` is called afresh for every attempt, so a caller whose body is
 * one-shot (a stream, a `FormData` it consumed) builds it inside `send`.
 * After the last attempt the final 429 `Response` is RETURNED untouched, so the
 * caller's existing `!res.ok` handling raises the same user-facing error.
 *
 * Bucket pacing (round 2, Codex P2): `rateLimitedFetch` pauses the `files` /
 * `general` bucket until `now + Retry-After` on every 429, and for a
 * `server_busy` 429 it caps that pause at {@link SERVER_BUSY_MAX_WAIT_SECONDS}
 * (it asks {@link serverBusyWait}). The pause is an absolute timestamp that
 * starts before the wait below does, so it has lapsed by the time the wait
 * ends: exactly ONE wait per retry, never more than 30 s, and a successful
 * retry leaves nothing paused behind it.
 *
 * Superseded retries (round 2, Codex P1): a caller whose payload is
 * "last write wins" (the search index) passes `shouldRetry`; once it says no,
 * the retry is dropped — no wait, no request — and the last 429 is returned.
 */

export const SERVER_BUSY_CODE = 'server_busy';
/** Re-sends after the first attempt: 1 + 3 = 4 requests in total. */
export const SERVER_BUSY_MAX_RETRIES = 3;
/** The longest single wait. The server caps `Retry-After` at 60 s; a UI that sat silent for that long looks hung. */
export const SERVER_BUSY_MAX_WAIT_SECONDS = 30;
/** Floor, so a `Retry-After: 0` (or a missing one) cannot become a hot loop. */
export const SERVER_BUSY_MIN_WAIT_SECONDS = 1;

function abortError(): Error {
  // Hermes has no DOMException; callers check `err.name === 'AbortError'`.
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}

function secondsFrom(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim() === '' ? NaN : value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Seconds to wait: the larger of the `Retry-After` header and the body's
 * `retry_after`, at least 1, at most 30.
 */
export function serverBusyWaitSeconds(headerValue: string | null, bodyValue: unknown): number {
  const wanted = Math.max(
    secondsFrom(headerValue) ?? 0,
    secondsFrom(bodyValue) ?? 0,
    SERVER_BUSY_MIN_WAIT_SECONDS,
  );
  return Math.min(wanted, SERVER_BUSY_MAX_WAIT_SECONDS);
}

/** Returns the wait in seconds when `res` is a `429 server_busy`, else `null`. Leaves `res`'s body unread. */
export async function serverBusyWait(res: Response): Promise<number | null> {
  if (res.status !== 429 || typeof res.clone !== 'function') return null;
  let body: { error?: unknown; retry_after?: unknown } = {};
  try {
    body = (await res.clone().json()) as typeof body;
  } catch {
    return null;
  }
  if (!body || body.error !== SERVER_BUSY_CODE) return null;
  return serverBusyWaitSeconds(res.headers.get('Retry-After'), body.retry_after);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `send`; while it answers `429 server_busy`, wait and run it again — at
 * most {@link SERVER_BUSY_MAX_RETRIES} more times. Resolves with the first
 * non-`server_busy` response, or the last `server_busy` one when the retries
 * are spent, or `shouldRetry()` (checked before and after each wait) says the
 * request is no longer wanted. Rejects with an `AbortError` as soon as `signal` fires, including
 * mid-wait (no further request is made).
 */
export async function withServerBusyRetry(
  send: () => Promise<Response>,
  signal?: AbortSignal,
  shouldRetry?: () => boolean,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await send();
    const waitSeconds = await serverBusyWait(res);
    if (waitSeconds === null || attempt >= SERVER_BUSY_MAX_RETRIES) return res;
    if (shouldRetry && !shouldRetry()) return res;
    await sleepAbortable(waitSeconds * 1000, signal);
    // Re-check after the wait: a newer write may have been sent meanwhile.
    if (shouldRetry && !shouldRetry()) return res;
  }
}
