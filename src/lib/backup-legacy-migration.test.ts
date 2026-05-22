// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock AsyncStorage with an in-memory map so the migration's idempotency
// guard is testable without the real native module.
const memoryStore = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => memoryStore.get(key) ?? null,
    setItem: async (key: string, value: string) => { memoryStore.set(key, value); },
    removeItem: async (key: string) => { memoryStore.delete(key); },
  },
}));

// `import * as` in backup-bridge freezes the BeebeebCrypto namespace at import
// time, so live mutations to a mocked module aren't visible. We use the
// __setBridgeForTest hook on backup-bridge instead — same control surface,
// without the namespace-frozen footgun.
mock.module('../../modules/beebeeb-crypto', () => ({}));

let migrateSpy = mock(async () => {});

function makeBridgeReady(setBridge: (b: any) => void) {
  migrateSpy = mock(async () => {});
  setBridge({
    getBackupStatus: async () => ({}),
    migrateLegacyBackupState: migrateSpy,
  });
}

function makeBridgeUnavailable(setBridge: (b: any) => void) {
  migrateSpy = mock(async () => {});
  setBridge(null);
}

const {
  chunkRows,
  hasMigrated,
  legacyRowFromAsset,
  runLegacyBackupMigration,
  __testing,
} = await import('./backup-legacy-migration');
const { __setBridgeForTest } = await import('./backup-bridge');

describe('legacyRowFromAsset', () => {
  test('shapes a fully-populated asset into the bridge payload', () => {
    const row = legacyRowFromAsset({
      local_asset_id: 'PH-1234',
      remote_file_id: 'r-abc',
      remote_path: '/Backups/iPhone/x.jpg',
      content_hash: 'sha256-deadbeef',
      file_size: 4_194_304,
      created_at: '2026-05-20T12:00:00.000Z',
      uploaded_at: '2026-05-20T12:00:05.123Z',
      asset_type: 'photo',
      status: 'uploaded',
      queued_at: 1_700_000_000_000,
      last_attempt_at: 1_700_000_001_000,
      retry_count: 2,
      error_message: null,
    });

    expect(row).toEqual({
      localAssetId: 'PH-1234',
      remoteFileId: 'r-abc',
      contentHash: 'sha256-deadbeef',
      fileSize: 4_194_304,
      createdAt: '2026-05-20T12:00:00.000Z',
      uploadedAt: '2026-05-20T12:00:05.123Z',
      assetType: 'photo',
      status: 'uploaded',
      retryCount: 2,
      errorMessage: null,
    });
  });

  test('preserves null remote/uploaded fields for pending assets', () => {
    const row = legacyRowFromAsset({
      local_asset_id: 'PH-pending',
      remote_file_id: null,
      remote_path: null,
      content_hash: '',
      file_size: 0,
      created_at: '2026-05-22T00:00:00.000Z',
      uploaded_at: null,
      asset_type: 'video',
      status: 'pending_upload',
      queued_at: null,
      last_attempt_at: null,
      retry_count: 0,
      error_message: null,
    });

    expect(row.remoteFileId).toBeNull();
    expect(row.uploadedAt).toBeNull();
    expect(row.assetType).toBe('video');
    expect(row.status).toBe('pending_upload');
  });
});

describe('chunkRows', () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      localAssetId: `id-${i}`,
      remoteFileId: null,
      contentHash: '',
      fileSize: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      uploadedAt: null,
      assetType: 'photo' as const,
      status: 'pending_upload',
      retryCount: 0,
      errorMessage: null,
    }));

  test('returns no batches for an empty input', () => {
    expect(chunkRows([])).toEqual([]);
  });

  test('respects the default batch size of 500', () => {
    const batches = chunkRows(makeRows(1_250));
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(500);
    expect(batches[1]).toHaveLength(500);
    expect(batches[2]).toHaveLength(250);
    expect(__testing.BATCH_SIZE).toBe(500);
  });

  test('honors a custom batch size', () => {
    const batches = chunkRows(makeRows(7), 3);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  test('floors fractional sizes and never returns empty batches', () => {
    const batches = chunkRows(makeRows(5), 2.7);
    expect(batches.every((b) => b.length > 0)).toBe(true);
    expect(batches.flat()).toHaveLength(5);
  });
});

describe('runLegacyBackupMigration', () => {
  beforeEach(() => {
    memoryStore.clear();
    makeBridgeUnavailable(__setBridgeForTest);
  });

  afterEach(() => {
    memoryStore.clear();
    makeBridgeUnavailable(__setBridgeForTest);
  });

  test('skips when the bridge is not yet ready', async () => {
    const result = await runLegacyBackupMigration({
      fetchAll: async () => [{ local_asset_id: 'x' } as any],
    });
    expect(result).toEqual({ skipped: true, rowsMigrated: 0 });
    expect(await hasMigrated()).toBe(false);
  });

  test('skips when the flag is already set', async () => {
    memoryStore.set(__testing.MIGRATION_FLAG_KEY, '1');
    makeBridgeReady(__setBridgeForTest);
    const result = await runLegacyBackupMigration({
      fetchAll: async () => [],
    });
    expect(result).toEqual({ skipped: true, rowsMigrated: 0 });
  });

  test('batches rows, calls native ingestor, sets the flag', async () => {
    makeBridgeReady(__setBridgeForTest);
    const fetched = Array.from({ length: 1_001 }, (_, i) => ({
      local_asset_id: `id-${i}`,
      remote_file_id: null,
      remote_path: null,
      content_hash: '',
      file_size: 0,
      created_at: '2026-05-20T00:00:00.000Z',
      uploaded_at: null,
      asset_type: 'photo' as const,
      status: 'pending_upload',
      queued_at: null,
      last_attempt_at: null,
      retry_count: 0,
      error_message: null,
    }));

    const result = await runLegacyBackupMigration({
      fetchAll: async () => fetched,
    });

    expect(result).toEqual({ skipped: false, rowsMigrated: 1_001 });
    // 500 + 500 + 1 → 3 native calls.
    expect(migrateSpy).toHaveBeenCalledTimes(3);
    expect(await hasMigrated()).toBe(true);
  });

  test('does not call native when no rows exist', async () => {
    makeBridgeReady(__setBridgeForTest);
    const result = await runLegacyBackupMigration({
      fetchAll: async () => [],
    });
    expect(result.skipped).toBe(false);
    expect(result.rowsMigrated).toBe(0);
    expect(migrateSpy).not.toHaveBeenCalled();
    expect(await hasMigrated()).toBe(true);
  });
});
