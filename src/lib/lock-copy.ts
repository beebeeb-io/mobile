// Task 1539 (finding 5, lead decision — PR #109 review) — honest "Lock
// file" copy.
//
// `file-locks.ts`'s SecureStore calls use no `keychainAccessGroup`, so the
// lock record is almost certainly not visible to the BeebeebFileProvider
// extension despite its entitlements declaring a shared keychain group — a
// file locked in the app can still be opened, unmodified, through the iOS
// Files app. Switching to the shared group would silently un-lock/orphan
// existing users' locked files, a real migration, and is explicitly NOT
// done here. Until it is, the UI must say what the lock actually covers
// instead of an unqualified "is now locked" that implies more than it
// delivers.

/** The toast shown right after a file is locked (FilesScreen's "Lock file" action). */
export function lockedToastMessage(name: string): string {
  return `"${name}" is locked in the Beebeeb app`;
}

/**
 * The honest disclosure shown wherever there is room next to a "Locked"
 * explainer (PreviewScreen's locked placeholders) — kept out of the toast
 * above, which is intentionally short.
 */
export const FILES_APP_LOCK_CAVEAT = 'Files opened through the iOS Files app are not locked.';
