import { Platform } from 'react-native';

/**
 * Task 2303 — Android has no native backup engine yet.
 *
 * The Android module (`modules/beebeeb-crypto/android/.../BeebeebCryptoModule.kt`)
 * does not register a single backup function: `enablePhotoBackup`,
 * `enableContactsBackup`, `enableCalendarBackup`, `resumeContactsBackup`,
 * `resumeCalendarBackup`, `triggerImmediateBackup`, `getBackupProgress`,
 * `disable*` and `teardownAllBackup` exist only in the iOS module. Porting the
 * engine is task 0728 (months of work), so until then the Android UI must not
 * offer a control that calls into a bridge function Android does not have.
 *
 * This module is the ONE decision point for that: every backup entry point in
 * `src/lib/backup-context.tsx` and both UI surfaces (the Photos auto-backup
 * pill and Settings → Backup) ask here instead of scattering
 * `Platform.OS === 'android'` checks. iOS and web behaviour is unchanged.
 *
 * Do not add a `Platform.OS` check for backup anywhere else.
 */

/** Exact, non-tappable copy shown wherever Android would otherwise offer backup. */
export const ANDROID_BACKUP_UNAVAILABLE_COPY =
  'Backup from this phone is not available on Android yet.';

/**
 * Every backup native function the backup UI path can reach. The guard test
 * (`backup-native-surface.guard.test.ts`) checks each one against the Android
 * module's registrations — a function that is not registered there may only be
 * reachable behind `isPhoneBackupSupported()`.
 */
export const BACKUP_UI_NATIVE_FUNCTIONS = [
  'configureBackupFolder',
  'disablePhotoBackup',
  'disableContactsBackup',
  'disableCalendarBackup',
  'teardownAllBackup',
  'enablePhotoBackup',
  'enableContactsBackup',
  'enableCalendarBackup',
  'resumeContactsBackup',
  'resumeCalendarBackup',
  'getBackupProgress',
  'triggerImmediateBackup',
  'getPhotoBackupIncludeVideos',
  'setPhotoBackupIncludeVideos',
] as const;

/**
 * Whether this platform has a native phone backup engine. Only Android lacks
 * one; 'web' is included because its callers already short-circuit on web and
 * this gate must not change that behaviour.
 */
export function isPhoneBackupSupported(
  platform: string = Platform.OS,
): boolean {
  return platform !== 'android';
}

/** The status line to show instead of backup controls, or null when backup works. */
export function phoneBackupUnavailableMessage(
  platform: string = Platform.OS,
): string | null {
  return isPhoneBackupSupported(platform) ? null : ANDROID_BACKUP_UNAVAILABLE_COPY;
}
