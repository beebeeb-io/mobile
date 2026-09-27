// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 (Codex P1 on PR #134) — which in-flight uploads this device started.
import { describe, expect, test } from 'bun:test'
import { OWNED_UPLOAD_TTL_MS, createOwnedUploadLedger } from './owned-upload-ledger'

function memStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

describe('createOwnedUploadLedger', () => {
  test('add / has / remove', async () => {
    const ledger = createOwnedUploadLedger(memStorage())
    expect(await ledger.has('a')).toBe(false)
    await ledger.add('a')
    expect(await ledger.has('a')).toBe(true)
    expect(await ledger.has('b')).toBe(false)
    await ledger.remove('a')
    expect(await ledger.has('a')).toBe(false)
  })

  test('survives a restart (a new ledger over the same storage)', async () => {
    const storage = memStorage()
    await createOwnedUploadLedger(storage).add('a')
    expect(await createOwnedUploadLedger(storage).has('a')).toBe(true)
  })

  test('an entry older than the TTL (under the server 7-day sweep) no longer proves ownership', async () => {
    let t = 1_000_000
    const ledger = createOwnedUploadLedger(memStorage(), () => t)
    await ledger.add('a')
    t += OWNED_UPLOAD_TTL_MS - 1
    expect(await ledger.has('a')).toBe(true)
    t += 2
    expect(await ledger.has('a')).toBe(false)
    expect(OWNED_UPLOAD_TTL_MS).toBeLessThan(7 * 24 * 60 * 60 * 1000)
  })

  test('concurrent adds are not lost', async () => {
    const ledger = createOwnedUploadLedger(memStorage())
    await Promise.all(['a', 'b', 'c'].map((id) => ledger.add(id)))
    expect(await ledger.has('a')).toBe(true)
    expect(await ledger.has('b')).toBe(true)
    expect(await ledger.has('c')).toBe(true)
  })

  test('corrupt or unreadable storage means "not ours"', async () => {
    const storage = memStorage()
    storage.map.set('beebeeb:owned-uploads:v1', 'not json')
    expect(await createOwnedUploadLedger(storage).has('a')).toBe(false)
    const broken = { getItem: async () => { throw new Error('x') }, setItem: async () => { throw new Error('x') } }
    const ledger = createOwnedUploadLedger(broken)
    await ledger.add('a')
    expect(await ledger.has('a')).toBe(false)
  })
})
