// @ts-nocheck
// Task 2096 — SSE resync / reconnect catch-up. Derived from the 1686 harness.
// Task 1686 — iOS idle heat: the SSE reconnect busy-loop. RED-first tests for
// the three properties the fix must have:
//
//   1. Honest backoff — reconnectDelayMs caps at RECONNECT_MAX_DELAY_MS and
//      only ever jitters DOWNWARD from the exponential curve (every sample in
//      [curve×0.8, curve]), so backoff is bounded and de-synchronized.
//   2. Background pause — a reconnect failure while the app is
//      backgrounded/locked schedules NO timer; returning to foreground
//      replays exactly one reconnect (never one per skipped tick).
//   3. Flapping guard — a stream that dies between token fetch and open
//      keeps the backoff ladder climbing instead of resetting to the 1.5 s
//      floor every cycle.
//
// Same isolation rules as sync-client.test.ts: this file mocks every native
// module it needs itself (task 0877).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const secureStore = new Map<string, string>();

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
  deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));

// Controllable fake AppState — sync-client imports AppState from
// 'react-native' for the foreground-resume wiring in start().
let currentState = 'active';
type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();

mock.module('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() {
      return currentState;
    },
    addEventListener: (_type: string, listener: AppStateListener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
}));

// Fake EventSource that records its listeners so tests can fire 'open' /
// 'error' explicitly. Constructed fresh per openStream() call; all instances
// are kept so tests can reach the most recent one.
type ESListener = (event?: { data?: string }) => void;
// REAL react-native-sse over a fake XMLHttpRequest (task 2096b): proves what
// the library actually dispatches when the server ends the stream cleanly.
class FakeXHR {
  static DONE = 4;
  static LOADING = 3;
  static all: FakeXHR[] = [];
  readyState = 0;
  status = 0;
  responseText = '';
  timeout = 0;
  onreadystatechange: (() => void) | null = null;
  constructor() { FakeXHR.all.push(this); }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {}
  respond(state: number, status: number, text = '') {
    this.readyState = state; this.status = status; this.responseText = text;
    this.onreadystatechange?.();
  }
}
(globalThis as any).XMLHttpRequest = FakeXHR;
// bun's CJS interop hands the package main back as { default: Module }; load
// the library's own class file directly so the code under test is the real one.
const RealEventSource = (await import('react-native-sse/src/EventSource.js')).default;
mock.module('react-native-sse', () => ({ default: RealEventSource }));

let getStreamTokenCalls = 0;
let getSyncOpsCalls = 0;
mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'session-token',
  getStreamToken: async () => {
    getStreamTokenCalls += 1;
    return { stream_token: 'tok', expires_at: '2099-01-01T00:00:00Z' };
  },
  submitSyncOps: async () => ({ applied: [], rejected: [] }),
  getSnapshot: async () => ({ seq_id: 0, nodes: [] }),
  getSyncOps: async () => { getSyncOpsCalls += 1; return []; },
}));

mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: async () => null,
  saveCachedFileIndex: async () => {},
  clearCachedFileIndex: async () => {},
  fileIndexCacheWriteScope: () => ({ epoch: { generation: 0, accountId: null }, generation: 0 }),
}));

mock.module('./file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async () => {},
}));

mock.module('./device-identity', () => ({
  getDeviceId: async () => 'device-1',
}));

const { SyncClient, setSyncClientAppState } = await import('./sync-client');


let capturedTimers: Array<{ fn: () => void; ms: number }> = [];
const realSetTimeout = globalThis.setTimeout;
function withCapturedTimers<T>(fn: () => T): T {
  capturedTimers = [];
  globalThis.setTimeout = ((inner: () => void, ms?: number) => {
    capturedTimers.push({ fn: inner, ms: ms ?? 0 });
    return capturedTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    return fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}
async function drain(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
async function runTimers() {
  const timers = capturedTimers;
  capturedTimers = [];
  for (const t of timers) t.fn();
  await drain();
}

async function started() {
  const client = new SyncClient();
  await client.start();
  await drain();
  getSyncOpsCalls = 0; // ignore start()'s own catch-up
  return client;
}


let timerId = 0;
let sseTimers: Array<{ fn: () => void; ms: number; id: number }> = [];
const realClear = globalThis.clearTimeout;
async function drain(times = 20) { for (let i = 0; i < times; i++) await Promise.resolve(); }

describe('real react-native-sse: clean server end (task 2096b)', () => {
  beforeEach(() => {
    secureStore.clear(); getSyncOpsCalls = 0; getStreamTokenCalls = 0;
    appStateListeners.clear(); FakeXHR.all = []; sseTimers = [];
    setSyncClientAppState('active');
  });

  test('HTTP 200 stream completes: library dispatches no event, silently re-opens, and we catch up on the re-open', async () => {
    const realST = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = ++timerId;
      sseTimers.push({ fn, ms: ms ?? 0, id });
      return id as any;
    }) as any;
    globalThis.clearTimeout = ((id: number) => {
      sseTimers = sseTimers.filter((t) => t.id !== id);
    }) as any;
    try {
      const client = new SyncClient();
      await client.start();
      await drain(500);
      // library constructor schedules open() after timeoutBeforeConnection
      sseTimers.splice(0).forEach((t) => t.fn());
      const xhr1 = FakeXHR.all[0];
      xhr1.respond(3, 200, ':ok\n\n');            // headers + first chunk -> 'open'
      getSyncOpsCalls = 0;
      xhr1.respond(4, 200, ':ok\n\n');            // server ended the stream cleanly
      await drain();
      expect(getSyncOpsCalls).toBe(0);     // library dispatched nothing yet
      // library re-polls after pollingInterval ...
      const poll = sseTimers.splice(0);
      expect(poll.some((t) => t.ms === 5000)).toBe(true);
      poll.forEach((t) => t.fn());
      const xhr2 = FakeXHR.all[1];
      xhr2.respond(3, 200, ':ok\n\n');            // ... and dispatches 'open' AGAIN on the same instance
      sseTimers.splice(0).forEach((t) => t.fn()); // debounce timer
      await drain();
      expect(getSyncOpsCalls).toBe(1);     // catch-up ran for the silent reconnect
    } finally {
      globalThis.setTimeout = realST;
      globalThis.clearTimeout = realClear;
    }
  });

  test('HTTP 500 -> library dispatches error -> exactly one reconnect catch-up, no schedule loop from our own close()', async () => {
    const realST = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = ++timerId;
      sseTimers.push({ fn, ms: ms ?? 0, id });
      return id as any;
    }) as any;
    globalThis.clearTimeout = ((id: number) => {
      sseTimers = sseTimers.filter((t) => t.id !== id);
    }) as any;
    try {
      const client = new SyncClient();
      await client.start();
      await drain(500);
      sseTimers.splice(0).forEach((t) => t.fn());
      getSyncOpsCalls = 0;
      FakeXHR.all[0].respond(4, 500, 'boom');
      await drain();
      // backoff timer (client) + the library's own post-error re-poll (5000 ms,
      // armed AFTER our close(), so it survives it): a zombie.
      const pending = sseTimers.splice(0);
      const zombie = pending.filter((t) => t.ms === 5000);
      const backoff = pending.filter((t) => t.ms !== 5000);
      expect(backoff.length).toBe(1);      // exactly one reconnect timer
      zombie.forEach((t) => t.fn());       // zombie re-open on the closed stream
      FakeXHR.all[FakeXHR.all.length - 1].respond(3, 200, ':ok\n\n');
      await drain();
      expect(client.getStatus?.() ?? (client as any).status).not.toBe('connected');
      backoff.forEach((t) => t.fn());
      await drain(500);
      expect(getSyncOpsCalls).toBe(1);
    } finally {
      globalThis.setTimeout = realST;
      globalThis.clearTimeout = realClear;
    }
  });
});
