// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 — the editor's network layer: foreground chunk transport, the
// "upload started" marker that drives abandon, and the narrowed conflict test.
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const uploadCalls: Array<Record<string, unknown>> = []
let uploadImpl: (params: Record<string, unknown>) => Promise<unknown> = async () => ({ id: 'f', version_number: 2 })
const abandonCalls: string[] = []

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message)
  }
}

mock.module('./api', () => ({
  ApiError,
  uploadEncryptedChunked: async (params: Record<string, unknown>) => {
    uploadCalls.push(params)
    return uploadImpl(params)
  },
  abandonFileUpload: async (id: string) => {
    abandonCalls.push(id)
  },
}))

const {
  abandonTextFileUpload,
  isStaleVersionConflict,
  saveFailedAfterUploadStarted,
  saveTextFileVersion,
} = await import('./text-file-save')

const encryptChunkFn = async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(4) })

beforeEach(() => {
  uploadCalls.length = 0
  abandonCalls.length = 0
  uploadImpl = async () => ({ id: 'f', version_number: 2 })
})

describe('saveTextFileVersion', () => {
  test('sends chunks over a FOREGROUND transfer (the editor is waiting on it)', async () => {
    await saveTextFileVersion({ fileId: 'f', nameEncrypted: 'n', text: 'hi', encryptChunkFn, versionReplace: { baseVersionNumber: 1 } })
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0].foregroundTransfer).toBe(true)
    expect(uploadCalls[0].versionReplace).toEqual({ fileId: 'f', baseVersionNumber: 1 })
  })

  test('a failure after init (first progress event) is marked upload-started', async () => {
    uploadImpl = async (params) => {
      ;(params.onProgress as (p: unknown) => void)({ phase: 'preparing' })
      throw new ApiError(0, 'Could not reach the server.')
    }
    const err = await saveTextFileVersion({ fileId: 'f', nameEncrypted: 'n', text: 'hi', encryptChunkFn }).catch((e) => e)
    expect(saveFailedAfterUploadStarted(err)).toBe(true)
  })

  test('a failure at init (no progress event) is NOT marked upload-started', async () => {
    uploadImpl = async () => {
      throw new ApiError(409, 'upload is already in progress for this file', 'upload is already in progress for this file')
    }
    const err = await saveTextFileVersion({ fileId: 'f', nameEncrypted: 'n', text: 'hi', encryptChunkFn }).catch((e) => e)
    expect(saveFailedAfterUploadStarted(err)).toBe(false)
  })
})

describe('isStaleVersionConflict', () => {
  test('true only for the stale-base 409, not for "upload already in progress"', () => {
    expect(isStaleVersionConflict(new ApiError(409, 'stale base version for replacement upload', 'stale base version for replacement upload'))).toBe(true)
    expect(isStaleVersionConflict(new ApiError(409, 'upload is already in progress for this file', 'upload is already in progress for this file'))).toBe(false)
  })
})

describe('abandonTextFileUpload', () => {
  test('calls the abandon endpoint and swallows its failure', async () => {
    await abandonTextFileUpload('file-1')
    expect(abandonCalls).toEqual(['file-1'])
  })
})
