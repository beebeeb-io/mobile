// @ts-nocheck
/**
 * Task 1704 slice 3 — the mobile story after an email-based password reset
 * (SLICE 1, server `routes/password.rs` `/auth/set-password-finish`: deletes
 * ALL sessions and COALESCE-KEeps `recovery_check` + `x25519_public_key`).
 *
 * GROUND TRUTH recorded in the task file (verified 2026-10-02 against this
 * tree): mobile has NO password-wrapped vault store. The master key lives in
 * the iOS Keychain (`storeKeyInKeychain`, Secure-Enclave-wrapped) with a
 * SecureStore fallback + simulator file — all password-INDEPENDENT. There is
 * no mobile equivalent of web `vault.ts wrapAndStore` and no `wrong_password`
 * unlock failure shape (that is web's `VaultUnlockOutcome`; mobile `unlock()`
 * never consumes a password). So the "re-wrap ceremony" on mobile is
 * STRUCTURAL, not a new code path:
 *
 *   1. The reset deletes sessions only. The device's stored session dies via
 *      a plain 401 (`clearToken()` + `setUser(null)`) — the signed-out
 *      plaintext purge does NOT touch the keychain key (only an explicit
 *      `signOut()` purges it), so the owner-tagged key survives.
 *   2. Fresh login with the NEW password → user-keyed `CryptoProvider` remount
 *      → post-login `unlock()` → owner-tag precheck 'bound' → keychain load →
 *      ownership proof against the PRESERVED recovery_check (or, redundantly,
 *      the preserved X25519 public key) → match → vault unlocked, no phrase
 *      prompt.
 *   3. Keychain empty (new device) → `no_key` → `needsRecoveryPhrase` → the
 *      honest "Vault locked" landing (`RecoveryUnlockScreen`), where the
 *      12-word phrase derives the key and (SE-)stores it. A wrong phrase is a
 *      retryable error on that landing — never a dead end, never a password
 *      retry loop (there is no password-unlock path to loop on).
 *   4. Owner-tag mismatch → purged BEFORE any load + phrase required (1594's
 *      cross-account protection, untouched).
 *
 * These tests drive the REAL `CryptoProvider.unlock()` with the same hook-host
 * harness as `crypto-context.key-ownership.test.ts` (1594). Every native
 * module and relative dependency is mocked here (isolated-runner rule, mobile
 * CLAUDE.md "Tests"). `./key-ownership`, `./expected-user` and
 * `./crypto-context` are NOT mocked — they are the code under test.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ─── hook host (mirrors crypto-context.key-ownership.test.ts) ────────────────
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
// USER_U is the account that reset its password via email and signed back in
// with the NEW password. USER_OTHER is a different account whose key was once
// left on this device.
const KEY_U = new Uint8Array(32).fill(0x17);
const KEY_OTHER = new Uint8Array(32).fill(0x2e);
const PHRASE_U = 'phrase-of-account-u';
const PHRASE_OTHER = 'phrase-of-account-other';
const USER_U = '44444444-4444-4444-8444-444444444444';
const USER_OTHER = '55555555-5555-4555-8555-555555555555';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const checkOf = (k: Uint8Array) => k.map((x) => x ^ 0x5a);
const pubOf = (k: Uint8Array) => k.map((x) => x ^ 0x33);
const privOf = (k: Uint8Array) => k.map((x) => x ^ 0x77);

// SecureStore labels (the real strings — key-ownership.ts owns them).
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
  sessionUser: USER_U as string,
  // The account row AFTER an email reset: recovery_check + x25519_public_key
  // COALESCE-kept (SLICE 1 keeps both — they are simply not in the SET list).
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
  confirmMasterKeyHandle: async () => true,
  createRequestKeypairWithHandle: async () => ({}),
  decryptNames: async () => [],
  mirrorSessionUserId: async () => true,
  mirrorSimulatorFileProviderMasterKey: async () => true,
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
    if (phrase === PHRASE_U) return { masterKey: new Uint8Array(KEY_U) };
    if (phrase === PHRASE_OTHER) return { masterKey: new Uint8Array(KEY_OTHER) };
    throw new Error('invalid phrase');
  },
  releaseHandle: async (h: number) => { calls.released.push(h); handles.delete(h); },
  replaceKeychainAccessControl: async () => true,
  replaceKeychainAccessControlFromHandle: async () => true,
  storeKeyInKeychain: async () => { throw new Error('no secure enclave on the simulator'); },
  unwrapRequestPrivateWithHandle: async () => new Uint8Array(32),
  deleteKeyFromKeychain: async () => { calls.deleteKeychain += 1; return true; },
};
mock.module('../../modules/beebeeb-crypto', () => cryptoMock);

mock.module('../services/BackupService', () => ({
  setBackupEncryption: () => {},
  getKeepVaultUnlocked: async () => false,
}));
mock.module('./runtime-trace', () => ({
  recordRuntimeTrace: () => null,
}));
mock.module('./file-request-crypto', () => ({ createRequestKeyResolver: () => ({ clear: () => {} }) }));
mock.module('./recovery-phrase-verify', () => ({ verifyRecoveryPhraseAgainstStoredCheck: async () => false }));

mock.module('./api', () => ({
  ApiError: FakeApiError,
  getToken: async () => 'token',
  getApiUrl: () => 'http://localhost:3001',
  // POST /api/v1/auth/verify-recovery-check — mirrors the server exactly:
  // 400 invalid_recovery_phrase on a mismatch OR when no check is stored.
  // SLICE 1 preserved the check, so the resident key proves with it directly.
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
const { PHRASE_WRONG_ACCOUNT_MESSAGE } = await import('./key-ownership');

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
  render.unmount = () => {
    for (const cleanup of host.cleanups.splice(0)) cleanup();
  };
  return render;
}

/** The keychain exactly as this device left it the last time it unlocked. */
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

function expectKeyIntact(key: Uint8Array, owner: string) {
  expect(secure.get(CHECK)).toBe(b64(checkOf(key)));
  expect(secure.get(FALLBACK)).toBe(b64(key));
  expect(secure.get(OWNER)).toBe(owner);
  expect(files.get(SIM_FILE)).toBe(b64(key));
  expect(calls.deleteKeychain).toBe(0);
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
  server.sessionUser = USER_U;
  server.users = {
    [USER_U]: { check: b64(checkOf(KEY_U)), pub: b64(pubOf(KEY_U)) },
    [USER_OTHER]: { check: b64(checkOf(KEY_OTHER)), pub: b64(pubOf(KEY_OTHER)) },
  };
});

describe('1704 slice 3 — mobile after an email password reset', () => {
  test('resident keychain key + fresh login with the NEW password → vault unlocks with NO phrase prompt (the reset re-arms the vault)', async () => {
    // The device unlocked this vault before the reset: key + check + owner tag
    // all resident and owner-tagged to the resetting account.
    seedStoredKey(KEY_U, USER_U);
    const render = mountProvider(USER_U);

    // The post-login vault unlock — no phrase is ever given (mobile unlock()
    // takes no password at all; the keychain blob is not password-wrapped, so
    // there is nothing to re-wrap under the new password).
    await render().unlock();

    const after = render();
    expect(after.isUnlocked).toBe(true);
    expect(after.needsRecoveryPhrase).toBe(false);
    // The proof ran against the PRESERVED recovery_check (owner tag made the
    // key 'bound' before any load → trusted mode) and matched on the first try.
    expect(calls.verify).toEqual([b64(checkOf(KEY_U))]);
    // Nothing was purged or rewritten: the resident key simply re-armed.
    expectKeyIntact(KEY_U, USER_U);
  });

  test('keychain empty (new device) → needsRecoveryPhrase arms the Vault locked landing, nothing stored or destroyed', async () => {
    // A brand-new device: no key was ever provisioned here. The reset changed
    // nothing about that.
    const render = mountProvider(USER_U);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    const after = render();
    expect(after.isUnlocked).toBe(false);
    // The dedicated signal VaultRecoveryGate routes to RecoveryUnlock — the
    // honest "Vault locked" landing with the 12-word phrase path — never an
    // error-toast dead end and never a password retry loop.
    expect(after.needsRecoveryPhrase).toBe(true);
    expect(calls.deleteKeychain).toBe(0);
    expect(secure.has(CHECK)).toBe(false);
    expect(secure.has(FALLBACK)).toBe(false);
    expect(secure.has(OWNER)).toBe(false);
  });

  test("owner-tag mismatch still purges BEFORE any load and requires the phrase (cross-account protection unchanged by the reset)", async () => {
    // Another account's leftover key on this device — the owner tag names
    // USER_OTHER while USER_U signs in (post-reset or not).
    seedStoredKey(KEY_OTHER, USER_OTHER);
    const render = mountProvider(USER_U);

    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);

    expectKeyPurged();
    const after = render();
    expect(after.isUnlocked).toBe(false);
    expect(after.needsRecoveryPhrase).toBe(true);
    // Purged before the key was ever loaded: no native handle was created and
    // no fallback read happened — nothing the backup engine could adopt.
    expect(calls.createHandle).toBe(0);
    expect(calls.fallbackReads).toBe(0);
    // A key that never belonged to this account never POSTed its recovery_check.
    expect(calls.verify).toEqual([]);
  });

  test('no resident key + a wrong phrase → refused with nothing stored, landing stays armed, the correct phrase still unlocks (no dead end)', async () => {
    const render = mountProvider(USER_U);

    // 1. The device holds no key: the unlock arms the locked landing.
    await expect(render().unlock()).rejects.toThrow(/no master key in keychain/i);
    expect(render().needsRecoveryPhrase).toBe(true);

    // 2. A wrong phrase typed ON the landing is refused against THIS account
    //    (preserved recovery_check → settled by the preserved X25519 public
    //    key) and stores NOTHING — the wrong key never touches the keychain.
    await expect(render().unlock(PHRASE_OTHER)).rejects.toThrow(PHRASE_WRONG_ACCOUNT_MESSAGE);
    expect(secure.has(CHECK)).toBe(false);
    expect(secure.has(FALLBACK)).toBe(false);
    expect(secure.has(OWNER)).toBe(false);
    expect(files.has(SIM_FILE)).toBe(false);
    // The refused phrase's transient handle was released, never adopted.
    expect(calls.released).toEqual([1]);
    // The landing is still armed — the failure is a retryable error on the
    // landing, not a dead end and not a forced sign-out.
    expect(render().needsRecoveryPhrase).toBe(true);

    // 3. The correct phrase derives the account key, proves against the
    //    preserved bindings, and unlocks (storing the key for future unlocks).
    await render().unlock(PHRASE_U);
    const after = render();
    expect(after.isUnlocked).toBe(true);
    expect(after.needsRecoveryPhrase).toBe(false);
    expect(secure.get(OWNER)).toBe(USER_U);
    expect(secure.get(FALLBACK)).toBe(b64(KEY_U));
  });
});