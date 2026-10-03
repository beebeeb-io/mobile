// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1688 — photo-library permission re-prompt loop. Pattern:
// src/lib/calendar-permissions.test.ts. Mutation evidence is in task 1688
// Notes: with `accessPrivileges === 'limited'` removed from
// photoPermissionGranted (the pre-fix blind spot) the limited cases fail.
import { describe, expect, test } from 'bun:test';
import {
  ensurePhotoPermission,
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