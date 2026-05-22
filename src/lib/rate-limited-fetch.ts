type FetchInput = RequestInfo | URL;
type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;
type NowFn = () => number;

export type RateLimitBucket = 'auth' | 'files' | 'shares' | 'general' | 'external';

const DEFAULT_BUCKET_SPACING_MS: Record<RateLimitBucket, number> = {
  auth: 250,
  files: 120,
  shares: 250,
  general: 140,
  external: 0,
};

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

  if (pathname.includes('/api/v1/files') || pathname.includes('/api/v1/uploads')) return 'files';
  if (pathname.includes('/api/v1/auth')) return 'auth';
  if (pathname.includes('/api/v1/shares')) return 'shares';
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
    const state = stateFor(bucket);
    state.nextAt = Math.max(state.nextAt, now() + pauseMs);
  }

  function applyResponsePacing(bucket: RateLimitBucket, response: Response): void {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), now());
    if (response.status === 429 && retryAfterMs !== null) {
      pauseBucket(bucket, retryAfterMs);
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
      const response = await fetchImpl(input, init);
      applyResponsePacing(bucket, response);
      return response;
    }

    const state = stateFor(bucket);
    const task = state.chain.then(async () => {
      const waitMs = Math.max(0, state.nextAt - now());
      if (waitMs > 0) await sleep(waitMs);
      state.nextAt = Math.max(now(), state.nextAt) + minSpacing;
      const response = await fetchImpl(input, init);
      applyResponsePacing(bucket, response);
      return response;
    });
    state.chain = task.then(() => undefined, () => undefined);
    return task;
  };
}

export const rateLimitedFetch = createRateLimitedFetch();
