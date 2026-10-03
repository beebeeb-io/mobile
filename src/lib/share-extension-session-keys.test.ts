// @ts-nocheck — bun runs this; `bun:test` types + `import.meta.dir` are not
// in the Expo tsconfig (same convention as FilesScreen.region.test.ts).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task 1671 — after task 0447 moved the session token + API base URL from
// App Group UserDefaults to the shared Keychain (`BeebeebKeychainCore`,
// written by `BeebeebCryptoModule.mirrorSessionToAppGroup`), the Share
// Extension's `ShareViewController.loadSharedConfig()` kept reading the OLD
// UserDefaults keys (`beebeeb_session_token` / `beebeeb_api_url`), which the
// app had stopped writing. Once a stale pre-0447 UserDefaults copy was
// purged by a sign-out (task 1531/1593), the extension always saw a nil
// session token and showed "Sign in to Beebeeb first" even right after a
// successful Face ID unlock.
//
// This grep-guard proves the extension reader and the app's writer can never
// drift onto different key literals again: both must reference the SAME
// `BeebeebKeychainCore.sessionTokenKey` / `.apiBaseUrlKey` symbols (declared
// once, in the canonical shared file every keychain-reading target
// compiles), and the extension source must not reintroduce the dead
// App-Group-UserDefaults keys as a plaintext fallback (0447 removed that
// storage path for security — see BeebeebKeychainCore.swift's "Generic
// string storage" doc comment).
const ROOT = join(import.meta.dir, '..', '..');

const KEYCHAIN_CORE = join(ROOT, 'modules/beebeeb-crypto/ios/Shared/BeebeebKeychainCore.swift');
const CRYPTO_MODULE = join(ROOT, 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift');
const SHARE_VIEW_CONTROLLER = join(ROOT, 'targets/share-extension/ShareViewController.swift');

// The exact dead keys the extension used to read directly from App Group
// UserDefaults, bypassing the shared Keychain entirely.
const DEAD_SESSION_TOKEN_KEY = 'beebeeb_session_token';
const DEAD_API_URL_KEY = 'beebeeb_api_url';

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('share extension session/API keys match the shared-keychain writer', () => {
  it('BeebeebKeychainCore declares the canonical session token + API base URL keys', () => {
    const src = readSource(KEYCHAIN_CORE);
    expect(src).toMatch(/static let sessionTokenKey = "io\.beebeeb\.sessionToken"/);
    expect(src).toMatch(/static let apiBaseUrlKey = "io\.beebeeb\.apiBaseUrl"/);
  });

  it("BeebeebCryptoModule's mirrorSessionToAppGroup writer uses the canonical BeebeebKeychainCore keys, not re-typed literals", () => {
    const src = readSource(CRYPTO_MODULE);
    expect(src).toMatch(/sharedSessionTokenKey\s*=\s*BeebeebKeychainCore\.sessionTokenKey/);
    expect(src).toMatch(/sharedAPIBaseURLKey\s*=\s*BeebeebKeychainCore\.apiBaseUrlKey/);
  });

  it('ShareViewController reads the session token + API URL via the canonical BeebeebKeychainCore keys', () => {
    const src = readSource(SHARE_VIEW_CONTROLLER);
    expect(src).toMatch(/BeebeebKeychainCore\.loadString\(key:\s*BeebeebKeychainCore\.sessionTokenKey\)/);
    expect(src).toMatch(/BeebeebKeychainCore\.loadString\(key:\s*BeebeebKeychainCore\.apiBaseUrlKey\)/);
  });

  it('ShareViewController never reads the dead pre-0447 App-Group-UserDefaults session/API keys', () => {
    const src = readSource(SHARE_VIEW_CONTROLLER);
    expect(src).not.toContain(DEAD_SESSION_TOKEN_KEY);
    expect(src).not.toContain(DEAD_API_URL_KEY);
  });


  it('mirrorSessionToAppGroup reports shared File Provider credential write failures instead of swallowing them', () => {
    const src = readSource(CRYPTO_MODULE);
    const start = src.indexOf('AsyncFunction("mirrorSessionToAppGroup")');
    expect(start).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('AsyncFunction("mirrorBackupClientSession")', start);
    expect(next).toBeGreaterThan(start);
    const body = src.slice(start, next);

    expect(body).not.toContain('try? BeebeebKeychainCore.storeString(token, key: sharedSessionTokenKey)');
    expect(body).not.toContain('try? BeebeebKeychainCore.storeString(baseUrl, key: sharedAPIBaseURLKey)');
    expect(body).toMatch(/try BeebeebKeychainCore\.storeString\(token, key: sharedSessionTokenKey\)/);
    expect(body).toMatch(/try BeebeebKeychainCore\.storeString\(baseUrl, key: sharedAPIBaseURLKey\)/);
    expect(body).toMatch(/fileprovider\.auth_mirror\.failed/);
    expect((body.match(/return false/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
