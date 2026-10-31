// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
//
// Task 2303 — the Photos auto-backup pill on Android is a plain status line,
// never a control that offers backup (the old pill's "Enable in Settings" led
// to Settings toggles that call native backup functions the Android module
// does not register). iOS keeps its real banner.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platform = { OS: 'android' };

const host = (name: string) => (props: any) =>
  React.createElement(name, { ...props, testID: props.testID }, props.children);

mock.module('react-native', () => ({
  View: host('View'),
  Text: host('Text'),
  TouchableOpacity: host('TouchableOpacity'),
  ActivityIndicator: host('ActivityIndicator'),
  StyleSheet: { create: (s: any) => s, absoluteFill: {}, hairlineWidth: 1 },
  Platform: platform,
}));

mock.module('expo-haptics', () => ({
  selectionAsync: async () => {},
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: 'light' },
}));

mock.module('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: () => {} }),
}));

mock.module('../../components/glass', () => ({
  GlassSurface: host('GlassSurface'),
  glassMaterial: () => ({ label: '#111', labelMuted: '#777' }),
}));

mock.module('../../lib/backup-context', () => ({
  useBackup: () => ({
    isPhotoBackupEnabled: backupEnabled,
    backupProgress: { total: 0, completed: 0, inProgress: 0, pending: 0, failed: 0, state: 'idle' },
    lastBackupAt: null,
    includeVideos: false,
  }),
}));

mock.module('../../lib/useNetworkStatus', () => ({ useNetworkStatus: () => true }));
mock.module('../../lib/date-format', () => ({ formatDate: (v: string) => v }));
mock.module('../../lib/theme-context', () => ({
  useTheme: () => ({
    colors: { ink4: '#999', amberDeep: '#b60', green: '#090', amber: '#fc0' },
    resolved: 'light',
  }),
}));

let backupEnabled = false;

const { AutoBackupBanner } = await import('./AutoBackupBanner');

function render() {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(React.createElement(AutoBackupBanner)); });
  return renderer;
}

function texts(renderer: any): string[] {
  return renderer.root
    .findAllByType('Text')
    .map((node: any) => node.children.filter((c: any) => typeof c === 'string').join(''));
}

function hostNames(renderer: any): string[] {
  return renderer.root.findAll((node: any) => typeof node.type === 'string').map((n: any) => n.type);
}

beforeEach(() => {
  platform.OS = 'android';
  backupEnabled = false;
});

afterEach(() => {
  act(() => {});
});

describe('task 2303 — Photos auto-backup pill, Android', () => {
  test('shows the status line and offers no tappable control', () => {
    const renderer = render();
    expect(texts(renderer)).toContain('Backup from this phone is not available on Android yet.');
    expect(texts(renderer)).not.toContain('Auto-backup off');
    expect(texts(renderer)).not.toContain('Enable in Settings');
    expect(hostNames(renderer)).not.toContain('TouchableOpacity');
    const links = renderer.root.findAll((node: any) => node.props?.accessibilityRole === 'link');
    expect(links).toEqual([]);
  });

  test('stays the status line even when a stored preference says backup is on', () => {
    backupEnabled = true;
    const renderer = render();
    expect(texts(renderer)).toContain('Backup from this phone is not available on Android yet.');
    expect(hostNames(renderer)).not.toContain('TouchableOpacity');
  });
});

describe('task 2303 — Photos auto-backup pill, iOS unchanged', () => {
  test('off state still offers "Enable in Settings"', () => {
    platform.OS = 'ios';
    const renderer = render();
    expect(texts(renderer)).toContain('Auto-backup off');
    expect(texts(renderer)).toContain('Enable in Settings');
    expect(texts(renderer)).not.toContain('Backup from this phone is not available on Android yet.');
    expect(hostNames(renderer).filter((n: string) => n === 'TouchableOpacity').length).toBe(1);
    const links = renderer.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props?.accessibilityRole === 'link',
    );
    expect(links.length).toBe(1);
  });
});
