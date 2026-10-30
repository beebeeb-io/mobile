// @ts-nocheck
/**
 * Task SF-0001 (contract 2275 L13) — the owner writes on mobile only under an
 * id the client chose.
 *
 * Covers the frozen §7 rows for this client:
 *  - A7: every create/init/completion answer is compared with the id this
 *    client proposed; a difference aborts with `server_changed_item_id` before
 *    any seal, rename, chunk PUT or destination use.
 *  - A7b: a new-file v2 init carries the client's own id.
 *  - A7c: a persisted session without the self-minted marker (or naming a
 *    different id) is abandoned and restarted under a fresh own id; one with
 *    the marker and a matching id resumes.
 *  - A8: a folder create whose answer differs is aborted — nothing goes in.
 *
 * Isolated per bun:test-per-file semantics (mobile CLAUDE.md, "Tests").
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()
const fetchCalls: Array<{ url: string; init: RequestInit }> = []
let fetchQueue: Array<() => Promise<Response>> = []
const uploadAsyncQueue: Array<{ status: number; body: string }> = []
const uploadAsyncCalls: Array<{ url: string; options: Record<string, unknown> }> = []
let nativeAvailable = false
const nativeCalls: Array<Record<string, unknown>> = []

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
  readAsStringAsync: async () => '',
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
  isNativeUploadAvailable: () => nativeAvailable,
  planUploadChunksNative: () => ({ chunkSizeBytes: 8, chunkCount: 1 }),
  uploadChunksNative: async (req: Record<string, unknown>) => {
    nativeCalls.push(req)
    return { id: req.fileId, name_encrypted: 'n', encryptedUnderFileId: req.fileId }
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

const TOKEN_KEY = 'beebeeb_session_token'
const CLIENT_ID = '11111111-2222-4333-8444-555555555555'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function initAnswer(fileId: string, sessionId = 'S1', chunkCount = 1) {
  return async () => jsonResponse({
    file_id: fileId,
    upload_session_id: sessionId,
    chunk_size_bytes: 4_194_304,
    chunk_count: chunkCount,
    lease_seconds: 3600,
    heartbeat_interval_secs: 9_999,
  })
}

function requestBody(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string)
}

async function loadFreshApi() {
  return import(`./api?idEchoTest=${Math.random()}`)
}

beforeEach(() => {
  store.clear()
  store.set(TOKEN_KEY, 'test-token')
  fetchCalls.length = 0
  fetchQueue = []
  uploadAsyncQueue.length = 0
  uploadAsyncCalls.length = 0
  nativeCalls.length = 0
  nativeAvailable = false
})

describe('A7 — a create whose answer echoes another id is aborted', () => {
  test('v2 init echoing a different id aborts before any chunk PUT, complete or seal', async () => {
    fetchQueue.push(initAnswer('server-chosen-id'))
    const { uploadEncryptedChunked, ServerChangedItemIdError } = await loadFreshApi()

    const err = await uploadEncryptedChunked({
      fileId: CLIENT_ID,
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    }).catch((e) => e)

    expect(err).toBeInstanceOf(ServerChangedItemIdError)
    expect(err.code).toBe('server_changed_item_id')
    expect(err.message).toBe('The server answered with a different item. Nothing was uploaded under it.')
    expect(uploadAsyncCalls).toHaveLength(0)
    expect(fetchCalls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(0)
  })

  test('the native path aborts before the engine encrypts or PUTs under the echoed id', async () => {
    nativeAvailable = true
    fetchQueue.push(initAnswer('server-chosen-id'))
    const { uploadEncryptedFileNative, ServerChangedItemIdError } = await loadFreshApi()

    const err = await uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: CLIENT_ID,
      inputUri: 'file:///cache/a.bin',
      nameEncrypted: 'n',
      plaintextSizeBytes: 100,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(ServerChangedItemIdError)
    expect(nativeCalls).toHaveLength(0)
  })

  test('a completion answer naming a different id aborts before the name is patched', async () => {
    fetchQueue.push(
      initAnswer(CLIENT_ID),
      async () => jsonResponse({}, 200), // chunk 0
      async () => jsonResponse({ id: 'server-chosen-id', name_encrypted: 'n' }, 200), // complete
    )
    uploadAsyncQueue.push({ status: 200, body: '{}' })
    const { uploadEncryptedChunked, ServerChangedItemIdError } = await loadFreshApi()

    const err = await uploadEncryptedChunked({
      fileId: CLIENT_ID,
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    }).catch((e) => e)

    expect(err).toBeInstanceOf(ServerChangedItemIdError)
    // No rename/patch was issued for the echoed id.
    expect(fetchCalls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(0)
  })
})

describe('A7b — a new-file v2 init carries the id this client minted', () => {
  test('the init body proposes the client id and the upload completes under it', async () => {
    fetchQueue.push(
      initAnswer(CLIENT_ID),
      async () => jsonResponse({ id: CLIENT_ID, name_encrypted: 'n' }, 200),
    )
    uploadAsyncQueue.push({ status: 200, body: '{}' })
    const { uploadEncryptedChunked } = await loadFreshApi()

    const result = await uploadEncryptedChunked({
      fileId: CLIENT_ID,
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
    })

    const initCalls = fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))
    expect(initCalls).toHaveLength(1)
    expect(requestBody(initCalls[0]).file_id).toBe(CLIENT_ID)
    expect(result.id).toBe(CLIENT_ID)
  })
})

describe('A7c — persisted sessions', () => {
  test('a legacy session with no self-minted marker is abandoned, then restarted under the client id', async () => {
    const legacyFileId = 'server-chosen-id'
    store.set('beebeeb_upload_resume_rk', JSON.stringify({
      protocol: 'v2',
      fileId: legacyFileId,
      uploadSessionId: 'OLD-SESSION',
      chunkSizeBytes: 4_194_304,
      chunkCount: 1,
      plaintextSizeBytes: 1_000,
      parentId: null,
      mimeType: null,
      lastUploadedChunkIndex: 0,
      // no selfMinted marker — pre-update state
    }))
    fetchQueue.push(
      async () => jsonResponse({}, 200), // POST /files/server-chosen-id/upload/abandon
      initAnswer(CLIENT_ID, 'S2'),
      async () => jsonResponse({ id: CLIENT_ID, name_encrypted: 'n' }, 200),
    )
    uploadAsyncQueue.push({ status: 200, body: '{}' })
    const { uploadEncryptedChunked } = await loadFreshApi()

    const result = await uploadEncryptedChunked({
      fileId: CLIENT_ID,
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      resumeKey: 'rk',
      readEncryptedChunk: async () => new Uint8Array(10),
    })

    // Abandoned the stored id — never resumed it.
    expect(fetchCalls[0].url).toBe('https://api.test/api/v1/files/server-chosen-id/upload/abandon')
    expect(uploadAsyncCalls.every((c) => !c.url.includes('OLD-SESSION'))).toBe(true)
    // Restarted under the id this client owns.
    const initCalls = fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))
    expect(initCalls).toHaveLength(1)
    expect(requestBody(initCalls[0]).file_id).toBe(CLIENT_ID)
    expect(result.id).toBe(CLIENT_ID)
  })

  test('a session with the marker and the same id resumes without a fresh init', async () => {
    store.set('beebeeb_upload_resume_rk', JSON.stringify({
      protocol: 'v2',
      fileId: CLIENT_ID,
      uploadSessionId: 'S1',
      chunkSizeBytes: 4_194_304,
      chunkCount: 1,
      plaintextSizeBytes: 1_000,
      parentId: null,
      mimeType: null,
      lastUploadedChunkIndex: -1,
      selfMinted: true,
    }))
    fetchQueue.push(
      async () => jsonResponse({ id: CLIENT_ID, name_encrypted: 'n' }, 200), // complete only
    )
    uploadAsyncQueue.push({ status: 200, body: '{}' })
    const { uploadEncryptedChunked } = await loadFreshApi()

    const result = await uploadEncryptedChunked({
      fileId: CLIENT_ID,
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      resumeKey: 'rk',
      readEncryptedChunk: async () => new Uint8Array(10),
    })

    expect(fetchCalls.filter((c) => c.url.endsWith('/uploads/init'))).toHaveLength(0)
    expect(uploadAsyncCalls[0].url).toBe('https://api.test/api/v1/uploads/S1/chunks/0')
    expect(result.id).toBe(CLIENT_ID)
  })
})

describe('A8 — a folder create whose answer differs is aborted', () => {
  test('createFolder rejects and the caller never enters the folder', async () => {
    fetchQueue.push(async () => jsonResponse({ id: 'server-chosen-folder', name_encrypted: 'e' }))
    const { createFolder, ServerChangedItemIdError } = await loadFreshApi()

    const err = await createFolder('enc', undefined, CLIENT_ID).catch((e) => e)
    expect(err).toBeInstanceOf(ServerChangedItemIdError)
    const body = requestBody(fetchCalls[0])
    expect(body.folder_id).toBe(CLIENT_ID)
  })

  test('a matching echo returns the client-chosen folder', async () => {
    fetchQueue.push(async () => jsonResponse({ id: CLIENT_ID, name_encrypted: 'e' }))
    const { createFolder } = await loadFreshApi()
    const created = await createFolder('enc', undefined, CLIENT_ID)
    expect(created.id).toBe(CLIENT_ID)
  })
})
