// @ts-nocheck — isolated Bun process with explicit native mocks.
import React, { useEffect } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, mock, test } from 'bun:test';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const platform = { OS: 'android' };
let handler: (() => boolean) | null = null;
let removed = 0;
const actions: string[] = [];
mock.module('react-native', () => ({
  Platform: platform,
  BackHandler: { addEventListener: (event: string, callback: () => boolean) => {
    expect(event).toBe('hardwareBackPress');
    handler = callback;
    return { remove: () => { handler = null; removed += 1; } };
  } },
}));
// A mounted harness represents focus; unmount represents blur. The actual
// navigation library invokes this same effect/cleanup on focus transitions.
mock.module('@react-navigation/native', () => ({ useFocusEffect: (effect: () => unknown) => useEffect(effect, [effect]) }));
const { useAndroidFilesBack } = await import('./use-android-files-back');

function Harness({ selecting = false, searching = false, folderDepth = 1 }) {
  useAndroidFilesBack({
    selecting, searching, folderDepth,
    exitSelection: () => { actions.push('selection'); },
    closeSearch: () => { actions.push('search'); },
    goToParent: () => { actions.push('parent'); },
  });
  return null;
}

async function press(props = {}) {
  let tree;
  await act(async () => { tree = create(<Harness {...props} />); });
  const handled = handler?.();
  await act(async () => { tree.unmount(); });
  return handled;
}

beforeEach(() => {
  platform.OS = 'android';
  handler = null;
  removed = 0;
  actions.length = 0;
});

describe('focused Android file browser Back', () => {
  test('exits selection before search or folder navigation', async () => {
    expect(await press({ selecting: true, searching: true, folderDepth: 3 })).toBe(true);
    expect(actions).toEqual(['selection']);
  });

  test('closes search before leaving its folder', async () => {
    expect(await press({ searching: true, folderDepth: 3 })).toBe(true);
    expect(actions).toEqual(['search']);
  });

  test('returns to the parent of a nested folder', async () => {
    expect(await press({ folderDepth: 3 })).toBe(true);
    expect(actions).toEqual(['parent']);
  });

  test('lets navigation handle Back at the drive root', async () => {
    expect(await press()).toBe(false);
    expect(actions).toEqual([]);
  });

  test('removes its listener when the file browser loses focus', async () => {
    await press({ folderDepth: 2 });
    expect(removed).toBe(1);
    expect(handler).toBeNull();
  });

  test('does not intercept iOS navigation', async () => {
    platform.OS = 'ios';
    expect(await press({ folderDepth: 3 })).toBeUndefined();
    expect(actions).toEqual([]);
    expect(removed).toBe(0);
  });

  test('updates the handler after folder state changes', async () => {
    let tree;
    await act(async () => { tree = create(<Harness folderDepth={2} />); });
    expect(handler?.()).toBe(true);
    await act(async () => { tree.update(<Harness folderDepth={1} />); });
    expect(handler?.()).toBe(false);
    expect(actions).toEqual(['parent']);
    await act(async () => { tree.unmount(); });
  });
});
