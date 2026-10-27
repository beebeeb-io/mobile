// @ts-nocheck — bun test types are outside the Expo tsconfig.
//
// Task 2245 (P1): the "!" on the Settings tab must lead somewhere. These are
// the RED-first tests for the root rows that carry the reason, rendered from
// the SAME `computeSettingsAttention` object the badge reads.
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const primitive = (name) => (props) => React.createElement(name, props, props.children);
mock.module('react-native', () => ({
  Text: primitive('Text'), View: primitive('View'), TouchableOpacity: primitive('Button'),
  Platform: { OS: 'ios' }, StyleSheet: { create: (s) => s },
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: () => null }));

const { SettingsCategoryList } = await import('./SettingsCategories');
const { computeSettingsAttention } = await import('../../lib/settings-attention');

const c = { ink: '#111', ink2: '#222', ink3: '#555', ink4: '#777', line: '#ddd', amberDeep: '#b8860b' };

function texts(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
  if (node.children) texts(node.children, out);
  return out;
}

async function render(attention) {
  let mounted;
  await act(async () => {
    mounted = TestRenderer.create(
      <SettingsCategoryList colors={c} backgroundColor="#fff" onSelect={() => {}} attention={attention} />,
    );
  });
  return mounted;
}

describe('Settings root rows carry the reason (task 2245)', () => {
  test('failed backup items show on the Backups & files row with a "!" marker', async () => {
    const mounted = await render(computeSettingsAttention({ backupFailedCount: 3 }));
    const all = texts(mounted.toJSON());
    expect(all).toContain('3 items need attention');
    expect(all).not.toContain('Phone backups, photos and file access');
    expect(mounted.root.findAll((n) => typeof n.type === 'string' && n.props?.testID === 'settings-category-backups-attention')).toHaveLength(1);
    expect(mounted.root.findAll((n) => typeof n.type === 'string' && n.props?.testID === 'settings-category-account-attention')).toHaveLength(0);
    await act(async () => mounted.unmount());
  });

  test('high storage shows on the Account row with the same marker', async () => {
    const mounted = await render(computeSettingsAttention({ usedBytes: 82, limitBytes: 100 }));
    const all = texts(mounted.toJSON());
    expect(all).toContain('Storage 82% full');
    expect(all).not.toContain('Your account and storage use');
    expect(mounted.root.findAll((n) => typeof n.type === 'string' && n.props?.testID === 'settings-category-account-attention')).toHaveLength(1);
    expect(mounted.root.findAll((n) => typeof n.type === 'string' && n.props?.testID === 'settings-category-backups-attention')).toHaveLength(0);
    await act(async () => mounted.unmount());
  });

  test('both reasons mark both rows', async () => {
    const mounted = await render(computeSettingsAttention({ backupFailedCount: 1, usedBytes: 95, limitBytes: 100 }));
    const all = texts(mounted.toJSON());
    expect(all).toContain('1 item needs attention');
    expect(all).toContain('Storage 95% full');
    expect(mounted.root.findAll((n) => typeof n.type === 'string' && /^settings-category-(backups|account)-attention$/.test(n.props?.testID ?? ''))).toHaveLength(2);
    await act(async () => mounted.unmount());
  });

  test('nothing to report leaves every row unchanged and unmarked', async () => {
    const mounted = await render(computeSettingsAttention({ backupFailedCount: 0, usedBytes: 10, limitBytes: 100 }));
    const all = texts(mounted.toJSON());
    expect(all).toContain('Phone backups, photos and file access');
    expect(all).toContain('Your account and storage use');
    expect(all).not.toContain('!');
    expect(mounted.root.findAll((n) => typeof n.type === 'string' && (n.props?.testID ?? '').endsWith('-attention'))).toHaveLength(0);
    await act(async () => mounted.unmount());
  });

  test('without an attention prop the hub renders exactly as before', async () => {
    const mounted = await render(undefined);
    const all = texts(mounted.toJSON());
    expect(all).toContain('Phone backups, photos and file access');
    expect(all).not.toContain('!');
    await act(async () => mounted.unmount());
  });
});
