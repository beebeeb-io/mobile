// @ts-nocheck
import { describe, expect, it } from 'bun:test'
import {
  nativeProgressToUploadProgress,
  parseNativeUploadError,
  resumeStateMatchesNativePlan,
} from './native-upload-bridge'

describe('parseNativeUploadError', () => {
  it('extracts the envelope even when Expo wraps the message', () => {
    const wrapped =
      'Unexpected exception: {"bb_upload_error":true,"status":413,"code":"quota_exceeded","message":"Storage quota exceeded"}'
    expect(parseNativeUploadError(wrapped)).toEqual({
      status: 413,
      code: 'quota_exceeded',
      message: 'Storage quota exceeded',
    })
  })

  it('tolerates a missing machine code', () => {
    const env = parseNativeUploadError('{"bb_upload_error":true,"status":500,"message":"Upload failed (HTTP 500)"}')
    expect(env).toEqual({ status: 500, code: undefined, message: 'Upload failed (HTTP 500)' })
  })

  it('returns null for errors that are not from the native uploader', () => {
    expect(parseNativeUploadError('Invalid master key handle ID: 3')).toBeNull()
    expect(parseNativeUploadError(undefined)).toBeNull()
    expect(parseNativeUploadError('{"status":1}')).toBeNull()
  })
})

describe('nativeProgressToUploadProgress', () => {
  const ctx = { chunkSizeBytes: 4 * 1024 * 1024, uploadSessionId: 'sess-1' }

  it('maps a transport tick onto the uploading phase with byte-level progress', () => {
    const p = nativeProgressToUploadProgress(
      {
        requestId: 'r',
        stage: 'uploading',
        chunksUploaded: 1,
        chunksTotal: 5,
        bytesUploaded: 5_500_000,
        bytesTotal: 17_848_752,
        cryptoBytesPerSec: 812_000_000,
      },
      ctx,
    )
    expect(p).toEqual({
      phase: 'uploading',
      chunksTotal: 5,
      chunksUploaded: 1,
      bytesTotal: 17_848_752,
      bytesUploaded: 5_500_000,
      chunkSizeBytes: ctx.chunkSizeBytes,
      cryptoBytesPerSec: 812_000_000,
      uploadSessionId: 'sess-1',
      protocol: 'v2',
    })
  })

  it('reports the encrypting stage as preparing and drops a zero crypto rate', () => {
    const p = nativeProgressToUploadProgress(
      { requestId: 'r', stage: 'encrypting', chunksUploaded: 0, chunksTotal: 0, bytesUploaded: 0, bytesTotal: 0, cryptoBytesPerSec: 0 },
      ctx,
    )
    expect(p.phase).toBe('preparing')
    expect(p.cryptoBytesPerSec).toBeUndefined()
  })

  it('never reports more bytes than the total', () => {
    const p = nativeProgressToUploadProgress(
      { requestId: 'r', stage: 'uploading', chunksUploaded: 2, chunksTotal: 2, bytesUploaded: 1_000_100, bytesTotal: 1_000_000 },
      ctx,
    )
    expect(p.bytesUploaded).toBe(1_000_000)
  })
})

describe('resumeStateMatchesNativePlan', () => {
  const state = {
    protocol: 'v2' as const,
    uploadSessionId: 'sess-9',
    chunkSizeBytes: 4_194_304,
    chunkCount: 10,
    plaintextSizeBytes: 40_195_671,
    parentId: null,
    mimeType: null,
    lastUploadedChunkIndex: 3,
  }
  const plan = { plaintextSizeBytes: 40_195_671, chunkSizeBytes: 4_194_304, chunkCount: 10 }

  it('accepts a v2 session planned with the same chunk layout', () => {
    expect(resumeStateMatchesNativePlan(state, plan)).toBe(true)
  })

  it('rejects a session whose chunk layout differs from the core plan', () => {
    expect(resumeStateMatchesNativePlan({ ...state, chunkSizeBytes: 8_388_608, chunkCount: 5 }, plan)).toBe(false)
  })

  it('rejects v1 sessions, other folders, other sizes and missing state', () => {
    expect(resumeStateMatchesNativePlan({ ...state, protocol: 'v1', uploadSessionId: null }, plan)).toBe(false)
    expect(resumeStateMatchesNativePlan({ ...state, parentId: 'folder-a' }, plan)).toBe(false)
    expect(resumeStateMatchesNativePlan(state, { ...plan, parentId: 'folder-a' })).toBe(false)
    expect(resumeStateMatchesNativePlan({ ...state, plaintextSizeBytes: 1 }, plan)).toBe(false)
    expect(resumeStateMatchesNativePlan(null, plan)).toBe(false)
  })
})
