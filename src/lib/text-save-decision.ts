/**
 * Task 1563 — pure save/conflict decision logic for the text/markdown/code
 * editor's Save flow. Deliberately dependency-free (no `api.ts`, no RN) so
 * it is directly unit-testable with no module mocking at all; the network
 * call itself and the `ApiError`-based conflict DETECTION live in
 * `text-file-save.ts`, which is the thin, RN-dependent layer that calls into
 * these pure functions.
 */

/** "Keep both" naming for the conflict dialog: "<name> (edited on <device>)<.ext>". */
export function buildKeepBothName(originalName: string, deviceLabel: string): string {
  const dot = originalName.lastIndexOf('.')
  const hasExt = dot > 0 && dot < originalName.length - 1
  const stem = hasExt ? originalName.slice(0, dot) : originalName
  const ext = hasExt ? originalName.slice(dot) : ''
  return `${stem} (edited on ${deviceLabel})${ext}`
}

/** Outcome of one save attempt against the server. */
export type SaveAttemptResult =
  | { kind: 'success' }
  | { kind: 'conflict' }
  | { kind: 'error' }

/** What the UI shows next after a save attempt resolves. */
export type SaveNextAction =
  | { action: 'done' }
  | { action: 'show-conflict-dialog' }
  | { action: 'show-error' }

export function decideAfterSaveAttempt(result: SaveAttemptResult): SaveNextAction {
  switch (result.kind) {
    case 'success':
      return { action: 'done' }
    case 'conflict':
      return { action: 'show-conflict-dialog' }
    case 'error':
      return { action: 'show-error' }
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

/** The three (plus Cancel) options the conflict dialog offers. */
export type ConflictChoice = 'keep-both' | 'new-version' | 'discard' | 'cancel'

export type ConflictNextAction =
  | { action: 'retry-as-keep-both' }
  | { action: 'retry-as-new-version' }
  | { action: 'discard-and-close' }
  | { action: 'stay-in-editor' }

export function decideAfterConflictChoice(choice: ConflictChoice): ConflictNextAction {
  switch (choice) {
    case 'keep-both':
      return { action: 'retry-as-keep-both' }
    case 'new-version':
      return { action: 'retry-as-new-version' }
    case 'discard':
      return { action: 'discard-and-close' }
    case 'cancel':
      return { action: 'stay-in-editor' }
    default: {
      const _exhaustive: never = choice
      return _exhaustive
    }
  }
}
