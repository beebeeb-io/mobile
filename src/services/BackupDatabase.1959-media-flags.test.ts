// @ts-nocheck
/**
 * Task 1959 round 4 — `getBackupMediaFlags`: the backup engine's own record
 * of which remote files are photos/videos (is_media true) and which are
 * contacts/calendars (false). The Photos tab uses it to show a backup upload
 * that arrived inside the file-index window without asking the server.
 */
import { describe, expect, mock, test } from 'bun:test';

const rows = [
  { remote_file_id: 'r-photo', asset_type: 'photo' },
  { remote_file_id: 'r-video', asset_type: 'video' },
  { remote_file_id: 'r-contact', asset_type: 'contact' },
  { remote_file_id: 'r-calendar', asset_type: 'calendar' },
];
const selects = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiRemove: async () => {}, getAllKeys: async () => [] },
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => {},
    runAsync: async () => ({ changes: 0 }),
    getFirstAsync: async () => ({ user_version: 999 }),
    getAllAsync: async (sql, params = []) => {
      if (!/SELECT remote_file_id, asset_type FROM backup_assets/.test(sql)) return [];
      selects.push(params.length);
      return rows.filter((r) => params.includes(r.remote_file_id));
    },
  }),
}));

const { getBackupMediaFlags } = await import('./BackupDatabase');

describe('getBackupMediaFlags (1959 round 4)', () => {
  test('photo and video -> true, contact and calendar -> false, unknown ids absent', async () => {
    const out = await getBackupMediaFlags(['r-photo', 'r-video', 'r-contact', 'r-calendar', 'r-unknown']);
    expect(Object.fromEntries(out)).toEqual({ 'r-photo': true, 'r-video': true, 'r-contact': false, 'r-calendar': false });
  });

  test('no ids: no query; many ids: chunked under the SQLite bind limit', async () => {
    selects.length = 0;
    expect((await getBackupMediaFlags([])).size).toBe(0);
    expect(selects).toEqual([]);
    const many = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await getBackupMediaFlags(['r-photo', ...many]);
    expect(selects.every((n) => n <= 400)).toBe(true);
    expect(selects.reduce((a, b) => a + b, 0)).toBe(1001);
  });
});
