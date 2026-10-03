// @ts-nocheck
/**
 * Task 1610 — `setupTotp()`'s request shape.
 *
 * Bug: the client always POSTed `/api/v1/auth/2fa/setup` with an empty body
 * and no `X-Confirm-Token`. The server requires step-up (either the current
 * TOTP/backup code as `body.code`, or a step-up token as `X-Confirm-Token`)
 * once the account already has 2FA on (`routes/totp.rs`
 * `setup_step_up_validated_if_required`) — server behavior verified correct,
 * not loosened. This proves the CLIENT now sends one of those two things
 * when asked to, and still sends the original bare call when neither is
 * supplied (the fresh-enrollment, 2FA-off path, unchanged).
 *
 * Isolated per bun:test-per-file semantics (mobile CLAUDE.md, "Tests") —
 * mocks mirror `api.upload-session-reinit.test.ts`'s minimal set (only what
 * `setupTotp`/`disableTotp` actually touch through the shared `request()`
 * helper: token storage + the fetch transport).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()
const fetchCalls: Array<{ url: string; init: RequestInit }> = []
let nextResponse: (() => Promise<Response>) | null = null

mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' }, version: '1.0.0' } },
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
  uploadAsync: async () => { throw new Error('not expected in this file') },
}))
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => null,
  uploadChunksNative: async () => { throw new Error('native path not expected in this file') },
}))
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }))
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }))
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }))
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    if (!nextResponse) throw new Error(`unexpected fetch: ${url}`)
    return nextResponse()
  },
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestBody(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string)
}

async function loadFreshApi() {
  return import(`./api?totpSetupTest=${Math.random()}`)
}

beforeEach(() => {
  store.clear()
  store.set('beebeeb_session_token', 'test-token')
  fetchCalls.length = 0
  nextResponse = null
})

describe('setupTotp request shape', () => {
  test('called bare (fresh enrollment, 2FA off): empty body, no X-Confirm-Token — unchanged behavior', async () => {
    nextResponse = async () => jsonResponse({ secret: 'S', qr_uri: 'otpauth://x', backup_codes: ['1'] })
    const { setupTotp } = await loadFreshApi()
    await setupTotp()
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toBe('https://api.test/api/v1/auth/2fa/setup')
    expect(requestBody(call)).toEqual({})
    expect((call.init.headers as Record<string, string>)['X-Confirm-Token']).toBeUndefined()
  })

  test('called with a code: body carries it, no X-Confirm-Token', async () => {
    nextResponse = async () => jsonResponse({ secret: 'S', qr_uri: 'otpauth://x', backup_codes: ['1'] })
    const { setupTotp } = await loadFreshApi()
    await setupTotp({ code: '654321' })
    const call = fetchCalls[0]
    expect(requestBody(call)).toEqual({ code: '654321' })
    expect((call.init.headers as Record<string, string>)['X-Confirm-Token']).toBeUndefined()
  })

  test('called with a confirmToken: X-Confirm-Token header carries it, empty body', async () => {
    nextResponse = async () => jsonResponse({ secret: 'S', qr_uri: 'otpauth://x', backup_codes: ['1'] })
    const { setupTotp } = await loadFreshApi()
    await setupTotp({ confirmToken: 'tok-abc' })
    const call = fetchCalls[0]
    expect(requestBody(call)).toEqual({})
    expect((call.init.headers as Record<string, string>)['X-Confirm-Token']).toBe('tok-abc')
  })

  test('a bare call against an already-enabled account surfaces the 403 with the server message (never silently swallowed)', async () => {
    nextResponse = async () => jsonResponse(
      { error: 'confirmation_required', message: 'This action requires password confirmation' },
      403,
    )
    const { setupTotp, ApiError } = await loadFreshApi()
    let caught: unknown
    try {
      await setupTotp()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as InstanceType<typeof ApiError>).status).toBe(403)
    expect((caught as InstanceType<typeof ApiError>).message).toBe('This action requires password confirmation')
  })

  // Documents a real gap found while building this fix, NOT fixed here (out
  // of scope — broad blast radius across every other caller of the shared
  // `request()` helper): mobile only carries `err.error` through as
  // `ApiError.code` for an allowlist (account_mismatch, plan_required,
  // account_lapsed — see `request()`'s `!res.ok` branch in api.ts). Every
  // other server error code, including `confirmation_required` and
  // `invalid_totp_code`, comes back with `code: undefined`. The screen
  // branches on `.status` instead (see TwoFactorSetupScreen.tsx's
  // StepDisable/StepReauth) specifically because of this gap — pin it down
  // here so a future attempt to "simplify" those branches back to `.code`
  // fails loudly.
  test('KNOWN GAP: .code is undefined for error codes outside the allowlist — status is the reliable signal', async () => {
    nextResponse = async () => jsonResponse(
      { error: 'invalid_totp_code', message: "That code didn't match. Check your authenticator app and try again." },
      400,
    )
    const { setupTotp, ApiError } = await loadFreshApi()
    let caught: unknown
    try {
      await setupTotp({ code: '000000' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as InstanceType<typeof ApiError>).status).toBe(400)
    expect((caught as InstanceType<typeof ApiError>).code).toBeUndefined()
    expect((caught as InstanceType<typeof ApiError>).message).toBe(
      "That code didn't match. Check your authenticator app and try again.",
    )
  })
})

describe('disableTotp request shape (unchanged — regression guard)', () => {
  test('sends the code in the body, no X-Confirm-Token', async () => {
    nextResponse = async () => jsonResponse({})
    const { disableTotp } = await loadFreshApi()
    await disableTotp('111222')
    const call = fetchCalls[0]
    expect(call.url).toBe('https://api.test/api/v1/auth/2fa/disable')
    expect(requestBody(call)).toEqual({ code: '111222' })
    expect((call.init.headers as Record<string, string>)['X-Confirm-Token']).toBeUndefined()
  })
})
