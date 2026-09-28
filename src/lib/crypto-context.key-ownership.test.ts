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
// Task 1594 round 3 (T1): `cleanups` collects the return values of any
// `useEffect(fn, [])` (mount-once, "on unmount" pattern) run for this host —
// see `useEffect` below and `mountProvider().unmount()`. Every OTHER effect
// (non-empty deps) is still never run, exactly as before this addition —
// unchanged for all pre-existing tests in this file.
let currentHost: { slots: any[]; idx: number; cleanups: Array<() => void> } | null = null;
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
  // Task 1594 round 3 (T1): a `[]`-deps effect (the mount-once "release on
  // unmount" pattern) is run ONCE per host — slot-cached like any other hook
  // — and its returned cleanup is collected so a test can invoke it later via
  // `mountProvider(...).unmount()`, simulating a real unmount. Every other
  // `useEffect` call (non-empty deps) is left exactly as before: never run.
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    if (deps && deps.length === 0) {
      const cell = useSlot(() => ({ cleanup: fn() as (() => void) | void }));
      if (typeof cell.cleanup === 'function') currentHost!.cleanups.push(cell.cleanup);
      return;
    }
    currentHost!.idx++;
  },
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
  // Task 1594 round 4 (F4): every handle id `confirmMasterKeyHandle` was
  // called with, in call order.
  confirmed: [] as number[],
  // Task 1594 round 4 (R4): every value `mirrorSessionUserId` (the native
  // call underneath `mirrorSignedInUserId`) was called with, in call order.
  // NOTE: this test harness never runs a `useEffect` with non-empty deps
  // (see the T1-era comment on the `useEffect` mock below), so the mount
  // effect that also calls `mirrorSignedInUserId` never fires here — every
  // entry recorded in a test is from `unlock()`'s own round-4 call.
  mirroredSignedInUser: [] as (string | null)[],
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
// Task 1594 round 3 (T3): a one-shot failure injected into the NEXT write of
// a specific SecureStore key — used to prove `writeKeyOwner()` failing after
// a successful verify releases the handle instead of leaking it.
let failNextWriteOf: string | null = null;
// Task 1594 round 6 (reviewer follow-up): a one-shot failure injected into
// the NEXT `confirmMasterKeyHandle` call — proves the failure is traced
// instead of silently swallowed.
let failNextConfirm = false;
// Task 1594 round 4 (Codex P1, crypto-context.tsx:763): a one-shot PAUSE
// (not failure) injected into the NEXT write of a specific SecureStore key —
// lets a test hold `storeMasterKey()` itself paused mid-write (i.e. AFTER
// its ownership verdict already resolved and its `disposedRef` check already
// passed) so it can unmount the provider from underneath it and prove the
// generation check inside `storeMasterKey` catches what `disposedRef`
// (checked only before `storeMasterKey` is called) cannot.
let pauseNextWriteOf: string | null = null;
let writePauseGate: Promise<void> | null = null;
let releaseWritePauseFn: (() => void) | null = null;
let writePauseEnteredPromise: Promise<void> | null = null;
let resolveWritePauseEntered: (() => void) | null = null;
function armWritePause(key: string) {
  pauseNextWriteOf = key;
  writePauseGate = new Promise<void>((resolve) => { releaseWritePauseFn = resolve; });
  writePauseEnteredPromise = new Promise<void>((resolve) => { resolveWritePauseEntered = resolve; });
}
// Task 1594 round 4: a reentrancy detector on `setItemAsync` — counts how
// many calls are simultaneously "open" (entered but not yet returned).
// Without serialization, two overlapping `storeMasterKey()` calls (A's
// abandoned one, still paused; B's fresh one, running concurrently) can each
// have a `setItemAsync` call open at the same time — `maxSecureWriteDepth`
// would exceed 1. The round-4 queue in `crypto-context.tsx` must keep this at
// 1: B's entire write sequence cannot start until A's has fully finished.
let secureWriteDepth = 0;
let maxSecureWriteDepth = 0;
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => {
    if (k === FALLBACK) calls.fallbackReads += 1;
    return secure.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    secureWriteDepth += 1;
    maxSecureWriteDepth = Math.max(maxSecureWriteDepth, secureWriteDepth);
    try {
      if (failNextWriteOf === k) {
        failNextWriteOf = null;
        throw new Error('SecureStore write failed (simulated, task 1594 T3)');
      }
      if (pauseNextWriteOf === k) {
        pauseNextWriteOf = null;
        resolveWritePauseEntered?.();
        await writePauseGate;
      }
      secure.set(k, v);
    } finally {
      secureWriteDepth -= 1;
    }
  },
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
  confirmMasterKeyHandle: async (h: number) => {
    if (failNextConfirm) {
      failNextConfirm = false;
      throw new Error('confirmMasterKeyHandle failed (simulated, task 1594 round 6)');
    }
    calls.confirmed.push(h);
    return true;
  },
  createRequestKeypairWithHandle: async () => ({}),
  decryptNames: async () => [],
  mirrorSessionUserId: async (userId: string | null) => { calls.mirroredSignedInUser.push(userId); return true; },
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
// Task 1594 round 6 (reviewer follow-up): recorded (not just a no-op) so a
// test can prove a specific trace fired — no existing test in this file
// asserts on trace content, so this is purely additive.
const traceCalls: Array<{ name: string; fields: Record<string, unknown> }> = [];
mock.module('./runtime-trace', () => ({
  recordRuntimeTrace: (name: string, fields: Record<string, unknown> = {}) => { traceCalls.push({ name, fields }); return null; },
}));
mock.module('./file-request-crypto', () => ({ createRequestKeyResolver: () => ({ clear: () => {} }) }));
mock.module('./recovery-phrase-verify', () => ({ verifyRecoveryPhraseAgainstStoredCheck: async () => false }));
// Task 1594 round 3 (T1): a one-shot gate that pauses `verifyRecoveryCheck`
// for ONE specific check value (keyed by value, since the endpoint itself
// takes no user id) — lets a test hold an unlock() paused mid-server-verify
// so it can unmount the provider before letting the verdict resolve. Every
// OTHER call (a different check value, or when no gate is armed) is
// untouched — the existing tests above never arm it, so they see no change.
let gatedCheckB64: string | null = null;
let pendingGate: Promise<void> | null = null;
let releaseGateFn: (() => void) | null = null;
let verifyEnteredPromise: Promise<void> | null = null;
let resolveVerifyEntered: (() => void) | null = null;
function armVerifyGate(checkB64: string) {
  gatedCheckB64 = checkB64;
  pendingGate = new Promise<void>((resolve) => { releaseGateFn = resolve; });
  verifyEnteredPromise = new Promise<void>((resolve) => { resolveVerifyEntered = resolve; });
}

mock.module('./api', () => ({
  ApiError: FakeApiError,
  getToken: async () => 'token',
  getApiUrl: () => 'http://localhost:3001',
  // POST /api/v1/auth/verify-recovery-check — mirrors the server exactly:
  // 400 invalid_recovery_phrase on a mismatch OR when no check is stored.
  verifyRecoveryCheck: async (checkB64: string) => {
    if (gatedCheckB64 != null && checkB64 === gatedCheckB64) {
      resolveVerifyEntered?.();
      await pendingGate;
      gatedCheckB64 = null; // one-shot
    }
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
  const host = { slots: [] as any[], idx: 0, cleanups: [] as Array<() => void> };
  const render = () => {
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
  // Task 1594 round 3 (T1): simulate a real unmount — runs every cleanup
  // captured by a `[]`-deps `useEffect` during this host's renders (App.tsx
  // re-keys CryptoProvider by user id, so a sign-in as a different account is
  // exactly this: this host is never rendered again).
  render.unmount = () => {
    for (const cleanup of host.cleanups.splice(0)) cleanup();
  };
  return render;
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
  calls.confirmed = [];
  calls.mirroredSignedInUser = [];
  server.reachable = true;
  server.sessionUser = USER_B;
  server.users = {
    [USER_A]: { check: b64(checkOf(KEY_A)), pub: b64(pubOf(KEY_A)) },
    [USER_B]: { check: b64(checkOf(KEY_B)), pub: b64(pubOf(KEY_B)) },
  };
  gatedCheckB64 = null;
  pendingGate = null;
  releaseGateFn = null;
  verifyEnteredPromise = null;
  resolveVerifyEntered = null;
  failNextWriteOf = null;
  failNextConfirm = false;
  traceCalls.length = 0;
  pauseNextWriteOf = null;
  writePauseGate = null;
  releaseWritePauseFn = null;
  writePauseEnteredPromise = null;
  resolveWritePauseEntered = null;
  secureWriteDepth = 0;
  maxSecureWriteDepth = 0;
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

  test("a legacy key without an owner, wrong account's public key → locked, purged, phrase required, recovery_check NEVER sent", async () => {
    seedStoredKey(KEY_A, null); // a pre-fix build never recorded an owner
    server.sessionUser = USER_B;
    const render = mountProvider(USER_B);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    // F1 (round 2): an UNBOUND key must NEVER have its recovery_check sent —
    // it may be a DIFFERENT account's reset credential. Ownership is proven
    // (or here, disproven) via the public key only.
    expect(calls.verify).toEqual([]);
    expectKeyPurged();
    // The handle loaded to derive the public key is released, never kept.
    expect(calls.released.length).toBe(calls.createHandle);
    const after = render();
    expect(after.isUnlocked).toBe(false);
    expect(after.needsRecoveryPhrase).toBe(true);
  });

  test('a legacy key whose public key matches the account → unlocked, owner recorded, recovery_check NEVER sent', async () => {
    seedStoredKey(KEY_A, null);
    server.sessionUser = USER_A;
    const render = mountProvider(USER_A);

    await render().unlock();

    expect(render().isUnlocked).toBe(true);
    // F1: unbound proof goes straight to the public key — recovery_check is
    // never POSTed for a key with no local owner record.
    expect(calls.verify).toEqual([]);
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
    // F1: the FIRST mount's key is unbound (seedStoredKey(..., null)), so it
    // is proven via the public key WITHOUT ever sending recovery_check — only
    // the SECOND mount (by then 'bound', from the first mount's write) sends
    // it, and it matches on the first try (server.users[USER_A].check is
    // already KEY_A's).
    expect(calls.verify.length).toBe(1);
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
    expect(calls.verify).toEqual([]); // F1: unbound never sends recovery_check
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

describe('1594 round 2 (F1) — an unbound key never sends recovery_check', () => {
  test('unbound key, account has no public key on file either → unverifiable, phrase required, NOT purged, recovery_check never sent', async () => {
    seedStoredKey(KEY_A, null); // unbound
    server.sessionUser = USER_A;
    server.users[USER_A] = { check: null, pub: null }; // no check AND no public key
    const render = mountProvider(USER_A);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    expect(calls.verify).toEqual([]);
    // 'unverifiable' + unbound → asks for the phrase but does NOT purge (the
    // key might still be this account's; there is simply nothing on the
    // server yet to prove it against).
    expect(secure.has(CHECK)).toBe(true);
    expect(secure.has(FALLBACK)).toBe(true);
    expect(calls.deleteKeychain).toBe(0);
    const after = render();
    expect(after.needsRecoveryPhrase).toBe(true);
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

describe('1594 round 3 (Codex T1) — an unlock abandoned by unmount never outlives its provider', () => {
  test('provider unmounts mid ownership-verify → the abandoned unlock releases the handle and never clobbers a newer provider\'s published owner', async () => {
    const { getExpectedUserId, setExpectedUserId } = await import('./expected-user');
    setExpectedUserId(null);

    // A's key is already BOUND (precheckKeyOwner → 'bound' → mode 'trusted'
    // → verifyRecoveryCheck), so the gate below pauses exactly where the real
    // bug's server round-trip was in flight.
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_A;
    const renderA = mountProvider(USER_A);
    renderA(); // mount: registers the `[]`-deps unmount cleanup

    armVerifyGate(b64(checkOf(KEY_A)));
    const unlockAPromise = renderA().unlock();
    await verifyEnteredPromise; // paused inside api.verifyRecoveryCheck for A
    const handleForA = calls.createHandle;
    expect(handleForA).toBeGreaterThan(0);
    expect(calls.released).not.toContain(handleForA);

    // The account changes on-device: A's provider unmounts (App.tsx re-keys
    // CryptoProvider by user id on every sign-in / session change).
    renderA.unmount();

    // B signs in fresh (its own phrase) and completes a normal unlock WHILE
    // A's verify is still parked server-side.
    server.sessionUser = USER_B;
    const renderB = mountProvider(USER_B);
    await renderB().unlock(PHRASE_B);
    expect(getExpectedUserId()).toBe(USER_B);

    // A's abandoned verify now resolves ('match' — the key really was A's;
    // that must not matter once the provider that started this unlock() is
    // gone).
    releaseGateFn!();
    await expect(unlockAPromise).rejects.toThrow(/unmounted/i);

    // The abandoned unlock must NOT have clobbered B's published owner...
    expect(getExpectedUserId()).toBe(USER_B);
    // ...and must have released the native handle it loaded instead of
    // leaking it.
    expect(calls.released).toContain(handleForA);
  });
});

describe('1594 round 3 (Codex T3) — a failed owner-record write releases the handle', () => {
  test('writeKeyOwner() throwing after a successful (unbound-key) verify releases the just-loaded handle instead of leaking it', async () => {
    seedStoredKey(KEY_A, null); // unbound legacy key → precheck 'unbound' → verdict via public key → writeKeyOwner() on match
    server.sessionUser = USER_A;
    failNextWriteOf = OWNER; // the NEXT SecureStore.setItemAsync(OWNER, …) throws
    const render = mountProvider(USER_A);

    await expect(render().unlock()).rejects.toThrow(/SecureStore write failed/);

    // The verify succeeded (public-key match) and the write was attempted —
    // recovery_check was never sent (F1, unbound mode) — but the owner was
    // never actually persisted, since the write itself failed.
    expect(calls.verify).toEqual([]);
    expect(secure.has(OWNER)).toBe(false);
    // The handle loaded to prove ownership must be released, not leaked.
    expect(calls.released.length).toBe(calls.createHandle);
    const after = render();
    expect(after.isUnlocked).toBe(false);
  });
});

describe('1594 round 4 (Codex P1, crypto-context.tsx:763) — an abandoned phrase-unlock write cannot outlive its provider', () => {
  test("sign-out mid storeMasterKey() write leaves no key behind — never resurrects the abandoned account's key", async () => {
    // A's ownership verdict already resolved and its disposedRef check (the
    // one immediately before `storeMasterKey` is called) already passed —
    // the race here is entirely INSIDE storeMasterKey's own sequential
    // SecureStore writes, which disposedRef (checked only before the call)
    // cannot see. No second account is involved here — this isolates the
    // "abandoned provider recreates A's key after sign-out" failure mode
    // from any interleaving with a second sign-in (covered separately below).
    server.sessionUser = USER_A;
    const renderA = mountProvider(USER_A);
    renderA(); // mount: registers the unmount cleanup

    armWritePause(FALLBACK);
    const unlockAPromise = renderA().unlock(PHRASE_A);
    await writePauseEnteredPromise; // paused inside storeMasterKey's own write, for A

    // Sign-out ("Use another account") while storeMasterKey is mid-write —
    // no new provider mounts here.
    renderA.unmount();
    releaseWritePauseFn!();

    await expect(unlockAPromise).rejects.toThrow(/unmounted/i);

    // The abandoned write must not have resurrected any part of A's key.
    expectKeyPurged();
    // F4: an instance that never reaches adoption must never confirm its
    // handle into the native, app-wide cache either.
    expect(calls.confirmed).toEqual([]);
  });

  test("B's own storeMasterKey call queues behind A's abandoned one instead of racing it — never runs concurrently, never gets clobbered by A finishing late", async () => {
    const { getExpectedUserId } = await import('./expected-user');

    server.sessionUser = USER_A;
    const renderA = mountProvider(USER_A);
    renderA(); // mount: registers the unmount cleanup

    armWritePause(FALLBACK);
    const unlockAPromise = renderA().unlock(PHRASE_A);
    await writePauseEnteredPromise; // paused inside storeMasterKey's own write, for A

    // "Use another account": A's provider unmounts while storeMasterKey is
    // still mid-write (the exact Codex scenario — NOT while awaiting the
    // ownership verify, which already finished).
    renderA.unmount();

    // B signs in fresh and starts its OWN, unrelated unlock while A's write
    // is still parked.
    server.sessionUser = USER_B;
    const renderB = mountProvider(USER_B);
    const unlockBPromise = renderB().unlock(PHRASE_B);
    let bSettled = false;
    unlockBPromise.then(() => { bSettled = true; }, () => { bSettled = true; });

    // Drain many microtask turns (not wall-clock time — deterministic) so
    // every one of B's OWN pre-storeMasterKey steps (recoverFromPhrase,
    // createMasterKeyHandle, the ownership verify) — and, on UNFIXED code,
    // its entire storeMasterKey write sequence too, since nothing there
    // blocks it — gets every chance to run while A's write is still parked.
    // Without the round-4 queue, B's SecureStore writes have nothing stopping
    // them from starting (and finishing) while A's stale ones are still open:
    // `bSettled` goes true here. WITH the queue, B's storeMasterKey call
    // cannot even start until A's turn is released, so it must still be
    // pending.
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(bSettled).toBe(false);
    // No two SecureStore writes (A's stale one, B's — if it had been allowed
    // to start) were ever simultaneously in flight during that drain.
    expect(maxSecureWriteDepth).toBeLessThanOrEqual(1);

    // Release A's paused write: it finishes its remaining local writes,
    // notices the generation moved on, purges what IT wrote, and throws —
    // freeing the queue for B's turn, which only then starts writing.
    releaseWritePauseFn!();

    await expect(unlockAPromise).rejects.toThrow(/unmounted/i);
    await unlockBPromise;

    // B's key is the one left standing — not recreated-A, not a corrupted mix.
    expect(getExpectedUserId()).toBe(USER_B);
    expect(secure.get(FALLBACK)).toBe(b64(KEY_B));
    expect(secure.get(OWNER)).toBe(USER_B);
    expect(secure.get(CHECK)).toBe(b64(checkOf(KEY_B)));
    expect(renderB().isUnlocked).toBe(true);
    // F4: only B's handle is ever confirmed into the native cache — A's
    // abandoned one never gets there.
    expect(calls.confirmed).toEqual([calls.createHandle]);
  });
});

describe('1594 round 4 (F4, BeebeebCryptoModule.swift ~1547/~1562) — confirmMasterKeyHandle is called exactly on adoption, never on mismatch/unverifiable-unbound/disposed', () => {
  test('phrase unlock at signup (no session yet, ownerUserId null) → confirmed exactly once, with the adopted handle', async () => {
    const render = mountProvider(undefined);
    await render().unlock(PHRASE_A);

    expect(render().isUnlocked).toBe(true);
    expect(calls.confirmed).toEqual([calls.createHandle]);
  });

  test('phrase unlock with a server "match" verdict → confirmed exactly once', async () => {
    server.sessionUser = USER_A;
    const render = mountProvider(USER_A);
    await render().unlock(PHRASE_A);

    expect(render().isUnlocked).toBe(true);
    expect(calls.confirmed).toEqual([calls.createHandle]);
  });

  test('phrase unlock with a server "mismatch" verdict (wrong account\'s phrase) → refused, NEVER confirmed', async () => {
    server.sessionUser = USER_B; // signed in as B, but A's phrase is typed
    const render = mountProvider(USER_B);

    await expect(render().unlock(PHRASE_A)).rejects.toThrow(/different account/i);

    expect(calls.confirmed).toEqual([]);
  });

  test('keychain (software-fallback) unlock, key already bound to this account → confirmed exactly once', async () => {
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_A;
    const render = mountProvider(USER_A);
    await render().unlock();

    expect(render().isUnlocked).toBe(true);
    expect(calls.confirmed).toEqual([calls.createHandle]);
  });

  test("keychain unlock, A's key + B signed in → purged before load, NEVER confirmed (no handle even created)", async () => {
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_B;
    const render = mountProvider(USER_B);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    expect(calls.createHandle).toBe(0);
    expect(calls.confirmed).toEqual([]);
  });

  test("keychain unlock, unbound key + account with no public key on file (unverifiable) → refused, handle released, NEVER confirmed", async () => {
    seedStoredKey(KEY_A, null);
    server.sessionUser = USER_A;
    server.users[USER_A] = { check: null, pub: null }; // nothing to prove against

    const render = mountProvider(USER_A);
    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    // A handle WAS created (the software-fallback path always creates one to
    // verify against the stored check) and then released — this is exactly
    // the case F4 exists for: a handle that touched native code but must
    // never reach the app-wide cache since ownership was never proven.
    expect(calls.createHandle).toBeGreaterThan(0);
    expect(calls.released.length).toBe(calls.createHandle);
    expect(calls.confirmed).toEqual([]);
  });
});

describe('1594 round 4 (R4) — the signed-in-user mirror is re-asserted after every successful unlock', () => {
  test('a successful phrase unlock re-mirrors the signed-in user id', async () => {
    server.sessionUser = USER_A;
    const render = mountProvider(USER_A);

    await render().unlock(PHRASE_A);

    // A later `mirrorSessionToAppGroup` token-change event (api.ts, the
    // login token arriving) DELETES this exact shared value the instant the
    // token changes — landing any time relative to this provider's own mount
    // effect, which also writes it once but which this harness never runs
    // for a non-`[]`-deps effect anyway (see the `mirroredSignedInUser`
    // fixture comment). `unlock()` re-asserting it directly, once the key is
    // confirmed adopted, is what actually closes the race regardless of that
    // ordering.
    expect(calls.mirroredSignedInUser).toEqual([USER_A]);
  });

  test('a successful keychain unlock re-mirrors the signed-in user id', async () => {
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_A;
    const render = mountProvider(USER_A);

    await render().unlock();

    expect(calls.mirroredSignedInUser).toEqual([USER_A]);
  });

  test('an unlock that never adopts a key (server "mismatch" verdict) does NOT re-mirror', async () => {
    server.sessionUser = USER_B; // signed in as B, but A's phrase is typed
    const render = mountProvider(USER_B);

    await expect(render().unlock(PHRASE_A)).rejects.toThrow(/different account/i);

    expect(calls.mirroredSignedInUser).toEqual([]);
  });

  test('an unlock refused by owner-mismatch precheck (purged before any load) does NOT re-mirror', async () => {
    seedStoredKey(KEY_A, USER_A);
    server.sessionUser = USER_B;
    const render = mountProvider(USER_B);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    expect(calls.mirroredSignedInUser).toEqual([]);
  });
});

describe('1594 round 6 (reviewer follow-up, storeMasterKeyExclusive stale-write rollback) — a SAME-account remount race must not purge a newer, already-established key', () => {
  test("A's provider remounts (same account, no account switch) while storeMasterKey is paused mid-writeKeyOwner; the fresh remount's own keychain-unlock proves and re-records the SAME key first — the stale call must abandon quietly, not purge what the remount just established", async () => {
    // Task 1594 round 6: round 4 only modelled the CROSS-account shape (A's
    // abandoned write must not clobber B's fresh one) — this models the
    // SAME-account shape the reviewer flagged: a provider can unmount and
    // remount for the SAME user (a brief session churn, not a sign-out), and
    // the fresh instance's KEYCHAIN-unlock path (`loadVerifiedMasterKeyHandle`
    // + a direct `writeKeyOwner` call that does NOT go through
    // `storeMasterKeyQueue`) can legitimately re-prove and re-record the very
    // key the stale `storeMasterKeyExclusive` call is still mid-writing.
    server.sessionUser = USER_A;
    const renderA = mountProvider(USER_A);
    renderA(); // mount: registers the unmount cleanup

    // Pause storeMasterKeyExclusive's OWN `writeKeyOwner` write specifically —
    // by this point it has ALREADY written the check label and the fallback
    // key material (both readable by a concurrent keychain-unlock), but has
    // NOT yet reached its own final `stillCurrent()` check.
    armWritePause(OWNER);
    const unlockAPromise = renderA().unlock(PHRASE_A);
    await writePauseEnteredPromise; // paused inside storeMasterKeyExclusive's own writeKeyOwner

    // The SAME account's provider unmounts and remounts (App.tsx keys
    // CryptoProvider by user id — a session ending and a fresh one starting
    // for the SAME user is exactly a `signed-out` → `USER_A` remount, NOT a
    // different user id). This is what round 4's queue does not protect
    // against: it only serializes concurrent `storeMasterKey` CALLS, and this
    // remount's own path never calls `storeMasterKey` at all.
    renderA.unmount();
    const renderA2 = mountProvider(USER_A);
    const unlockA2Promise = renderA2().unlock(); // keychain unlock, no phrase

    // Drain microtask turns so the remount's own precheck → keychain load →
    // ownership verify → writeKeyOwner sequence runs to completion while A's
    // original call is still parked.
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await unlockA2Promise; // the remount's own unlock must succeed on its own

    // Sanity: the remount actually re-established ownership via ITS OWN
    // `writeKeyOwner` call (not via `storeMasterKey`/`storeMasterKeyQueue`).
    expect(secure.get(OWNER)).toBe(USER_A);
    expect(renderA2().isUnlocked).toBe(true);
    const deleteKeychainCallsBeforeRelease = calls.deleteKeychain;

    // NOW release A's original, now-stale write. It resumes past its own
    // `writeKeyOwner` call, finds the generation has moved on, and — pre-fix —
    // unconditionally purges everything (the remount's just-established,
    // CORRECT state included, since they share the same keychain labels).
    releaseWritePauseFn!();
    await expect(unlockAPromise).rejects.toThrow(/unmounted/i);

    // The fix: no NEW purge happened as a result of releasing the stale
    // write — the remount's key, check, and owner record all survive intact.
    expect(calls.deleteKeychain).toBe(deleteKeychainCallsBeforeRelease);
    expect(secure.get(OWNER)).toBe(USER_A);
    expect(secure.get(CHECK)).toBe(b64(checkOf(KEY_A)));
    expect(secure.get(FALLBACK)).toBe(b64(KEY_A));
    expect(renderA2().isUnlocked).toBe(true);
  });
});

describe('1594 round 6 (reviewer follow-up, crypto-context.tsx confirmMasterKeyHandle) — a failure to confirm the handle into the native cache is traced, not swallowed', () => {
  test('confirmMasterKeyHandle rejecting during a successful phrase unlock is traced with the opaque handle id (no key material)', async () => {
    failNextConfirm = true;
    const render = mountProvider(USER_A);
    server.sessionUser = USER_A;

    // The unlock itself still succeeds — a failure to warm the NATIVE cache
    // must not fail the whole unlock (backup/thumbnails degrade silently
    // today; that gap is F4's own, separate concern) — but it must leave a
    // trace an engineer can actually find, unlike before this fix.
    await render().unlock(PHRASE_A);

    expect(render().isUnlocked).toBe(true);
    const trace = traceCalls.find((t) => t.name === 'vault.key_ownership.confirm_handle_failed');
    expect(trace).toBeDefined();
    // The handle id is an opaque native reference — never key material.
    expect(typeof trace!.fields.handleId).toBe('number');
    expect(JSON.stringify(trace)).not.toMatch(/phrase-of-account|a1a1a1|master.?key/i);
  });

  test('confirmMasterKeyHandle succeeding records no failure trace', async () => {
    const render = mountProvider(USER_A);
    server.sessionUser = USER_A;

    await render().unlock(PHRASE_A);

    expect(traceCalls.find((t) => t.name === 'vault.key_ownership.confirm_handle_failed')).toBeUndefined();
  });
});
