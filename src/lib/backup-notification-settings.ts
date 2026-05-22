import * as SecureStore from 'expo-secure-store';
import {
  DEFAULT_BACKUP_NOTIFICATION_SETTINGS,
  type BackupNotificationSettings,
} from './backup-notification-policy';
import { configureBackupNotificationSettings } from '../../modules/beebeeb-crypto';

type BackupNotificationKind = 'completion' | 'no_change' | 'action_needed';

const SETTINGS_KEY = 'beebeeb_backup_notification_settings';
const LAST_SENT_PREFIX = 'beebeeb_backup_notification_last_sent_';

function normalizeSettings(raw: unknown): BackupNotificationSettings {
  const parsed = raw && typeof raw === 'object' ? raw as Partial<BackupNotificationSettings> : {};
  return {
    backupSummaries: typeof parsed.backupSummaries === 'boolean'
      ? parsed.backupSummaries
      : DEFAULT_BACKUP_NOTIFICATION_SETTINGS.backupSummaries,
    noChangeCheckins: typeof parsed.noChangeCheckins === 'boolean'
      ? parsed.noChangeCheckins
      : DEFAULT_BACKUP_NOTIFICATION_SETTINGS.noChangeCheckins,
    actionNeeded: typeof parsed.actionNeeded === 'boolean'
      ? parsed.actionNeeded
      : DEFAULT_BACKUP_NOTIFICATION_SETTINGS.actionNeeded,
  };
}

export async function getBackupNotificationSettings(): Promise<BackupNotificationSettings> {
  const raw = await SecureStore.getItemAsync(SETTINGS_KEY).catch(() => null);
  if (!raw) return DEFAULT_BACKUP_NOTIFICATION_SETTINGS;

  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_BACKUP_NOTIFICATION_SETTINGS;
  }
}

export async function setBackupNotificationSettings(
  next: BackupNotificationSettings,
): Promise<BackupNotificationSettings> {
  const normalized = normalizeSettings(next);
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(normalized)).catch(() => {});
  await mirrorBackupNotificationSettings(normalized);
  return normalized;
}

export async function setBackupNotificationSetting(
  key: keyof BackupNotificationSettings,
  value: boolean,
): Promise<BackupNotificationSettings> {
  const current = await getBackupNotificationSettings();
  return setBackupNotificationSettings({ ...current, [key]: value });
}

export async function mirrorBackupNotificationSettings(
  settings: BackupNotificationSettings,
): Promise<void> {
  await configureBackupNotificationSettings(settings).catch(() => {});
}

export async function getBackupNotificationLastSentAt(
  kind: BackupNotificationKind,
): Promise<number | null> {
  const raw = await SecureStore.getItemAsync(`${LAST_SENT_PREFIX}${kind}`).catch(() => null);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function recordBackupNotificationSent(
  kind: BackupNotificationKind,
  at: number = Date.now(),
): Promise<void> {
  await SecureStore.setItemAsync(`${LAST_SENT_PREFIX}${kind}`, String(at)).catch(() => {});
}
