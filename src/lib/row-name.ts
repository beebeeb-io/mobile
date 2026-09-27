/**
 * row-name — what a Files row shows in its name slot (task 1592 item 6).
 *
 * A row whose name is encrypted shows a grey placeholder bar while the batch
 * decrypt runs. When the decrypt FAILED for that row (the batch returned an
 * error for it, e.g. the name was sealed under a key this vault cannot
 * derive), the row used to keep the placeholder forever: it looked like a
 * load that never finishes. A failed name is a settled state, so it gets
 * settled words instead.
 */

export const NAME_UNAVAILABLE_FOLDER = 'Folder — name unavailable';
export const NAME_UNAVAILABLE_FILE = 'File — name unavailable';

export type RowNameDisplay =
  | { kind: 'name'; text: string }
  | { kind: 'pending' }
  | { kind: 'unavailable'; text: string };

export function rowNameDisplay(opts: {
  decryptedName: string | undefined;
  /** The row's plain fallback (FilesScreen `displayName`): '' for an encrypted name. */
  fallbackName: string;
  nameEncrypted: string | null | undefined;
  isFolder: boolean;
  /** The batch decrypt ran for this row and could not decrypt its name. */
  nameUnavailable: boolean;
}): RowNameDisplay {
  if (opts.decryptedName) return { kind: 'name', text: opts.decryptedName };
  const encrypted = !!opts.nameEncrypted?.startsWith('{');
  if (!encrypted) return { kind: 'name', text: opts.fallbackName };
  if (opts.nameUnavailable) {
    return { kind: 'unavailable', text: opts.isFolder ? NAME_UNAVAILABLE_FOLDER : NAME_UNAVAILABLE_FILE };
  }
  return { kind: 'pending' };
}
