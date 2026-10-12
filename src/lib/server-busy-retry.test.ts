// @ts-nocheck
/**
 * Task 1870 — a `429 server_busy` upload is retried after Retry-After.
 *
 * Contract (server 1786 part A): `POST /files/upload` and `PUT /index` answer
 * `429 {"error":"server_busy","retry_after":N}` + `Retry-After: N` when the
 * process-wide buffered-upload budget stays full. A different 429,
 * `upload_rate_limited`, must NOT be retried.
 *
 * Time is faked (bun `jest.useFakeTimers`): the waits are asserted to the
 * millisecond, never slept for real.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  SERVER_BUSY_MAX_RETRIES,
  SERVER_BUSY_MAX_WAIT_SECONDS,
  serverBusyWaitSeconds,
  withServerBusyRetry,
} from './server-busy-retry'
import { createRateLimitedFetch } from './rate-limited-fetch'

function busy(retryAfter: number | null, bodyRetryAfter: number | null = retryAfter): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (retryAfter !== null) headers['Retry-After'] = String(retryAfter)
  return new Response(
    JSON.stringify({ error: 'server_busy', message: 'busy', ...(bodyRetryAfter !== null ? { retry_after: bodyRetryAfter } : {}) }),
    { status: 429, headers },
  )
}
function rateLimited(): Response {
  return new Response(JSON.stringify({ error: 'upload_rate_limited', message: 'Too many uploads', retry_after: 2 }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'Retry-After': '2' },
  })
}
function created(): Response {
  return new Response(JSON.stringify({ id: 'f1' }), { status: 201, headers: { 'content-type': 'application/json', ETag: '"e1"' } })
}

/** Let every already-resolved promise continuation run (fake timers do not touch microtasks). */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve()
}

/** Scripted fetch: returns the queued responses in order, records the fake-clock time of each call. */
function scripted(queue: Array<() => Response>) {
  const calls: number[] = []
  const fn = async () => {
    calls.push(Date.now())
    const next = queue.shift()
    if (!next) throw new Error('unexpected extra request')
    return next()
  }
  return { fn, calls }
}

/**
 * Run `p` to completion while pumping the fake clock, so a regression that WRONGLY
 * starts waiting shows up as an extra request (a failed assertion) rather than a hang.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  for (let i = 0; i < 8; i++) {
    await flush()
    jest.advanceTimersByTime(30_000)
  }
  return p
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('serverBusyWaitSeconds', () => {
  test('uses the larger of header and body, floors at 1, caps at 30', () => {
    expect(serverBusyWaitSeconds('2', 5)).toBe(5)
    expect(serverBusyWaitSeconds('7', 5)).toBe(7)
    expect(serverBusyWaitSeconds(null, 4)).toBe(4)
    expect(serverBusyWaitSeconds('0', 0)).toBe(1)
    expect(serverBusyWaitSeconds(null, undefined)).toBe(1)
    expect(serverBusyWaitSeconds('60', 60)).toBe(SERVER_BUSY_MAX_WAIT_SECONDS)
    expect(serverBusyWaitSeconds('garbage', 'nope')).toBe(1)
  })
})

describe('withServerBusyRetry', () => {
  test('(a) 429 server_busy + Retry-After: 2, then 201 -> succeeds after exactly one retry, waited >= 2 s', async () => {
    const s = scripted([() => busy(2), () => created()])
    const start = Date.now()
    const p = withServerBusyRetry(s.fn)
    await flush()
    expect(s.calls.length).toBe(1)

    jest.advanceTimersByTime(1999)
    await flush()
    expect(s.calls.length).toBe(1) // still waiting at 1.999 s

    jest.advanceTimersByTime(1)
    const res = await p
    expect(res.status).toBe(201)
    expect(s.calls.length).toBe(2)
    expect(s.calls[1] - start).toBeGreaterThanOrEqual(2000)
  })

  test('the wait is max(header, body retry_after), at least 1 s', async () => {
    const s = scripted([() => busy(1, 3), () => created()])
    const p = withServerBusyRetry(s.fn)
    await flush()
    jest.advanceTimersByTime(2999)
    await flush()
    expect(s.calls.length).toBe(1)
    jest.advanceTimersByTime(1)
    expect((await p).status).toBe(201)
    expect(s.calls.length).toBe(2)
  })

  test('a single wait is capped at 30 s', async () => {
    const s = scripted([() => busy(60), () => created()])
    const p = withServerBusyRetry(s.fn)
    await flush()
    jest.advanceTimersByTime(29_999)
    await flush()
    expect(s.calls.length).toBe(1)
    jest.advanceTimersByTime(1)
    expect((await p).status).toBe(201)
  })

  test('(b) four consecutive server_busy -> gives up after 4 attempts and returns the 429 untouched', async () => {
    const s = scripted([() => busy(1), () => busy(1), () => busy(1), () => busy(1), () => created()])
    const p = withServerBusyRetry(s.fn)
    for (let i = 0; i < SERVER_BUSY_MAX_RETRIES; i++) {
      await flush()
      jest.advanceTimersByTime(1000)
    }
    const res = await p
    expect(s.calls.length).toBe(4) // 1 + 3 retries; the queued 201 was never requested
    expect(res.status).toBe(429)
    // The caller's existing error path still gets a readable body.
    expect(((await res.json()) as { error: string }).error).toBe('server_busy')
  })

  test('(c) 429 upload_rate_limited -> returned at once, not retried', async () => {
    const s = scripted([() => rateLimited(), () => created()])
    const res = await settle(withServerBusyRetry(s.fn))
    expect(res.status).toBe(429)
    expect(s.calls.length).toBe(1)
    expect(((await res.json()) as { error: string }).error).toBe('upload_rate_limited')
  })

  test('other statuses and an unparsable 429 are not retried', async () => {
    for (const make of [
      () => new Response('{}', { status: 500 }),
      () => new Response('<html>', { status: 429, headers: { 'Retry-After': '2' } }),
      () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    ]) {
      const s = scripted([make, () => created()])
      const res = await settle(withServerBusyRetry(s.fn))
      expect(res.ok).toBe(false)
      expect(s.calls.length).toBe(1)
    }
  })

  test('(d) abort during the wait -> rejects AbortError immediately, no further request', async () => {
    const s = scripted([() => busy(5), () => created()])
    const ac = new AbortController()
    const p = withServerBusyRetry(s.fn, ac.signal)
    p.catch(() => {}) // observed below
    await flush()
    expect(s.calls.length).toBe(1)

    jest.advanceTimersByTime(1000) // mid-wait
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })

    jest.advanceTimersByTime(60_000)
    await flush()
    expect(s.calls.length).toBe(1) // the timer was cleared; nothing was re-sent
  })

  test('an already-aborted signal does not start a wait', async () => {
    const s = scripted([() => busy(5), () => created()])
    const ac = new AbortController()
    ac.abort()
    await expect(withServerBusyRetry(s.fn, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(s.calls.length).toBe(1)
  })

  test('send is called afresh each attempt (a one-shot body can be rebuilt)', async () => {
    let built = 0
    const queue = [() => busy(1), () => created()]
    const p = withServerBusyRetry(async () => {
      built++
      return queue.shift()!()
    })
    await flush()
    jest.advanceTimersByTime(1000)
    await p
    expect(built).toBe(2)
  })
})

describe('bucket pacing stays coherent with the real rateLimitedFetch', () => {
  test('the 429 pauses the files bucket until Retry-After; the retry adds no second wait, and nothing stays paused after success', async () => {
    const sleeps: number[] = []
    const queue = [() => busy(2), () => created(), () => created()]
    const rl = createRateLimitedFetch({
      fetchImpl: async () => queue.shift()!(),
      sleep: async (ms) => { sleeps.push(ms) },
      now: () => Date.now(),
    })
    const url = 'https://api.test/api/v1/files/upload'
    const p = withServerBusyRetry(() => rl(url, { method: 'POST' }))
    await flush()
    jest.advanceTimersByTime(2000)
    expect((await p).status).toBe(201)
    // The bucket's own pause (now + 2 s) had already lapsed when the retry went out: no sleep at all.
    expect(sleeps.filter((ms) => ms > 0)).toEqual([])

    // A later files-bucket request is paced by the normal 120 ms spacing only.
    expect((await rl(url, { method: 'POST' })).status).toBe(201)
    expect(Math.max(0, ...sleeps)).toBeLessThanOrEqual(120)
  })

  // Codex P2 on #176: the bucket pause must not outlast the helper's capped wait.
  test('(r2-2) server_busy Retry-After: 60 through the real rateLimitedFetch -> retry sent after 30 s (not 60), one wait only', async () => {
    const sleeps: number[] = []
    const sentAt: number[] = []
    const queue = [() => busy(60), () => created()]
    const rl = createRateLimitedFetch({
      fetchImpl: async () => { sentAt.push(Date.now()); return queue.shift()!() },
      // The bucket's own sleep, on the same fake clock, recorded.
      sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, ms)) },
    })
    const url = 'https://api.test/api/v1/files/upload'
    const start = Date.now()
    const p = withServerBusyRetry(() => rl(url, { method: 'POST' }))
    await flush()
    expect(sentAt.length).toBe(1)

    jest.advanceTimersByTime(29_999)
    await flush()
    expect(sentAt.length).toBe(1) // still waiting at 29.999 s
    jest.advanceTimersByTime(1)
    await flush()
    expect(sentAt.length).toBe(2) // retry out at 30 s, not held in the bucket until 60 s
    expect(sentAt[1] - start).toBe(30_000)
    expect((await p).status).toBe(201)
    expect(sleeps.filter((ms) => ms > 120)).toEqual([]) // the bucket added no second long wait
  })

  test('(r2-3) upload_rate_limited Retry-After: 60 still pauses the bucket for the full 60 s, as today', async () => {
    const sleeps: number[] = []
    const queue = [
      () => new Response(JSON.stringify({ error: 'upload_rate_limited', retry_after: 60 }), {
        status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '60' } }),
      () => created(),
    ]
    const rl = createRateLimitedFetch({
      fetchImpl: async () => queue.shift()!(),
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    })
    const url = 'https://api.test/api/v1/files/upload'
    expect((await rl(url, { method: 'POST' })).status).toBe(429)
    expect((await rl(url, { method: 'POST' })).status).toBe(201)
    expect(Math.max(...sleeps)).toBe(60_000)
  })
})
