// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let store = new Map();
let failRead = false;
let failWrite = false;
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k) => { if (failRead) throw new Error('locked'); return store.get(k) ?? null; },
  setItemAsync: async (k, v) => { if (failWrite) throw new Error('locked'); store.set(k, v); },
}));
const { WELCOME_SEEN_KEY, markWelcomeSeen, readWelcomeSeen } = await import('./welcome-seen');

beforeEach(() => { store = new Map(); failRead = false; failWrite = false; });

describe('welcome-seen', () => {
  test('a fresh install has not seen it; marking persists it', async () => {
    expect(await readWelcomeSeen()).toBe(false);
    await markWelcomeSeen();
    expect(store.get(WELCOME_SEEN_KEY)).toBe('1');
    expect(await readWelcomeSeen()).toBe(true);
  });
  test('an unreadable store never traps anyone behind the screen (reads as seen)', async () => {
    failRead = true;
    expect(await readWelcomeSeen()).toBe(true);
  });
  test('a failed write does not throw', async () => {
    failWrite = true;
    await markWelcomeSeen();
    expect(await readWelcomeSeen()).toBe(false);
  });
});
