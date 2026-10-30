/**
 * SF-0002 M2a: the per-file write verdict the Files UI will read in run 3.
 *
 * Two independent halves decide it:
 *  - the NAME convention the row was authenticated with (a batch name hit is
 *    `string_or_binary`; an owner-resolved retry reports `string`, `binary` or
 *    `upper_repair`);
 *  - the CONTENT classification of the current `objectVersionId` (from
 *    `classifyOwnerContent`).
 *
 * The contract's decision table, as one function:
 *  - name `upper_repair`                     → read_only (0 requests);
 *  - content `upper_repair`                  → read_only;
 *  - name and content both known, not upper  → writable;
 *  - anything else (unknown)                 → unknown, never writable.
 *
 * Rename needs only the name half (allowed whenever the name is string, binary
 * or string_or_binary). A move keeps the content half because the
 * `objectVersionId` did not change; a NEW object version resets it to unknown.
 *
 * State is keyed by the account epoch and cleared with `clearSharedKeys` (lock,
 * account switch). No UI reads it yet — that is run 3.
 */
import { accountEpoch, onAccountEpochAdvance, sameAccountEpoch, type AccountEpoch } from './account-epoch';
import type { OwnerNameConvention } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';

export type ContentConvention = 'string' | 'binary' | 'string_or_binary' | 'upper_repair' | 'unknown';
export type FileWriteState = 'unknown' | 'writable' | 'read_only';

interface Entry {
  name?: OwnerNameConvention;
  /** The object version the content half describes. */
  objectVersionId?: string;
  content?: ContentConvention;
}

let epoch: AccountEpoch = accountEpoch();
let entries = new Map<string, Entry>();

function live(): Map<string, Entry> {
  if (!sameAccountEpoch(epoch, accountEpoch())) reset();
  return entries;
}

function reset(): void {
  epoch = accountEpoch();
  entries = new Map<string, Entry>();
}

/** Drop every verdict (lock, account switch). */
export function clearWriteState(): void { reset(); }

onAccountEpochAdvance(clearWriteState);

export function recordNameConvention(fileId: string, convention: OwnerNameConvention): void {
  const map = live();
  map.set(fileId, { ...map.get(fileId), name: convention });
}

export function hasUpperRepairName(fileId: string): boolean {
  return live().get(fileId)?.name === 'upper_repair';
}

/**
 * Record a classified content version. `unknown` is never cached (it would
 * pin a failure); a different `objectVersionId` replaces the old content half.
 */
export function recordContentConvention(
  fileId: string,
  objectVersionId: string,
  convention: ContentConvention,
): void {
  const map = live();
  const entry = map.get(fileId) ?? {};
  if (convention === 'unknown') {
    map.set(fileId, { ...entry, objectVersionId, content: undefined });
    return;
  }
  map.set(fileId, { ...entry, objectVersionId, content: convention });
}

/** Note the row's current object version. A CHANGE resets the content half. */
export function noteObjectVersion(fileId: string, objectVersionId: string): void {
  const map = live();
  const entry = map.get(fileId);
  if (!entry) { map.set(fileId, { objectVersionId }); return; }
  if (entry.objectVersionId === objectVersionId) return;
  map.set(fileId, { name: entry.name, objectVersionId });
}

/** The cached classification for this exact version, or `unknown`. */
export function cachedContentConvention(fileId: string, objectVersionId: string): ContentConvention {
  const entry = live().get(fileId);
  if (!entry || entry.objectVersionId !== objectVersionId || !entry.content) return 'unknown';
  return entry.content;
}

export function fileWriteState(fileId: string): FileWriteState {
  const entry = live().get(fileId);
  if (!entry?.name) return 'unknown';
  if (entry.name === 'upper_repair') return 'read_only';
  if (entry.content === 'upper_repair') return 'read_only';
  if (!entry.content || entry.content === 'unknown') return 'unknown';
  return 'writable';
}

/** Rename is allowed whenever the name half is known and not upper_repair. */
export function renameAllowed(fileId: string): boolean {
  const name = live().get(fileId)?.name;
  return name != null && name !== 'upper_repair';
}

/** Overwrite needs both halves decided, and neither read-only. */
export function overwriteAllowed(fileId: string): boolean {
  return fileWriteState(fileId) === 'writable';
}
