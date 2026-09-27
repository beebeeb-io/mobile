// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 — "Ask when a file changed on another device" defaults OFF.
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()
let failReads = false

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (failReads) throw new Error('storage unavailable')
      return store.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      store.set(key, value)
    },
  },
}))

const { getAskOnRemoteChange, setAskOnRemoteChange, DEFAULT_ASK_ON_REMOTE_CHANGE } = await import('./editor-conflict-setting')

beforeEach(() => {
  store.clear()
  failReads = false
})

describe('editor conflict setting', () => {
  test('defaults to OFF on a fresh install', async () => {
    expect(DEFAULT_ASK_ON_REMOTE_CHANGE).toBe(false)
    expect(await getAskOnRemoteChange()).toBe(false)
  })

  test('persists ON and back OFF', async () => {
    await setAskOnRemoteChange(true)
    expect(await getAskOnRemoteChange()).toBe(true)
    await setAskOnRemoteChange(false)
    expect(await getAskOnRemoteChange()).toBe(false)
  })

  test('a corrupt value or an unreadable store is OFF', async () => {
    store.set('beebeeb:editor-ask-on-remote-change:v1', 'yes please')
    expect(await getAskOnRemoteChange()).toBe(false)
    failReads = true
    expect(await getAskOnRemoteChange()).toBe(false)
  })
})
