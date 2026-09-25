// @ts-nocheck
/**
 * Task 1539 (finding 4) — passphrase-protected share links were completely
 * unusable on iOS: the server's ONLY field spelling is `requires_passphrase`
 * (repos/server/beebeeb-api/src/routes/shares.rs:747/968), the mobile
 * `ShareInfo` type declared `passphrase_required` (a field the server never
 * sends), there was no `verifySharePassphrase` API function at all (web has
 * one, repos/web/src/lib/api.ts), and a 401 from a missing/wrong passphrase
 * surfaced the raw server string "unauthorized" to the user instead of an
 * honest message.
 *
 * RED on main:
 *   1. `verifySharePassphrase` does not exist on main's `src/lib/api.ts` at
 *      all — `import { verifySharePassphrase } ...` fails:
 *        error: export 'verifySharePassphrase' not found in './api'
 *   2. `downloadSharedFileBlob`'s 401 branch on main does
 *        `throw new ApiError(res.status, err.error ?? err.message ?? ...)`
 *      with no remapping, so a 401 body `{"error":"unauthorized"}` throws
 *      an ApiError whose `.message` is literally `"unauthorized"` — the
 *      "leaks a raw internal error string" assertion below fails on main.
 * Both failures are pasted into the task file's Notes section.
 *
 * Isolated per bun:test-per-file semantics (mobile/CLAUDE.md "Tests") —
 * every native module `api.ts` touches is mocked here, same scaffold as
 * `api.delete-account.test.ts` / `api-client-session.test.ts`.
 */
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

mock.module('expo-file-system/legacy', () => ({}));

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
  return import(`./api?sharePassphraseTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

describe('getShareByToken — requires_passphrase field name (finding 4)', () => {
  test('a passphrase-gated share is read through requires_passphrase, matching the server field', async () => {
    fetchQueue.push(async () => jsonResponse({
      id: 'share-1',
      share_type: 'file',
      requires_passphrase: true,
      expires_at: null,
    }));

    const { getShareByToken } = await loadFreshApi();
    const info = await getShareByToken('tok123');

    // This is the exact assertion that fails on main: the type/UI read
    // `passphrase_required`, a key this response never has, so the gate
    // could never render.
    expect(info.requires_passphrase).toBe(true);
    expect((info as Record<string, unknown>).passphrase_required).toBeUndefined();
  });
});

describe('verifySharePassphrase (finding 4)', () => {
  test('POSTs {passphrase} to /verify and returns the full share metadata on success', async () => {
    fetchQueue.push(async () => jsonResponse({
      id: 'share-1',
      share_type: 'file',
      file_name_encrypted: 'encrypted-name',
      size_bytes: 4096,
      wrapped_file_key: 'd2VpcmRieXRlcw==',
    }));

    const { verifySharePassphrase } = await loadFreshApi();
    const result = await verifySharePassphrase('tok123', 'correct horse battery staple');

    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0];
    expect(url).toBe('https://api.test/api/v1/shares/tok123/verify');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ passphrase: 'correct horse battery staple' });
    // Public endpoint — no auth header should be sent.
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    expect(result.file_name_encrypted).toBe('encrypted-name');
    expect(result.wrapped_file_key).toBe('d2VpcmRieXRlcw==');
  });

  test('a wrong passphrase (server 401 "unauthorized") throws an honest message, not the raw server string', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'unauthorized' }, 401));

    const { ApiError, verifySharePassphrase } = await loadFreshApi();
    const err = await verifySharePassphrase('tok123', 'wrong-guess').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    // This is the finding-4 leak: on main this assertion fails because
    // err.message is literally the string "unauthorized".
    expect(err.message).not.toBe('unauthorized');
    expect(err.message.toLowerCase()).toContain('passphrase');
  });
});

describe('downloadSharedFileBlob — passphrase header + honest 401 (finding 4)', () => {
  test('forwards a provided passphrase as X-Share-Passphrase', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    fetchQueue.push(async () => new Response(body, {
      status: 200,
      headers: { 'X-Chunk-Count': '1', 'X-Chunk-Size': '4', 'X-Original-Size': '4' },
    }));

    const { downloadSharedFileBlob } = await loadFreshApi();
    await downloadSharedFileBlob('tok123', 'the-passphrase');

    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0];
    expect(url).toBe('https://api.test/api/v1/shares/tok123/download');
    expect((init.headers as Record<string, string>)['X-Share-Passphrase']).toBe('the-passphrase');
  });

  test('a missing/wrong passphrase 401 throws an honest message, not the raw "unauthorized" string', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'unauthorized' }, 401));

    const { ApiError, downloadSharedFileBlob } = await loadFreshApi();
    const err = await downloadSharedFileBlob('tok123').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).not.toBe('unauthorized');
    expect(err.message.toLowerCase()).toContain('passphrase');
  });
});
