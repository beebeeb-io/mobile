// @ts-nocheck
/**
 * Task 1962 round 4 — Bug 7f/7h guard.
 *
 * A forced sign-out resets and purges the native thumbnail queue
 * (`ThumbnailQueueDB.swift`) and the app-process storage.
 *
 * Invariant: `clearQueueOnSignOut` and
 * `purgePlaintextStorage` stay plain synchronous `AsyncFunction`s on
 * Expo's shared serial queue (no `runOnQueue`, no `async` closure), so
 * the native order matches the JS order of the sign-out.
 *
 * Matrix 4's behavioural half (an advanced epoch makes the check fail) runs
 * against the real `account-epoch` module; this file mocks nothing else.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { accountEpoch, advanceAccountEpoch, isCurrentAccountEpoch } from './account-epoch';

const ROOT = join(import.meta.dir, '../..');
const THUMBNAIL_MODULE = join(ROOT, 'modules/beebeeb-crypto/ios/ThumbnailServiceModule.swift');
const CRYPTO_MODULE = join(ROOT, 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift');
const WORKER_POOL = join(ROOT, 'modules/beebeeb-crypto/ios/ThumbnailWorkerPool.swift');

function extractBody(source: string, signature: RegExp): string {
  const sigMatch = signature.exec(source);
  if (!sigMatch) {
    throw new Error(`signature not found: ${signature}`);
  }
  const openBraceIndex = source.indexOf('{', sigMatch.index + sigMatch[0].length);
  if (openBraceIndex === -1) {
    throw new Error(`no opening brace found after signature: ${signature}`);
  }
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  throw new Error(`unbalanced braces after signature: ${signature}`);
}

function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

describe('matrix 4: an enqueue after the epoch advanced is dropped by the guard', () => {
  test('isCurrentAccountEpoch is false once the account epoch advances', () => {
    const captured = accountEpoch();
    expect(isCurrentAccountEpoch(captured)).toBe(true);
    advanceAccountEpoch();
    expect(isCurrentAccountEpoch(captured)).toBe(false);
  });
});

describe('sign-out native functions stay synchronous on Expo\'s shared serial queue (7f, 7h)', () => {
  const thumbnailModule = readFileSync(THUMBNAIL_MODULE, 'utf8');
  const cryptoModule = readFileSync(CRYPTO_MODULE, 'utf8');

  const cases: Array<[string, string, RegExp]> = [
    ['clearQueueOnSignOut', thumbnailModule, /AsyncFunction\("clearQueueOnSignOut"\)/],
    ['purgePlaintextStorage', cryptoModule, /AsyncFunction\("purgePlaintextStorage"\)/],
  ];

  for (const [name, source, signature] of cases) {
    test(`${name} does not hop queues or wrap an async closure`, () => {
      const body = stripLineComments(extractBody(source, signature));
      expect(body).not.toContain('runOnQueue');
      expect(body).not.toMatch(/\bTask\s*\{/);
      expect(body).not.toMatch(/\basync\b/);
      expect(body).not.toMatch(/\bawait\b/);
    });
  }

  test('clearQueueOnSignOut still cancels the pool and clears the queue (7h)', () => {
    const body = stripLineComments(extractBody(thumbnailModule, /AsyncFunction\("clearQueueOnSignOut"\)/));
    expect(body).toContain('cancelAll()');
    expect(body).toContain('clearAll()');
  });
});

describe('the app-process purge resets the thumbnail queue and keeps its files (7b)', () => {
  const cryptoModule = readFileSync(CRYPTO_MODULE, 'utf8');
  const body = stripLineComments(
    extractBody(cryptoModule, /AsyncFunction\("purgePlaintextStorage"\)/),
  );

  test('workers are stopped, then the queue is reset, both BEFORE the registry purge', () => {
    const cancel = body.indexOf('ThumbnailWorkerPool.shared.cancelAll()');
    const reset = body.indexOf('ThumbnailQueueDB.prepareForStoragePurge()');
    const purgeAll = body.indexOf('PlaintextStorageProtection.purgeAll(');
    expect(cancel).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(cancel);
    expect(purgeAll).toBeGreaterThan(reset);
  });

  test('the registry purge keeps all three queue files in every outcome', () => {
    // `preserving:` is the manifest's kept set UNION the queue's own
    // [.sqlite, -wal, -shm] — so neither a successful nor a failed reset can
    // let the sweep unlink a database under a live connection (7d closes and
    // unlinks them itself).
    expect(body).toMatch(
      /PlaintextStorageProtection\.purgeAll\(pendingNonce: pendingNonce, preserving: manifest\.kept\.union\(ThumbnailQueueDB\.storagePurgePaths\(\)\)\)/,
    );
  });

});

describe('a purge generation stops in-flight workers and pump() (round 5, P2.6)', () => {
  const pool = stripLineComments(readFileSync(WORKER_POOL, 'utf8'));

  test('cancelAll bumps the generation and pump() refuses a stale one', () => {
    const cancelAll = extractBody(pool, /public func cancelAll\(\)/);
    expect(cancelAll).toContain('purgeGate.purge()');
    const pumpBody = extractBody(pool, /func pump\(\)/);
    expect(pumpBody).toContain('purgeGate.allowsPump');
    expect(pumpBody).toMatch(/if isPaused \|\| !mayPump \{ return \}/);
  });

  test('the next account bind re-enables the pool', () => {
    const bind = extractBody(pool, /public func bindAccount\(\)/);
    expect(bind).toContain('purgeGate.bind()');
    const enqueue = extractBody(pool, /public func enqueue\(fileIds: \[String\], qualityPreset: String\)/);
    expect(enqueue).toContain('bindAccount()');
  });

  test('a worker captures its generation and discards a stale result before any write', () => {
    const enqueueOp = extractBody(pool, /private func enqueueOperation\(item: ThumbnailQueueDB\.Item\)/);
    expect(enqueueOp).toContain('let generation = currentPurgeGeneration()');
    expect(enqueueOp).toContain('runOne(item: item, generation: generation)');
    const runOne = extractBody(pool, /private func runOne\(item: ThumbnailQueueDB\.Item, generation: UInt64\) async/);
    const guardIndex = runOne.indexOf('guard self.isPurgeGenerationCurrent(generation) else');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(runOne.indexOf('ThumbnailQueueDB.shared.markSucceeded'));
    expect(guardIndex).toBeLessThan(runOne.indexOf('onFileCompleted?('));
  });
});

describe('the stats timer is serialized on one queue (round 5, P2.7)', () => {
  const pool = stripLineComments(readFileSync(WORKER_POOL, 'utf8'));

  test('all timer access goes through the stats queue, with a specific key for the handler', () => {
    expect(pool).toContain('statsTimerQueue.setSpecific(key: statsTimerQueueKey');
    expect(pool).toContain('DispatchQueue.getSpecific(key: statsTimerQueueKey)');
    const start = extractBody(pool, /private func startStatsTimerIfNeeded\(\)/);
    expect(start).toContain('onStatsTimerQueue');
    const stop = extractBody(pool, /private func stopStatsTimer\(\)/);
    expect(stop).toContain('onStatsTimerQueue');
  });
});
