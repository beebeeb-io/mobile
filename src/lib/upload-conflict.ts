/**
 * Task 1685 — pre-upload dedupe decision logic (pure, testable).
 *
 * Before this module the photo-batch path decided conflicts SILENTLY:
 * same-name + size-differs auto-versioned with no prompt, and unresolved
 * collisions got a getUniqueMobileName rename — so re-uploading after a crash
 * duplicated everything (Guus: "op zijn minst wil ik de optie om te
 * overschrijven of skippen en dan per file of alle files"). The batch path now
 * asks per file, with an apply-to-remaining shortcut; FilesScreen only wires
 * the Alert — the decision mapping lives here.
 *
 * Match key: the DECRYPTED filename within the current folder,
 * case-insensitive (the same key findConflict always used). A content-hash key
 * is NOT available on the mobile picker path — picker assets expose name/size
 * only, and the vault's names are E2E-encrypted, so a server-side hash probe
 * does not exist. Filename + the user's own decision is the shipped contract;
 * recorded in task 1685's Notes.
 *
 * Semantics of "Overwrite": the vault is versioned and there is no destructive
 * overwrite primitive — overwrite means a NEW VERSION under the existing file
 * row (reuse id + name_encrypted, exactly what the old single-file "Replace"
 * did). "Skip" drops the incoming file. "Keep both" uploads under a suffixed
 * name with a fresh id.
 */

export type ConflictResolution = 'overwrite' | 'skip' | 'keep-both';

export interface BatchConflictInput {
  /** Index of the asset within the picked batch (the returned map's key). */
  index: number;
  incomingName: string;
  incomingMimeType: string | null;
  incomingSizeBytes: number | null;
  existingId: string;
  existingName: string;
  existingNameEncrypted: string;
  existingSizeBytes: number | null;
}

export type BatchDecision =
  /** Overwrite → upload as a new version of the existing row. */
  | { action: 'version-existing'; existingId: string; existingNameEncrypted: string }
  /** Keep both → upload under this unique suffixed name with a fresh id. */
  | { action: 'keep-both'; finalName: string }
  /** Skip → do not upload this asset at all. */
  | { action: 'skip' };

/** First non-folder row whose decrypted name equals `name` (case-insensitive). */
export function findDecryptedNameConflict(
  name: string,
  namesById?: Readonly<Record<string, string>>,
): string | null {
  if (!name || !namesById) return null;
  const lower = name.toLowerCase();
  for (const [id, decrypted] of Object.entries(namesById)) {
    if (decrypted && decrypted.toLowerCase() === lower) return id;
  }
  return null;
}

/**
 * First `base (N).ext`-style name not present in `takenLower` (lowercased).
 * Mirrors the old FilesScreen.getUniqueMobileName, which now delegates here so
 * there is exactly one suffixing implementation.
 */
export function nextAvailableName(name: string, takenLower: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  let candidate = name;
  while (takenLower.has(candidate.toLowerCase())) {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  }
  return candidate;
}

/**
 * Expand per-file resolutions (the "apply to remaining" choices the caller
 * already expanded) into concrete decisions, assigning keep-both final names
 * that avoid every taken name, every incoming name, and each other.
 *
 * `conflicts` and `resolutions` must be parallel arrays (caller-owned order =
 * the order the prompts ran). Results are keyed by the ORIGINAL batch index.
 */
export function planBatchResolutions(
  conflicts: readonly BatchConflictInput[],
  resolutions: readonly ConflictResolution[],
  takenLower: ReadonlySet<string>,
): Map<number, BatchDecision> {
  if (conflicts.length !== resolutions.length) {
    throw new Error(
      `planBatchResolutions: conflicts (${conflicts.length}) and resolutions (${resolutions.length}) must be parallel arrays`,
    );
  }
  const decisions = new Map<number, BatchDecision>();
  // Reserve every incoming name up front: a later plain (non-conflicting)
  // upload of the same name must never steal a keep-both final name that was
  // already planned for an earlier asset.
  const taken = new Set(takenLower);
  for (const conflict of conflicts) taken.add(conflict.incomingName.toLowerCase());

  conflicts.forEach((conflict, i) => {
    switch (resolutions[i]) {
      case 'overwrite':
        decisions.set(conflict.index, {
          action: 'version-existing',
          existingId: conflict.existingId,
          existingNameEncrypted: conflict.existingNameEncrypted,
        });
        break;
      case 'skip':
        decisions.set(conflict.index, { action: 'skip' });
        break;
      case 'keep-both': {
        const finalName = nextAvailableName(conflict.incomingName, taken);
        taken.add(finalName.toLowerCase());
        decisions.set(conflict.index, { action: 'keep-both', finalName });
        break;
      }
      default:
        throw new Error(`planBatchResolutions: unknown resolution at ${i}: ${String(resolutions[i])}`);
    }
  });
  return decisions;
}