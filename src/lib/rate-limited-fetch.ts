import { SERVER_BUSY_MAX_WAIT_SECONDS, serverBusyWait } from './server-busy-retry';

type FetchInput = RequestInfo | URL;
type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;
type NowFn = () => number;

export type RateLimitBucket = 'auth' | 'files' | 'thumbnails' | 'shares' | 'billing' | 'general' | 'external';

const DEFAULT_BUCKET_SPACING_MS: Record<RateLimitBucket, number> = {
  auth: 250,
  files: 120,
  // Task 2233 item 1 (A1) — thumbnail GETs are not paced against `files`.
  // Serializing them (120 ms each, waiting for the previous response) meant a
  // 32-tile Android screen was 32 sequential round trips. The server has its
  // own 50k/min thumbnail limiter; client concurrency is bounded by the
  // thumbnail queue (6) and 429/5xx pacing is applied per response below.
  thumbnails: 0,
  shares: 250,
  // Billing reads (subscription + plans) are a tiny, low-frequency pair that a
  // single screen fires together. Keep them in their own zero-spacing bucket so
  // they run in parallel instead of serializing behind the shared `general`
  // 140 ms cadence — the server billing tier is generous and these are GETs.
  billing: 0,
  general: 140,
  external: 0,
};

/**
 * Task 1591 (bug 3) — the longest this client will silently hold a request
 * back because an earlier response asked it to wait.
 *
 * Before 1591 a 429's `Retry-After` paused the WHOLE bucket for however long
 * the server said. The signup limiter (3/hour per IP, server
 * `SignupLimiter`) answers with `Retry-After: 3600`, so after one 429 the
 * next signup attempt — and every other request in that bucket — sat in
 * `sleep()` for up to an hour before it was even sent: the Create-account
 * button spun for minutes with no message
 * (`_qa-evidence/1573/captures/work/ipad-signup-stuck-spinner-after-429.png`).
 *
 * A Retry-After up to one minute is throughput pacing (the per-IP / per-user
 * sliding windows are 60 s) and is honoured in full for the whole bucket. A
 * longer one is a per-endpoint policy lockout: the bucket is paused for at
 * most this cap — other requests resume after it, the retried request goes
 * out, the server answers 429 again at once, and the caller shows the
 * retry-after to the user (`ApiError.retryAfterSeconds` + `friendlyError`).
 * So no request is ever held back silently for more than a minute.
 *
 * Task 1593 (#141 review P2): 1591 first DROPPED a longer pause entirely,
 * which left a bucket that had just been told to back off completely
 * unpaced — a background loop (thumbnail/photo sync in the `files` bucket)
 * then hammered the server at its normal 120 ms cadence straight into the
 * lockout. Capping keeps the bucket paced without the hour-long silent wait.
 */
export const MAX_PACING_PAUSE_MS = 60_000;

interface RateLimitedFetchOptions {
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  now?: NowFn;
  bucketSpacingMs?: Partial<Record<RateLimitBucket, number>>;
}

interface BucketState {
  chain: Promise<void>;
  nextAt: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inputToUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function bucketForUrl(input: FetchInput): RateLimitBucket {
  const raw = inputToUrl(input);
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    // Relative URLs are rare in this app, but the path checks below still work.
  }

  // Thumbnail GETs (`/api/v1/files/{id}/thumbnail[/small|/large]`) have their
  // own concurrency-bounded, unpaced lane (task 2233 A1). Check before the
  // generic `/api/v1/files` rule below.
  if (/\/api\/v1\/files\/[^/]+\/thumbnail(?:\/(?:small|large))?\/?$/.test(pathname)) return 'thumbnails';
  if (pathname.includes('/api/v1/files') || pathname.includes('/api/v1/uploads')) return 'files';
  if (pathname.includes('/api/v1/auth')) return 'auth';
  if (pathname.includes('/api/v1/shares')) return 'shares';
  if (pathname.includes('/api/v1/billing')) return 'billing';
  if (pathname.includes('/api/')) return 'general';
  return 'external';
}

export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return null;
}

function parseResetPauseMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const resetMs = seconds * 1000;
  return Math.max(0, resetMs - now);
}

export function createRateLimitedFetch(options: RateLimitedFetchOptions = {}): FetchLike {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const spacing = { ...DEFAULT_BUCKET_SPACING_MS, ...options.bucketSpacingMs };
  const states = new Map<RateLimitBucket, BucketState>();

  function stateFor(bucket: RateLimitBucket): BucketState {
    let state = states.get(bucket);
    if (!state) {
      state = { chain: Promise.resolve(), nextAt: 0 };
      states.set(bucket, state);
    }
    return state;
  }

  function pauseBucket(bucket: RateLimitBucket, pauseMs: number): void {
    if (pauseMs <= 0) return;
    // A pause longer than the cap is a policy lockout, not pacing — pause the
    // bucket for the cap only, never silently for the whole lockout (see
    // MAX_PACING_PAUSE_MS).
    const cappedMs = Math.min(pauseMs, MAX_PACING_PAUSE_MS);
    const state = stateFor(bucket);
    state.nextAt = Math.max(state.nextAt, now() + cappedMs);
  }

  async function applyResponsePacing(bucket: RateLimitBucket, response: Response): Promise<void> {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), now());
    if (response.status === 429 && retryAfterMs !== null) {
      // Task 1870 r2 (Codex P2): a `429 server_busy` is retried by
      // `withServerBusyRetry` after at most SERVER_BUSY_MAX_WAIT_SECONDS. If
      // the bucket were paused for the server's full Retry-After (up to 60 s)
      // the retry would sit in the bucket for the rest of it — a second wait
      // on top of the first. So pause it for the same capped time. Any other
      // 429 (upload_rate_limited, the generic limiter) keeps the full pause.
      const busy = (await serverBusyWait(response)) !== null;
      pauseBucket(bucket, busy ? Math.min(retryAfterMs, SERVER_BUSY_MAX_WAIT_SECONDS * 1000) : retryAfterMs);
    } else {
      const remaining = Number(response.headers.get('X-RateLimit-Remaining'));
      if (Number.isFinite(remaining) && remaining <= 2) {
        const resetPauseMs = parseResetPauseMs(response.headers.get('X-RateLimit-Reset'), now());
        if (resetPauseMs !== null) pauseBucket(bucket, resetPauseMs);
      }
    }
  }

  return async (input: FetchInput, init?: RequestInit) => {
    const bucket = bucketForUrl(input);
    const minSpacing = spacing[bucket] ?? 0;
    if (minSpacing <= 0) {
      // Zero-spacing buckets do not serialize: the request starts immediately
      // unless the bucket is currently paused by a 429/Retry-After. Task 2233
      // round 1 (A1) introduced that pause for `thumbnails` only; `billing`
      // and `external` behave exactly as on main (no pause gate).
      if (bucket === 'thumbnails') {
        const state = stateFor(bucket);
        const waitMs = Math.max(0, state.nextAt - now());
        if (waitMs > 0) await sleep(waitMs);
      }
      const response = await fetchImpl(input, init);
      await applyResponsePacing(bucket, response);
      return response;
    }

    const state = stateFor(bucket);
    const task = state.chain.then(async () => {
      const waitMs = Math.max(0, state.nextAt - now());
      if (waitMs > 0) await sleep(waitMs);
      state.nextAt = Math.max(now(), state.nextAt) + minSpacing;
      const response = await fetchImpl(input, init);
      await applyResponsePacing(bucket, response);
      return response;
    });
    state.chain = task.then(() => undefined, () => undefined);
    return task;
  };
}

export const rateLimitedFetch = createRateLimitedFetch();
