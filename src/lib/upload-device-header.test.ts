// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 (for 1580) — the device-id header on upload init/complete.
import { describe, expect, test } from 'bun:test'
import { DEVICE_ID_HEADER, deviceIdHeader } from './upload-device-header'

describe('deviceIdHeader', () => {
  test('uses the header name the server already reads on photo-backup clear-association', () => {
    expect(DEVICE_ID_HEADER).toBe('X-Beebeeb-Device-Id')
  })

  test('carries the canonical device id', async () => {
    expect(await deviceIdHeader(async () => 'dev-123')).toEqual({ 'X-Beebeeb-Device-Id': 'dev-123' })
  })

  test('a device id that cannot be read adds no header and never throws into the upload', async () => {
    expect(await deviceIdHeader(async () => {
      throw new Error('keychain locked')
    })).toEqual({})
    expect(await deviceIdHeader(async () => '')).toEqual({})
  })
})
