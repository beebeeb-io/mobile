/**
 * SF-0002 M2a run 3: the contract's app-side decision table as pure functions.
 *
 * Runs 1–2 produced the two halves of a per-file verdict:
 *  - the NAME convention an owned name authenticated under (`resolveOwnerName`:
 *    `string` | `binary` | `upper_repair`, or the batch's `string_or_binary`);
 *  - the CONTENT convention of the current object version (`classifyOwnerContent`).
 *
 * The screens resolve those first, then ask these functions what to offer. Kept
 * dependency-free so every row of the table is testable without rendering the
 * share sheet, the files list or the editor.
 *
 * Rules (plan amendment (3), decision table + refinement (a)):
 *  - Rename: offered for a String or Binary name (including `string_or_binary`),
 *    even when the CONTENT is UpperRepair. Not for UpperRepair/unresolved names.
 *  - Overwrite / new version / editor save: UpperRepair coerces to a copy
 *    (fresh id, unique name); unknown shows the network copy and uploads
 *    nothing.
 *  - Single-file share: only when the name is exactly String and the content is
 *    not UpperRepair or unknown.
 *  - Folder shares: leave out descendants whose NAME is Binary or UpperRepair.
 *  - Moves stay allowed everywhere.
 */
import type { OwnerNameConvention } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';
import type { ContentConvention } from './sf-0002-write-state';

export const READ_ONLY_EDIT_COPY =
  'This file was saved by an older version of the app and can only be read. Save a copy to edit it.';
export const READ_ONLY_SHARE_COPY =
  "This file was saved by an older version of the app and can't be shared yet.";
/** The existing network-error copy (api.ts `friendlyError` for status 0). */
export const OWNER_CHECK_FAILED_COPY =
  'Could not reach the server. Check your connection and try again.';

/** The listing's object version id; the content classification is keyed by it. */
export function objectVersionIdOf(file: {
  download_version?: string | number | null;
  version_number?: number;
  updated_at?: string;
}): string {
  return String(file.download_version ?? file.version_number ?? file.updated_at ?? 'current');
}

/** A resolved name convention; `null`/`undefined` means unresolved or failed. */
export type NameState = OwnerNameConvention | null | undefined;

const KNOWN_NAMES = new Set<string>(['string', 'binary', 'string_or_binary']);

function knownName(name: NameState): boolean {
  return name != null && KNOWN_NAMES.has(name);
}

/** Rename needs only the name half: known and not UpperRepair. */
export function renameOffer(name: NameState, _content: ContentConvention): 'rename' | 'no-rename' {
  return knownName(name) && name !== 'upper_repair' ? 'rename' : 'no-rename';
}

export type UploadConflictPlan =
  | { action: 'ask' }
  | { action: 'keep-both'; copy: string }
  | { action: 'retry'; copy: string };

/**
 * The upload / new-version conflict sheet. `ask` is the ordinary
 * Overwrite/Keep both prompt; `keep-both` is the coerced read-only choice;
 * `retry` means nothing was uploaded.
 */
export function uploadConflictPlan(name: NameState, content: ContentConvention): UploadConflictPlan {
  if (name === 'upper_repair' || content === 'upper_repair') {
    return { action: 'keep-both', copy: READ_ONLY_EDIT_COPY };
  }
  if (!knownName(name) || content === 'unknown') {
    return { action: 'retry', copy: OWNER_CHECK_FAILED_COPY };
  }
  return { action: 'ask' };
}

export type EditorSavePlan =
  | { action: 'save'; label: 'Save' }
  | { action: 'save-copy'; label: 'Save as a copy'; copy: string }
  | { action: 'retry'; copy: string; retry: boolean };

/**
 * The editor's Save. `save-copy` still saves, but as a fresh file; `retry` with
 * `retry: true` is a classification failure that may be retried, while
 * `retry: false` is a permanently read-only name.
 */
export function editorSavePlan(name: NameState, content: ContentConvention): EditorSavePlan {
  if (name === 'upper_repair') {
    return { action: 'retry', copy: READ_ONLY_EDIT_COPY, retry: false };
  }
  if (!knownName(name)) {
    return { action: 'retry', copy: OWNER_CHECK_FAILED_COPY, retry: true };
  }
  if (content === 'upper_repair') {
    return { action: 'save-copy', label: 'Save as a copy', copy: READ_ONLY_EDIT_COPY };
  }
  if (content === 'unknown') {
    return { action: 'retry', copy: OWNER_CHECK_FAILED_COPY, retry: true };
  }
  return { action: 'save', label: 'Save' };
}

export type SharePlan =
  | { allowed: true }
  | { allowed: false; copy: string; retry: boolean };

/**
 * A single-file share needs the exact String convention: Binary and
 * `string_or_binary` are only proven to decrypt, not proven canonical, so they
 * are refused rather than minted into a link. Unknown is a check failure.
 */
export function singleFileSharePlan(name: NameState, content: ContentConvention): SharePlan {
  if (name === 'upper_repair') {
    return { allowed: false, copy: READ_ONLY_SHARE_COPY, retry: false };
  }
  if (!knownName(name) || content === 'unknown') {
    return { allowed: false, copy: OWNER_CHECK_FAILED_COPY, retry: true };
  }
  if (name === 'string' && content !== 'upper_repair') return { allowed: true };
  return { allowed: false, copy: READ_ONLY_SHARE_COPY, retry: false };
}

export interface FolderShareItem {
  fileId: string;
  name: NameState;
  content?: ContentConvention;
}

export interface FolderSharePlan {
  included: string[];
  excluded: string[];
  /** "N files can't be shared yet", or null when nothing was left out. */
  copy: string | null;
}

/**
 * Folder links and shared-folder publishes are snapshots: a descendant whose
 * NAME is Binary or UpperRepair is left out (the request-upload precedent in
 * folder-bundle.ts) and counted for the sharer.
 */
export function folderSharePlan(items: readonly FolderShareItem[]): FolderSharePlan {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const item of items) {
    if (item.name === 'binary' || item.name === 'upper_repair') excluded.push(item.fileId);
    else included.push(item.fileId);
  }
  const count = excluded.length;
  return {
    included,
    excluded,
    copy: count > 0 ? `${count} ${count === 1 ? 'file' : 'files'} can't be shared yet` : null,
  };
}

/**
 * `BackupService.moveLegacyItem` moves an item and (optionally) renames it. The
 * move is never gated; the rename follows the name half only.
 */
export function legacyMovePlan(name: NameState, targetName: string | null | undefined): { move: true; rename: boolean } {
  return { move: true, rename: renameOffer(name, 'unknown') === 'rename' && !!targetName };
}
