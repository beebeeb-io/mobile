// @ts-nocheck — bun test types are outside the Expo tsconfig.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript6'; // TS 7 (native port) has no in-memory compiler API

const source = readFileSync(new URL('../../screens/SettingsScreen.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('SettingsScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const categories = [];
const rows = [];
function visit(node, home = null) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'SettingsCategory') {
    home = node.openingElement.attributes.properties.find((a) => a.name?.text === 'id')?.initializer?.text;
    categories.push(home);
  }
  if (ts.isJsxSelfClosingElement(node) && ['SettingsRow', 'ToggleRow', 'SectionHeader'].includes(node.tagName.getText(ast))) {
    const label = node.attributes.properties.find((a) => ['label', 'title'].includes(a.name?.text))?.initializer?.text;
    if (label) rows.push({ label, home });
  }
  ts.forEachChild(node, (child) => visit(child, home));
}
visit(ast);

describe('settings information architecture', () => {
  test('each settings section lives inside exactly one of eight categories', () => {
    expect(categories).toHaveLength(8);
    expect([...new Set(categories)].sort()).toEqual(['account', 'appearance', 'backups', 'help', 'notifications', 'privacy', 'security', 'storage']);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((row) => row.home === null)).toEqual([]);
  });
  test('backup policy, photo display and security controls have distinct homes', () => {
    for (const label of ['Back up camera roll', 'Include videos', 'Folders shown in Photos', 'Photo loading & quality', 'Trash']) {
      expect(rows.filter((row) => row.label === label)).toEqual([{ label, home: 'backups' }]);
    }
    for (const label of ['Biometric lock', 'Two-factor authentication', 'Add a device']) {
      expect(rows.filter((row) => row.label === label)).toEqual([{ label, home: 'security' }]);
    }
    expect(rows.filter((row) => row.label === 'Sign out')).toEqual([{ label: 'Sign out', home: 'account' }]);
  });
  test('no generic Advanced entry or OS-specific names misdescribe shared actions', () => {
    expect(rows.filter((row) => ['Advanced', 'Face ID lock', 'Siri & Shortcuts', 'Rate on App Store'].includes(row.label))).toEqual([]);
    expect(rows.filter((row) => row.label === 'System settings')).toEqual([{ label: 'System settings', home: 'help' }]);
  });
  test('account and local backup alerts keep both existing preference writers', () => {
    expect(source.includes("handleNotifPrefToggle('backup_complete', v)")).toBe(true);
    expect(source.includes("handleBackupNotifPrefToggle('backupSummaries', v)")).toBe(true);
    expect(source.includes('title="Account notifications"')).toBe(true);
    expect(source.includes('title="On this device"')).toBe(true);
  });
});
