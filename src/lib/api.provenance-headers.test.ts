// @ts-nocheck
/**
 * Task 1436 (the mobile half of 1392) — writer-provenance headers.
 *
 * `mobileClientHeaders()` already sent `X-Beebeeb-Client: mobile-ios` /
 * `mobile-android` on the 5 unauthenticated auth-bootstrap calls (signup,
 * login, opaque login-finish, 2FA verify, opaque register-finish). This adds
 * `X-Beebeeb-Client-Version` next to it there.
 *
 * IMPORTANT finding during this task: `mobileClientHeaders()` was NOT wired
 * into any of the upload-init call sites (`/api/v1/files/upload/init`,
 * `/api/v1/uploads/init`) — the actual requests that create the
 * `object_versions` row the server records these headers on (server PR #23 /
 * task 1369). Mobile writer-provenance was 100% blank before this change,
 * not just missing the version (the task file's premise, based on an earlier
 * shallow grep, understated the gap). This test suite covers both: the
 * pre-existing auth-bootstrap sites (version added) AND the upload-init
 * sites (both headers added, newly).
 *
 * Isolated per bun:test-per-file semantics — every native module this file
 * needs is mocked here (see mobile/CLAUDE.md "Tests"), mirroring
 * api.native-upload.test.ts's pattern exactly.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];
const nativeUploadCalls: Array<Record<string, unknown>> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));

// No `version` on expoConfig here — proves the '1.0.0' fallback (matching
// device-registration.ts's existing convention) rather than a crash/undefined.
mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}));

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('expo-file-system/legacy', () => ({}));

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => true,
  planUploadChunksNative: () => ({ chunkSizeBytes: 4_194_304, chunkCount: 1 }),
  uploadChunksNative: async (params: Record<string, unknown>) => {
    nativeUploadCalls.push(params);
    return { chunksUploaded: 1, bytesUploaded: 0, bytesTotal: 0, cryptoBytesPerSec: 0 };
  },
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadFreshApi() {
  return import(`./api?provenanceHeadersTest=${Math.random()}`);
}

function headerValue(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  nativeUploadCalls.length = 0;
});

describe('writer-provenance headers on auth-bootstrap calls (1436)', () => {
  test('login() sends X-Beebeeb-Client-Version alongside the existing X-Beebeeb-Client', async () => {
    fetchQueue.push(async () => jsonResponse({
      user_id: 'u1',
      session_token: 'tok',
      device_confirmation_secret: 'secret',
      created_at: new Date().toISOString(),
    }));

    const { login } = await loadFreshApi();
    await login('test@beebeeb.io', 'password');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/v1/auth/login');
    expect(headerValue(fetchCalls[0].init, 'X-Beebeeb-Client')).toBe('mobile-ios');
    // No version in the mocked expoConfig -> falls back to '1.0.0', proving
    // the fallback path (not just the happy path where it's configured).
    expect(headerValue(fetchCalls[0].init, 'X-Beebeeb-Client-Version')).toBe('1.0.0');
  });
});

describe('writer-provenance headers on upload-init calls (1436 — the actual gap)', () => {
  test('a fresh native upload sends both headers on POST /api/v1/uploads/init', async () => {
    store.set('beebeeb_session_token', 'test-token');
    fetchQueue.push(
      // POST /api/v1/uploads/init
      async () => jsonResponse({
        file_id: 'SERVER-ID',
        upload_session_id: 'upload-session-1',
        chunk_size_bytes: 4_194_304,
        chunk_count: 1,
      }),
      // POST /api/v1/uploads/:id/complete
      async () => jsonResponse({ id: 'SERVER-ID', name_encrypted: 'name-cipher' }),
    );

    const { uploadEncryptedFileNative } = await loadFreshApi();
    await uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    });

    const initCall = fetchCalls.find((c) => c.url.includes('/api/v1/uploads/init'));
    expect(initCall).toBeDefined();
    expect(headerValue(initCall!.init, 'X-Beebeeb-Client')).toBe('mobile-ios');
    expect(headerValue(initCall!.init, 'X-Beebeeb-Client-Version')).toBe('1.0.0');
  });
});
