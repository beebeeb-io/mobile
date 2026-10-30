// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
//
// Task 2303 — guard: every BeebeebCrypto backup function the backup UI path
// can call is either registered in the Android module or gated off on
// Android. The Android Kotlin module is pinned by
// scripts/android-release-guard.sh, so the fix is JS-only: the gate lives in
// `src/lib/backup-platform-support.ts` and nothing else may reintroduce a
// backup call on Android.
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The helper reads `Platform.OS` at call time; mock it before importing.
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));

const {
  ANDROID_BACKUP_UNAVAILABLE_COPY,
  BACKUP_UI_NATIVE_FUNCTIONS,
  isPhoneBackupSupported,
  phoneBackupUnavailableMessage,
} = await import('./backup-platform-support');

const ROOT = join(import.meta.dir, '..', '..');
const ANDROID_MODULE = join(
  ROOT,
  'modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoModule.kt',
);
const kotlin = readFileSync(ANDROID_MODULE, 'utf-8');
const backupContext = readFileSync(join(import.meta.dir, 'backup-context.tsx'), 'utf-8');
const autoBackupBanner = readFileSync(
  join(import.meta.dir, '..', 'screens', 'photos', 'AutoBackupBanner.tsx'),
  'utf-8',
);
const settingsScreen = readFileSync(join(import.meta.dir, '..', 'screens', 'SettingsScreen.tsx'), 'utf-8');

const registrations = new Set<string>();
for (const match of kotlin.matchAll(/(?:Async)?Function\("([^"]+)"\)/g)) {
  registrations.add(match[1]);
}

describe('task 2303 — Android native surface inventory', () => {
  test('the Android module registers no native backup function at all (the premise)', () => {
    for (const fn of BACKUP_UI_NATIVE_FUNCTIONS) {
      expect(registrations.has(fn)).toBe(false);
    }
  });

  test('every backup function the UI calls is registered in Android or gated off on Android', () => {
    const unregistered = BACKUP_UI_NATIVE_FUNCTIONS.filter((fn) => !registrations.has(fn));
    // The list is not vacuous: this task exists because these functions are
    // missing on Android today.
    expect(unregistered.length).toBeGreaterThan(0);
    const gated = !isPhoneBackupSupported('android');
    for (const fn of unregistered) {
      expect(`${fn}:${gated ? 'gated' : 'ungated'}`).toBe(`${fn}:gated`);
    }
    // iOS must not be gated.
    expect(isPhoneBackupSupported('ios')).toBe(true);
  });

  test('the inventory matches what backup-context imports from the crypto module', () => {
    const importBlock = backupContext.match(
      /import \{([\s\S]*?)\} from '\.\.\/\.\.\/modules\/beebeeb-crypto';/,
    );
    expect(importBlock).not.toBeNull();
    const imported = importBlock![1]
      .split(',')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name && !name.startsWith('type '))
      .filter((name) => name.includes('Backup'));
    // `mirrorBackupClientSession` is JS-side self-guarded (its wrapper returns
    // false without the native function) and its only caller,
    // `mirrorBackupSessionForNative`, already returns early off iOS. Pin that
    // existing gate rather than pretending it goes through the new helper.
    const SELF_GUARDED = ['mirrorBackupClientSession'];
    expect(backupContext).toMatch(
      /async function mirrorBackupSessionForNative\(\): Promise<void> \{\s*if \(Platform\.OS !== 'ios'\) return;/,
    );
    const missingFromInventory = imported.filter(
      (name) =>
        !(BACKUP_UI_NATIVE_FUNCTIONS as readonly string[]).includes(name) &&
        !SELF_GUARDED.includes(name),
    );
    expect(missingFromInventory).toEqual([]);
  });

  test('every backup UI entry point asks the one helper before any native call', () => {
    for (const entryPoint of [
      'refreshNativeProgress',
      'enableNativeBackup',
      'togglePhotoBackup',
      'toggleContactsBackup',
      'toggleCalendarBackup',
      'triggerBackupNow',
      'stopBackupEngines',
    ]) {
      const start = Math.max(
        backupContext.indexOf(`function ${entryPoint}(`),
        backupContext.indexOf(`const ${entryPoint} = useCallback(`),
      );
      expect(start).toBeGreaterThan(-1);
      const body = backupContext.slice(start, start + 900);
      expect(`${entryPoint}:${body.includes('isPhoneBackupSupported()')}`).toBe(`${entryPoint}:true`);
    }
  });
});

describe('task 2303 — Android UI offers a status line, never a backup control', () => {
  test('the exact copy is defined once and is the honest wording', () => {
    expect(ANDROID_BACKUP_UNAVAILABLE_COPY).toBe(
      'Backup from this phone is not available on Android yet.',
    );
    expect(phoneBackupUnavailableMessage('android')).toBe(ANDROID_BACKUP_UNAVAILABLE_COPY);
    expect(phoneBackupUnavailableMessage('ios')).toBeNull();
  });

  test('the copy lives only in the helper (one source of truth)', () => {
    for (const source of [backupContext, autoBackupBanner, settingsScreen, kotlin]) {
      expect(source.includes(ANDROID_BACKUP_UNAVAILABLE_COPY)).toBe(false);
    }
  });

  test('the Photos pill gates before the "Auto-backup off" control and renders the status line', () => {
    expect(autoBackupBanner).toContain("import { BackupUnavailableStatus }");
    expect(autoBackupBanner).toContain('isPhoneBackupSupported');
    const banner = autoBackupBanner;
    const gate = banner.indexOf('!isPhoneBackupSupported()');
    const offControl = banner.indexOf('Auto-backup off');
    expect(gate).toBeGreaterThan(-1);
    expect(offControl).toBeGreaterThan(gate);
    // The Android branch has no tappable control between the gate and the
    // end of its returned tree.
    const androidBranch = banner.slice(gate, offControl);
    expect(androidBranch).toContain('<BackupUnavailableStatus');
    expect(androidBranch).not.toContain('TouchableOpacity');
    expect(androidBranch).not.toContain('onPress');
  });

  test('Settings renders the status line instead of the photo/contacts/calendar toggles on Android', () => {
    expect(settingsScreen).toContain("import { BackupUnavailableStatus }");
    expect(settingsScreen).toContain('isPhoneBackupSupported');
    const gate = settingsScreen.indexOf('!isPhoneBackupSupported()');
    expect(gate).toBeGreaterThan(-1);
    expect(settingsScreen.slice(gate, gate + 200)).toContain('<BackupUnavailableStatus');
    const toggles = settingsScreen.indexOf('label="Back up camera roll"');
    expect(toggles).toBeGreaterThan(gate);
    expect(toggles - gate).toBeLessThan(1200);
  });
});
