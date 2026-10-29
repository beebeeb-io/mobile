// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1722 round 4 (Guus 2026-10-15, Q1 "Files on by default", Q2 "Always reset on sign-out"):
 * the app applies the default through src/lib/files-mount-default.ts (behaviour:
 * files-mount-default.test.ts). This file holds the wiring: App.tsx's registrar, the Settings
 * switch, and the native `everMounted` field the upgrade check reads.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

describe('wiring', () => {
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
  const settings = readFileSync(join(ROOT, 'src/screens/SettingsScreen.tsx'), 'utf8');
  const nativeModule = readFileSync(join(ROOT, 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'), 'utf8');

  test('App.tsx: the registrar applies the default for the signed-in account', () => {
    const start = app.indexOf('function FileProviderDomainRegistrar(');
    const end = app.indexOf('\nfunction ', start + 10);
    const registrar = app.slice(start, end);
    expect(registrar).toContain('ensureFilesMountedByDefault(userId)');
    expect(registrar).not.toContain('registerTrustedFileProviderDomain(');
    expect(app).toMatch(/<FileProviderDomainRegistrar enabled=\{[^}]+\} userId=\{user\?\.user_id \?\? null\} \/>/);
  });

  test('Settings: the switch goes through setFilesMountedByUser and keeps its warning', () => {
    const start = settings.indexOf('const handleFileProviderMountToggle = useCallback(');
    const end = settings.indexOf('const handleNotificationsToggle', start);
    const handler = settings.slice(start, end);
    expect(handler).toContain('setFilesMountedByUser({');
    expect(handler).not.toContain('mountTrustedFileProvider(');
    expect(handler).not.toContain('removeTrustedFileProvider(');
    expect(settings).toContain('label="Show Beebeeb in Files"');
    expect(settings).toContain('subtitle="Anyone who can unlock this iPhone can access the mounted Files location."');
    expect(settings).toContain('testID="files-mount-toggle"');
  });

  test('native: the privacy state says whether Files was ever mounted on this install', () => {
    const start = nativeModule.indexOf('private func fileProviderPrivacyState(defaults: UserDefaults? = sharedDefaults())');
    const body = nativeModule.slice(start, nativeModule.indexOf('\n}\n', start));
    expect(body).toContain('let everMounted = defaults?.string(forKey: fileProviderDomainSchemaKey) != nil');
    expect(body).toContain('"everMounted": everMounted');
  });
});
