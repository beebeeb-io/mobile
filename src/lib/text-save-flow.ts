/**
 * Task 1578 — the text editor's Save orchestration, as a dependency-injected
 * pure module (no `api.ts`, no React Native) so every branch is unit-testable.
 *
 * Why this exists (build 218, Guus's device report): the editor treated EVERY
 * HTTP 409 from `POST /api/v1/uploads/init` as "a newer version was saved on
 * another device". The server returns 409 for two different reasons
 * (`beebeeb-api/src/routes/uploads.rs`, `init_upload`):
 *
 *   - "upload is already in progress for this file" — `files.is_uploading`
 *     is still TRUE from an earlier save that started (init succeeded) but
 *     never reached `complete`. Nothing on the client ever cleaned that up
 *     (the server's own TTL sweep only runs after 7 days), so ONE interrupted
 *     save made every later save of that file fail with a false "another
 *     device" dialog, on a single device.
 *   - "stale base version for replacement upload" — the real optimistic-
 *     concurrency conflict: someone else saved first.
 *
 * `classifySaveConflict` tells them apart, `runTextSave` recovers from the
 * first (abandon the stuck upload via `POST /files/:id/upload/abandon`, then
 * retry once) and hands the second back to the caller, which shows the
 * existing conflict dialog exactly as before (lead correction, 2026-09-27:
 * no setting — the popup Guus reported was the `file_updated` push, not
 * this dialog).
 */

export type SaveConflictKind = 'stale-version' | 'upload-in-progress'

interface ErrorLike {
  status?: unknown
  message?: unknown
  code?: unknown
}

/**
 * Which kind of 409 `err` is, or `null` when it is not a save conflict at all.
 * Matches the server's `ApiError::Conflict(String)` wire text, which the
 * mobile `ApiError` carries in both `message` and `code` (the body is
 * `{"error": "<text>"}`). An unrecognised 409 is NOT a stale-version conflict:
 * it must never be reported to the user as "saved on another device".
 */
export function classifySaveConflict(err: unknown): SaveConflictKind | null {
  if (!err || typeof err !== 'object') return null
  const e = err as ErrorLike
  if (e.status !== 409) return null
  const text = `${typeof e.code === 'string' ? e.code : ''} ${typeof e.message === 'string' ? e.message : ''}`.toLowerCase()
  if (text.includes('stale base version')) return 'stale-version'
  if (text.includes('already in progress')) return 'upload-in-progress'
  return null
}

/** Thrown by a `save` dependency to say whether the server had already accepted `init`. */
export interface SaveAttemptFailure {
  cause: unknown
  /** True once `init` succeeded — i.e. this attempt left `files.is_uploading = TRUE` behind. */
  uploadStarted: boolean
}

export interface TextSaveDeps {
  /** One upload attempt against `baseVersionNumber`. Resolves with the new version number. */
  save: (baseVersionNumber: number) => Promise<number>
  /** Tells whether a rejection from `save` happened after `init` succeeded. */
  uploadStarted: (err: unknown) => boolean
  /** `POST /files/:id/upload/abandon` — best-effort, must never throw into the flow. */
  abandon: () => Promise<void>
  /** The file's CURRENT version on the server (`GET /files/:id/versions`). */
  readCurrentVersion: () => Promise<number>
}

export type TextSaveResult =
  | { kind: 'saved'; versionNumber: number }
  /** A real stale-version conflict: another device saved first. */
  | { kind: 'conflict'; freshVersionNumber: number }
  /** An earlier save of this file is still in flight and could not be cleared. */
  | { kind: 'busy' }
  | { kind: 'error'; error: unknown }

export interface TextSaveOptions {
  baseVersionNumber: number
}

async function safeAbandon(deps: TextSaveDeps): Promise<void> {
  try {
    await deps.abandon()
  } catch {
    // Best-effort. The server's 7-day sweep is the backstop.
  }
}

/**
 * Runs one Save. Always settles: every branch either returns or awaits a
 * bounded number of dependency calls (at most two upload attempts), and
 * dependency rejections are turned into `{ kind: 'error' }` — never rethrown —
 * so the caller's `finally { setSaving(false) }` always runs.
 */
export async function runTextSave(deps: TextSaveDeps, opts: TextSaveOptions): Promise<TextSaveResult> {
  const base = opts.baseVersionNumber
  let clearedStuckUpload = false
  // At most: the original attempt, plus one retry after clearing a stuck upload.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const versionNumber = await deps.save(base)
      return { kind: 'saved', versionNumber }
    } catch (err) {
      const kind = classifySaveConflict(err)
      if (kind === 'upload-in-progress') {
        if (clearedStuckUpload) return { kind: 'busy' }
        clearedStuckUpload = true
        await safeAbandon(deps)
        continue
      }
      if (kind === 'stale-version') {
        try {
          return { kind: 'conflict', freshVersionNumber: await deps.readCurrentVersion() }
        } catch (readErr) {
          return { kind: 'error', error: readErr }
        }
      }
      // Any other failure: if this attempt got past `init`, it left the file
      // marked as uploading — clear it now so the NEXT save does not 409.
      if (deps.uploadStarted(err)) await safeAbandon(deps)
      return { kind: 'error', error: err }
    }
  }
  return { kind: 'busy' }
}

/**
 * A synchronous single-flight gate. React state (`saving`) is read from a
 * render closure, so two taps landing before the re-render both saw
 * `saving === false` and started two concurrent uploads of the same file —
 * the second of which is itself an "upload already in progress" 409.
 */
export function createSingleFlight() {
  let busy = false
  return {
    get busy() {
      return busy
    },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined
      busy = true
      try {
        return await fn()
      } finally {
        busy = false
      }
    },
  }
}
