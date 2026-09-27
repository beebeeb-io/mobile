// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1587 review — behaviour tests of the "+" → New file create flow with
// every effect mocked: the clash on a FRESH re-list, the failure → abandon
// path (the P1), success → the Preview params carry the new file's id.
import { describe, expect, mock, test } from 'bun:test'
import {
  NewDocumentCreateError,
  createNewDocumentFile,
  decryptFolderNames,
  previewParamsForNewDocument,
} from './create-new-document'
import { NEW_DOCUMENT_TYPES, NewDocumentNameClashError } from './new-document'

const md = NEW_DOCUMENT_TYPES.md
const txt = NEW_DOCUMENT_TYPES.txt
const mdReq = { type: md, name: 'Groceries.md', mimeType: 'text/markdown', opensInEditor: true }
const pyReq = { type: txt, name: 'deploy.py', mimeType: 'text/x-python', opensInEditor: true }

function makeDeps(over = {}) {
  const calls = { order: [] }
  const deps = {
    isUnlocked: () => true,
    listFolderNames: mock(async () => { calls.order.push('list'); return ['Other.md'] }),
    generateFileId: mock(async () => { calls.order.push('id'); return 'file-123' }),
    writeTempFile: mock(async (fileId, content) => { calls.order.push('write'); calls.content = content; return `cache/new-${fileId}` }),
    deleteTempFile: mock(async () => { calls.order.push('delete') }),
    upload: mock(async (args) => {
      calls.order.push('upload')
      calls.uploadArgs = args
      return { id: args.fileId, size_bytes: 18, created_at: '2026-09-27T20:00:00Z', chunk_count: 1, version_number: 1, storage_pool_id: null }
    }),
    abandonUpload: mock(async () => { calls.order.push('abandon') }),
    ...over,
  }
  return { deps, calls }
}

describe('createNewDocumentFile', () => {
  test('success: re-lists the folder, writes the starter file, uploads it under the new id, cleans the temp file', async () => {
    const { deps, calls } = makeDeps()
    const out = await createNewDocumentFile(mdReq, 'folder-1', deps)
    expect(out.id).toBe('file-123')
    expect(deps.listFolderNames).toHaveBeenCalledWith('folder-1')
    expect(calls.uploadArgs).toEqual({ fileId: 'file-123', uri: 'cache/new-file-123', name: 'Groceries.md', parentId: 'folder-1', mimeType: 'text/markdown' })
    expect(calls.content).toBe('# Groceries\n\n')
    expect(calls.order).toEqual(['list', 'id', 'write', 'upload', 'delete'])
    expect(deps.abandonUpload).not.toHaveBeenCalled()
  })

  test('a clash on the FRESH listing (not the on-screen one) refuses before any upload, and does not abandon', async () => {
    const { deps, calls } = makeDeps({ listFolderNames: mock(async () => ['GROCERIES.md']) })
    await expect(createNewDocumentFile(mdReq, null, deps)).rejects.toBeInstanceOf(NewDocumentNameClashError)
    expect(deps.generateFileId).not.toHaveBeenCalled()
    expect(deps.upload).not.toHaveBeenCalled()
    expect(deps.abandonUpload).not.toHaveBeenCalled()
    expect(calls.order).toEqual([])
  })

  test('the fresh-listing clash folds Unicode (NFD sibling vs NFC name)', async () => {
    const { deps } = makeDeps({ listFolderNames: mock(async () => ['Café.md']) })
    await expect(createNewDocumentFile({ ...mdReq, name: 'Café.md' }, null, deps)).rejects.toBeInstanceOf(NewDocumentNameClashError)
  })

  test('P1: an upload that fails after init abandons THAT file id, then reports a user-facing error', async () => {
    const { deps, calls } = makeDeps({
      upload: mock(async () => { calls.order.push('upload'); throw new Error('Network request failed') }),
    })
    const err = await createNewDocumentFile(pyReq, null, deps).catch((e) => e)
    expect(err).toBeInstanceOf(NewDocumentCreateError)
    expect(err.message).toBe("Couldn't create the file: Network request failed")
    expect(deps.abandonUpload).toHaveBeenCalledTimes(1)
    expect(deps.abandonUpload).toHaveBeenCalledWith('file-123')
    expect(calls.order).toEqual(['list', 'id', 'write', 'upload', 'abandon', 'delete'])
  })

  test('P1: a failing abandon (NotFound / offline) is swallowed — the original error still surfaces', async () => {
    const { deps } = makeDeps({
      upload: mock(async () => { throw new Error('upload failed') }),
      abandonUpload: mock(async () => { throw new Error('404 NotFound') }),
    })
    const err = await createNewDocumentFile(pyReq, null, deps).catch((e) => e)
    expect(err.message).toBe("Couldn't create the file: upload failed")
    expect(deps.abandonUpload).toHaveBeenCalledWith('file-123')
    expect(deps.deleteTempFile).toHaveBeenCalledWith('cache/new-file-123')
  })

  test('a failure before a file id exists (the re-list) abandons nothing', async () => {
    const { deps } = makeDeps({ listFolderNames: mock(async () => { throw new Error('offline') }) })
    const err = await createNewDocumentFile(pyReq, null, deps).catch((e) => e)
    expect(err).toBeInstanceOf(NewDocumentCreateError)
    expect(deps.abandonUpload).not.toHaveBeenCalled()
  })

  test('the error text goes through the caller\'s describer (friendlyError in FilesScreen)', async () => {
    const { deps } = makeDeps({ upload: mock(async () => { throw new Error('raw') }) })
    const err = await createNewDocumentFile(pyReq, null, deps, () => 'No connection').catch((e) => e)
    expect(err.message).toBe("Couldn't create the file: No connection")
  })

  test('a locked vault refuses before listing or uploading', async () => {
    const { deps } = makeDeps({ isUnlocked: () => false })
    await expect(createNewDocumentFile(mdReq, null, deps)).rejects.toThrow('The vault locked. Unlock it, then try again.')
    expect(deps.listFolderNames).not.toHaveBeenCalled()
    expect(deps.upload).not.toHaveBeenCalled()
  })
})

// Codex PR #139 P2: the fresh clash check decrypts request uploads itself
// (getRequestContentKey path) instead of trusting the possibly stale cache.
describe('decryptFolderNames (fresh clash names)', () => {
  const listing = [
    { id: 'n1', req: false, enc: 'e-n1' },
    { id: 'r1', req: true, enc: 'e-r1' }, // arrived from another device: NOT in the cache
  ]
  function sources(over = {}) {
    return {
      isRequestUpload: (f) => f.req,
      decryptNormalNames: mock(async (fs) => fs.map((f) => (f.id === 'n1' ? 'Other.md' : null))),
      decryptRequestUploadName: mock(async (f) => (f.id === 'r1' ? 'Notes.md' : 'x')),
      cachedName: () => undefined,
      ...over,
    }
  }

  test('a request upload missing from the cache is decrypted with its own key and clashes: creating "notes.md" is refused', async () => {
    const src = sources()
    const { deps } = makeDeps({ listFolderNames: mock(async () => decryptFolderNames(listing, src)) })
    await expect(createNewDocumentFile({ ...mdReq, name: 'notes.md' }, 'folder-1', deps)).rejects.toBeInstanceOf(NewDocumentNameClashError)
    expect(src.decryptRequestUploadName).toHaveBeenCalledTimes(1)
    expect(deps.upload).not.toHaveBeenCalled()
  })

  test('the fresh decrypt wins over a stale cached name (renamed elsewhere)', async () => {
    const names = await decryptFolderNames(listing, sources({ cachedName: (f) => (f.id === 'r1' ? 'Old.md' : undefined) }))
    expect(names.sort()).toEqual(['Notes.md', 'Other.md'])
  })

  test('one undecryptable request upload is unknown (cache fallback, else nothing); the rest still count', async () => {
    const two = [...listing, { id: 'r2', req: true, enc: 'bad' }]
    const failR2 = mock(async (f) => { if (f.id === 'r2') throw new Error('bad key'); return 'Notes.md' })
    expect((await decryptFolderNames(two, sources({ decryptRequestUploadName: failR2 }))).sort()).toEqual(['Notes.md', 'Other.md'])
    const cachedR2 = sources({ decryptRequestUploadName: failR2, cachedName: (f) => (f.id === 'r2' ? 'Seen.md' : undefined) })
    expect((await decryptFolderNames(two, cachedR2)).sort()).toEqual(['Notes.md', 'Other.md', 'Seen.md'])
  })

  test('a failed normal-batch decrypt fails closed (propagates) instead of skipping every sibling', async () => {
    const src = sources({ decryptNormalNames: mock(async () => { throw new Error('locked') }) })
    await expect(decryptFolderNames(listing, src)).rejects.toThrow('locked')
  })
})

describe('previewParamsForNewDocument', () => {
  test('opens the uploaded file id, in the editor when the extension opens there', () => {
    const uploaded = { id: 'file-123', size_bytes: 18, created_at: 'T', chunk_count: 1, version_number: 1, storage_pool_id: 'p1' }
    expect(previewParamsForNewDocument(uploaded, mdReq)).toEqual({
      fileId: 'file-123',
      fileName: 'Groceries.md',
      mimeType: 'text/markdown',
      sizeBytes: 18,
      createdAt: 'T',
      chunkCount: 1,
      versionNumber: 1,
      storagePoolId: 'p1',
      startInEditMode: true,
    })
    expect(previewParamsForNewDocument(uploaded, { ...pyReq, name: 'data.csv', opensInEditor: false }).startInEditMode).toBe(false)
  })
})
