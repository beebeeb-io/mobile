// @ts-nocheck
// Task 1685 fix 7 — the durable resume POINTER that makes a post-crash
// placeholder row resumable.
//
// The primary resume state is keyed by hash(parentId|uri|name|mime|size),
// which is uncomputable after a relaunch (uri/name unknown). api.ts therefore
// ALSO records a per-file pointer (`beebeeb_upload_resume_file_<fileId>`)
// once per attempt, carrying everything a tapped row needs to re-run the
// attempt. These tests drive a REAL uploadEncryptedChunked round-trip against
// a mocked fetch queue and SecureStore, and prove:
//  1. a successful upload records the pointer AND clears it on completion;
//  2. a mid-upload failure keeps the pointer (that is the crash case).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}));

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

const uploads: Array<{ url: string; httpMethod: string }> = [];
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///docs/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  FileSystemUploadType: { BINARY_CONTENT: 1 },
  FileSystemSessionType: { FOREGROUND: 1 },
  getInfoAsync: async (uri: string) => ({ exists: true, size: 10, uri }),
  readAsStringAsync: async (_uri: string, _opts?: unknown) => {
    // 10 zero bytes → base64 (AAAA...A). Position/length ignored: every chunk
    // read returns the same 10 plaintext bytes.
    return 'AAAAAAAAAAAAAA==';
  },
  writeAsStringAsync: async () => {},
  deleteAsync: async () => {},
  copyAsync: async () => {},
  uploadAsync: async (url: string, _uri: string, opts: { httpMethod: string }) => {
    uploads.push({ url, httpMethod: opts.httpMethod });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected upload: ${url}`);
    return next();
  },
}));

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
  opaqueLoginStart: async () => { throw new Error('opaque not mocked in this test'); },
  generateRandomBytes: async (n: number) => new Uint8Array(n).fill(7),
}));

mock.module('./file-index-cache', () => ({
  clearCachedFileIndex: async () => {},
}));

mock.module('./sync-client', () => ({
  getDeviceId: async () => 'device-1',
}));

mock.module('./announcement-context', () => ({
  setAnnouncement: () => {},
  clearAnnouncement: () => {},
}));

mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));

const UPLOAD_URI = 'file:///cache/upload-abc-photo.jpg';

const TOKEN_KEY = 'beebeeb_session_token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadFreshApi() {
  return import(`./api?resumePointerTest=${Math.random()}`);
}

async function loadFreshEncryptedUpload() {
  return import(`./encrypted-upload?resumePointerTest=${Math.random()}`);
}

function encryptChunkStub(fileId: string, plaintext: Uint8Array) {
  void fileId;
  return Promise.resolve({
    nonce: new Uint8Array(12).fill(1),
    ciphertext: new Uint8Array(plaintext.length + 16).fill(2),
    cipherSuite: 'aes-256-gcm',
  });
}

function encryptMetadataStub(_fileId: string, metadata: string) {
  // Deterministic: nonce all-zeros, ciphertext = the metadata bytes twice so
  // the finalize name-patch sees an UNCHANGED name and skips the patch call.
  const plain = new TextEncoder().encode(metadata);
  const ciphertext = new Uint8Array(plain.length * 2);
  ciphertext.set(plain, 0);
  ciphertext.set(plain, plain.length);
  return Promise.resolve({ nonce: new Uint8Array(12), ciphertext, cipherSuite: 'aes-256-gcm' });
}

const FILE_ENTRY = {
  id: 'server-1',
  name_encrypted: 'enc',
  mime_type: null,
  size_bytes: 66,
  is_folder: false,
  chunk_count: 2,
  created_at: '2026-10-02T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  version_number: 1,
};

function queueSuccessfulV2Upload(): void {
  fetchQueue.push(async () => jsonResponse({
    file_id: 'server-1',
    upload_session_id: 'us-1',
    chunk_size_bytes: 8,
    chunk_count: 2,
    lease_seconds: 60,
    heartbeat_interval_secs: 5,
  }));
  fetchQueue.push(async () => jsonResponse({}, 200)); // chunk 0 PUT
  fetchQueue.push(async () => jsonResponse({}, 200)); // chunk 1 PUT
  fetchQueue.push(async () => jsonResponse(FILE_ENTRY, 200)); // complete
}

beforeEach(() => {
  store.clear();
  store.set(TOKEN_KEY, 'session-token');
  fetchCalls.length = 0;
  fetchQueue = [];
  uploads.length = 0;
});

async function runUpload(): Promise<{ api: Awaited<ReturnType<typeof loadFreshApi>>; error?: unknown }> {
  const api = await loadFreshApi();
  const { encryptedUpload } = await loadFreshEncryptedUpload();
  try {
    await encryptedUpload({
      fileId: 'client-1',
      uri: UPLOAD_URI,
      name: 'photo.jpg',
      parentId: 'parent-1',
      mimeType: 'image/jpeg',
      encryptChunkFn: encryptChunkStub,
      encryptMetadataFn: encryptMetadataStub,
    });
    return { api };
  } catch (err) {
    return { api, error: err };
  }
}

describe('per-file resume pointer (task 1685 fix 7)', () => {
  test('a completed upload leaves NO resume pointer (nothing left to resume)', async () => {
    queueSuccessfulV2Upload();
    const { api, error } = await runUpload();
    expect(error).toBeUndefined();

    const pointer = await api.getUploadResumeForFile('server-1');
    expect(pointer).toBeNull();
    expect(store.get('beebeeb_upload_resume_file_server-1')).toBeUndefined();
  });

  test('a mid-upload failure KEEPS the pointer with everything a row tap needs', async () => {
    fetchQueue.push(async () => jsonResponse({
      file_id: 'server-1',
      upload_session_id: 'us-1',
      chunk_size_bytes: 8,
      chunk_count: 2,
      lease_seconds: 60,
      heartbeat_interval_secs: 5,
    }));
    fetchQueue.push(async () => jsonResponse({ error: 'network dropped' }, 500));

    const { api, error } = await runUpload();
    expect(error).toBeDefined();

    const pointer = await api.getUploadResumeForFile('server-1');
    expect(pointer).not.toBeNull();
    expect(pointer.fileId).toBe('server-1');
    expect(pointer.sourceUri).toBe(UPLOAD_URI);
    expect(pointer.name).toBe('photo.jpg');
    expect(pointer.parentId).toBe('parent-1');
    expect(pointer.mimeType).toBe('image/jpeg');
    expect(pointer.plaintextSizeBytes).toBe(10);
    expect(typeof pointer.resumeKey).toBe('string');
    expect(pointer.resumeKey.length).toBeGreaterThan(0);
    // The pointer must point at a REAL primary resume state.
    expect(store.get(`beebeeb_upload_resume_${pointer.resumeKey}`)).not.toBeNull();
  });

  test('forgetUploadResume removes the pointer; a bogus stored entry reads as null', async () => {
    store.set('beebeeb_upload_resume_file_x', JSON.stringify({
      fileId: 'x', resumeKey: 'k', sourceUri: 'file:///cache/a', name: 'a.jpg',
      parentId: null, mimeType: null, plaintextSizeBytes: 1,
    }));
    const api = await loadFreshApi();
    expect(await api.getUploadResumeForFile('x')).not.toBeNull();
    await api.forgetUploadResume('x');
    expect(await api.getUploadResumeForFile('x')).toBeNull();

    store.set('beebeeb_upload_resume_file_y', '{not json');
    expect(await api.getUploadResumeForFile('y')).toBeNull();
  });
});