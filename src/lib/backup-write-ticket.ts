/**
 * backup-write-ticket — the JS side of the backup manifest's write fence.
 *
 * Task 1667 round 8 (Codex P1 "Fence late photo scans before resetting the
 * manifest", mobile#182 at 556ef334). The native engine fences its own
 * writers with a generation that the sign-out reset advances
 * (`ManifestWriteFence.swift`). This module does the same for every write
 * the JS layer makes to `beebeeb-backup.db` (`BackupDatabase.ts`).
 *
 * A ticket is taken when the work STARTS (a delete, a verification, a
 * reconcile), before its first await. A write under it runs only while both
 * still hold:
 *   - the account epoch (`account-epoch.ts`): moved by every sign-in and
 *     sign-out (`setToken` / `clearToken`);
 *   - the purge generation: moved by every storage-purge hold
 *     (`BackupDatabase.suspendForStoragePurge`), the hold the native manifest
 *     reset runs inside. The account-deletion flow purges BEFORE it signs out,
 *     so the epoch alone would let a write that waited out the purge land in
 *     the emptied manifest.
 * `BackupDatabase` checks the ticket in the same synchronous step that starts
 * the statement (after the purge barrier and the handle await), so no
 * purge can fall between the check and the write.
 */

import { accountEpoch, isCurrentAccountEpoch, type AccountEpoch } from './account-epoch';

export interface BackupWriteTicket extends AccountEpoch {
  readonly purgeGeneration: number;
}

let purgeGeneration = 0;

/** Take a ticket when the work starts, before its first await. */
export function backupWriteTicket(): BackupWriteTicket {
  return { ...accountEpoch(), purgeGeneration };
}

/** A storage-purge hold was installed: every ticket taken so far is dead. */
export function advanceBackupPurgeGeneration(): void {
  purgeGeneration += 1;
}

/** True while a write under `ticket` may still run. */
export function admitsBackupWrite(ticket: BackupWriteTicket): boolean {
  return ticket.purgeGeneration === purgeGeneration && isCurrentAccountEpoch(ticket);
}
