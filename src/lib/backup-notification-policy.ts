export interface BackupNotificationSettings {
  backupSummaries: boolean;
  noChangeCheckins: boolean;
  actionNeeded: boolean;
}

export const DEFAULT_BACKUP_NOTIFICATION_SETTINGS: BackupNotificationSettings = {
  backupSummaries: true,
  noChangeCheckins: true,
  actionNeeded: true,
};

export const BACKUP_COMPLETION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const BACKUP_NO_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldNotifyBackupCompletion({
  sessionUploadedCount,
  settings,
  lastSentAt,
  now,
}: {
  sessionUploadedCount: number;
  settings: BackupNotificationSettings;
  lastSentAt: number | null;
  now: number;
}): boolean {
  return (
    settings.backupSummaries &&
    sessionUploadedCount > 0 &&
    (lastSentAt == null || now - lastSentAt >= BACKUP_COMPLETION_COOLDOWN_MS)
  );
}

export function backupCompletionBody(sessionUploadedCount: number): string {
  const label = sessionUploadedCount === 1 ? '1 new photo' : `${sessionUploadedCount} new photos`;
  return `Beebeeb backed up ${label} in the last 24 hours`;
}

export function shouldNotifyBackupNoChanges({
  settings,
  lastSentAt,
  now,
}: {
  settings: BackupNotificationSettings;
  lastSentAt: number | null;
  now: number;
}): boolean {
  return (
    settings.noChangeCheckins &&
    (lastSentAt == null || now - lastSentAt >= BACKUP_NO_CHANGE_COOLDOWN_MS)
  );
}

export function backupNoChangeBody(): string {
  return 'Beebeeb checked your camera roll. Nothing new to back up.';
}
