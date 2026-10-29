// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { describeApiEnvironment } from './api-environment';

describe('describeApiEnvironment', () => {
  test('the shared dev API and a lane\'s own loopback port are both Local', () => {
    for (const u of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://10.0.2.2:3001', 'http://localhost:3146']) {
      expect(describeApiEnvironment(u).kind, u).toBe('local');
      expect(describeApiEnvironment(u).label).toBe('Local');
    }
  });
  test('production is Production', () => {
    expect(describeApiEnvironment('https://api.beebeeb.io')).toEqual({ kind: 'production', label: 'Production', baseUrl: 'https://api.beebeeb.io' });
  });
  test('anything else is Custom, never mistaken for Local (no port, https, other hosts, lookalikes)', () => {
    for (const u of ['http://localhost', 'https://localhost:3001', 'http://evil.example:3001', 'http://localhost.evil.example:3001', 'http://192.168.1.2:3001', 'https://api.beebeeb.io.evil.example']) {
      expect(describeApiEnvironment(u).kind, u).toBe('custom');
    }
  });
});
