// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 — the `file_updated` push is OFF unless the user turned it on.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_NOTIFICATION_PREFERENCES, normalizeNotificationPreferences } from './notification-prefs'

describe('notification preference defaults', () => {
  test('file_updated defaults to OFF', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES.file_updated).toBe(false)
  })

  test('a server response without file_updated shows the toggle OFF', () => {
    const prefs = normalizeNotificationPreferences({
      share_received: true,
      storage_warning: true,
      new_device_login: true,
      backup_complete: false,
    })
    expect(prefs.file_updated).toBe(false)
  })

  test('null / non-boolean file_updated also falls back to OFF', () => {
    expect(normalizeNotificationPreferences({ file_updated: null }).file_updated).toBe(false)
    expect(normalizeNotificationPreferences({ file_updated: 'true' }).file_updated).toBe(false)
    expect(normalizeNotificationPreferences(undefined).file_updated).toBe(false)
  })

  test('an explicit server value wins, both ways', () => {
    expect(normalizeNotificationPreferences({ file_updated: true }).file_updated).toBe(true)
    expect(normalizeNotificationPreferences({ share_received: false }).share_received).toBe(false)
  })

  test('other categories keep their existing defaults when absent', () => {
    expect(normalizeNotificationPreferences({})).toEqual({
      file_updated: false,
      share_received: true,
      storage_warning: true,
      new_device_login: true,
      backup_complete: false,
    })
  })
})
