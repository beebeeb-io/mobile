// @ts-nocheck
/**
 * Task SF-0001 (mobile#259 review M9): "Overwrite" by a member who may only
 * add to a shared folder. The listed id is refused with 403 at the init (an
 * explicit file_id without Edit permission); the bytes then go up as a NEW
 * file under a freshly minted id, as the old name match did (task 2250).
 */
import { describe, expect, mock, test } from 'bun:test'

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message) }
}
class UploadInitRefusedError extends ApiError {
  constructor(message: string) { super(403, message, 'forbidden') }
}
mock.module('./api', () => ({ ApiError, UploadInitRefusedError }))

const { replaceOrAdd, uploadReplacingOrAdding } = await import('./replace-or-add')

describe('replaceOrAdd', () => {
  test('a replace that goes through stays a replace under the listed id', async () => {
    const calls = []
    const out = await replaceOrAdd({
      existingId: 'listed',
      mint: async () => 'never',
      upload: async (t) => { calls.push(t); return t.fileId },
    })
    expect(out).toBe('listed')
    expect(calls).toEqual([{ fileId: 'listed', replacing: true }])
  })

  test('the first init refusing the listed id becomes a new file under a freshly minted id', async () => {
    const calls = []
    const out = await replaceOrAdd({
      existingId: 'listed',
      mint: async () => 'fresh',
      upload: async (t) => {
        calls.push(t)
        if (t.replacing) throw new UploadInitRefusedError('forbidden')
        return t.fileId
      },
    })
    expect(out).toBe('fresh')
    expect(calls).toEqual([{ fileId: 'listed', replacing: true }, { fileId: 'fresh', replacing: false }])
  })

  test('any other failure is not turned into a new file', async () => {
    // mobile#259 round 3: a typed 403 (billing, frozen, unverified) or a plain
    // one from a chunk PUT / complete is the user's answer, not a second upload.
    for (const err of [
      new ApiError(409, 'conflict'),
      new ApiError(500, 'boom'),
      new Error('network'),
      new ApiError(403, 'Your account is read-only', 'billing_read_only'),
      new ApiError(403, 'Account frozen', 'account_frozen'),
      new ApiError(403, 'forbidden', 'forbidden'),
    ]) {
      let attempts = 0
      const out = await replaceOrAdd({
        existingId: 'listed',
        mint: async () => 'fresh',
        upload: async () => { attempts += 1; throw err },
      }).catch((e) => e)
      expect(out).toBe(err)
      expect(attempts).toBe(1)
    }
  })

  test('uploadReplacingOrAdding: a plain upload when nothing is overwritten', async () => {
    const calls = []
    await uploadReplacingOrAdding(undefined, 'new-id', async () => 'never', async (id, replacing) => { calls.push([id, replacing]) })
    expect(calls).toEqual([['new-id', false]])
  })
})
