// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { decideStartupAuthUi, shouldKeepStartupRestoring } from './startup-auth';

describe('startup auth UI decision', () => {
  test('keeps restoring while stored credentials may still exist', () => {
    expect(decideStartupAuthUi('unknown')).toBe('keep-restoring');
    expect(decideStartupAuthUi('token-present')).toBe('keep-restoring');
    expect(decideStartupAuthUi('token-read-timeout')).toBe('keep-restoring');
    expect(shouldKeepStartupRestoring('unknown')).toBe(true);
    expect(shouldKeepStartupRestoring('token-present')).toBe(true);
    expect(shouldKeepStartupRestoring('token-read-timeout')).toBe(true);
  });

  test('only definitive no-session states show signed-out UI', () => {
    expect(decideStartupAuthUi('no-token')).toBe('show-signed-out');
    expect(decideStartupAuthUi('invalid-token')).toBe('show-signed-out');
    expect(shouldKeepStartupRestoring('no-token')).toBe(false);
    expect(shouldKeepStartupRestoring('invalid-token')).toBe(false);
  });

  test('restored session shows authenticated UI', () => {
    expect(decideStartupAuthUi('restored')).toBe('show-authenticated');
    expect(shouldKeepStartupRestoring('restored')).toBe(false);
  });
});
