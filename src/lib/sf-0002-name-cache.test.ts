// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
/**
 * SF-0002 M2a: a persistent name-cache entry now carries the convention the
 * name was decrypted with. An entry from before the upgrade has none, and it
 * must be a MISS (re-decrypt once) rather than silently trusting a name whose
 * write verdict is unknown.
 */
import { beforeEach, expect, mock, test } from 'bun:test';

const DOC = 'file:///tmp/docs/';
const CACHE_FILE = `${DOC}beebeeb-name-cache-v1.json`;
const files = new Map<string, string>();

mock.module('expo-file-system/legacy', () => ({
  documentDirectory: DOC,
  getInfoAsync: async (uri: string) => ({ exists: files.has(uri) }),
  readAsStringAsync: async (uri: string) => {
    const value = files.get(uri);
    if (value === undefined) throw new Error('no such file');
    return value;
  },
  writeAsStringAsync: async (uri: string, value: string) => { files.set(uri, value); },
  deleteAsync: async (uri: string) => { files.delete(uri); },
}));
mock.module('./plaintext-storage', () => ({ notePlaintextPathCreated: () => {} }));

const { loadNameCache } = await import('./name-cache');

beforeEach(() => { files.clear(); });

test('an_entry_with_its_convention_loads', async () => {
  files.set(CACHE_FILE, JSON.stringify({
    f: { name: 'canonical.pdf', mime: 'application/pdf', version: 2, convention: 'string_or_binary' },
    g: { name: 'repaired.pdf', mime: 'application/pdf', version: 1, convention: 'upper_repair' },
  }));
  const cache = await loadNameCache();
  expect(cache.f.convention).toBe('string_or_binary');
  expect(cache.g.convention).toBe('upper_repair');
});

test('an_entry_without_its_convention_is_a_miss', async () => {
  files.set(CACHE_FILE, JSON.stringify({
    old: { name: 'from-the-upgrade.pdf', mime: 'application/pdf', version: 3 },
    bad: { name: 'nonsense.pdf', mime: null, version: 1, convention: 'writable' },
    ok: { name: 'kept.pdf', mime: null, version: 1, convention: 'string' },
  }));
  const cache = await loadNameCache();
  expect(cache.old).toBeUndefined();
  expect(cache.bad).toBeUndefined();
  expect(cache.ok.convention).toBe('string');
});
