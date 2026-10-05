// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { runBreachCheck } from './breach-step';

function rig(body) {
  const seen = { fetch: [], evaluate: [] };
  const breach = {
    prefix: 'ABCDE',
    evaluate: async (p, b, f) => { seen.evaluate.push([p, b, f]); return { kind: 'clean' }; },
  };
  const fetchBody = async (endpoint, prefix) => {
    seen.fetch.push([endpoint, prefix]);
    if (body instanceof Error) throw body;
    return body;
  };
  return { seen, breach, fetchBody };
}

describe('runBreachCheck', () => {
  test('the SAME prefix goes into the request and into evaluate', async () => {
    const r = rig('SUFFIX:2');
    await runBreachCheck(r.fetchBody, r.breach, { endpoint: '/api/v1/auth/pwned-range/{prefix}', failOpen: true });
    expect(r.seen.fetch).toEqual([['/api/v1/auth/pwned-range/{prefix}', 'ABCDE']]);
    expect(r.seen.evaluate).toEqual([['ABCDE', 'SUFFIX:2', true]]);
  });
  test('fail_open is the document\'s, passed through untouched', async () => {
    for (const failOpen of [true, false]) {
      const r = rig('x');
      await runBreachCheck(r.fetchBody, r.breach, { endpoint: '/api/v1/a/{prefix}', failOpen });
      expect(r.seen.evaluate[0][2]).toBe(failOpen);
    }
  });
  test('a failed or null fetch is an outage (null body), never an exception and never "clean"', async () => {
    for (const body of [null, new Error('offline')]) {
      const r = rig(body);
      await runBreachCheck(r.fetchBody, r.breach, { endpoint: '/api/v1/a/{prefix}', failOpen: false });
      expect(r.seen.evaluate[0][1]).toBeNull();
    }
  });
  test('no valid endpoint means no request at all and an outage', async () => {
    for (const endpoint of [null, undefined, '']) {
      const r = rig('x');
      await runBreachCheck(r.fetchBody, r.breach, { endpoint, failOpen: true });
      expect(r.seen.fetch.length).toBe(0);
      expect(r.seen.evaluate[0][1]).toBeNull();
    }
  });
});
