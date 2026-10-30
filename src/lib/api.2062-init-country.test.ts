// @ts-nocheck
/**
 * Task 2062 — the in-progress upload card names the COUNTRY the server chose
 * at init (`storage_location.country` on the v2 init response, and on the v1
 * init response), not "Europe" until the transfer is done. `UploadProgress.
 * storageCountry` is absent when the server does not send one (an older
 * server, or a resumed session that has no fresh init response); the card
 * then keeps its "Europe" fallback.
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

function initResponse(sessionId: string, opts?: { chunkCount?: number; heartbeatIntervalSecs?: number; leaseSeconds?: number }): () => Promise<Response> {
  return async () => jsonResponse({
    file_id: 'F',
    upload_session_id: sessionId,
    chunk_size_bytes: 4_194_304,
    chunk_count: opts?.chunkCount ?? 1,
    lease_seconds: opts?.leaseSeconds ?? 3600,
    heartbeat_interval_secs: opts?.heartbeatIntervalSecs ?? 9_999, // huge: never fires in a fast test
  })
}

function requestBody(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string)
}

async function loadFreshApi() {
  return import(`./api?init2062=${Math.random()}`)
}

beforeEach(() => {
  store.clear()
  fetchCalls.length = 0
  fetchQueue = []
  heartbeatCalls.length = 0
  uploadAsyncQueue = []
  uploadAsyncCalls.length = 0
})

function initWithLocation(location) {
  return async () => jsonResponse({
    file_id: 'F',
    upload_session_id: 'S1',
    chunk_size_bytes: 4_194_304,
    chunk_count: 1,
    lease_seconds: 3600,
    heartbeat_interval_secs: 9_999,
    ...(location === undefined ? {} : { storage_location: location }),
  })
}

async function run(location) {
  store.set('beebeeb_session_token', 'test-token')
  fetchQueue.push(initWithLocation(location), async () => jsonResponse({ id: 'F', name_encrypted: 'n' }))
  uploadAsyncQueue.push({ status: 200, body: '{}' })
  const events = []
  const { uploadEncryptedChunked } = await loadFreshApi()
  await uploadEncryptedChunked({
    fileId: 'F',
    nameEncrypted: 'n',
    plaintextSizeBytes: 1_000,
    readEncryptedChunk: async () => new Uint8Array(10),
    onProgress: (p) => events.push(p),
  })
  return events
}

describe('uploadEncryptedChunked reports the init country (task 2062)', () => {
  test('every progress event after init carries the country the server named', async () => {
    const events = await run({ region: 'europe', country: 'Finland', country_code: 'FI' })
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.map((e) => e.storageCountry)).toEqual(events.map(() => 'Finland'))
  })

  test('no storage_location (older server) leaves storageCountry absent', async () => {
    const events = await run(undefined)
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.every((e) => e.storageCountry === undefined)).toBe(true)
  })

  test('a null country (unknown pool) is no country, never a guess', async () => {
    const events = await run({ region: 'europe', country: null, country_code: null })
    expect(events.every((e) => e.storageCountry === undefined)).toBe(true)
  })
})

describe('v1 fallback init (task 2062)', () => {
  test('a v2-less server: the v1 init response country reaches the progress events', async () => {
    store.set('beebeeb_session_token', 'test-token')
    fetchQueue.push(
      async () => jsonResponse({ error: 'not found' }, 404), // /uploads/init absent
      async () => jsonResponse({ file_id: 'F', storage_location: { country: 'Germany', country_code: 'DE' } }), // /files/upload/init
    )
    const events = []
    const { uploadEncryptedChunked } = await loadFreshApi()
    fetchQueue.push(async () => jsonResponse({ id: 'F', name_encrypted: 'n' })) // complete
    uploadAsyncQueue.push({ status: 200, body: '{}' })
    await uploadEncryptedChunked({
      fileId: 'F',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1_000,
      readEncryptedChunk: async () => new Uint8Array(10),
      onProgress: (p) => events.push(p),
    })
    // The v1 'preparing' event is emitted BEFORE the v1 init call; everything after carries it.
    const afterInit = events.slice(1)
    expect(afterInit.length).toBeGreaterThan(0)
    expect(afterInit.every((e) => e.storageCountry === 'Germany')).toBe(true)
  })
})
