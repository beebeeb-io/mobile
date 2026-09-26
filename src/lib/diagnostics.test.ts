// @ts-nocheck
import { afterEach, describe, expect, test } from 'bun:test';
import { runDiagnostics } from './diagnostics';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function finalResult(apiUrl: string) {
  let last;
  for await (const r of runDiagnostics(apiUrl)) last = r;
  return last;
}

describe('runDiagnostics DNS check targets the configured API host', () => {
  test('a local API URL is labelled localhost, not api.beebeeb.io', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (url: string) => {
      calls.push(String(url));
      if (String(url).startsWith('https://beebeeb.io')) return new Response(null, { status: 200 });
      throw new TypeError('Network request failed');
    };
    const r = await finalResult('http://localhost:3350');
    const dns = r.checks.find((c) => c.id === 'dns');
    expect(dns.status).toBe('fail');
    expect(dns.detail).toContain('localhost:3350');
    expect(dns.detail).not.toContain('api.beebeeb.io');
    expect(r.summary).toContain('localhost:3350');
    expect(r.summary).not.toContain('api.beebeeb.io');
    // The probes themselves went to the configured host.
    expect(calls.some((u) => u.startsWith('http://localhost:3350/health'))).toBe(true);
    expect(calls.some((u) => u.includes('api.beebeeb.io'))).toBe(false);
  });

  test('the production URL still names api.beebeeb.io', async () => {
    globalThis.fetch = async (url: string) => {
      if (String(url).startsWith('https://beebeeb.io')) return new Response(null, { status: 200 });
      throw new TypeError('Network request failed');
    };
    const r = await finalResult('https://api.beebeeb.io');
    const dns = r.checks.find((c) => c.id === 'dns');
    expect(dns.detail).toBe('cannot resolve api.beebeeb.io');
    expect(r.summary).toBe("Can't resolve api.beebeeb.io. Your DNS might be blocking us.");
  });
});
