// @ts-nocheck
/**
 * Task 1589 — `uploadEncryptedChunked` (the JS chunk loop: Android, the iOS
 * JS fallback, `text-file-save.ts`) must recover from a v2 upload session the
 * server's lease sweeper reclaimed mid-upload (server PR #120): a chunk PUT
 * or complete answering 404 (or the legacy 400 "not writable: expired") means
 * "this session is gone" — drop it, re-init the SAME file id, and restart
 * from chunk 0, at most ONCE per call. A second sweep in a row throws the
 * typed `UploadRestartFailedError` instead of looping. Also covers: a 5xx on
 * the re-init's own init call is retried with the SAME id (never a fresh
 * one), and a heartbeat renews the session while the upload is active.
 *
 * Mirrors web's `upload-session-reinit.ts` test (PR #122) and the CLI's
 * `upload::swept_session_reinit` tests (PR #50) — same bounded contract,
 * proven here for mobile's JS chunk-upload path.
 *
 * Isolated per bun:test-per-file semantics (mobile CLAUDE.md, "Tests") — every
 * native module this file needs is mocked here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()
const fetchCalls: Array<{ url: string; init: RequestInit }> = []
let fetchQueue: Array<() => Promise<Response>> = []
const heartbeatCalls: Array<{ url: string }> = []
let uploadAsyncQueue: Array<{ status: number; body: string }> = []
const uploadAsyncCalls: Array<{ url: string; options: Record<string, unknown> }> = []

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}))
mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}))
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value) },
  deleteItemAsync: async (key: string) => { store.delete(key) },
}))
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
  writeAsStringAsync: async () => {},
  deleteAsync: async () => {},
  uploadAsync: async (url: string, _uri: string, options: Record<string, unknown>) => {
    uploadAsyncCalls.push({ url, options })
    const next = uploadAsyncQueue.shift()
    if (!next) throw new Error(`unexpected chunk upload: ${url}`)
    return { status: next.status, body: next.body, headers: {} }
  },
}))
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => null,
  uploadChunksNative: async () => { throw new Error('native path not expected in this file') },
}))
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }))
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }))
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }))
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    if (url.endsWith('/heartbeat')) {
      heartbeatCalls.push({ url })
      return jsonResponse({ lease_seconds: 3600, heartbeat_interval_secs: 1 })
    }
    const next = fetchQueue.shift()
    if (!next) throw new Error(`unexpected fetch: ${url}`)
    return next()
  },
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function initResponse(sessionId: string, opts?: { chunkCount?: number; heartbeatIntervalSecs?: number }): () => Promise<Response> {
  return async () => jsonResponse({
    file_id: 'F',
    upload_session_id: sessionId,
    chunk_size_bytes: 4_194_304,
    chunk_count: opts?.chunkCount ?? 1,
    lease_seconds: 3600,
    heartbeat_interval_secs: opts?.heartbeatIntervalSecs ?? 9_999, // huge: never fires in a fast test
  })
}

function requestBody(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string)
}

async function loadFreshApi() {
  return import(`./api?reinitTest=${Math.random()}`)
}

beforeEach(() => {
  store.clear()
  fetchCalls.length = 0
  fetchQueue = []
  heartbeatCalls.length = 0
  uploadAsyncQueue = []
  uploadAsyncCalls.length = 0
})

describe('uploadEncryptedChunked — re-init on a swept v2 session (task 1589)', () => {
  test('a chunk PUT 404 re-inits the SAME file id once and restarts from chunk 0', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1', { chunkCount: 2 }),
      initResponse('S2', { chunkCount: 2 }), // re-init
      async () => jsonResponse({ id: 'F', name_encrypted: 'n' }), // complete
    )
    uploadAsyncQueue.push(
      { status: 404, body: '{"error":"not found"}' }, // chunk 0 on S1 — swept
      { status: 200, body: '{}' }, // chunk 0 on S2 (restarted from 0)
      { status: 200, body: '{}' }, // chunk 1 on S2
    )

    const { uploadEncryptedChunked } = await loadFreshApi()
    const result = await uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 5_000_000,
      readEncryptedChunk: async () => new Uint8Array(33),
    })

    expect(result.id).toBe('F')
    const initCalls = fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))
    expect(initCalls).toHaveLength(2)
    // The re-init is an explicit takeover of the SAME server file id.
    expect(requestBody(initCalls[1]).file_id).toBe('F')
    expect(uploadAsyncCalls).toHaveLength(3)
    expect(uploadAsyncCalls[0].url).toBe('https://api.test/api/v1/uploads/S1/chunks/0')
    expect(uploadAsyncCalls[1].url).toBe('https://api.test/api/v1/uploads/S2/chunks/0')
    expect(uploadAsyncCalls[2].url).toBe('https://api.test/api/v1/uploads/S2/chunks/1')
    const completeCall = fetchCalls.find((c) => c.url.endsWith('/complete'))
    expect(completeCall?.url).toBe('https://api.test/api/v1/uploads/S2/complete')
  })

  test('the legacy 400 "not writable: expired" is treated the same as 404', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      initResponse('S2'),
      async () => jsonResponse({ id: 'F', name_encrypted: 'n' }),
    )
    uploadAsyncQueue.push(
      { status: 400, body: '{"error":"upload session is not writable: expired"}' },
      { status: 200, body: '{}' },
    )

    const { uploadEncryptedChunked } = await loadFreshApi()
    const result = await uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    })
    expect(result.id).toBe('F')
    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(2)
  })

  test('complete() 404 (swept between the last chunk and complete) also re-inits once', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      async () => jsonResponse({ error: 'not found' }, 404), // complete on S1 — swept
      initResponse('S2'),
      async () => jsonResponse({ id: 'F', name_encrypted: 'n' }), // complete on S2
    )
    uploadAsyncQueue.push(
      { status: 200, body: '{}' }, // chunk 0 on S1
      { status: 200, body: '{}' }, // chunk 0 on S2 (restarted from 0)
    )

    const { uploadEncryptedChunked } = await loadFreshApi()
    const result = await uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    })
    expect(result.id).toBe('F')
    expect(uploadAsyncCalls).toHaveLength(2)
    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(2)
  })

  test('a SECOND sweep in a row throws UploadRestartFailedError and never re-inits a third time', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      initResponse('S2'), // the one bounded re-init
    )
    uploadAsyncQueue.push(
      { status: 404, body: '{"error":"not found"}' }, // chunk 0 on S1 — swept
      { status: 404, body: '{"error":"not found"}' }, // chunk 0 on S2 — swept AGAIN
    )

    const { uploadEncryptedChunked, UploadRestartFailedError } = await loadFreshApi()
    await expect(uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    })).rejects.toBeInstanceOf(UploadRestartFailedError)

    // Bounded: exactly one re-init, never a loop.
    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(2)
    expect(uploadAsyncCalls).toHaveLength(2)
  })

  test('a 409 (not a sweep) is never treated as session-gone — no re-init, error surfaces as-is', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(initResponse('S1'))
    uploadAsyncQueue.push({ status: 409, body: '{"error":"upload_in_progress","message":"Upload already in progress"}' })

    const { uploadEncryptedChunked, ApiError } = await loadFreshApi()
    await expect(uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    })).rejects.toMatchObject({ status: 409 })

    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(1)
    expect(uploadAsyncCalls).toHaveLength(1)
  })

  test('a 5xx on the RE-INIT itself is retried with the SAME file id, not abandoned or given a fresh id', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      async () => jsonResponse({ error: 'internal' }, 500), // re-init attempt 1
      async () => jsonResponse({ error: 'internal' }, 503), // re-init attempt 2
      initResponse('S2'),                                    // re-init attempt 3 — succeeds
      async () => jsonResponse({ id: 'F', name_encrypted: 'n' }),
    )
    uploadAsyncQueue.push(
      { status: 404, body: '{"error":"not found"}' },
      { status: 200, body: '{}' },
    )

    const { uploadEncryptedChunked } = await loadFreshApi()
    const result = await uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    })
    expect(result.id).toBe('F')
    const initCalls = fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))
    expect(initCalls).toHaveLength(4) // 1 original + 3 re-init attempts (2 failed, 1 succeeded)
    for (const call of initCalls.slice(1)) {
      expect(requestBody(call).file_id).toBe('F')
    }
  }, 10_000)

  test('the re-init keeps sending X-Beebeeb-Expected-User (task 1594/#143)', async () => {
    const { setExpectedUserId } = await import('./expected-user')
    setExpectedUserId('owner-123')
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      initResponse('S2'),
      async () => jsonResponse({ id: 'F', name_encrypted: 'n' }),
    )
    uploadAsyncQueue.push(
      { status: 404, body: '{"error":"not found"}' },
      { status: 200, body: '{}' },
    )

    const { uploadEncryptedChunked } = await loadFreshApi()
    await uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    })

    const initCalls = fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))
    expect(initCalls).toHaveLength(2)
    for (const call of initCalls) {
      const headers = call.init.headers as Record<string, string>
      expect(headers['X-Beebeeb-Expected-User']).toBe('owner-123')
    }
    setExpectedUserId(null)
  })
})

describe('uploadEncryptedChunked — heartbeat while active (task 1589)', () => {
  test('sends a heartbeat while a slow chunk read is in flight, and stops after completion', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1', { heartbeatIntervalSecs: 1 }),
      async () => jsonResponse({ id: 'F', name_encrypted: 'n' }),
    )
    uploadAsyncQueue.push({ status: 200, body: '{}' })

    const { uploadEncryptedChunked } = await loadFreshApi()
    const result = await uploadEncryptedChunked({
      fileId: 'client-id',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => {
        // Longer than the 1s heartbeat interval returned by init above —
        // the gap the heartbeat exists to cover.
        await new Promise((resolve) => setTimeout(resolve, 1_250))
        return new Uint8Array(10)
      },
    })

    expect(result.id).toBe('F')
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1)
    expect(heartbeatCalls[0].url).toBe('https://api.test/api/v1/uploads/S1/heartbeat')

    const countAtCompletion = heartbeatCalls.length
    await new Promise((resolve) => setTimeout(resolve, 400))
    // The pulse was stopped in `finally` — no heartbeat fires after the
    // upload has already completed.
    expect(heartbeatCalls.length).toBe(countAtCompletion)
  }, 10_000)
})
