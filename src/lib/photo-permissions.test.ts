// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1688 — photo-library permission re-prompt loop. Pattern:
// src/lib/calendar-permissions.test.ts. Mutation evidence is in task 1688
// Notes: with `accessPrivileges === 'limited'` removed from
// photoPermissionGranted (the pre-fix blind spot) the limited cases fail.
import { describe, expect, test } from 'bun:test';
import {
  ensurePhotoPermission,
  photoAccessNotice,
  getPhotoPermission,
  photoPermissionGranted,
} from './photo-permissions';

const LIMITED = { status: 'granted', granted: true, accessPrivileges: 'limited', canAskAgain: true };
const FULL = { status: 'granted', granted: true, accessPrivileges: 'all', canAskAgain: true };
const UNDETERMINED = { status: 'undetermined', granted: false, canAskAgain: true };
const DENIED = { status: 'denied', granted: false, accessPrivileges: 'none', canAskAgain: false };

describe('photoPermissionGranted (task 1688)', () => {
  test('a LIMITED library counts as granted — the sheet must not re-present', () => {
    expect(photoPermissionGranted(LIMITED)).toBe(true);
  });

  test('full grant is granted', () => {
    expect(photoPermissionGranted(FULL)).toBe(true);
    expect(photoPermissionGranted({ status: 'granted' })).toBe(true);
  });

  test('denied, undetermined, and missing responses are not granted', () => {
    expect(photoPermissionGranted(DENIED)).toBe(false);
    expect(photoPermissionGranted(UNDETERMINED)).toBe(false);
    expect(photoPermissionGranted({})).toBe(false);
    expect(photoPermissionGranted(null)).toBe(false);
    expect(photoPermissionGranted(undefined)).toBe(false);
  });
});

describe('ensurePhotoPermission (task 1688)', () => {
  test('already-granted (full): resolves without requesting — no prompt on mount/focus', async () => {
    let requestCalled = false;
    const outcome = await ensurePhotoPermission({
      getPermissionsAsync: async () => FULL,
      requestPermissionsAsync: async () => {
        requestCalled = true;
        return FULL;
      },
    });
    expect(outcome).toEqual({ granted: true, requested: false });
    expect(requestCalled).toBe(false);
  });

  test('already-granted (LIMITED): resolves without requesting — the 1688 relaunch-loop case', async () => {
    let requestCalled = false;
    const outcome = await ensurePhotoPermission({
      getPermissionsAsync: async () => LIMITED,
      requestPermissionsAsync: async () => {
        requestCalled = true;
        return LIMITED;
      },
    });
    expect(outcome).toEqual({ granted: true, requested: false });
    expect(requestCalled).toBe(false);
  });

  test('undetermined: requests once and reports what the user chose', async () => {
    let getCalled = 0;
    const outcome = await ensurePhotoPermission({
      getPermissionsAsync: async () => {
        getCalled += 1;
        return UNDETERMINED;
      },
      requestPermissionsAsync: async () => FULL,
    });
    expect(getCalled).toBe(1);
    expect(outcome).toEqual({ granted: true, requested: true });
  });

  test('denied request resolves false, does not throw', async () => {
    const outcome = await ensurePhotoPermission({
      getPermissionsAsync: async () => UNDETERMINED,
      requestPermissionsAsync: async () => DENIED,
    });
    expect(outcome).toEqual({ granted: false, requested: true });
  });

  test('passes writeOnly through to the request (Save-to-Photos video verification)', async () => {
    let sawWriteOnly;
    await ensurePhotoPermission(
      {
        getPermissionsAsync: async () => UNDETERMINED,
        requestPermissionsAsync: async (writeOnly) => {
          sawWriteOnly = writeOnly;
          return FULL;
        },
      },
      { writeOnly: true },
    );
    expect(sawWriteOnly).toBe(true);
  });

  test('a module with neither function resolves false without throwing', async () => {
    expect(await ensurePhotoPermission({})).toEqual({ granted: false, requested: false });
  });

  test('getPhotoPermission never prompts', async () => {
    let requestCalled = false;
    const response = await getPhotoPermission({
      getPermissionsAsync: async () => LIMITED,
      requestPermissionsAsync: async () => {
        requestCalled = true;
        return LIMITED;
      },
    });
    expect(response).toEqual(LIMITED);
    expect(requestCalled).toBe(false);
  });
});
// Backup was on, the camera-roll line said "Waiting for
// first scan" (or "0 photos on device") and nothing ever said why: the
// photos were simply not shared with Beebeeb (iOS "Selected photos"
// access with none or few selected, or access turned off).
describe('photoAccessNotice (limited / revoked photo access)', () => {
  test('full access needs no notice', () => {
    expect(photoAccessNotice(FULL, 120)).toBeNull();
    expect(photoAccessNotice({ status: 'granted' }, 0)).toBeNull();
  });

  test('limited access with nothing selected says nothing is shared and offers the picker', () => {
    expect(photoAccessNotice(LIMITED, 0)).toEqual({
      summary: 'Paused · no photos shared with Beebeeb',
      message: 'iOS shares no photos with Beebeeb, so there is nothing to back up.',
      actionLabel: 'Choose photos',
      action: 'picker',
    });
  });

  test('limited access with a selection says only those are backed up', () => {
    expect(photoAccessNotice(LIMITED, 1)).toEqual({
      summary: null,
      message: 'Only 1 selected photo is shared with Beebeeb.',
      actionLabel: 'Change',
      action: 'picker',
    });
    expect(photoAccessNotice(LIMITED, 2400)?.message).toBe('Only 2,400 selected photos are shared with Beebeeb.');
  });

  test('access turned off says so and points to iOS Settings', () => {
    expect(photoAccessNotice(DENIED, 0)).toEqual({
      summary: 'Paused · no access to Photos',
      message: 'Beebeeb is not allowed to read your photos.',
      actionLabel: 'Open Settings',
      action: 'settings',
    });
  });

  test('an unknown or missing permission shows nothing (no false alarm)', () => {
    expect(photoAccessNotice(null, 0)).toBeNull();
    expect(photoAccessNotice(UNDETERMINED, 0)).toBeNull();
  });
});
