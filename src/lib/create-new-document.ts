/**
 * Task 1587 — the create flow behind "+" → New file, with every effect
 * injected so it is unit-tested with mocks (create-new-document.test.ts).
 * FilesScreen supplies the real deps (listAllFiles + decryptNames, the cache
 * directory, encryptedUpload, abandonTextFileUpload) and does the UI side
 * (state, toast, navigation) with what this returns.
 *
 * Order, and why:
 *   1. The vault must be open (nothing is created on a plaintext path).
 *   2. A FRESH listing of the folder, every name decrypted now — the on-screen
 *      list can lag a sibling added on another device, and the server cannot
 *      check this itself: it only ever sees encrypted names.
 *   3. A tiny starter file in the cache (never 0 bytes — see
 *      `initialDocumentContent`), encrypted + uploaded through the SAME path
 *      as "Upload file".
 *   4. On failure after a file id exists: a best-effort abandon of that id
 *      (task 1578's pattern). A dropped connection after upload init leaves a
 *      server row with `is_uploading = true`; FilesScreen lists it as pending,
 *      so a retry with the same name would be refused as a clash, and the temp
 *      file the upload could resume from is already gone. For a first version
 *      the server deletes the row (`DeletedNewUpload`); a 404 / NotUploading
 *      is swallowed.
 */

import {
  NewDocumentNameClashError,
  foldName,
  initialDocumentContent,
  type NewDocumentType,
} from './new-document'

export interface NewDocumentCreateRequest {
  type: NewDocumentType
  name: string
  mimeType: string
  opensInEditor: boolean
}

/** The fields of the uploaded entry the caller needs (a structural subset of
 *  api.ts's FileEntry, so this module stays free of React Native imports). */
export interface CreatedFileEntry {
  id: string
  size_bytes?: number | null
  created_at: string
  chunk_count?: number
  version_number?: number
  storage_pool_id?: string | null
}

export interface CreateNewDocumentDeps<E extends CreatedFileEntry> {
  /** True when the vault is unlocked right now. */
  isUnlocked: () => boolean
  /** Every decryptable name in the folder, from a FRESH listing. */
  listFolderNames: (parentId: string | null) => Promise<string[]>
  generateFileId: () => Promise<string>
  /** Writes the starter content to a temp file named after the file id (never
   *  the name); returns its uri. */
  writeTempFile: (fileId: string, content: string) => Promise<string>
  deleteTempFile: (uri: string) => Promise<void>
  /** The encrypted upload ("Upload file"'s path). */
  upload: (args: { fileId: string; uri: string; name: string; parentId: string | null; mimeType: string }) => Promise<E>
  /** Clears a half-finished upload of `fileId` on the server. */
  abandonUpload: (fileId: string) => Promise<void>
}

/** Thrown for every non-clash failure; the message is user-facing. */
export class NewDocumentCreateError extends Error {
  constructor(detail: string) {
    super(`Couldn't create the file: ${detail}`)
    this.name = 'NewDocumentCreateError'
  }
}

export async function createNewDocumentFile<E extends CreatedFileEntry>(
  req: NewDocumentCreateRequest,
  parentId: string | null,
  deps: CreateNewDocumentDeps<E>,
  describeError: (err: unknown) => string = (e) => (e instanceof Error ? e.message : String(e)),
): Promise<E> {
  if (!deps.isUnlocked()) throw new Error('The vault locked. Unlock it, then try again.')
  let fileId: string | null = null
  let tempUri: string | null = null
  try {
    const siblings = await deps.listFolderNames(parentId)
    const wanted = foldName(req.name)
    if (siblings.some((n) => foldName(n) === wanted)) throw new NewDocumentNameClashError(req.name)
    fileId = await deps.generateFileId()
    tempUri = await deps.writeTempFile(fileId, initialDocumentContent(req.type, req.name))
    return await deps.upload({ fileId, uri: tempUri, name: req.name, parentId, mimeType: req.mimeType })
  } catch (err) {
    if (err instanceof NewDocumentNameClashError) throw err
    if (fileId) {
      try {
        await deps.abandonUpload(fileId)
      } catch {
        // Best-effort by design: NotFound (init never reached the server),
        // NotUploading, or offline. The server's stale-upload sweep is the backstop.
      }
    }
    throw new NewDocumentCreateError(describeError(err))
  } finally {
    if (tempUri) {
      try {
        await deps.deleteTempFile(tempUri)
      } catch {
        // A leftover cache file is harmless and the OS clears the cache.
      }
    }
  }
}

/** The Preview route params for a just-created file (opened in the editor
 *  when its extension opens there). */
export function previewParamsForNewDocument(uploaded: CreatedFileEntry, req: NewDocumentCreateRequest) {
  return {
    fileId: uploaded.id,
    fileName: req.name,
    mimeType: req.mimeType,
    sizeBytes: uploaded.size_bytes ?? 0,
    createdAt: uploaded.created_at,
    chunkCount: uploaded.chunk_count,
    versionNumber: uploaded.version_number,
    storagePoolId: uploaded.storage_pool_id ?? null,
    startInEditMode: req.opensInEditor,
  }
}
