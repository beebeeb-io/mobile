// @ts-nocheck — isolated Bun render of the real sheet, native dependencies mocked.
import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = fn => { fn(); return 1; };
const platform = { OS: 'android' };
const window = { width: 320, height: 240, scale: 1, fontScale: 2 };
const primitive = name => props => React.createElement(name, props, props.children);
const Value = class { setValue() {} interpolate() { return 1; } };
mock.module('react-native', () => ({
  Animated: { Value, View: primitive('AnimatedView'), spring: () => ({ start: fn => fn?.() }) },
  Dimensions: { get: () => window }, useWindowDimensions: () => window,
  Modal: primitive('Modal'), Platform: platform, Pressable: primitive('Pressable'),
  ScrollView: primitive('ScrollView'), View: primitive('View'), Text: primitive('Text'),
  StyleSheet: { create: s => s, hairlineWidth: 1 },
}));
mock.module('react-native-gesture-handler', () => ({ GestureHandlerRootView: primitive('GestureRoot'), PanGestureHandler: primitive('Pan'), State: { END: 5 } }));
mock.module('@expo/vector-icons', () => ({ Ionicons: primitive('Icon') }));
mock.module('expo-haptics', () => ({ selectionAsync() {}, impactAsync() {}, ImpactFeedbackStyle: { Medium: 1 } }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 20 }) }));
mock.module('../lib/theme-context', () => ({ useTheme: () => ({ colors: {}, resolved: 'light' }) }));
mock.module('./glass', () => ({ modalScrim: () => 'black' }));
mock.module('./glass/tab-bar-inset', () => ({ bottomAnchorInset: (safe, ios) => platform.OS === 'android' ? Math.max(safe, 12) : ios }));
mock.module('../theme', () => ({ fonts: {}, radii: { xl: 24, lg: 12 }, shadows: { lg: {} } }));
const { BBActionSheet } = await import('./BBActionSheet');
let tree;
afterEach(() => { if (tree) act(() => tree.unmount()); tree = null; platform.OS = 'android'; window.height = 240; });
function render(props = {}) {
  act(() => { tree = create(<BBActionSheet visible onClose={() => {}} title="Actions" rows={Array.from({ length: 12 }, (_, i) => ({ key: String(i), label: `Action ${i}`, icon: 'add', onPress() {} }))} {...props} />); });
}
function sheetStyle() {
  return Object.assign({}, ...tree.root.findAllByType('AnimatedView').find(n => n.props.onLayout).props.style);
}
test('Android at a short window height bounds the sheet and puts every action in a scroll view', () => {
  render();
  expect(sheetStyle().maxHeight).toBe(216);
  const positioningRoot = tree.root.findAllByType('View').find(n => n.findAllByType('AnimatedView').length > 0);
  expect(positioningRoot.props.style.flex).toBe(1);
  expect(positioningRoot.props.pointerEvents).toBe('box-none');
  const scroll = tree.root.findByType('ScrollView');
  expect(scroll.findAllByType('Pressable')).toHaveLength(12);
  expect(scroll.props.style.flexShrink).toBe(1);
  // Drag handling is on the header, not around the scrolling actions.
  expect(scroll.findAllByType('Pan')).toHaveLength(0);
  expect(tree.root.findByType('Pan').findAllByType('Pressable')).toHaveLength(0);
  window.height = 180;
  act(() => tree.update(<BBActionSheet visible title="Actions" rows={[]} onClose={() => {}} />));
  expect(sheetStyle().maxHeight).toBe(156);
});
test('last Android action still closes and invokes its callback', () => {
  const events = [];
  render({ onClose: () => events.push('close'), rows: [{ key: 'last', label: 'Last action', icon: 'add', onPress: () => events.push('action') }] });
  const scroll = tree.root.findByType('ScrollView');
  act(() => scroll.findByType('Pressable').props.onPress());
  expect(events).toEqual(['close', 'action']);
});
test('iOS retains its unconstrained rows and whole-sheet drag layout', () => {
  platform.OS = 'ios';
  render();
  expect(sheetStyle().maxHeight).toBeUndefined();
  expect(tree.root.findAllByType('ScrollView')).toHaveLength(0);
  expect(tree.root.findByType('Pan').findAllByType('Pressable')).toHaveLength(12);
  expect(sheetStyle().paddingBottom).toBe(20);
});
