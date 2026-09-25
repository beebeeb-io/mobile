// @ts-nocheck
// Task 1539 (finding 5, lead decision — PR #109 review) — honest "Lock
// file" copy. The SecureStore-backed lock has no keychainAccessGroup, so a
// file locked in the app is still fully readable through the iOS Files app
// via the BeebeebFileProvider extension — the keychain migration that would
// close that gap is NOT done here (a real migration, would silently
// un-lock/orphan existing users' locked files). Until then the UI must not
// claim (or imply, via an unqualified "is now locked") that the lock covers
// the file everywhere.
//
// RED on this branch pre-fix: `src/lib/lock-copy.ts` does not exist yet, so
// this whole file fails at module resolution:
//   error: Cannot find module './lock-copy' from ".../src/lib/lock-copy.test.ts"
import { describe, expect, test } from 'bun:test';
import { FILES_APP_LOCK_CAVEAT, lockedToastMessage } from './lock-copy';

describe('lockedToastMessage', () => {
  test('names the Beebeeb app as the scope of the lock, not an unqualified "is now locked"', () => {
    expect(lockedToastMessage('vacation.jpg')).toBe('"vacation.jpg" is locked in the Beebeeb app');
  });

  test('quotes whatever display name it is given, unmodified', () => {
    expect(lockedToastMessage('Q3 report (final).pdf')).toBe('"Q3 report (final).pdf" is locked in the Beebeeb app');
  });
});

describe('FILES_APP_LOCK_CAVEAT', () => {
  test('is the honest disclosure shown wherever there is room next to the "Locked" explainer', () => {
    expect(FILES_APP_LOCK_CAVEAT).toBe('Files opened through the iOS Files app are not locked.');
  });
});
