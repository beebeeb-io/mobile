// @ts-nocheck — bun test types are outside the Expo tsconfig.
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
const { SETTINGS_CATEGORIES, SettingsCategory, SettingsCategoryList } = await import('./SettingsCategories');

describe('settings category navigation', () => {
  test('the hub offers eight accessible category actions and dispatches their IDs', async () => {
    const selected = [];
    let mounted;
    await act(async () => { mounted = TestRenderer.create(<SettingsCategoryList colors={{ ink: '#111', ink3: '#555', ink4: '#777', line: '#ddd' }} backgroundColor="#fff" onSelect={(id) => selected.push(id)} />); });
    const buttons = mounted.root.findAll((node) => node.type === 'Button');
    expect(buttons).toHaveLength(8);
    for (const [index, button] of buttons.entries()) {
      expect(button.props.accessibilityRole).toBe('button');
      expect(button.props.accessibilityHint.length).toBeGreaterThan(10);
      expect(button.props.testID).toBe(`settings-category-${SETTINGS_CATEGORIES[index].id}`);
      await act(async () => button.props.onPress());
    }
    expect(selected).toEqual(SETTINGS_CATEGORIES.map((category) => category.id));
    await act(async () => mounted.unmount());
  });
  test('unselected categories do not mount their data readers or editors', async () => {
    let mounts = 0;
    function Editor() { mounts += 1; return <span>Account editor</span>; }
    let mounted;
    await act(async () => { mounted = TestRenderer.create(<SettingsCategory id="account" active={null}><Editor /></SettingsCategory>); });
    expect(mounts).toBe(0);
    await act(async () => mounted.update(<SettingsCategory id="account" active="security"><Editor /></SettingsCategory>));
    expect(mounts).toBe(0);
    await act(async () => mounted.update(<SettingsCategory id="account" active="account"><Editor /></SettingsCategory>));
    expect(mounts).toBe(1);
    await act(async () => mounted.update(<SettingsCategory id="account" active={null}><Editor /></SettingsCategory>));
    expect(mounted.toJSON()).toBeNull();
    await act(async () => mounted.unmount());
  });
});
