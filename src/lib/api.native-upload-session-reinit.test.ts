// @ts-nocheck
/**
 * Task 1589 — `uploadEncryptedFileNative` (iOS native manual-upload
 * streaming, `NativeManualUploader.swift`) must recover from a v2 session the
 * lease sweeper reclaimed while the native chunk transfer was in flight,
 * exactly like the JS chunk loop (`api.upload-session-reinit.test.ts`): a
 * 404 (or the legacy 400 "not writable: expired") surfaced from the native
 * bridge or from `finalizeUpload`'s complete call re-inits the SAME file id
 * once and restarts the native transfer from chunk 0. A second sweep throws
 * `UploadRestartFailedError`. Never falls back to a client-generated id.
 *
 * The native bridge reports a failure as an `Error` whose message embeds a
 * `{"bb_upload_error":true,"status":...}` envelope (`native-upload-bridge.ts`
 * `parseNativeUploadError`) — reproduced here without any real native code.
 *
 * Isolated per bun:test-per-file semantics (mobile CLAUDE.md, "Tests").
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()
const fetchCalls: Array<{ url: string; init: RequestInit }> = []
let fetchQueue: Array<() => Promise<Response>> = []
const nativeUploadCalls: Array<Record<string, unknown>> = []
let nativeUploadQueue: Array<(params: Record<string, unknown>) => Promise<unknown>> = []

function nativeGoneFailure(status: number, message: string): Error {
  return new Error(JSON.stringify({ bb_upload_error: true, status, message }))
}

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
mock.module('expo-file-system/legacy', () => ({}))
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => true,
  planUploadChunksNative: () => ({ chunkSizeBytes: 4_194_304, chunkCount: 1 }),
  uploadChunksNative: async (params: Record<string, unknown>) => {
    nativeUploadCalls.push(params)
    const next = nativeUploadQueue.shift()
    if (!next) throw new Error('unexpected native upload call')
    return next(params)
  },
}))
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }))
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }))
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }))
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    if (url.endsWith('/heartbeat')) return jsonResponse({ lease_seconds: 3600, heartbeat_interval_secs: 9_999 })
    const next = fetchQueue.shift()
    if (!next) throw new Error(`unexpected fetch: ${url}`)
    return next()
  },
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function initResponse(sessionId: string): () => Promise<Response> {
  return async () => jsonResponse({
    file_id: 'F',
    upload_session_id: sessionId,
    chunk_size_bytes: 4_194_304,
    chunk_count: 1,
    lease_seconds: 3600,
    heartbeat_interval_secs: 9_999,
  })
}

async function loadFreshApi() {
  return import(`./api?nativeReinitTest=${Math.random()}`)
}

beforeEach(() => {
  store.clear()
  fetchCalls.length = 0
  fetchQueue = []
  nativeUploadCalls.length = 0
  nativeUploadQueue = []
})

describe('uploadEncryptedFileNative — re-init on a swept v2 session (task 1589)', () => {
  test('a native 404 re-inits the SAME file id once and restarts the native transfer from chunk 0', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      initResponse('S2'), // re-init
      async () => jsonResponse({ id: 'F', name_encrypted: 'name-cipher' }), // complete
    )
    nativeUploadQueue.push(
      async () => { throw nativeGoneFailure(404, 'not found') },
      async () => ({ chunksUploaded: 1, bytesUploaded: 10, bytesTotal: 10, cryptoBytesPerSec: 0 }),
    )

    const { uploadEncryptedFileNative } = await loadFreshApi()
    const result = await uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    })

    expect(result?.id).toBe('F')
    expect(nativeUploadCalls).toHaveLength(2)
    // Both attempts encrypt under the SERVER file id — never the client id —
    // and the second attempt is under the NEW session, restarted at index 0.
    expect(nativeUploadCalls[0].fileId).toBe('F')
    expect(nativeUploadCalls[0].uploadSessionId).toBe('S1')
    expect(nativeUploadCalls[1].fileId).toBe('F')
    expect(nativeUploadCalls[1].uploadSessionId).toBe('S2')
    expect(nativeUploadCalls[1].startChunkIndex).toBe(0)
    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(2)
  })

  test('complete() 404 after a successful native transfer also re-inits once and re-transfers', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      async () => jsonResponse({ error: 'not found' }, 404), // complete on S1 — swept
      initResponse('S2'),
      async () => jsonResponse({ id: 'F', name_encrypted: 'name-cipher' }), // complete on S2
    )
    nativeUploadQueue.push(
      async () => ({ chunksUploaded: 1, bytesUploaded: 10, bytesTotal: 10, cryptoBytesPerSec: 0 }),
      async () => ({ chunksUploaded: 1, bytesUploaded: 10, bytesTotal: 10, cryptoBytesPerSec: 0 }),
    )

    const { uploadEncryptedFileNative } = await loadFreshApi()
    const result = await uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    })

    expect(result?.id).toBe('F')
    expect(nativeUploadCalls).toHaveLength(2)
    expect(nativeUploadCalls[1].uploadSessionId).toBe('S2')
  })

  test('a SECOND sweep in a row throws UploadRestartFailedError — never a third attempt', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      initResponse('S1'),
      initResponse('S2'),
    )
    nativeUploadQueue.push(
      async () => { throw nativeGoneFailure(404, 'not found') },
      async () => { throw nativeGoneFailure(404, 'not found') },
    )

    const { uploadEncryptedFileNative, UploadRestartFailedError } = await loadFreshApi()
    await expect(uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    })).rejects.toBeInstanceOf(UploadRestartFailedError)

    expect(nativeUploadCalls).toHaveLength(2)
    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(2)
  })

  test('a non-session-gone native failure (e.g. 401) is never treated as a sweep — no re-init', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(initResponse('S1'))
    nativeUploadQueue.push(async () => { throw nativeGoneFailure(401, 'Not signed in') })

    const { uploadEncryptedFileNative } = await loadFreshApi()
    await expect(uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    })).rejects.toMatchObject({ status: 401 })

    expect(nativeUploadCalls).toHaveLength(1)
    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(1)
  })
})
