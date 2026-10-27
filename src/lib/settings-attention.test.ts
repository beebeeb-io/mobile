// @ts-nocheck — bun test types are outside the Expo tsconfig.
//
// Task 2245 (P1): the Settings tab showed "!" while Settings itself said
// nothing. These are the RED-first tests for the one shared attention value:
// the same object drives the tab badge AND the Settings root rows.
import { describe, expect, test } from 'bun:test';
import {
  computeSettingsAttention,
  backupAttentionMessage,
  storageAttentionMessage,
  STORAGE_ATTENTION_RATIO,
} from './settings-attention';

const GB = 1_000_000_000;

describe('settings attention (task 2245)', () => {
  test('failed backup items raise the badge and name the count', () => {
    const attention = computeSettingsAttention({ backupFailedCount: 3, usedBytes: 1 * GB, limitBytes: 100 * GB });
    expect(attention.badge).toBe('!');
    expect(attention.backupFailedCount).toBe(3);
    expect(attention.reasons).toEqual([{ id: 'backups', message: '3 items need attention' }]);
  });

  test('one failed item is singular', () => {
    expect(backupAttentionMessage(1)).toBe('1 item needs attention');
    expect(computeSettingsAttention({ backupFailedCount: 1 }).reasons).toEqual([
      { id: 'backups', message: '1 item needs attention' },
    ]);
  });

  test('storage at or above 80% raises the badge and names the percent', () => {
    const attention = computeSettingsAttention({ backupFailedCount: 0, usedBytes: 82 * GB, limitBytes: 100 * GB });
    expect(attention.badge).toBe('!');
    expect(attention.storagePercent).toBe(82);
    expect(attention.reasons).toEqual([{ id: 'account', message: 'Storage 82% full' }]);
  });

  test('exactly 80% is attention, below it is not', () => {
    expect(computeSettingsAttention({ usedBytes: 80, limitBytes: 100 }).reasons).toEqual([
      { id: 'account', message: 'Storage 80% full' },
    ]);
    const calm = computeSettingsAttention({ usedBytes: 79, limitBytes: 100 });
    expect(calm.reasons).toEqual([]);
    expect(calm.badge).toBeUndefined();
    expect(calm.storagePercent).toBe(79);
    expect(STORAGE_ATTENTION_RATIO).toBe(0.8);
  });

  test('both reasons together keep both rows, one badge', () => {
    const attention = computeSettingsAttention({ backupFailedCount: 2, usedBytes: 90, limitBytes: 100 });
    expect(attention.badge).toBe('!');
    expect(attention.reasons).toEqual([
      { id: 'backups', message: '2 items need attention' },
      { id: 'account', message: 'Storage 90% full' },
    ]);
  });

  test('nothing to report means no badge and no reasons', () => {
    const attention = computeSettingsAttention({ backupFailedCount: 0, usedBytes: 10, limitBytes: 100 });
    expect(attention).toEqual({
      backupFailedCount: 0,
      storagePercent: 10,
      reasons: [],
      badge: undefined,
    });
  });

  test('an unknown plan limit never invents a storage warning', () => {
    const attention = computeSettingsAttention({ backupFailedCount: 0, usedBytes: 5 * GB, limitBytes: 0 });
    expect(attention.storagePercent).toBeNull();
    expect(attention.reasons).toEqual([]);
    expect(attention.badge).toBeUndefined();
  });

  test('a missing usage read does not clear a known backup reason', () => {
    const attention = computeSettingsAttention({ backupFailedCount: 4 });
    expect(attention.reasons).toEqual([{ id: 'backups', message: '4 items need attention' }]);
    expect(attention.storagePercent).toBeNull();
  });

  test('percent copy is bounded at 100 and never negative', () => {
    expect(storageAttentionMessage(100)).toBe('Storage 100% full');
    expect(computeSettingsAttention({ usedBytes: 250, limitBytes: 100 }).storagePercent).toBe(100);
    expect(computeSettingsAttention({ backupFailedCount: -5, usedBytes: -1, limitBytes: 100 })).toEqual({
      backupFailedCount: 0,
      storagePercent: 0,
      reasons: [],
      badge: undefined,
    });
  });
});
