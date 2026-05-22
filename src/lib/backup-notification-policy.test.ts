// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  BACKUP_COMPLETION_COOLDOWN_MS,
  BACKUP_NO_CHANGE_COOLDOWN_MS,
  DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
  shouldNotifyBackupCompletion,
  backupCompletionBody,
  shouldNotifyBackupNoChanges,
  backupNoChangeBody,
} from './backup-notification-policy';

describe('backup notification policy', () => {
  test('completion summaries require uploaded photos, enabled settings, and cooldown', () => {
    const now = 10_000_000;
    expect(shouldNotifyBackupCompletion({
      sessionUploadedCount: 0,
      settings: DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
      lastSentAt: null,
      now,
    })).toBe(false);
    expect(shouldNotifyBackupCompletion({
      sessionUploadedCount: 1,
      settings: DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
      lastSentAt: now - BACKUP_COMPLETION_COOLDOWN_MS - 1,
      now,
    })).toBe(true);
    expect(shouldNotifyBackupCompletion({
      sessionUploadedCount: 1,
      settings: DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
      lastSentAt: now - 60_000,
      now,
    })).toBe(false);
    expect(shouldNotifyBackupCompletion({
      sessionUploadedCount: 1,
      settings: { ...DEFAULT_BACKUP_NOTIFICATION_SETTINGS, backupSummaries: false },
      lastSentAt: null,
      now,
    })).toBe(false);
    expect(backupCompletionBody(1)).toBe('Beebeeb backed up 1 new photo in the last 24 hours');
    expect(backupCompletionBody(12)).toBe('Beebeeb backed up 12 new photos in the last 24 hours');
  });

  test('no-change check-ins are weekly and user-controlled', () => {
    const now = 20_000_000;
    expect(shouldNotifyBackupNoChanges({
      settings: DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
      lastSentAt: null,
      now,
    })).toBe(true);
    expect(shouldNotifyBackupNoChanges({
      settings: DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
      lastSentAt: now - BACKUP_NO_CHANGE_COOLDOWN_MS - 1,
      now,
    })).toBe(true);
    expect(shouldNotifyBackupNoChanges({
      settings: DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
      lastSentAt: now - 86_400_000,
      now,
    })).toBe(false);
    expect(shouldNotifyBackupNoChanges({
      settings: { ...DEFAULT_BACKUP_NOTIFICATION_SETTINGS, noChangeCheckins: false },
      lastSentAt: null,
      now,
    })).toBe(false);
    expect(backupNoChangeBody()).toBe('Beebeeb checked your camera roll. Nothing new to back up.');
  });
});
