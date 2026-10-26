// @ts-nocheck
import { expect, test } from 'bun:test';
import { startAccountRefusalPoll } from './account-refusal-poll';

function harness(tick: () => Promise<{shouldStopPolling: boolean}>, active = true) {
  const pending = new Map<number, {fn: () => void; ms: number}>();
  let id = 0;
  const poll = startAccountRefusalPoll(tick, active, {
    setTimeout: (fn, ms) => { pending.set(++id, {fn, ms}); return id; },
    clearTimeout: id => { pending.delete(id); },
  });
  return { poll, pending, fire() { const [key, task] = [...pending][0]; pending.delete(key); task.fn(); } };
}
const drain = async () => { for (let i=0; i<20; i++) await Promise.resolve(); };

test('refused ticks back off 15/30/60/60 seconds and stop at first unblocked tick', async () => {
  let calls = 0;
  const h = harness(async () => ({shouldStopPolling: ++calls === 5}));
  for (const delay of [15_000, 30_000, 60_000, 60_000]) {
    await drain(); expect([...h.pending.values()].map(x => x.ms)).toEqual([delay]); h.fire();
  }
  await drain(); expect(calls).toBe(5); expect(h.pending.size).toBe(0);
});

test('background clears timers and foreground rechecks immediately', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return {shouldStopPolling: false}; });
  await drain(); h.poll.setActive(false); expect(h.pending.size).toBe(0);
  h.poll.setActive(true); await drain(); expect(calls).toBe(2);
  h.poll.stop(); expect(h.pending.size).toBe(0);
});

test('foreground during a pending request stays serial and stop prevents later timers', async () => {
  let calls = 0;
  let resolve;
  const h = harness(async () => { calls++; return new Promise(r => { resolve = r; }); });
  h.poll.setActive(false); h.poll.setActive(true); expect(calls).toBe(1);
  resolve({shouldStopPolling: false}); await drain(); expect(calls).toBe(2);
  h.poll.stop(); resolve({shouldStopPolling: false}); await drain(); expect(h.pending.size).toBe(0);
});

test('repeated active notifications preserve the scheduled retry', async () => {
  const h = harness(async () => ({shouldStopPolling: false}));
  await drain(); h.poll.setActive(true); expect(h.pending.size).toBe(1); h.poll.stop();
});
