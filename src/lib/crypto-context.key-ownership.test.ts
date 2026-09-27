// @ts-nocheck
/**
 * Task 1594 [P0] — the master key must be bound to the account that owns it.
 *
 * The bug (proven on the dev DB, see the task file): a key left in the iOS
 * keychain by account A (a sign-in that never signed out, or a reinstall —
 * keychain items survive both) was silently used to unlock account B's vault.
 * `loadVerifiedMasterKeyHandle` only proved the key matched a check value
 * written FROM THE SAME KEY (integrity, not ownership), so B's backup then
 * sealed a whole new folder tree under A's key.
 *
 * These tests drive the REAL `CryptoProvider.unlock()` — no React renderer is
 * installed in this repo, so `react` is replaced by a tiny single-component
 * hook host (useState / useRef slots per mount, effects not run). A "mount" is
 * one provider instance; App.tsx keys CryptoProvider by user id, so a sign-in
 * as another user (or the same user after a session ended) is a NEW mount.
 *
 * Every native module and relative dependency is mocked here (isolated-runner
 * rule, mobile CLAUDE.md "Tests"). `./key-ownership` and `./expected-user` are
 * NOT mocked — they are the code under test.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ─── hook host ───────────────────────────────────────────────────────────────
let currentHost: { slots: any[]; idx: number } | null = null;
function useSlot<T>(init: () => T): T {
  const host = currentHost!;
  const i = host.idx++;
  if (!(i in host.slots)) host.slots[i] = init();
  return host.slots[i];
}
const reactMock = {
  createContext: () => ({ Provider: 'CryptoContext.Provider' }),
  useContext: () => null,
  useState: (initial: unknown) => {
    const cell = useSlot(() => ({ v: typeof initial === 'function' ? (initial as () => unknown)() : initial }));
    return [cell.v, (next: unknown) => { cell.v = typeof next === 'function' ? (next as (p: unknown) => unknown)(cell.v) : next; }];
  },
  useRef: (initial: unknown) => useSlot(() => ({ current: initial })),
  useCallback: (fn: unknown) => { currentHost!.idx++; return fn; },
  useEffect: () => { currentHost!.idx++; },
  useMemo: (fn: () => unknown) => { currentHost!.idx++; return fn(); },
};
mock.module('react', () => ({ default: reactMock, ...reactMock }));
const jsx = (type: unknown, props: unknown) => ({ type, props });
mock.module('react/jsx-runtime', () => ({ jsx, jsxs: jsx, Fragment: 'Fragment' }));
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: jsx, Fragment: 'Fragment' }));

// ─── fixtures ────────────────────────────────────────────────────────────────
const KEY_A = new Uint8Array(32).fill(0xa1);
const KEY_B = new Uint8Array(32).fill(0xb2);
const PHRASE_A = 'phrase-of-account-a';
const PHRASE_B = 'phrase-of-account-b';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const checkOf = (k: Uint8Array) => k.map((x) => x ^ 0x5a);
const pubOf = (k: Uint8Array) => k.map((x) => x ^ 0x33);
const privOf = (k: Uint8Array) => k.map((x) => x ^ 0x77);

// SecureStore labels (the real strings — the fix must not rename them).
const CHECK = 'io.beebeeb.master-key-check';
const FALLBACK = 'io.beebeeb.master-key.fallback';
const OWNER = 'io.beebeeb.master-key-owner';
const SIM_FILE = 'file:///tmp/docs/beebeeb-simulator-master-key.txt';

const secure = new Map<string, string>();
const files = new Map<string, string>();
const handles = new Map<number, Uint8Array>();
let nextHandle = 1;
const calls = {
  createHandle: 0,
  fallbackReads: 0,
  released: [] as number[],
  deleteKeychain: 0,
  verify: [] as string[],
  backfill: [] as string[],
};
const server = {
  reachable: true,
  sessionUser: USER_B as string,
  users: {} as Record<string, { check: string | null; pub: string | null }>,
};

class FakeApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

mock.module('expo-device', () => ({ isDevice: false, modelName: 'iPhone 17 Pro Simulator' }));
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///tmp/docs/',
  cacheDirectory: 'file:///tmp/cache/',
  writeAsStringAsync: async (p: string, v: string) => { files.set(p, v); },
  readAsStringAsync: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)!; },
  deleteAsync: async (p: string) => { files.delete(p); },
  getInfoAsync: async (p: string) => ({ exists: files.has(p) }),
  makeDirectoryAsync: async () => {},
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => {
    if (k === FALLBACK) calls.fallbackReads += 1;
    return secure.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));

const cryptoMock = {
  computeRecoveryCheck: async (k: Uint8Array) => checkOf(k),
  createMasterKeyHandle: async (k: Uint8Array) => {
    calls.createHandle += 1;
    const id = nextHandle++;
    handles.set(id, new Uint8Array(k));
    return id;
  },
  createRequestKeypairWithHandle: async () => ({}),
  decryptNames: async () => [],
  deriveX25519PublicFromPrivate: async (priv: Uint8Array) => priv.map((x) => x ^ 0x77 ^ 0x33),
  handleComputeRecoveryCheck: async (h: number) => checkOf(handles.get(h)!),
  handleDecryptChunk: async () => new Uint8Array(),
  handleDecryptMetadata: async () => '',
  handleDeriveFileKey: async () => new Uint8Array(32),
  handleDeriveX25519Private: async (h: number) => privOf(handles.get(h)!),
  handleEncryptChunk: async () => ({}),
  handleEncryptMetadata: async () => ({}),
  loadKeyFromKeychainAsHandle: async () => null,
  logDiagnostic: () => {},
  recoverFromPhrase: async (phrase: string) => {
    if (phrase === PHRASE_A) return { masterKey: new Uint8Array(KEY_A) };
    if (phrase === PHRASE_B) return { masterKey: new Uint8Array(KEY_B) };
    throw new Error('invalid phrase');
  },
  releaseHandle: async (h: number) => { calls.released.push(h); handles.delete(h); },
  replaceKeychainAccessControl: async () => true,
  replaceKeychainAccessControlFromHandle: async () => true,
  storeKeyInKeychain: async () => { throw new Error('no secure enclave on the simulator'); },
  unwrapRequestPrivateWithHandle: async () => new Uint8Array(32),
  deleteKeyFromKeychain: async () => { calls.deleteKeychain += 1; return true; },
  mirrorSimulatorFileProviderMasterKey: async () => true,
};
mock.module('../../modules/beebeeb-crypto', () => cryptoMock);

mock.module('../services/BackupService', () => ({
  setBackupEncryption: () => {},
  getKeepVaultUnlocked: async () => false,
}));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => null }));
mock.module('./file-request-crypto', () => ({ createRequestKeyResolver: () => ({ clear: () => {} }) }));
mock.module('./recovery-phrase-verify', () => ({ verifyRecoveryPhraseAgainstStoredCheck: async () => false }));
mock.module('./api', () => ({
  ApiError: FakeApiError,
  getToken: async () => 'token',
  getApiUrl: () => 'http://localhost:3001',
  // POST /api/v1/auth/verify-recovery-check — mirrors the server exactly:
  // 400 invalid_recovery_phrase on a mismatch OR when no check is stored.
  verifyRecoveryCheck: async (checkB64: string) => {
    calls.verify.push(checkB64);
    if (!server.reachable) throw new FakeApiError(0, 'Could not reach the server.');
    const stored = server.users[server.sessionUser]?.check ?? null;
    if (stored == null || stored !== checkB64) throw new FakeApiError(400, 'invalid_recovery_phrase');
  },
  // GET /api/v1/auth/public-key/{id} — null on 404.
  getUserPublicKey: async (id: string) => {
    if (!server.reachable) throw new FakeApiError(0, 'Could not reach the server.');
    return server.users[id]?.pub ?? null;
  },
  setRecoveryCheckIfAbsent: async (checkB64: string) => {
    calls.backfill.push(checkB64);
    return { updated: true };
  },
}));

const { CryptoProvider } = await import('./crypto-context');

function mountProvider(userId: string | undefined) {
  const host = { slots: [] as any[], idx: 0 };
  return () => {
    const prev = currentHost;
    currentHost = host;
    host.idx = 0;
    try {
      const el = CryptoProvider({ children: null, userId });
      return el.props.value;
    } finally {
      currentHost = prev;
    }
  };
}

/** A key as a previous (pre-fix or fixed) build left it on this simulator. */
function seedStoredKey(key: Uint8Array, owner: string | null) {
  secure.set(CHECK, b64(checkOf(key)));
  secure.set(FALLBACK, b64(key));
  files.set(SIM_FILE, b64(key));
  if (owner) secure.set(OWNER, owner);
}

function expectKeyPurged() {
  expect(secure.has(CHECK)).toBe(false);
  expect(secure.has(FALLBACK)).toBe(false);
  expect(secure.has(OWNER)).toBe(false);
  expect(files.has(SIM_FILE)).toBe(false);
  expect(calls.deleteKeychain).toBeGreaterThan(0);
}

beforeEach(() => {
  secure.clear();
  files.clear();
  handles.clear();
  nextHandle = 1;
  calls.createHandle = 0;
  calls.fallbackReads = 0;
  calls.released = [];
  calls.deleteKeychain = 0;
  calls.verify = [];
  calls.backfill = [];
  server.reachable = true;
  server.sessionUser = USER_B;
  server.users = {
    [USER_A]: { check: b64(checkOf(KEY_A)), pub: b64(pubOf(KEY_A)) },
    [USER_B]: { check: b64(checkOf(KEY_B)), pub: b64(pubOf(KEY_B)) },
  };
});

describe('1594 — a stored key is only ever used for the account that owns it', () => {
  test("A's key (owner recorded) + B signed in → unlock refused, key purged, phrase required, key never loaded", async () => {
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_B;
    const render = mountProvider(USER_B);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    expectKeyPurged();
    expect(calls.createHandle).toBe(0);
    expect(calls.fallbackReads).toBe(0);
    const after = render();
    expect(after.isUnlocked).toBe(false);
    expect(after.needsRecoveryPhrase).toBe(true);
  });

  test("a legacy key without an owner that verify-recovery-check rejects → locked, purged, phrase required", async () => {
    seedStoredKey(KEY_A, null); // a pre-fix build never recorded an owner
    server.sessionUser = USER_B;
    const render = mountProvider(USER_B);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    expect(calls.verify).toEqual([b64(checkOf(KEY_A))]);
    expectKeyPurged();
    // The handle loaded to derive the public key is released, never kept.
    expect(calls.released.length).toBe(calls.createHandle);
    const after = render();
    expect(after.isUnlocked).toBe(false);
    expect(after.needsRecoveryPhrase).toBe(true);
  });

  test('a legacy key that verify-recovery-check accepts → unlocked, owner recorded', async () => {
    seedStoredKey(KEY_A, null);
    server.sessionUser = USER_A;
    const render = mountProvider(USER_A);

    await render().unlock();

    expect(render().isUnlocked).toBe(true);
    expect(calls.verify).toEqual([b64(checkOf(KEY_A))]);
    expect(secure.get(OWNER)).toBe(USER_A);
    expect(calls.deleteKeychain).toBe(0);
  });

  test("session expired (no sign-out) → B signs in → A's key purged before any key load", async () => {
    seedStoredKey(KEY_A, null);
    server.sessionUser = USER_A;
    const renderA = mountProvider(USER_A);
    await renderA().unlock();
    expect(renderA().isUnlocked).toBe(true);
    const loadsAfterA = calls.createHandle;
    const readsAfterA = calls.fallbackReads;

    // The 401 path only does setUser(null): no signOut(), so no purge there.
    // App.tsx re-keys CryptoProvider → a fresh mount for B.
    server.sessionUser = USER_B;
    const renderB = mountProvider(USER_B);
    await expect(renderB().unlock()).rejects.toThrow(/no master key in keychain/i);

    expect(calls.createHandle).toBe(loadsAfterA);
    expect(calls.fallbackReads).toBe(readsAfterA);
    expectKeyPurged();
    expect(renderB().needsRecoveryPhrase).toBe(true);
  });

  test('the same user signing in again keeps the key (re-verified once per sign-in)', async () => {
    seedStoredKey(KEY_A, null);
    server.sessionUser = USER_A;
    const first = mountProvider(USER_A);
    await first().unlock();
    const second = mountProvider(USER_A);
    await second().unlock();
    await second().unlock(); // already unlocked → no second verification

    expect(second().isUnlocked).toBe(true);
    expect(calls.deleteKeychain).toBe(0);
    expect(secure.get(FALLBACK)).toBe(b64(KEY_A));
    expect(secure.get(OWNER)).toBe(USER_A);
    expect(calls.verify.length).toBe(2);
  });

  test('verification unreachable + a key with no recorded owner → not unlocked, NOT purged, no recovery prompt', async () => {
    seedStoredKey(KEY_A, null);
    server.sessionUser = USER_A;
    server.reachable = false;
    const render = mountProvider(USER_A);

    await expect(render().unlock()).rejects.toThrow();

    const after = render();
    expect(after.isUnlocked).toBe(false);
    expect(after.needsRecoveryPhrase).toBe(false);
    expect(secure.get(FALLBACK)).toBe(b64(KEY_A));
    expect(calls.deleteKeychain).toBe(0);
    expect(calls.released.length).toBe(calls.createHandle);
  });

  test('verification unreachable + the key already bound to this user → unlocks (offline-tolerant)', async () => {
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_A;
    server.reachable = false;
    const render = mountProvider(USER_A);

    await render().unlock();
    expect(render().isUnlocked).toBe(true);
  });

  test("an account with no stored recovery_check is proven by its x25519 public key (and backfilled)", async () => {
    seedStoredKey(KEY_A, null);
    server.sessionUser = USER_A;
    server.users[USER_A].check = null; // legacy account (task 0875)
    const render = mountProvider(USER_A);

    await render().unlock();

    expect(render().isUnlocked).toBe(true);
    expect(secure.get(OWNER)).toBe(USER_A);
    expect(calls.backfill).toEqual([b64(checkOf(KEY_A))]);
  });

  test('no signed-in user → the keychain key is not loaded at all', async () => {
    seedStoredKey(KEY_A, USER_A);
    const render = mountProvider(undefined);

    await expect(render().unlock()).rejects.toThrow();

    expect(render().isUnlocked).toBe(false);
    expect(calls.createHandle).toBe(0);
    expect(calls.fallbackReads).toBe(0);
    expect(secure.get(FALLBACK)).toBe(b64(KEY_A)); // not a purge — nobody to compare with
  });
});

describe('1594 — the recovery phrase must belong to the signed-in account', () => {
  test("B entering A's phrase is refused and nothing is stored", async () => {
    server.sessionUser = USER_B;
    const render = mountProvider(USER_B);

    await expect(render().unlock(PHRASE_A)).rejects.toThrow(/different account/i);

    expect(render().isUnlocked).toBe(false);
    expect(secure.has(FALLBACK)).toBe(false);
    expect(secure.has(CHECK)).toBe(false);
    expect(files.has(SIM_FILE)).toBe(false);
    expect(calls.released.length).toBe(calls.createHandle);
  });

  test("B entering B's phrase over A's leftover key → unlocked, B's key stored and bound to B", async () => {
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_B;
    const render = mountProvider(USER_B);

    await render().unlock(PHRASE_B);

    expect(render().isUnlocked).toBe(true);
    expect(secure.get(FALLBACK)).toBe(b64(KEY_B));
    expect(secure.get(CHECK)).toBe(b64(checkOf(KEY_B)));
    expect(secure.get(OWNER)).toBe(USER_B);
  });

  test('phrase verification unreachable → refused, nothing stored', async () => {
    server.sessionUser = USER_B;
    server.reachable = false;
    const render = mountProvider(USER_B);

    await expect(render().unlock(PHRASE_B)).rejects.toThrow();
    expect(secure.has(FALLBACK)).toBe(false);
  });
});

describe('1594 — X-Beebeeb-Expected-User follows the unlocked key', () => {
  test("unlock publishes the key owner's id; lock() withdraws it", async () => {
    const { getExpectedUserId, setExpectedUserId } = await import('./expected-user');
    // Earlier tests leave providers "mounted" (the host never runs unmount
    // effects), so start from a clean module state.
    setExpectedUserId(null);
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_A;
    const render = mountProvider(USER_A);

    expect(getExpectedUserId()).toBeNull();
    await render().unlock();
    expect(getExpectedUserId()).toBe(USER_A);
    render().lock();
    expect(getExpectedUserId()).toBeNull();
  });
});
