/**
 * Drains the iOS Share Extension's App Group dropbox into Beebeeb.
 *
 * The Share Extension lives in a separate process and can't talk to React
 * Native — it just writes file payloads + JSON manifests into the shared
 * App Group container (IncomingShares/ directory). On every cold start and
 * foreground transition the main app calls `processPendingShares()`, which
 * reads the dropbox, copies each file into the main-app sandbox, runs it
 * through the standard encrypted upload flow, and acknowledges the App Group
 * copy only on success.
 *
 * The redesigned Share Extension (v2) also stores a parent-folder mapping
 * as a JSON file in the App Group container (`share-parent-map.json`) so
 * files are uploaded to the folder the user selected in the extension's picker.
 */

import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system'
import { File, Paths } from 'expo-file-system/next'
import {
  acknowledgePendingShare,
  clearAllPendingShares,
  consumePendingShare,
  listPendingShares,
  type EncryptedData,
  type PendingShareResource,
  type PendingShareSummary,
} from '../../modules/beebeeb-crypto'
import { encryptedUpload, generateFileId } from '../../src/lib/encrypted-upload'

export type { PendingShareResource, PendingShareSummary }

const APP_GROUP = 'group.io.beebeeb.shared'
const PARENT_MAP_FILE = 'share-parent-map.json'

export interface ProcessResult {
  uploaded: number
  failed: number
  skipped: number
}

export interface ProcessPendingSharesOptions {
  vaultUnlocked: boolean
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>
  onItemUploaded?: (item: PendingShareResource) => void
}

const NOOP: ProcessResult = { uploaded: 0, failed: 0, skipped: 0 }

/**
 * Quick check used by the App.tsx mount/foreground hooks to know whether
 * there's anything to drain. Returns 0 on non-iOS — the extension is
 * iOS-only.
 */
export async function getPendingSharesCount(): Promise<number> {
  if (Platform.OS !== 'ios') return 0
  try {
    const list = await listPendingShares()
    return list.length
  } catch {
    return 0
  }
}

/**
 * Drain the dropbox. The caller must provide an unlocked vault and the normal
 * encryption functions. If the vault is locked, leave every share in the App
 * Group so it can be imported after unlock instead of leaking plaintext.
 */
export async function processPendingShares(opts: ProcessPendingSharesOptions): Promise<ProcessResult> {
  if (Platform.OS !== 'ios') return NOOP

  let pending: PendingShareSummary[]
  try {
    pending = await listPendingShares()
  } catch {
    return NOOP
  }
  if (pending.length === 0) return NOOP

  if (!opts.vaultUnlocked) {
    return { uploaded: 0, failed: 0, skipped: pending.length }
  }

  // Read the parent-folder mapping from the App Group container.
  // The share extension writes this so we know where to upload each file.
  const parentMap = readParentMap()

  const result: ProcessResult = { uploaded: 0, failed: 0, skipped: 0 }
  const uploadedIds: string[] = []

  for (const summary of pending) {
    let resource: PendingShareResource
    try {
      resource = await consumePendingShare(summary.id)
    } catch {
      result.failed += 1
      continue
    }

    try {
      // Look up the target folder from the parent map
      const parentId = parentMap[summary.id] ?? undefined

      await encryptedUpload({
        fileId: await generateFileId(),
        uri: resource.uri,
        name: resource.filename,
        parentId,
        mimeType: resource.mimeType,
        encryptChunkFn: opts.encryptChunkFn,
        encryptMetadataFn: opts.encryptMetadataFn,
      })
      result.uploaded += 1
      uploadedIds.push(summary.id)
      try {
        await acknowledgePendingShare(summary.id)
      } catch {
        // Upload succeeded, but the share may be retried if native cleanup fails.
      }
      opts?.onItemUploaded?.(resource)
    } catch {
      result.failed += 1
    } finally {
      // Always discard the main-app staging copy. The App Group original is
      // acknowledged only after upload, so failed imports remain retryable.
      try {
        await FileSystem.deleteAsync(resource.uri, { idempotent: true })
      } catch {
        // best-effort cleanup
      }
    }
  }

  // Clean up processed entries from the parent map
  if (uploadedIds.length > 0) {
    cleanParentMap(parentMap, uploadedIds)
  }

  return result
}

/**
 * Read the parent-folder mapping from the App Group container.
 * The share extension writes `share-parent-map.json` with format: { [shareId]: folderId }
 */
function readParentMap(): Record<string, string> {
  try {
    const groupDirectory = Paths.appleSharedContainers[APP_GROUP]
    if (!groupDirectory?.exists) return {}

    const file = new File(groupDirectory, PARENT_MAP_FILE)
    if (!file.exists) return {}

    const content = file.text()
    if (!content) return {}
    return JSON.parse(content) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Remove uploaded entries from the parent map and persist back.
 */
function cleanParentMap(
  currentMap: Record<string, string>,
  uploadedIds: string[],
): void {
  try {
    const groupDirectory = Paths.appleSharedContainers[APP_GROUP]
    if (!groupDirectory?.exists) return

    const cleaned = { ...currentMap }
    for (const id of uploadedIds) {
      delete cleaned[id]
    }

    const file = new File(groupDirectory, PARENT_MAP_FILE)
    if (Object.keys(cleaned).length === 0) {
      if (file.exists) file.delete()
    } else {
      if (!file.exists) file.create()
      file.write(JSON.stringify(cleaned))
    }
  } catch {
    // best-effort
  }
}

/**
 * Bail-out used during sign-out: drop everything queued without uploading
 * (the next user shouldn't inherit the previous user's pending shares).
 */
export async function discardAllPendingShares(): Promise<number> {
  if (Platform.OS !== 'ios') return 0
  try {
    const count = await clearAllPendingShares()
    // Also clear the parent map
    try {
      const groupDirectory = Paths.appleSharedContainers[APP_GROUP]
      if (groupDirectory?.exists) {
        const file = new File(groupDirectory, PARENT_MAP_FILE)
        if (file.exists) file.delete()
      }
    } catch {
      // best-effort
    }
    return count
  } catch {
    return 0
  }
}
