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
 * `classifySaveConflict` tells them apart. The in-progress 409 is NEVER
 * cleared silently: the server cannot say whose upload it is (an orphan from
 * this device's interrupted save, or another device saving right now) and
 * `POST /files/:id/upload/abandon` is file-scoped, so the flow returns
 * `needs-confirmation` and abandons + retries once only after the user says
 * so (`runTextSaveConfirmingClear`). Codex P1/P2 on PR #134: an earlier
 * persisted "uploads this device started" ledger was keyed by file id only
 * and could authorise abandoning another device's live upload — it was
 * removed. The only silent abandon left is this attempt's OWN upload, right
 * after it failed past `init` (known in memory, never persisted). The
 * stale-version 409 goes back to the caller, which shows the existing
 * conflict dialog exactly as before (lead correction, 2026-09-27:
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
  /**
   * The file is marked as uploading by an upload this attempt did not start:
   * an orphan from an interrupted save, or another device saving right now.
   * Only the user can tell those apart — ask before clearing it.
   */
  | { kind: 'needs-confirmation' }
  /** The user declined to clear the in-flight upload. Nothing was abandoned. */
  | { kind: 'cancelled' }
  /** An in-flight upload was cleared once and the retry hit one again. */
  | { kind: 'busy' }
  | { kind: 'error'; error: unknown }

export interface TextSaveOptions {
  baseVersionNumber: number
  /**
   * The user confirmed clearing the file's in-flight upload: on an
   * "already in progress" 409, abandon it and retry once.
   */
  clearInFlightUpload?: boolean
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
  // At most: the original attempt, plus one retry after a user-confirmed clear.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const versionNumber = await deps.save(base)
      return { kind: 'saved', versionNumber }
    } catch (err) {
      const kind = classifySaveConflict(err)
      if (kind === 'upload-in-progress') {
        if (clearedStuckUpload) return { kind: 'busy' }
        if (!opts.clearInFlightUpload) return { kind: 'needs-confirmation' }
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
 * `runTextSave`, plus the one question only the user can answer: when the
 * file is marked as uploading, `confirmClear` asks whether to clear it.
 * Yes → abandon + retry once; no → `cancelled`, nothing abandoned. Always settles; a
 * rejecting `confirmClear` counts as no.
 */
export async function runTextSaveConfirmingClear(
  deps: TextSaveDeps,
  opts: TextSaveOptions,
  confirmClear: () => Promise<boolean>,
): Promise<TextSaveResult> {
  const first = await runTextSave(deps, opts)
  if (first.kind !== 'needs-confirmation') return first
  let confirmed = false
  try {
    confirmed = await confirmClear()
  } catch {
    confirmed = false
  }
  if (!confirmed) return { kind: 'cancelled' }
  return runTextSave(deps, { ...opts, clearInFlightUpload: true })
}

/**
 * `readCurrentVersion` for the editor after a REAL stale-version conflict:
 * refresh ALL of the file's metadata (name, parent, version), not just the
 * version. The conflicting save may also have renamed or moved the file; a
 * later Save sends the cached `nameEncrypted`/`parentId` in the replacement
 * init and would silently revert that (Codex P2, PR #134 — main already did
 * a full `loadFileMeta()` here). `load` resolves null on failure; that is
 * turned into a rejection so `runTextSave` reports an error instead of a
 * conflict dialog with a made-up version.
 */
export async function refreshMetaForConflict(
  load: () => Promise<{ versionNumber: number } | null>,
): Promise<number> {
  const fresh = await load()
  if (!fresh) throw new Error("Could not read this file's current version. Try again.")
  return fresh.versionNumber
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
