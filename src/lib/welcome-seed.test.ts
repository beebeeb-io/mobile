// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Controllable mocks for the seed's dependencies.
let rootListing: any[] = [];
let listThrows = false;
let uploadCalls: any[] = [];
const secureStore = new Map<string, string>();

mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secureStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    secureStore.set(k, v);
  },
}));
mock.module('./api', () => ({
  listFiles: async () => {
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
mock.module('expo-file-system', () => ({
  cacheDirectory: '/tmp/cache/',
  EncodingType: { UTF8: 'utf8' },
  writeAsStringAsync: async () => {},
  deleteAsync: async () => {},
}));
mock.module('../../modules/beebeeb-crypto', () => ({}));

const { seedWelcomeMarkdown, WELCOME_FILENAME } = await import('./welcome-seed');

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
});
