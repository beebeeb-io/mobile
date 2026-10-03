// @ts-nocheck
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
mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'session-token',
  getStreamToken: async () => {
    getStreamTokenCalls += 1;
    return { stream_token: 'tok', expires_at: '2099-01-01T00:00:00Z' };
  },
  submitSyncOps: async () => ({ applied: [], rejected: [] }),
  getSnapshot: async () => ({ seq_id: 0, nodes: [] }),
  getSyncOps: async () => [],
}));

mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: async () => null,
  saveCachedFileIndex: async () => {},
  clearCachedFileIndex: async () => {},
}));

mock.module('./file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async () => {},
}));

mock.module('./device-identity', () => ({
  getDeviceId: async () => 'device-1',
}));

const {
  SyncClient,
  reconnectDelayMs,
  RECONNECT_MAX_DELAY_MS,
  setSyncClientAppState,
} = await import('./sync-client');

const JITTER = 0.2;

// Captured (fn, ms) pairs from setTimeout while a test drives failures —
// installed per-test by withCapturedTimers; timers NEVER auto-fire, tests
// decide what runs.
let capturedTimers: Array<{ fn: () => void; ms: number }> = [];
const realSetTimeout = globalThis.setTimeout;

function withCapturedTimers<T>(fn: () => T): T {
  capturedTimers = [];
  globalThis.setTimeout = ((inner: () => void, ms?: number) => {
    capturedTimers.push({ fn: inner, ms: ms ?? 0 });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    return fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

function fireAppState(next: string) {
  currentState = next;
  for (const listener of [...appStateListeners]) listener(next);
}

// `start()` fires openStream() un-awaited (`void this.openStream()`), so the
// EventSource is constructed a few microtasks later. Drain the microtask
// queue before a test touches `lastFakeES`.
async function drainMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// Deterministic wait for an async step of the client (e.g. openStream's
// token fetch / EventSource construction) to land — bounded, then fail loud.
async function waitUntil(cond: () => boolean, what: string, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntil: ${what} not met within ${maxTicks} microtask ticks`);
}

describe('reconnectDelayMs (task 1686 — honest backoff)', () => {
  test('every sample is capped: at most 1.2 × RECONNECT_MAX_DELAY_MS even for huge attempt counts', () => {
    const capTop = Math.ceil(RECONNECT_MAX_DELAY_MS * (1 + JITTER));
    for (let attempts = 0; attempts <= 40; attempts++) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const d = reconnectDelayMs(attempts, () => r);
        expect(d <= capTop).toBe(true);
        expect(d > 0).toBe(true);
      }
    }
    // And the deep-attempt samples all sit at the capped plateau (no
    // unbounded growth anywhere in the reachable range).
    for (let attempts = 12; attempts <= 40; attempts++) {
      const d = reconnectDelayMs(attempts, () => 0.999999);
      expect(d <= capTop).toBe(true);
      expect(d >= Math.floor(RECONNECT_MAX_DELAY_MS * (1 - JITTER))).toBe(true);
    }
  });

  test('every sample sits within the ±20% band [curve×0.8, curve×1.2]', () => {
    for (let attempts = 0; attempts <= 20; attempts++) {
      const curve = Math.min(1500 * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
      const lo = Math.floor(curve * (1 - JITTER));
      const hi = Math.floor(curve * (1 + JITTER));
      for (let r = 0; r < 1; r += 0.05) {
        const d = reconnectDelayMs(attempts, () => r);
        expect(d >= lo).toBe(true);
        expect(d <= hi).toBe(true);
      }
    }
  });

  test('bottom-of-band samples hit curve×0.8 exactly; monotone non-decreasing across attempts', () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(1200); // 1500 × 0.8
    expect(reconnectDelayMs(1, () => 0)).toBe(2400); // 3000 × 0.8
    expect(reconnectDelayMs(2, () => 0)).toBe(4800); // 6000 × 0.8
    // Monotone non-decreasing across attempts for any fixed r (here r=0.5 →
    // exactly the curve).
    let prev = 0;
    for (let a = 0; a <= 25; a++) {
      const d = reconnectDelayMs(a, () => 0.5);
      expect(d >= prev).toBe(true);
      prev = d;
    }
    // r=0.5 → jitter = 1.0 → the exact old exponential curve.
    expect(reconnectDelayMs(0, () => 0.5)).toBe(1500);
    expect(reconnectDelayMs(1, () => 0.5)).toBe(3000);
    expect(reconnectDelayMs(2, () => 0.5)).toBe(6000);
  });
});

describe('SyncClient reconnect pause (task 1686 — app-state seam)', () => {
  beforeEach(() => {
    secureStore.clear();
    getStreamTokenCalls = 0;
    appStateListeners.clear();
    lastFakeES = null;
    currentState = 'active';
    setSyncClientAppState('active');
  });

  test('a stream error while the app is backgrounded schedules NO reconnect timer; foreground replays exactly one', async () => {
    const client = new SyncClient();
    await client.start();
    await drainMicrotasks();
    const tokenCallsAtStart = getStreamTokenCalls;

    withCapturedTimers(() => {
      // Background the app (fire through the RN AppState listeners so the
      // module seam AND the client's listener both see it).
      fireAppState('background');
      setSyncClientAppState('background');

      // Stream dies while backgrounded.
      lastFakeES!.fire('error');

      // No reconnect timer may be scheduled while backgrounded.
      expect(capturedTimers.length).toBe(0);

      // Further background failures (flapping) also defer — never pile up.
      lastFakeES!.fire('error');
      expect(capturedTimers.length).toBe(0);

      // Foreground: exactly ONE reconnect is replayed.
      fireAppState('active');
      setSyncClientAppState('active');
      expect(capturedTimers.length).toBe(1);
    });

    // The paused loop made no token requests while backgrounded.
    expect(getStreamTokenCalls).toBe(tokenCallsAtStart);

    client.stop();
  });

  test('foreground-only reconnect replay: a second backgrounded failure + foreground schedules exactly one more, not a pile', async () => {
    const client = new SyncClient();
    await client.start();
    await drainMicrotasks();

    const scheduleCount = () => capturedTimers.length;
    withCapturedTimers(() => {
      fireAppState('background');
      setSyncClientAppState('background');
      lastFakeES!.fire('error');
      lastFakeES!.fire('error');
      lastFakeES!.fire('error');
      expect(scheduleCount()).toBe(0);

      fireAppState('active');
      setSyncClientAppState('active');
      expect(scheduleCount()).toBe(1);

      // While foregrounded, failures schedule normally again (one per failure).
      lastFakeES!.fire('error');
      expect(scheduleCount()).toBe(2);
    });

    client.stop();
  });
});

describe('SyncClient flapping-connection guard (task 1686)', () => {
  beforeEach(() => {
    secureStore.clear();
    getStreamTokenCalls = 0;
    appStateListeners.clear();
    lastFakeES = null;
    currentState = 'active';
    setSyncClientAppState('active');
  });

  test('a stream that dies between token fetch and open keeps the backoff ladder climbing', async () => {
    const client = new SyncClient();
    await client.start();
    await waitUntil(() => lastFakeES !== null, 'initial EventSource');

    // Cycle 1: the stream 'error's before ever firing 'open' — a failed
    // handshake. scheduleReconnect must treat this as the start of an outage.
    withCapturedTimers(() => {
      lastFakeES!.fire('error');
    });
    let timer = capturedTimers.pop()!;
    const delays: number[] = [timer.ms];

    // Cycles 2-3: reconnect (token fetch + new stream), and the new stream
    // again dies WITHOUT ever firing 'open' or delivering an op.
    for (let cycle = 0; cycle < 2; cycle++) {
      timer.fn(); // reconnect() → openStream() (both fully async)
      const esBefore = lastFakeES;
      await waitUntil(() => lastFakeES !== esBefore, `reconnect ${cycle + 2} opened a new stream`);
      withCapturedTimers(() => {
        lastFakeES!.fire('error');
      });
      timer = capturedTimers.pop()!;
      delays.push(timer.ms);
    }

    // OLD behavior: every failure reset attempts → every delay the 1.5 s
    // floor band [1200, 1800]. NEW behavior: the ladder climbs — the bands
    // for attempts 1/2/3 are [1200,1800] / [2400,3600] / [4800,7200], so the
    // delays are strictly increasing no matter where each draw lands.
    expect(delays.length).toBe(3);
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
    // And the third delay is already past the entire old floor band.
    expect(delays[2]).toBeGreaterThan(1800);

    client.stop();
  });

  test('a stream that opens cleanly and later drops resets the ladder (long-lived connection ≠ flapping)', async () => {
    const client = new SyncClient();
    await client.start();
    await waitUntil(() => lastFakeES !== null, 'initial EventSource');

    // Climb the ladder with three failed handshakes first.
    withCapturedTimers(() => {
      lastFakeES!.fire('error');
    });
    let timer = capturedTimers.pop()!;
    const flappingDelays = [timer.ms];
    for (let cycle = 0; cycle < 2; cycle++) {
      timer.fn();
      const esBefore = lastFakeES;
      await waitUntil(() => lastFakeES !== esBefore, `flap reconnect ${cycle + 2} opened a new stream`);
      withCapturedTimers(() => {
        lastFakeES!.fire('error');
      });
      timer = capturedTimers.pop()!;
      flappingDelays.push(timer.ms);
    }
    // Ladder climbed: third flapping delay is past the attempt-0 band.
    expect(flappingDelays[2]).toBeGreaterThan(1800);

    // Now the next stream GENUINELY connects: 'open' fires, an op arrives,
    // and only then does it drop.
    timer.fn();
    const esBefore = lastFakeES;
    await waitUntil(() => lastFakeES !== esBefore, 'post-flap reconnect opened a new stream');
    withCapturedTimers(() => {
      lastFakeES!.fire('open');
      lastFakeES!.fire('message', { data: JSON.stringify({ seq_id: 1, op_type: 'file_create', payload: { id: 'x' } }) });
      lastFakeES!.fire('error');
    });
    const afterCleanDrop = capturedTimers.pop()!.ms;

    // After a genuinely connected session the ladder is back at the attempt-0
    // band [1200, 1800] — reset, not continuing the climb (which would be
    // ≥ 4800).
    expect(afterCleanDrop).toBeGreaterThanOrEqual(1200);
    expect(afterCleanDrop).toBeLessThanOrEqual(1800);

    client.stop();
  });
});
