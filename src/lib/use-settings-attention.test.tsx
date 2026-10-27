// @ts-nocheck — bun test types are outside the Expo tsconfig.
//
// Task 2245 (P1): storage attention must not be frozen at mount. The tab
// badge lives in App.tsx (outside Settings) and the rows live in Settings, so
// the ONE hook refreshes on app foreground and exposes refresh() for the
// screen's focus effect.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let appStateListeners = [];
let currentUsage = { used_bytes: 10, plan_limit_bytes: 100 };
let readCount = 0;
let failedCount = 0;

mock.module('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (event, listener) => {
      if (event === 'change') appStateListeners.push(listener);
      return { remove: () => { appStateListeners = appStateListeners.filter((l) => l !== listener); } };
    },
  },
}));
mock.module('./api', () => ({
  getStorageUsage: async () => { readCount += 1; return currentUsage; },
}));
mock.module('./backup-context', () => ({
  useBackup: () => ({ backupProgress: { failed: failedCount } }),
}));

const { useSettingsAttention } = await import('./use-settings-attention');

function Harness({ onValue }) {
  const attention = useSettingsAttention();
  onValue(attention);
  return null;
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('useSettingsAttention (task 2245)', () => {
  beforeEach(() => {
    appStateListeners = [];
    currentUsage = { used_bytes: 10, plan_limit_bytes: 100 };
    readCount = 0;
    failedCount = 0;
  });

  test('reads storage once on mount and shares the badge decision with rows', async () => {
    let seen;
    let mounted;
    await act(async () => { mounted = TestRenderer.create(<Harness onValue={(v) => { seen = v; }} />); });
    await flush();
    expect(readCount).toBe(1);
    expect(seen.storagePercent).toBe(10);
    expect(seen.backupFailedCount).toBe(0);
    expect(seen.badge).toBeUndefined();
    await act(async () => mounted.unmount());
  });

  test('a foreground refresh picks up new usage without a remount', async () => {
    let seen;
    let mounted;
    await act(async () => { mounted = TestRenderer.create(<Harness onValue={(v) => { seen = v; }} />); });
    await flush();
    expect(seen.badge).toBeUndefined();

    currentUsage = { used_bytes: 90, plan_limit_bytes: 100 };
    await act(async () => { for (const listener of appStateListeners) listener('active'); });
    await flush();
    expect(seen.storagePercent).toBe(90);
    expect(seen.badge).toBe('!');
    expect(seen.reasons).toEqual([{ id: 'account', message: 'Storage 90% full' }]);

    currentUsage = { used_bytes: 10, plan_limit_bytes: 100 };
    await act(async () => { for (const listener of appStateListeners) listener('active'); });
    await flush();
    expect(seen.badge).toBeUndefined();
    expect(seen.reasons).toEqual([]);
    await act(async () => mounted.unmount());
  });

  test('refresh() is the focus hook: Settings calls it when the screen gains focus', async () => {
    let seen;
    let mounted;
    await act(async () => { mounted = TestRenderer.create(<Harness onValue={(v) => { seen = v; }} />); });
    await flush();
    const before = readCount;

    currentUsage = { used_bytes: 85, plan_limit_bytes: 100 };
    await act(async () => { seen.refresh(); });
    await flush();
    expect(readCount).toBe(before + 1);
    expect(seen.badge).toBe('!');
    await act(async () => mounted.unmount());
  });

  test('the backup reason follows the native count down to zero', async () => {
    failedCount = 2;
    let seen;
    let mounted;
    await act(async () => { mounted = TestRenderer.create(<Harness onValue={(v) => { seen = v; }} />); });
    await flush();
    expect(seen.reasons).toEqual([{ id: 'backups', message: '2 items need attention' }]);
    expect(seen.badge).toBe('!');

    failedCount = 0;
    await act(async () => {
      mounted.update(<Harness onValue={(v) => { seen = v; }} />);
    });
    expect(seen.reasons).toEqual([]);
    expect(seen.badge).toBeUndefined();
    await act(async () => mounted.unmount());
  });
});
