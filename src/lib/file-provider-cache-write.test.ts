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
const sync = (entries, extra = {}) => ({ kind: 'sync', entries, prune: false, pruneParents: null, trashChanged: false, epoch: EPOCH, seq: 0, ...extra });
const prune = (entries, pruneParents) => sync(entries, { prune: true, pruneParents });
const remove = (ids) => ({ kind: 'remove', ids, epoch: EPOCH, seq: 0 });
const root = (id) => ({ kind: 'protected-root', id, epoch: EPOCH, seq: 0 });

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

describe('issue: a queued write never lands over a newer one', () => {
  test('a restore (a newer upsert of the id) trims a queued removal of it; other ids stay', () => {
    const { deferred } = queue();
    deferred.defer(remove(['restored', 'still-gone']));
    deferred.issue(sync([entry('restored')]));
    expect(deferred.queued.map((w) => w.ids)).toEqual([['still-gone']]);
    deferred.issue(sync([entry('still-gone')]));
    expect(deferred.size).toBe(0); // emptied, dropped
  });

  test('a newer removal trims a queued upsert of the id', () => {
    const { deferred } = queue();
    deferred.defer(sync([entry('a'), entry('b')]));
    deferred.issue(remove(['a']));
    expect(deferred.queued[0].entries.map((e) => e.id)).toEqual(['b']);
  });

  test('a newer COMPLETE listing of a parent replaces that parent in a queued multi-parent prune; the other parents stay', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('a1', 'A'), entry('b1', 'B')], ['A', 'B', 'C']));
    deferred.issue(prune([entry('a1', 'A'), entry('a2', 'A')], ['A']));
    const queued = deferred.queued[0];
    expect(queued.entries.map((e) => e.id)).toEqual(['b1']);
    expect(queued.pruneParents).toEqual(['B', 'C']);
    expect(queued.prune).toBe(true);
  });

  test('a queued prune of the ROOT is trimmed by a newer root listing (null parent)', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('r1', null)], [null]));
    deferred.issue(prune([], [null]));
    expect(deferred.size).toBe(0);
  });

  test('a queued prune that loses its last pruned parent but keeps entries stays a prune of the parents those entries are in', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('b1', 'B'), entry('a1', 'A')], ['A']));
    deferred.issue(prune([entry('a9', 'A')], ['A']));
    const queued = deferred.queued[0];
    expect(queued.entries.map((e) => e.id)).toEqual(['b1']);
    expect(queued.prune).toBe(true);
    expect(queued.pruneParents).toBeNull();
  });

  test('a partial upsert of an id trims queued writes of that id; queued upserts of other ids stay', () => {
    const { deferred } = queue();
    deferred.defer(sync([entry('a1', 'A'), entry('a2', 'A')]));
    deferred.issue(sync([entry('a1', 'A')]));
    expect(deferred.queued[0].entries.map((e) => e.id)).toEqual(['a2']);
  });

  test('a newer write under a parent whose complete listing is queued: that parent leaves the queued listing (its replay would delete the fresh row)', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('a1', 'A'), entry('a2', 'A'), entry('b1', 'B')], ['A', 'B']));
    // a rename/upload of x in A (a partial push, no prune) lands
    deferred.issue(sync([entry('x', 'A')]));
    const queued = deferred.queued[0];
    expect(queued.entries.map((e) => e.id)).toEqual(['b1']);
    expect(queued.pruneParents).toEqual(['B']);
  });

  test('a queued listing of the only parent a newer write touched is dropped whole', () => {
    const { deferred } = queue();
    deferred.defer(prune([entry('a1', 'A')], ['A']));
    deferred.issue(sync([entry('x', 'A')]));
    expect(deferred.size).toBe(0);
  });

  test('the protected root: only the newest id survives', () => {
    const { deferred } = queue();
    deferred.defer(root('old'));
    deferred.issue(root('new'));
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
    deferred.issue(sync([entry('old')]));
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
    deferred.issue(sync([entry('x')]));
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

describe('sequence: a write refused AFTER a newer one landed is not queued over it', () => {
  test('A (a listing of P) is issued, B (a newer listing of P) is issued and lands, then A comes back not_now: A is not queued', () => {
    const { deferred } = queue();
    const a = prune([entry('old1', 'P'), entry('old2', 'P')], ['P']);
    const b = prune([entry('new1', 'P')], ['P']);
    deferred.issue(a);
    deferred.issue(b);
    expect(b.seq).toBeGreaterThan(a.seq);
    deferred.landed(b);
    deferred.defer(a); // refused late
    expect(deferred.size).toBe(0);
  });

  test('only what the newer write covers is dropped from the late write', () => {
    const { deferred } = queue();
    const a = prune([entry('a1', 'A'), entry('b1', 'B')], ['A', 'B']);
    const b = prune([entry('a9', 'A')], ['A']);
    deferred.issue(a);
    deferred.issue(b);
    deferred.landed(b);
    deferred.defer(a);
    expect(deferred.queued[0].entries.map((e) => e.id)).toEqual(['b1']);
    expect(deferred.queued[0].pruneParents).toEqual(['B']);
  });

  test('a trash refused late is not queued over a restore that landed', () => {
    const { deferred } = queue();
    const trash = remove(['x', 'y']);
    const restore = sync([entry('x')]);
    deferred.issue(trash);
    deferred.issue(restore);
    deferred.landed(restore);
    deferred.defer(trash);
    expect(deferred.queued[0].ids).toEqual(['y']);
  });

  test('an older protected-root id refused after a newer one landed is not queued', () => {
    const { deferred } = queue();
    const older = root('old');
    const newer = root('new');
    deferred.issue(older);
    deferred.issue(newer);
    deferred.landed(newer);
    deferred.defer(older);
    expect(deferred.size).toBe(0);
  });

  test('a write that landed AFTER the late one was issued is the only kind that trims it: an older landed write does not', () => {
    const { deferred } = queue();
    const earlier = sync([entry('x')]);
    deferred.issue(earlier);
    deferred.landed(earlier);
    const later = remove(['x']);
    deferred.issue(later); // issued after `earlier` landed
    deferred.defer(later);
    expect(deferred.queued[0].ids).toEqual(['x']);
  });

  test('a queued write that replays successfully counts as landed for later refusals', async () => {
    const { deferred } = queue();
    const queued = sync([entry('x')]);
    deferred.issue(queued);
    deferred.defer(queued);
    const late = remove(['x']);
    // `late` was issued BEFORE `queued`
    late.seq = queued.seq - 1;
    await deferred.replay(); // `queued` runs and lands
    deferred.defer(late);
    expect(deferred.size).toBe(0);
  });
});

describe('undo: a newer write that FAILS puts the trimmed queue back', () => {
  test('trimmed ids, trimmed parents and a dropped write all come back', () => {
    const { deferred } = queue();
    deferred.defer(remove(['a', 'b']));
    deferred.defer(prune([entry('p1', 'P'), entry('q1', 'Q')], ['P', 'Q']));
    deferred.defer(root('r'));
    const before = JSON.parse(JSON.stringify(deferred.queued));
    const undo = deferred.issue(prune([entry('p2', 'P'), entry('a', 'P')], ['P']));
    deferred.issue(root('r2'));
    expect(JSON.stringify(deferred.queued)).not.toBe(JSON.stringify(before));
    undo();
    // the root issue was a different call; undo of the first restores everything the first changed
    const restored = deferred.queued.filter((w) => w.kind !== 'protected-root');
    expect(restored.map((w) => (w.kind === 'remove' ? w.ids : w.entries.map((e) => e.id)))).toEqual([['a', 'b'], ['p1', 'q1']]);
    expect(restored[1].pruneParents).toEqual(['P', 'Q']);
  });

  test('a write emptied and dropped by the newer one is reinserted at its place', () => {
    const { deferred } = queue();
    deferred.defer(remove(['a']));
    deferred.defer(remove(['b']));
    const undo = deferred.issue(sync([entry('a'), entry('b')]));
    expect(deferred.size).toBe(0);
    undo();
    expect(deferred.queued.map((w) => w.ids)).toEqual([['a'], ['b']]);
  });

  test('after an account boundary the undo restores nothing', () => {
    const { deferred } = queue();
    deferred.defer(remove(['a']));
    const undo = deferred.issue(sync([entry('a')]));
    deferred.clear();
    undo();
    expect(deferred.size).toBe(0);
  });

  test('a queued write a replay already applied is not put back by the undo', async () => {
    const { deferred, ran } = queue();
    deferred.defer(remove(['a', 'b']));
    const undo = deferred.issue(sync([entry('a')]));
    await deferred.replay(); // runs remove(['b'])
    undo();
    expect(deferred.size).toBe(0);
    expect(ran.length).toBe(1);
  });
});

describe('round 4: a late or restored write never brings back stale rows', () => {
  test('a prune refused late loses a parent that a newer NON-prune write under it landed (the replay would delete the fresh row)', () => {
    const { deferred } = queue();
    const a = prune([entry('x', 'P'), entry('y', 'P')], ['P']);
    const b = sync([entry('x', 'P')]);
    deferred.issue(a);
    deferred.issue(b);
    deferred.landed(b);
    deferred.defer(a);
    expect(deferred.size).toBe(0); // P leaves A: nothing left to replay
  });

  test('...and keeps the other parents of that listing', () => {
    const { deferred } = queue();
    const a = prune([entry('x', 'P'), entry('q', 'Q')], ['P', 'Q']);
    const b = sync([entry('x', 'P')]);
    deferred.issue(a);
    deferred.issue(b);
    deferred.landed(b);
    deferred.defer(a);
    expect(deferred.queued[0].entries.map((e) => e.id)).toEqual(['q']);
    expect(deferred.queued[0].pruneParents).toEqual(['Q']);
  });

  test('an undo does not bring back data a later write already replaced: a deleted file does not reappear', () => {
    const { deferred } = queue();
    deferred.defer(sync([entry('x')])); // Q
    const undo = deferred.issue(sync([entry('x')])); // N1 trims Q to nothing
    expect(deferred.size).toBe(0);
    const n2 = remove(['x']);
    deferred.issue(n2);
    deferred.landed(n2); // N2 removes x and lands
    undo(); // N1 fails
    expect(deferred.size).toBe(0); // Q is NOT put back with x
  });

  test('a replay re-checks what landed before it runs a write', async () => {
    const ran: string[] = [];
    const { deferred } = queue({ run: async (w) => { ran.push(w.kind === 'sync' ? w.entries.map((e) => e.id).join(',') : 'other'); return true; } });
    const old = sync([entry('x'), entry('y')]);
    deferred.issue(old);
    const later = remove(['x']);
    deferred.issue(later);
    deferred.landed(later);
    deferred.defer(old);
    await deferred.replay();
    expect(ran).toEqual(['y']);
  });

  test('issue() snapshots only what it changes: untouched queued writes keep their arrays', () => {
    const { deferred } = queue();
    const untouched = sync([entry('keep', 'K')]);
    deferred.defer(untouched);
    const entriesBefore = untouched.entries;
    const undo = deferred.issue(sync([entry('other', 'O')]));
    expect(untouched.entries).toBe(entriesBefore);
    undo();
    expect(untouched.entries).toBe(entriesBefore);
    expect(deferred.size).toBe(1);
  });

  test('a replay that THROWS did not land: it does not trim older writes of the same targets', async () => {
    const dropped: unknown[] = [];
    const { deferred } = queue({
      onReplayError: (e) => dropped.push(e),
      run: async (w) => { if (w.kind === 'remove') throw new Error('native failure'); return true; },
    });
    const old = sync([entry('x')]);
    deferred.issue(old);
    const failing = remove(['x']);
    deferred.issue(failing);
    deferred.defer(failing);
    await deferred.replay(); // the removal of x throws and is dropped: x was NOT removed
    expect(dropped.length).toBe(1);
    deferred.defer(old); // the older upsert of x is refused late: nothing newer LANDED for x
    expect(deferred.queued.map((w) => w.entries.map((e) => e.id))).toEqual([['x']]);
  });
});
