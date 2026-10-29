// @ts-nocheck — bun test types are outside the Expo tsconfig.
//
// Task 2245 (P1), lead review round: there must be ONE usage snapshot for the
// tab badge and the Settings rows. These tests mount TWO consumers under the
// shared provider and prove a refresh from either one updates both, that a
// slow old response cannot overwrite a newer one, and that a failed read
// never leaves a badge with no row reason.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let appStateListeners = [];
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

type Pending = { resolve: (usage: any) => void; reject: (error: any) => void };
let pending: Pending[] = [];

mock.module('./api', () => ({
  getStorageUsage: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
}));
mock.module('./backup-context', () => ({
  useBackup: () => ({ backupProgress: { failed: failedCount } }),
}));

const { SettingsAttentionProvider, useSettingsAttention } = await import('./settings-attention-context');

const usage = (used: number, limit = 100) => ({ used_bytes: used, plan_limit_bytes: limit, plan_name: 'free' });
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

function Probe({ onValue }) {
  const attention = useSettingsAttention();
  onValue(attention);
  return null;
}

function Tree({ a, b }) {
  return (
    <SettingsAttentionProvider>
      <Probe onValue={a} />
      <Probe onValue={b} />
    </SettingsAttentionProvider>
  );
}

async function mountPair() {
  const seen = { a: null, b: null };
  let mounted;
  await act(async () => {
    mounted = TestRenderer.create(<Tree a={(v) => { seen.a = v; }} b={(v) => { seen.b = v; }} />);
  });
  await flush();
  return { seen, mounted };
}

async function resolveNext(value) {
  const next = pending.shift();
  await act(async () => {
    next.resolve(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function rejectNext() {
  const next = pending.shift();
  await act(async () => {
    next.reject(new Error('offline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('shared settings attention provider (task 2245)', () => {
  beforeEach(() => {
    appStateListeners = [];
    pending = [];
    failedCount = 0;
  });

  test('both consumers read the same snapshot, and a refresh from one updates both', async () => {
    const { seen, mounted } = await mountPair();
    expect(pending).toHaveLength(1);
    await resolveNext(usage(10));
    expect(seen.a.storagePercent).toBe(10);
    expect(seen.b.storagePercent).toBe(10);
    expect(seen.a.badge).toBeUndefined();
    expect(seen.b.badge).toBeUndefined();

    await act(async () => { seen.a.refresh(); });
    await resolveNext(usage(90));
    for (const value of [seen.a, seen.b]) {
      expect(value.storagePercent).toBe(90);
      expect(value.badge).toBe('!');
      expect(value.reasons).toEqual([{ id: 'account', message: 'Storage 90% full' }]);
    }
    await act(async () => mounted.unmount());
  });

  test('a slow old response cannot overwrite a newer one', async () => {
    const { seen, mounted } = await mountPair();
    await resolveNext(usage(10));

    await act(async () => { seen.a.refresh(); }); // request 2 (slow)
    await act(async () => { seen.b.refresh(); }); // request 3 (newer)
    expect(pending).toHaveLength(2);

    pending[1].resolve(usage(90));
    await flush();
    expect(seen.a.storagePercent).toBe(90);
    expect(seen.b.storagePercent).toBe(90);

    pending[0].resolve(usage(10));
    await flush();
    expect(seen.a.storagePercent).toBe(90);
    expect(seen.b.storagePercent).toBe(90);
    expect(seen.a.badge).toBe('!');
    expect(seen.b.badge).toBe('!');
    await act(async () => mounted.unmount());
  });

  test('a failed fetch never shows a badge without a row reason', async () => {
    const { seen, mounted } = await mountPair();
    await rejectNext();
    for (const value of [seen.a, seen.b]) {
      expect(value.usage).toBeNull();
      expect(value.badge).toBeUndefined();
      expect(value.reasons).toEqual([]);
    }

    await act(async () => { seen.a.refresh(); });
    await resolveNext(usage(90));
    for (const value of [seen.a, seen.b]) {
      expect(value.badge).toBe('!');
      expect(value.reasons).toEqual([{ id: 'account', message: 'Storage 90% full' }]);
    }

    await act(async () => { seen.b.refresh(); });
    await rejectNext();
    for (const value of [seen.a, seen.b]) {
      expect(value.storagePercent).toBe(90);
      expect(value.badge).toBe('!');
      expect(value.reasons).toEqual([{ id: 'account', message: 'Storage 90% full' }]);
    }
    await act(async () => mounted.unmount());
  });

  test('the backup reason is shared too and clears at zero', async () => {
    failedCount = 2;
    const { seen, mounted } = await mountPair();
    await resolveNext(usage(10));
    for (const value of [seen.a, seen.b]) {
      expect(value.reasons).toEqual([{ id: 'backups', message: '2 items need attention' }]);
      expect(value.badge).toBe('!');
    }

    failedCount = 0;
    await act(async () => { mounted.update(<Tree a={(v) => { seen.a = v; }} b={(v) => { seen.b = v; }} />); });
    for (const value of [seen.a, seen.b]) {
      expect(value.reasons).toEqual([]);
      expect(value.badge).toBeUndefined();
    }
    await act(async () => mounted.unmount());
  });

  test('foregrounding refreshes the one provider for both consumers', async () => {
    const { seen, mounted } = await mountPair();
    await resolveNext(usage(10));

    await act(async () => { for (const listener of appStateListeners) listener('active'); });
    expect(pending).toHaveLength(1);
    await resolveNext(usage(85));
    expect(seen.a.storagePercent).toBe(85);
    expect(seen.b.storagePercent).toBe(85);
    await act(async () => mounted.unmount());
  });
});
