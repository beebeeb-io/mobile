// @ts-nocheck
/**
 * Task 1683f — the trash-cancels-in-flight contract at the api.ts seam:
 *
 *   1. `registerUploadAbort(fileId)` hands back a live signal;
 *      `abortUploadForFile(fileId)` aborts it (true) and settles the entry
 *      (a second call finds nothing and returns false).
 *   2. a caller-supplied signal forwards into the registered controller — BOTH
 *      the upload's own signal and a later trash abort reach the engine run.
 *   3. the resume-state index: seeded keys + index are dropped wholesale by
 *      `sweepAllUploadResumeStates` (the sign-out sweep — today these keys
 *      survive sign-out AND account switches, a cross-account leak), and
 *      `clearUploadResumeState` removes a single key + its index entry.
 *
 * Isolated per bun:test-per-file semantics (mobile CLAUDE.md, "Tests"); mock
 * header cloned from api.heartbeat-clamp.test.ts (the proven api.ts loader).
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
// The sync-client/file-index-cache/announcement-context subtrees pull RN's
// codegen path (TurboModuleRegistry named check dies on the real index.js) —
// mock them at the leaves exactly like api.heartbeat-clamp.test.ts does.
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }))
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }))
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }))
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => null,
  uploadChunksNative: async () => { throw new Error('not exercised in this file') },
  decryptLocalFileNative: async () => { throw new Error('not exercised in this file') },
  downloadAndDecryptFileNative: async () => { throw new Error('not exercised in this file') },
  isNativeAvailable: true,
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
  logDiagnostic: () => {},
}))

const {
  registerUploadAbort,
  abortUploadForFile,
  settleUploadSignal,
  sweepAllUploadResumeStates,
  clearUploadResumeState,
} = await import('./api')

describe('task 1683f — trash cancels the in-flight upload (api seam)', () => {
  test('abortUploadForFile aborts the registered signal and settles the entry', () => {
    const signal = registerUploadAbort('file-a')
    expect(signal.aborted).toBe(false)
    expect(abortUploadForFile('file-a')).toBe(true)
    expect(signal.aborted).toBe(true)
    // Settled — a second trash call finds nothing (the entry was removed).
    expect(abortUploadForFile('file-a')).toBe(false)
  })

  test('a caller signal forwards into the registered controller; settle clears the entry', () => {
    const caller = new AbortController()
    const registered = registerUploadAbort('file-b', caller.signal)
    expect(registered.aborted).toBe(false)
    caller.abort()
    expect(registered.aborted).toBe(true)
    // Still registered until the engine settles — trash can also abort it.
    expect(abortUploadForFile('file-b')).toBe(true)
    settleUploadSignal('file-b', registered)
    expect(abortUploadForFile('file-b')).toBe(false)
  })

  test('registerUploadAbort aborts a stale run when the same file registers again', () => {
    const first = registerUploadAbort('file-c')
    const second = registerUploadAbort('file-c')
    expect(first.aborted).toBe(true) // superseded
    expect(second.aborted).toBe(false)
    expect(abortUploadForFile('file-c')).toBe(true)
    expect(second.aborted).toBe(true)
  })

  test('sweepAllUploadResumeStates drops every indexed resume key + the index', async () => {
    // Seed the store the way saveUploadResumeState would (it is module-private;
    // the sweep + index are the contract under test).
    store.set('beebeeb_upload_resume_k1', JSON.stringify({ protocol: 'v1', fileId: 'f1' }))
    store.set('beebeeb_upload_resume_k2', JSON.stringify({ protocol: 'v2', fileId: 'f2' }))
    store.set('beebeeb_upload_resume_index', JSON.stringify(['k1', 'k2']))
    await sweepAllUploadResumeStates()
    expect(store.has('beebeeb_upload_resume_k1')).toBe(false)
    expect(store.has('beebeeb_upload_resume_k2')).toBe(false)
    expect(store.has('beebeeb_upload_resume_index')).toBe(false)
    // Sweeping again on an empty store is a no-op (never throws).
    await sweepAllUploadResumeStates()
  })

  test('clearUploadResumeState removes the key AND its index entry', async () => {
    store.set('beebeeb_upload_resume_k3', JSON.stringify({ protocol: 'v1', fileId: 'f3' }))
    store.set('beebeeb_upload_resume_index', JSON.stringify(['k3', 'k4']))
    await clearUploadResumeState('k3')
    expect(store.has('beebeeb_upload_resume_k3')).toBe(false)
    expect(JSON.parse(store.get('beebeeb_upload_resume_index'))).toEqual(['k4'])
  })
})
