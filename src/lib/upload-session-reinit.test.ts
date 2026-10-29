// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1589 — pure-function tests for `isUploadSessionGone` /
 * `UploadRestartFailedError`. No mocks needed: this module is
 * dependency-free by design (see its header).
 */
import { describe, expect, test } from 'bun:test'
import { isUploadSessionGone, UploadRestartFailedError } from './upload-session-reinit'

describe('isUploadSessionGone', () => {
  test('404 is always gone, regardless of body', () => {
    expect(isUploadSessionGone(404)).toBe(true)
    expect(isUploadSessionGone(404, undefined)).toBe(true)
    expect(isUploadSessionGone(404, { error: 'not_found' })).toBe(true)
    expect(isUploadSessionGone(404, {})).toBe(true)
  })

  test('400 "not writable: expired" (legacy pre-#120 server) is gone', () => {
    expect(isUploadSessionGone(400, { error: 'upload session is not writable: expired' })).toBe(true)
    expect(isUploadSessionGone(400, { message: 'Upload session is not writable: EXPIRED' })).toBe(true)
    // A little whitespace variance in the message is still matched.
    expect(isUploadSessionGone(400, { error: 'not writable:   expired' })).toBe(true)
  })

  test('a 400 for an unrelated reason is NOT gone', () => {
    expect(isUploadSessionGone(400, { error: 'chunk 0 has not been uploaded' })).toBe(false)
    expect(isUploadSessionGone(400, {})).toBe(false)
    expect(isUploadSessionGone(400)).toBe(false)
  })

  test('every other status is NOT gone — 409 conflict, 401, 429, 500, 200', () => {
    expect(isUploadSessionGone(409, { error: 'upload_in_progress' })).toBe(false)
    expect(isUploadSessionGone(401)).toBe(false)
    expect(isUploadSessionGone(429)).toBe(false)
    expect(isUploadSessionGone(500)).toBe(false)
    expect(isUploadSessionGone(200)).toBe(false)
  })

  test('409 account_mismatch is NOT gone — that is a different, higher-priority signal', () => {
    expect(isUploadSessionGone(409, { error: 'account_mismatch' })).toBe(false)
  })
})

describe('UploadRestartFailedError', () => {
  test('is a distinctly-named Error with a sensible default message', () => {
    const err = new UploadRestartFailedError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('UploadRestartFailedError')
    expect(err.message.length).toBeGreaterThan(0)
  })

  test('accepts a custom message', () => {
    const err = new UploadRestartFailedError('custom')
    expect(err.message).toBe('custom')
  })
})
