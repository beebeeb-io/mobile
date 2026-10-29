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
let lastFakeES: { listeners: Map<string, ESListener> } | null = null;
mock.module('react-native-sse', () => ({
  default: class FakeEventSource {
    listeners = new Map<string, ESListener>();
    constructor() {
      lastFakeES = this;
    }
    addEventListener(type: string, listener: ESListener) {
      this.listeners.set(type, listener);
    }
    close() {}
    fire(type: string, event?: { data?: string }) {
      this.listeners.get(type)?.(event);
    }
  },
}));

let getStreamTokenCalls = 0;
let getSyncOpsCalls = 0;
let getSyncOpsImpl = async () => [];
mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'session-token',
  getStreamToken: async () => {
    getStreamTokenCalls += 1;
    return { stream_token: 'tok', expires_at: '2099-01-01T00:00:00Z' };
  },
  submitSyncOps: async () => ({ applied: [], rejected: [] }),
  getSnapshot: async () => ({ seq_id: 0, nodes: [] }),
  getSyncOps: async () => { getSyncOpsCalls += 1; return getSyncOpsImpl(); },
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

describe('SyncClient catch-up on reconnect / resync (task 2096)', () => {
  beforeEach(() => {
    secureStore.clear();
    getStreamTokenCalls = 0;
    getSyncOpsCalls = 0;
    getSyncOpsImpl = async () => [];
    appStateListeners.clear();
    lastFakeES = null;
    currentState = 'active';
    setSyncClientAppState('active');
  });

  test('stream error -> reconnect runs exactly one catch-up', async () => {
    await started();
    withCapturedTimers(() => lastFakeES!.fire('error'));
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('server ends the stream cleanly (close event) -> reconnect with exactly one catch-up', async () => {
    await started();
    withCapturedTimers(() => lastFakeES!.fire('close'));
    expect(capturedTimers.length).toBe(1);
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('close followed by error on the same stream still yields one catch-up', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('close');
      lastFakeES!.fire('error');
    });
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('a second open on the same stream (library silent re-open after a clean server end) -> one debounced catch-up', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('open');          // first open: nothing to catch up
    });
    expect(capturedTimers.length).toBe(0);
    withCapturedTimers(() => {
      lastFakeES!.fire('open');          // library re-opened after clean end
      lastFakeES!.fire('open');
    });
    expect(getSyncOpsCalls).toBe(0);
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('legacy guessed shapes are inert: named resync event and {type:resync} message do nothing', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('resync', { data: '{}' });
      lastFakeES!.fire('message', { data: JSON.stringify({ type: 'resync' }) });
    });
    expect(capturedTimers.length).toBe(0);
    await drain();
    expect(getSyncOpsCalls).toBe(0);
  });

  test('heartbeats and non-sync notifications do nothing', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('ping', { data: '' });
      lastFakeES!.fire('heartbeat', { data: '' });
      lastFakeES!.fire('message', { data: JSON.stringify({ type: 'heartbeat' }) });
      lastFakeES!.fire('message', { data: JSON.stringify({ type: 'file.created' }) });
      lastFakeES!.fire('message', { data: ': keepalive' });
    });
    expect(capturedTimers.length).toBe(0);
    await drain();
    expect(getSyncOpsCalls).toBe(0);
  });

  test('a later re-open after the first catch-up ran triggers another catch-up', async () => {
    await started();
    withCapturedTimers(() => { lastFakeES!.fire('open'); lastFakeES!.fire('open'); });
    await runTimers();
    withCapturedTimers(() => lastFakeES!.fire('open'));
    await runTimers();
    expect(getSyncOpsCalls).toBe(2);
  });
});

 test('live ops wait behind catch-up so their higher cursor cannot skip missed ops', async () => {
  const client = await started();
  let resolve;
  getSyncOpsImpl = () => new Promise(r => { resolve = r; });
  const catchingUp = (client as any).catchUp('test'); await drain();
  const op = (seq_id, id) => ({seq_id,op_type:'file_create',payload:{id,name_encrypted:'enc'},created_at:'2026-10-26T00:00:00Z'});
  lastFakeES!.fire('message',{data:JSON.stringify(op(2,'live'))}); await drain();
  resolve([op(1,'missed')]); await catchingUp; await drain();
  expect(client.getAllNodes().map(x=>x.id).sort()).toEqual(['live','missed']);
  expect(client.getLastSeq()).toBe(2); client.stop();
});
