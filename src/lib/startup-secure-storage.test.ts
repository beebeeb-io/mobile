// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  classifyStartupError,
  decideStartupAuthUi,
  secureStorageUnavailableCopy,
  SecureStorageReadError,
  startupAuthStateForError,
  StartupTokenReadRecoveryError,
} from './startup-auth';

// A keychain read that fails at cold launch (before first unlock, a
// protected-data timing race, an unsigned build) is NOT a network failure.
// Before this fix it fell through to the "Couldn't reach our servers"
// diagnostics panel while the API was healthy.

function apiError(status: number) {
  const e = new Error('boom');
  e.name = 'ApiError';
  e.status = status;
  return e;
}

// Shape of the rejection expo-secure-store raises for a Keychain OSStatus
// (KeyChainException -> CodedError code ERR_KEY_CHAIN).
function rawKeychainError() {
  const e = new Error("Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User interaction is not allowed.");
  e.code = 'ERR_KEY_CHAIN';
  return e;
}

describe('startup error classification: secure storage vs network', () => {
  test('a wrapped SecureStore read failure is secure-storage, never network', () => {
    const err = new SecureStorageReadError(new Error('User interaction is not allowed.'));
    expect(classifyStartupError(err)).toBe('secure-storage');
    expect(classifyStartupError(err)).not.toBe('network');
  });

  test('a raw expo-secure-store keychain exception is secure-storage', () => {
    expect(classifyStartupError(rawKeychainError())).toBe('secure-storage');
  });

  test('network and API classifications are unchanged', () => {
    expect(classifyStartupError(apiError(0))).toBe('network');
    expect(classifyStartupError(apiError(401))).toBe('invalid-token');
    expect(classifyStartupError(apiError(503))).toBe('api-503');
    expect(classifyStartupError(new StartupTokenReadRecoveryError())).toBe('token-read-timeout');
    expect(classifyStartupError(new Error('timeout'))).toBe('timeout');
    expect(classifyStartupError(new Error('something else'))).toBe('exception');
  });
});

describe('startup fallback for a secure storage failure', () => {
  test('maps to the secure-storage state, not the restoring/diagnostics state', () => {
    const state = startupAuthStateForError(new SecureStorageReadError(new Error('errSecInteractionNotAllowed')), 'unknown');
    expect(state).toBe('secure-storage-unavailable');
    expect(decideStartupAuthUi(state)).toBe('show-secure-storage-error');
    expect(decideStartupAuthUi(state)).not.toBe('keep-restoring');
  });

  test('a raw keychain exception also routes to the secure-storage state', () => {
    expect(startupAuthStateForError(rawKeychainError(), 'unknown')).toBe('secure-storage-unavailable');
  });

  test('other failures keep their previous state (token-read timeout still keeps restoring)', () => {
    expect(startupAuthStateForError(new StartupTokenReadRecoveryError(), 'unknown')).toBe('token-read-timeout');
    expect(decideStartupAuthUi(startupAuthStateForError(new StartupTokenReadRecoveryError(), 'unknown'))).toBe('keep-restoring');
    expect(startupAuthStateForError(apiError(0), 'token-present')).toBe('token-present');
  });

  test('the fallback copy names secure storage and asks to unlock, not the network', () => {
    for (const os of ['ios', 'android']) {
      const copy = secureStorageUnavailableCopy(os);
      expect(copy.title).toBe("Couldn't read this device's secure storage");
      expect(`${copy.title} ${copy.body}`).not.toMatch(/servers|network|internet/i);
    }
    expect(secureStorageUnavailableCopy('ios').body).toContain('Unlock your iPhone and try again');
    expect(secureStorageUnavailableCopy('android').body).toContain('Unlock your phone and try again');
  });
});
