// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * LD-0002 round 2 — the deferral queue on its own (`file-provider-cache-write.ts`,
 * no `react-native`): order, supersession by newer writes, the cap, a throwing
 * write, backoff while the app is already foreground.
 */
import { describe, expect, test } from 'bun:test';
import { REPLAY_BASE_DELAY_MS, REPLAY_MAX_DELAY_MS, REPLAY_MAX_RETRIES, createDeferredCacheWrites } from './file-provider-cache-write';

const EPOCH = { generation: 1, accountId: 'a' };
const entry = (id: string, parent: string | null = 'p') => ({ id, parent_id: parent });
const sync = (entries, extra = {}) => ({ kind: 'sync', entries, prune: false, pruneParents: null, trashChanged: false, epoch: EPOCH, ...extra });
const prune = (entries, pruneParents) => sync(entries, { prune: true, pruneParents });
const remove = (ids) => ({ kind: 'remove', ids, epoch: EPOCH });
const root = (id) => ({ kind: 'protected-root', id, epoch: EPOCH });

function queue(extra = {}) {
  const foreground: Array<() => void> = [];
  const ran: unknown[] = [];
  const deferred = createDeferredCacheWrites({
    run: async (write) => { ran.push(JSON.parse(JSON.stringify(write))); return true; },
    subscribeToForeground: (cb) => foreground.push(cb),
    ...extra,
  });
  return { deferred, foreground, ran };
}

describe('createDeferredCacheWrites', () => {
  test('subscribes to the foreground once, on the first deferral; an empty write is not queued', () => {
    const { deferred, foreground } = queue();
    deferred.defer(sync([]));
    deferred.defer(remove([]));
    expect(deferred.size).toBe(0);
    expect(foreground.length).toBe(0);
    deferred.defer(remove(['a']));
    deferred.defer(remove(['b']));
    expect(foreground.length).toBe(1);
  });

  test('runs in order; a refused write stops the queue and stays', async () => {
    let secondAnswers = false;
    const order: string[] = [];
    const { deferred } = queue({ run: async (w) => { order.push(w.ids[0]); return w.ids[0] === 'b' ? secondAnswers : true; } });
    deferred.defer(remove(['a']));
    deferred.defer(remove(['b']));
    deferred.defer(remove(['c']));
    await deferred.replay();
    expect(order).toEqual(['a', 'b']);
    expect(deferred.size).toBe(2);
    secondAnswers = true;
    await deferred.replay();
    expect(order).toEqual(['a', 'b', 'b', 'c']);
    expect(deferred.size).toBe(0);
  });

  test('a write that throws is dropped, reported, and does not stop the ones behind it', async () => {
    const errors: unknown[] = [];
    const order: string[] = [];
    const { deferred } = queue({
      onReplayError: (e) => errors.push(e),
      run: async (w) => { if (w.ids[0] === 'bad') throw new Error('gate closed'); order.push(w.ids[0]); return true; },
    });
    deferred.defer(remove(['bad']));
    deferred.defer(remove(['after']));
    await deferred.replay();
    expect(errors.length).toBe(1);
    expect(order).toEqual(['after']);
    expect(deferred.size).toBe(0);
  });

  test('over the cap the oldest falls off the front and is reported, not dropped silently', () => {
    const dropped: unknown[] = [];
    const { deferred } = queue({ max: 3, onOverflow: (w) => dropped.push(w) });
    for (const id of ['1', '2', '3', '4', '5']) deferred.defer(remove([id]));
    expect(deferred.size).toBe(3);
    expect(dropped.map((w) => w.ids[0])).toEqual(['1', '2']);
  });

  test('a foreground event during a replay is not lost: the queue is re-checked afterwards', async () => {
    let release: () => void = () => {};
    const order: string[] = [];
    const { deferred } = queue({
      run: (w) => new Promise((resolve) => {
        if (w.ids[0] === 'slow') release = () => { order.push('slow'); resolve(true); };
        else { order.push(w.ids[0]); resolve(true); }
      }),
    });
    deferred.defer(remove(['slow']));
    const first = deferred.replay();
    deferred.defer(remove(['late']));
    const second = deferred.replay();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['slow', 'late']);
  });

  test('clear() empties the queue', () => {
    const { deferred } = queue();
    deferred.defer(remove(['a']));
    deferred.clear();
    expect(deferred.size).toBe(0);
  });
});

describe('supersede: a queued write never lands over a newer one', () => {
  test('a restore (a newer upsert of the id) trims a queued removal of it; other ids stay', () => {
    const { deferred } = queue();
    deferred.defer(remove(['restored', 'still-gone']));
    deferred.supersede(sync([entry('restored')]));
    expect(deferred.queued.map((w) => w.ids)).toEqual([['still-gone']]);
    deferred.supersede(sync([entry('still-gone')]));
    expect(deferred.size).toBe(0); // emptied, dropped
  });

  test('a newer removal trims a queued upsert of the id', () => {
    const { deferred } = queue();
    deferred.defer(sync([entry('a'), entry('b')]));
    deferred.supersede(remove(['a']));
    expect(deferred.queued[0].entries.map((e) => e.id)).toEqual(['b']);
  });

  test('a newer COMPLETE listing of a parent replaces that parent in a queued multi-parent prune; the other parents stay', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('a1', 'A'), entry('b1', 'B')], ['A', 'B', 'C']));
    deferred.supersede(prune([entry('a1', 'A'), entry('a2', 'A')], ['A']));
    const queued = deferred.queued[0];
    expect(queued.entries.map((e) => e.id)).toEqual(['b1']);
    expect(queued.pruneParents).toEqual(['B', 'C']);
    expect(queued.prune).toBe(true);
  });

  test('a queued prune of the ROOT is trimmed by a newer root listing (null parent)', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('r1', null)], [null]));
    deferred.supersede(prune([], [null]));
    expect(deferred.size).toBe(0);
  });

  test('a queued prune that loses its last pruned parent but keeps entries stays a prune of the parents those entries are in', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('b1', 'B'), entry('a1', 'A')], ['A']));
    deferred.supersede(prune([entry('a9', 'A')], ['A']));
    const queued = deferred.queued[0];
    expect(queued.entries.map((e) => e.id)).toEqual(['b1']);
    expect(queued.prune).toBe(true);
    expect(queued.pruneParents).toBeNull();
  });

  test('a partial upsert (no prune) of an id trims queued writes of that id and no parent', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('a1', 'A'), entry('a2', 'A')], ['A']));
    deferred.supersede(sync([entry('a1', 'A')]));
    expect(deferred.queued[0].entries.map((e) => e.id)).toEqual(['a2']);
    expect(deferred.queued[0].pruneParents).toEqual(['A']);
  });

  test('the protected root: only the newest id survives', () => {
    const { deferred } = queue();
    deferred.defer(root('old'));
    deferred.supersede(root('new'));
    expect(deferred.size).toBe(0);
    deferred.defer(root('new'));
    expect(deferred.queued.map((w) => w.id)).toEqual(['new']);
  });

  test('a replay that has started but not yet called native sees the trimmed write', async () => {
    let proceed: () => void = () => {};
    const seen: string[][] = [];
    const { deferred } = queue({
      run: async (write) => {
        await new Promise<void>((resolve) => { proceed = resolve; }); // e.g. awaiting the plaintext lease
        seen.push(write.entries.map((e) => e.id)); // read when native is called
        return true;
      },
    });
    deferred.defer(sync([entry('old'), entry('keep')]));
    const replaying = deferred.replay();
    deferred.supersede(sync([entry('old')]));
    proceed();
    await replaying;
    expect(seen).toEqual([['keep']]);
  });

  test('a write trimmed to nothing while it ran is not run again or left behind', async () => {
    let proceed: () => void = () => {};
    let calls = 0;
    const { deferred } = queue({ run: async () => { calls += 1; await new Promise<void>((r) => { proceed = r; }); return false; } });
    deferred.defer(remove(['x']));
    const replaying = deferred.replay();
    deferred.supersede(sync([entry('x')]));
    expect(deferred.size).toBe(0);
    proceed();
    await replaying;
    expect(calls).toBe(1);
    expect(deferred.size).toBe(0);
  });
});

describe('backoff while the app is already foreground', () => {
  function foregroundQueue(refused: { value: boolean }) {
    const delays: number[] = [];
    const scheduled: Array<() => void> = [];
    const q = queue({
      isForeground: () => true,
      scheduleReplay: (run, delay) => { delays.push(delay); scheduled.push(run); },
      run: async () => !refused.value,
    });
    return { ...q, delays, scheduled };
  }

  test('a refusal while foreground is retried with doubling delays, capped, and for a bounded number of times', async () => {
    const refused = { value: true };
    const { deferred, delays, scheduled } = foregroundQueue(refused);
    deferred.defer(remove(['a']));
    expect(delays).toEqual([REPLAY_BASE_DELAY_MS]);
    for (let i = 0; i < 20 && scheduled.length > 0; i++) {
      const next = scheduled.shift();
      next();
      await deferred.replay();
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(REPLAY_MAX_DELAY_MS);
    expect(delays.length).toBe(REPLAY_MAX_RETRIES);
    expect(deferred.size).toBe(1); // still queued: the next foreground event runs it
  });

  test('once it is accepted the queue empties and no further retry is scheduled', async () => {
    const refused = { value: true };
    const { deferred, delays, scheduled } = foregroundQueue(refused);
    deferred.defer(remove(['a']));
    refused.value = false;
    scheduled.shift()();
    await deferred.replay();
    expect(deferred.size).toBe(0);
    expect(delays.length).toBe(1);
  });

  test('a real foreground event restarts the backoff from the beginning', async () => {
    const refused = { value: true };
    const { deferred, delays, scheduled, foreground } = foregroundQueue(refused);
    deferred.defer(remove(['a']));
    scheduled.shift()();
    await deferred.replay();
    expect(delays).toEqual([1000, 2000]);
    foreground[0](); // 'active': the backoff starts over
    await deferred.replay();
    scheduled.shift()(); // the timer that was already pending fires
    await deferred.replay();
    expect(delays[delays.length - 1]).toBe(1000);
  });

  test('in the background nothing is scheduled: only the foreground event runs the queue', () => {
    const delays: number[] = [];
    const { deferred } = queue({ isForeground: () => false, scheduleReplay: (_run, delay) => delays.push(delay) });
    deferred.defer(remove(['a']));
    expect(delays).toEqual([]);
  });
});
