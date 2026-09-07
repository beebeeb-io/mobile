// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { calendarPermissionGranted, ensureCalendarPermission } from './calendar-permissions';

describe('calendarPermissionGranted', () => {
  test('true when granted flag or status says granted', () => {
    expect(calendarPermissionGranted({ granted: true, status: 'granted' })).toBe(true);
    expect(calendarPermissionGranted({ status: 'granted' })).toBe(true);
    expect(calendarPermissionGranted({ granted: true })).toBe(true);
  });

  test('false when denied, undetermined, missing, or null/undefined', () => {
    expect(calendarPermissionGranted({ status: 'denied', granted: false })).toBe(false);
    expect(calendarPermissionGranted({ status: 'undetermined' })).toBe(false);
    expect(calendarPermissionGranted({})).toBe(false);
    expect(calendarPermissionGranted(null)).toBe(false);
    expect(calendarPermissionGranted(undefined)).toBe(false);
  });
});

describe('ensureCalendarPermission', () => {
  test('resolves true immediately when already granted, without requesting', async () => {
    let requestCalled = false;
    const granted = await ensureCalendarPermission({
      getCalendarPermissions: async () => ({ status: 'granted', granted: true }),
      requestCalendarPermissions: async () => {
        requestCalled = true;
        return { status: 'granted', granted: true };
      },
    });
    expect(granted).toBe(true);
    expect(requestCalled).toBe(false);
  });

  test('requests permission when not yet granted, and resolves true if the user grants it', async () => {
    const granted = await ensureCalendarPermission({
      getCalendarPermissions: async () => ({ status: 'undetermined', granted: false }),
      requestCalendarPermissions: async () => ({ status: 'granted', granted: true }),
    });
    expect(granted).toBe(true);
  });

  test('resolves false when the user denies the request', async () => {
    const granted = await ensureCalendarPermission({
      getCalendarPermissions: async () => ({ status: 'undetermined', granted: false }),
      requestCalendarPermissions: async () => ({ status: 'denied', granted: false }),
    });
    expect(granted).toBe(false);
  });

  test('resolves false (does not throw) when the module has neither function', async () => {
    const granted = await ensureCalendarPermission({});
    expect(granted).toBe(false);
  });

  // Regression test for task 1390: expo-calendar 57 promoted the
  // object-oriented API to the package root and turned the OLD flat-function
  // names (`getCalendarPermissionsAsync`/`requestCalendarPermissionsAsync`)
  // into deprecated shims that unconditionally throw when called. A module
  // shaped like that — new names present and reachable, but simulating what
  // happens if a call into the native/JS bridge itself fails — must have its
  // throw propagate out of `ensureCalendarPermission` rather than being
  // swallowed into a silent `false`, so the caller (SettingsScreen) can tell
  // "broken" apart from "denied" and show a real error instead of a no-op.
  test('propagates a throw from the underlying module instead of swallowing it', async () => {
    const throwingModule = {
      getCalendarPermissions: async () => {
        throw new Error(
          'Method getCalendarPermissionsAsync imported from "expo-calendar" is deprecated.\n' +
          'Import the legacy API from "expo-calendar/legacy" or migrate to the new object-oriented API from "expo-calendar".',
        );
      },
      requestCalendarPermissions: async () => ({ status: 'granted', granted: true }),
    };
    await expect(ensureCalendarPermission(throwingModule)).rejects.toThrow(
      /deprecated/,
    );
  });

  test('propagates a throw from requestCalendarPermissions when the current check resolves un-granted', async () => {
    const throwingModule = {
      getCalendarPermissions: async () => ({ status: 'undetermined', granted: false }),
      requestCalendarPermissions: async () => {
        throw new Error('native module unavailable');
      },
    };
    await expect(ensureCalendarPermission(throwingModule)).rejects.toThrow(
      'native module unavailable',
    );
  });
});
