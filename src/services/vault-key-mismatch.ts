/**
 * Task 1594 [P0] — the error BackupService throws instead of building a folder
 * tree it cannot read. Its own module (no imports) so backup-context and the
 * Settings surface can recognise it without loading BackupService's tree.
 */

/**
 * Task 1594 [P0]: thrown when a folder listing holds folders whose names this
 * device's master key cannot decrypt and none of them is the folder we need.
 * That is what a WRONG key looks like (another account's key left in the
 * keychain): every name fails, "no match" follows, and ensureFolder used to
 * seal a brand-new Backups tree under the wrong key (5 folders on the dev DB,
 * 2026-09-26). The backup stops instead; nothing is created.
 */
export class VaultKeyMismatchError extends Error {
  readonly code = 'vault_key_mismatch';
  constructor(public readonly undecryptableFolders: number) {
    super(
      `Backup stopped: the vault key on this device can't read ${undecryptableFolders} of your folder name${undecryptableFolders === 1 ? '' : 's'}, ` +
      'so it may not be your account\'s key. Nothing was created. Sign out, sign in again and enter your recovery phrase.',
    );
    this.name = 'VaultKeyMismatchError';
  }
}

export function isVaultKeyMismatchError(err: unknown): err is VaultKeyMismatchError {
  return err instanceof VaultKeyMismatchError
    || (err instanceof Error && (err as { code?: unknown }).code === 'vault_key_mismatch');
}
