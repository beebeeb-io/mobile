/**
 * Task 1578 (for task 1580) — the originating device on upload requests.
 *
 * Upload `init` and both upload `complete` calls carry
 * `X-Beebeeb-Device-Id: <getDeviceId()>` — the same header name and value
 * `photoBackupClearAssociation` already sends — so the server can tell which
 * device wrote a version and skip that device when it fans out the
 * `file_updated` push.
 *
 * Pure (the id source is injected) so it is unit-testable without React
 * Native. Best-effort by design: a device id that can't be read must never
 * fail the upload itself, so a rejection or an empty id yields no header.
 */

export const DEVICE_ID_HEADER = 'X-Beebeeb-Device-Id'

export async function deviceIdHeader(getId: () => Promise<string>): Promise<Record<string, string>> {
  try {
    const id = await getId()
    return typeof id === 'string' && id.length > 0 ? { [DEVICE_ID_HEADER]: id } : {}
  } catch {
    return {}
  }
}
