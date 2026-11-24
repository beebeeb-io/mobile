// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  APP_LOCK_DELAY_OPTIONS,
  APP_LOCK_DELAY_KEY,
  APP_LOCK_PREF_KEY,
  DEFAULT_LOCK_DELAY_MS,
  classifyKeyLoad,
  isAppLockEnabled,
  parseLockDelayMs,
  softwareFallbackUnlockPlan,
  settingChangeNeedsAuth,
  shouldLockAtLaunch,
  shouldRelockOnReturn,
} from './app-lock-policy';

describe('softwareFallbackUnlockPlan', () => {
  test('a physical-device software key requires device-owner auth before it is read', () => {
    expect(softwareFallbackUnlockPlan({
      physicalFallbackPresent: true,
      deviceOwnerAuthenticated: false,
      viaPassword: false,
    })).toBe('authenticate');
  });

  test('the authenticated retry reads the fallback directly and avoids a second native prompt', () => {
    expect(softwareFallbackUnlockPlan({
      physicalFallbackPresent: true,
      deviceOwnerAuthenticated: true,
      viaPassword: false,
    })).toBe('prefer-fallback');
  });

  test('normal native keys and the Beebeeb-password fallback keep their existing path', () => {
    expect(softwareFallbackUnlockPlan({
      physicalFallbackPresent: false,
      deviceOwnerAuthenticated: false,
      viaPassword: false,
    })).toBe('normal');
    expect(softwareFallbackUnlockPlan({
      physicalFallbackPresent: true,
      deviceOwnerAuthenticated: false,
      viaPassword: true,
    })).toBe('prefer-fallback');
  });
});

describe('storage keys', () => {
  test('keep the existing SecureStore keys', () => {
    expect(APP_LOCK_PREF_KEY).toBe('beebeeb_biometric_lock');
    expect(APP_LOCK_DELAY_KEY).toBe('beebeeb_biometric_delay');
  });
});

test('setup and Settings share the five approved lock delays', () => {
  expect(APP_LOCK_DELAY_OPTIONS).toEqual([
    { label: 'Immediately', ms: 0 },
    { label: '1 minute', ms: 60_000 },
    { label: '5 minutes', ms: 300_000 },
    { label: '15 minutes', ms: 900_000 },
    { label: '1 hour', ms: 3_600_000 },
  ]);
});

describe('isAppLockEnabled', () => {
  test('unset is ON', () => {
    expect(isAppLockEnabled(null)).toBe(true);
    expect(isAppLockEnabled(undefined)).toBe(true);
  });
  test('only an explicit "false" is OFF', () => {
    expect(isAppLockEnabled('false')).toBe(false);
    expect(isAppLockEnabled('true')).toBe(true);
    expect(isAppLockEnabled('')).toBe(true);
  });
});

describe('parseLockDelayMs', () => {
  test('default is 15 minutes when unset', () => {
    expect(DEFAULT_LOCK_DELAY_MS).toBe(900_000);
    expect(parseLockDelayMs(null)).toBe(900_000);
    expect(parseLockDelayMs(undefined)).toBe(900_000);
    expect(parseLockDelayMs('garbage')).toBe(900_000);
  });
  test('a stored value is kept, including 0', () => {
    expect(parseLockDelayMs('0')).toBe(0);
    expect(parseLockDelayMs('60000')).toBe(60_000);
    expect(parseLockDelayMs('3600000')).toBe(3_600_000);
  });
});

describe('shouldLockAtLaunch', () => {
  test('a signed-in launch locks whatever the setting', () => {
    expect(shouldLockAtLaunch({ signedIn: true, recentlyUnlocked: false })).toBe(true);
  });
  test('signed out never locks', () => {
    expect(shouldLockAtLaunch({ signedIn: false, recentlyUnlocked: false })).toBe(false);
  });
  test('a fresh sign-in inside the grace window is not asked again', () => {
    expect(shouldLockAtLaunch({ signedIn: true, recentlyUnlocked: true })).toBe(false);
  });
});

describe('shouldRelockOnReturn', () => {
  const base = { enabled: true, backgroundedForMs: 20 * 60_000, delayMs: DEFAULT_LOCK_DELAY_MS, recentlyUnlocked: false };
  test('relocks only after MORE than the delay', () => {
    expect(shouldRelockOnReturn(base)).toBe(true);
    expect(shouldRelockOnReturn({ ...base, backgroundedForMs: 900_000 })).toBe(false);
    expect(shouldRelockOnReturn({ ...base, backgroundedForMs: 900_001 })).toBe(true);
    expect(shouldRelockOnReturn({ ...base, backgroundedForMs: 60_000 })).toBe(false);
  });
  test('delay 0 relocks on any real return', () => {
    expect(shouldRelockOnReturn({ ...base, delayMs: 0, backgroundedForMs: 1 })).toBe(true);
  });
  test('never when the setting is off', () => {
    expect(shouldRelockOnReturn({ ...base, enabled: false })).toBe(false);
  });
  test('never inside the grace window', () => {
    expect(shouldRelockOnReturn({ ...base, recentlyUnlocked: true })).toBe(false);
  });
  test('never without a real background period', () => {
    expect(shouldRelockOnReturn({ ...base, backgroundedForMs: null })).toBe(false);
  });
});

describe('settingChangeNeedsAuth', () => {
  test('turning off needs auth, turning on does not', () => {
    expect(settingChangeNeedsAuth({ kind: 'toggle', enable: false })).toBe(true);
    expect(settingChangeNeedsAuth({ kind: 'toggle', enable: true })).toBe(false);
  });
  test('a longer delay needs auth, a shorter or equal one does not', () => {
    expect(settingChangeNeedsAuth({ kind: 'delay', fromMs: 60_000, toMs: 300_000 })).toBe(true);
    expect(settingChangeNeedsAuth({ kind: 'delay', fromMs: 900_000, toMs: 60_000 })).toBe(false);
    expect(settingChangeNeedsAuth({ kind: 'delay', fromMs: 60_000, toMs: 60_000 })).toBe(false);
  });
});

describe('classifyKeyLoad', () => {
  const noKey = new Error('No master key in keychain — provide a master key to restore');
  test('success opens', () => {
    expect(classifyKeyLoad({ error: null, viaPassword: false })).toBe('open');
    expect(classifyKeyLoad({ error: null, viaPassword: true })).toBe('open');
  });
  test('a cancelled or failed prompt stays locked', () => {
    expect(classifyKeyLoad({ error: new Error('User canceled the authentication'), viaPassword: false })).toBe('stay-locked');
    expect(classifyKeyLoad({ error: 'weird', viaPassword: false })).toBe('stay-locked');
  });
  test('a missing key goes to recovery', () => {
    expect(classifyKeyLoad({ error: noKey, viaPassword: false })).toBe('recovery');
    expect(classifyKeyLoad({ error: noKey, viaPassword: true })).toBe('recovery');
  });
  test('the password fallback with a failed key load goes to recovery, never open', () => {
    expect(classifyKeyLoad({ error: new Error('auth failed'), viaPassword: true })).toBe('recovery');
  });
});
