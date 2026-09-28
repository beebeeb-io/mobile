// @ts-nocheck
/**
 * Task 1599 followup 4 — the upload heartbeat interval `startUploadHeartbeatPulse`
 * uses to renew a v2 session's lease (server PR #120 / task 1589) must be
 * clamped, never trusted verbatim from the server's `heartbeat_interval_secs`:
 *
 *   - a FLOOR of 15s: a server bug or a compromised/misbehaving server
 *     returning e.g. `0` or `1` must never make the client hammer the
 *     heartbeat endpoint on every tick.
 *   - a CEILING of `lease_seconds / 2`: an interval close to (or past) the
 *     lease means the lease can expire between heartbeats even when nothing
 *     went wrong — halving it guarantees at least one heartbeat lands with
 *     lease to spare before the deadline.
 *
 * The ceiling wins over the floor when the two conflict (a very short
 * lease) — a heartbeat that undershoots the stated floor is safer than one
 * that can outlive its own lease.
 *
 * Isolated per bun:test-per-file semantics (mobile CLAUDE.md, "Tests").
 */
import { describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}))
mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}))
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value) },
  deleteItemAsync: async (key: string) => { store.delete(key) },
}))
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
  writeAsStringAsync: async () => {},
  deleteAsync: async () => {},
  uploadAsync: async () => { throw new Error('not exercised in this file') },
}))
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => null,
  uploadChunksNative: async () => { throw new Error('not exercised in this file') },
}))
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }))
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }))
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }))
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async () => { throw new Error('not exercised in this file') },
}))

async function loadFreshApi() {
  return import(`./api?heartbeatClampTest=${Math.random()}`)
}

describe('clampHeartbeatIntervalSecs (task 1599 followup 4)', () => {
  test('a normal server value within [15, lease/2] passes through unchanged', async () => {
    const { clampHeartbeatIntervalSecs } = await loadFreshApi()
    // lease 3600 → ceiling 1800; 100 is comfortably inside [15, 1800].
    expect(clampHeartbeatIntervalSecs(100, 3600)).toBe(100)
  })

  test('a server value below the 15s floor is raised to 15', async () => {
    const { clampHeartbeatIntervalSecs } = await loadFreshApi()
    expect(clampHeartbeatIntervalSecs(0, 3600)).toBe(15)
    expect(clampHeartbeatIntervalSecs(1, 3600)).toBe(15)
    expect(clampHeartbeatIntervalSecs(-5, 3600)).toBe(15)
  })

  test('a server value above lease/2 is lowered to the ceiling', async () => {
    const { clampHeartbeatIntervalSecs } = await loadFreshApi()
    // lease 300 → ceiling 150; a server-suggested 9999 must be capped.
    expect(clampHeartbeatIntervalSecs(9_999, 300)).toBe(150)
  })

  test('a very short lease: the ceiling wins over the 15s floor', async () => {
    const { clampHeartbeatIntervalSecs } = await loadFreshApi()
    // lease 20 → ceiling 10, BELOW the 15s floor. The ceiling must win —
    // a heartbeat that never fires before the lease expires defeats the
    // entire point of the heartbeat.
    expect(clampHeartbeatIntervalSecs(5, 20)).toBe(10)
    expect(clampHeartbeatIntervalSecs(9_999, 20)).toBe(10)
  })

  test('an unknown lease (undefined, or <= 0) applies only the floor', async () => {
    const { clampHeartbeatIntervalSecs } = await loadFreshApi()
    expect(clampHeartbeatIntervalSecs(9_999, undefined)).toBe(9_999)
    expect(clampHeartbeatIntervalSecs(5, undefined)).toBe(15)
    expect(clampHeartbeatIntervalSecs(9_999, 0)).toBe(9_999)
    expect(clampHeartbeatIntervalSecs(9_999, -1)).toBe(9_999)
  })
})
