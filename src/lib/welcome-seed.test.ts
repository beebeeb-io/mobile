// @ts-nocheck
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

// Controllable mocks for the seed's dependencies.
let rootListing: any[] = [];
let listThrows = false;
let uploadCalls: any[] = [];
let listFilesCalls: Array<{ parentId: unknown; trashed: unknown }> = [];
const secureStore = new Map<string, string>();

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secureStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    secureStore.set(k, v);
  },
}));
mock.module('./api', () => ({
  listFiles: async (parentId: unknown, trashed: unknown) => {
    listFilesCalls.push({ parentId, trashed });
    if (listThrows) throw new Error('network');
    return rootListing;
  },
}));
mock.module('./encrypted-upload', () => ({
  generateFileId: async () => 'file-123',
  encryptedUpload: async (opts: any) => {
    uploadCalls.push(opts);
  },
}));
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: '/tmp/cache/',
  EncodingType: { UTF8: 'utf8' },
  writeAsStringAsync: async () => {},
  deleteAsync: async () => {},
}));
mock.module('../../modules/beebeeb-crypto', () => ({}));

const { seedWelcomeMarkdown, ensureUnlockedAndSeed, WELCOME_FILENAME } = await import('./welcome-seed');

const FOLDER = { id: 'f1', is_folder: true };
const FILE = { id: 'd1', is_folder: false };
const opts = () => ({
  userId: 'user-1',
  encryptChunkFn: async () => ({}),
  encryptMetadataFn: async () => ({}),
});

beforeEach(() => {
  rootListing = [];
  listThrows = false;
  uploadCalls = [];
  listFilesCalls = [];
  secureStore.clear();
});

describe('seedWelcomeMarkdown — root-content guard (0558)', () => {
  test('REGRESSION: a fresh account whose root has ONLY the auto-created Backups folder STILL seeds', async () => {
    rootListing = [FOLDER];
    const seeded = await seedWelcomeMarkdown(opts());
    expect(seeded).toBe(true);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].name).toBe(WELCOME_FILENAME);
  });

  test('truly empty root seeds', async () => {
    rootListing = [];
    expect(await seedWelcomeMarkdown(opts())).toBe(true);
    expect(uploadCalls).toHaveLength(1);
  });

  test('a root with a real FILE (existing user / already-seeded welcome.md) skips + latches', async () => {
    rootListing = [FOLDER, FILE];
    expect(await seedWelcomeMarkdown(opts())).toBe(false);
    expect(uploadCalls).toHaveLength(0);
    expect(secureStore.get('beebeeb_welcome_seeded:user-1')).toBe('true');
  });

  test('per-device SecureStore flag short-circuits before any network call', async () => {
    secureStore.set('beebeeb_welcome_seeded:user-1', 'true');
    rootListing = [FOLDER]; // would otherwise seed
    expect(await seedWelcomeMarkdown(opts())).toBe(false);
    expect(uploadCalls).toHaveLength(0);
  });

  test('a transient listFiles error does NOT latch markSeeded (so it retries next launch)', async () => {
    listThrows = true;
    expect(await seedWelcomeMarkdown(opts())).toBe(false);
    expect(uploadCalls).toHaveLength(0);
    expect(secureStore.has('beebeeb_welcome_seeded:user-1')).toBe(false);
  });

  test('listFiles is called ROOT-scoped, non-recursive — a photo the 1443 backup race already', async () => {
    // uploaded INTO Backups/ must never be visible to this guard. The server
    // scopes listFiles by parent_id, so a nested file simply never appears in
    // a call with parentId=undefined — but if a future change swapped this for
    // a recursive/listAllFiles call, that nested file WOULD start tripping the
    // "real content at root" guard on every fresh account. Pin the call shape.
    rootListing = [FOLDER]; // root has only the auto-created Backups folder...
    // ...the photo backup created lives under Backups/, invisible to this call.
    const seeded = await seedWelcomeMarkdown(opts());
    expect(seeded).toBe(true);
    expect(listFilesCalls).toHaveLength(1);
    expect(listFilesCalls[0]).toEqual({ parentId: undefined, trashed: false });
  });

  test('successful seed logs "seed done: <fileId>" at info level (Metro visibility, 1444)', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      rootListing = [FOLDER];
      const seeded = await seedWelcomeMarkdown(opts());
      expect(seeded).toBe(true);
      const doneLog = infoSpy.mock.calls.find((c) => String(c[0]).includes('seed done'));
      expect(doneLog).toBeDefined();
      expect(String(doneLog?.[0])).toContain('file-123');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('a skipped seed (root already has content) logs "seed skipped: ..." at info level', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      rootListing = [FOLDER, FILE];
      const seeded = await seedWelcomeMarkdown(opts());
      expect(seeded).toBe(false);
      const skipLog = infoSpy.mock.calls.find((c) => String(c[0]).includes('seed skipped'));
      expect(skipLog).toBeDefined();
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('ensureUnlockedAndSeed — CryptoProvider remount race (1444)', () => {
  // Root cause: `<CryptoProvider key={user?.user_id ?? 'signed-out'}>`
  // (App.tsx) remounts the whole crypto context the instant `user.user_id`
  // first populates during signup, because SignupScreen unlocks the vault
  // BEFORE `refreshAuth()` sets `user` (under the transient 'signed-out'
  // key). The remounted instance starts locked (`isUnlocked: false`);
  // `BiometricGuard`'s "post-login vault unlock" effect (App.tsx) re-unlocks
  // it, but fire-and-forget — a fast verify (e.g. a scripted/Maestro run)
  // can reach RecoveryPhraseVerifyScreen.handleVerify before that resolves.
  // The OLD code trusted a stale `isUnlocked` snapshot and silently skipped
  // the seed with NO log line at all whenever this raced. These tests pin
  // the fix: actively (re)unlock before deciding to skip.

  test('vault already unlocked: seeds directly, never calls unlock()', async () => {
    rootListing = [FOLDER];
    let unlockCalls = 0;
    const unlock = async () => {
      unlockCalls += 1;
    };
    const seeded = await ensureUnlockedAndSeed({ ...opts(), isUnlocked: true, unlock });
    expect(seeded).toBe(true);
    expect(unlockCalls).toBe(0);
    expect(uploadCalls).toHaveLength(1);
  });

  test('REGRESSION: isUnlocked reads false at verify time but unlock() resolves — seed still runs', async () => {
    // Before the fix, this exact shape (isUnlocked: false, key actually
    // recoverable from keychain) silently skipped the seed — nothing was
    // even attempted, let alone logged. This is the task 1444 bug.
    rootListing = [FOLDER];
    let unlockCalls = 0;
    const unlock = async () => {
      unlockCalls += 1;
    };
    const seeded = await ensureUnlockedAndSeed({ ...opts(), isUnlocked: false, unlock });
    expect(unlockCalls).toBe(1);
    expect(seeded).toBe(true);
    expect(uploadCalls).toHaveLength(1);
  });

  test('unlock() genuinely fails: seed is skipped and the reason is logged, not silently swallowed', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      rootListing = [FOLDER];
      const unlock = async () => {
        throw new Error('No master key in keychain — provide a recovery phrase to restore');
      };
      const seeded = await ensureUnlockedAndSeed({ ...opts(), isUnlocked: false, unlock });
      expect(seeded).toBe(false);
      expect(uploadCalls).toHaveLength(0);
      const skipLog = infoSpy.mock.calls.find((c) => String(c[0]).includes('seed skipped'));
      expect(skipLog).toBeDefined();
    } finally {
      infoSpy.mockRestore();
    }
  });
});
