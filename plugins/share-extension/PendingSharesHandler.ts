/**
 * Drains the iOS Share Extension's App Group dropbox into Beebeeb.
 *
 * The Share Extension lives in a separate process and can't talk to React
 * Native — it just writes file payloads + JSON manifests into the shared
 * App Group container. On every cold start and foreground transition the
 * main app calls `processPendingShares()`, which reads the dropbox, copies
 * each file into the main-app sandbox, runs it through the standard
 * upload flow, and removes both copies on success.
 */

import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system'
import {
  clearAllPendingShares,
  consumePendingShare,
  listPendingShares,
  type EncryptedData,
  type PendingShareResource,
  type PendingShareSummary,
} from '../../modules/beebeeb-crypto'
import { encryptedUpload, generateFileId } from '../../src/lib/encrypted-upload'

export type { PendingShareResource, PendingShareSummary }

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

  const result: ProcessResult = { uploaded: 0, failed: 0, skipped: 0 }

  for (const summary of pending) {
    let resource: PendingShareResource
    try {
      resource = await consumePendingShare(summary.id)
    } catch {
      result.failed += 1
      continue
    }

    try {
      await encryptedUpload({
        fileId: generateFileId(),
        uri: resource.uri,
        name: resource.filename,
        mimeType: resource.mimeType,
        encryptChunkFn: opts.encryptChunkFn,
        encryptMetadataFn: opts.encryptMetadataFn,
      })
      result.uploaded += 1
      opts?.onItemUploaded?.(resource)
    } catch {
      result.failed += 1
    } finally {
      // Always discard the staged copy — on failure, the share is gone
      // from the dropbox already (consume removed it) so we'd otherwise
      // leak the file. Re-queueing on failure is a future enhancement.
      try {
        await FileSystem.deleteAsync(resource.uri, { idempotent: true })
      } catch {
        // best-effort cleanup
      }
    }
  }

  return result
}

/**
 * Bail-out used during sign-out: drop everything queued without uploading
 * (the next user shouldn't inherit the previous user's pending shares).
 */
export async function discardAllPendingShares(): Promise<number> {
  if (Platform.OS !== 'ios') return 0
  try {
    return await clearAllPendingShares()
  } catch {
    return 0
  }
}
