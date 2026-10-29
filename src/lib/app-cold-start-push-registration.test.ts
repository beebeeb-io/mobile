// @ts-nocheck — this file runs in Bun's isolated test process.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

describe('cold-start push registration wiring', () => {
  test('chains Android push registration after cold-start device registration', () => {
    const coldStartBlock = appSource.match(
      /Register this device with the clients API \(best-effort, cold launch\)\.[\s\S]*?initLocalIdentifierMap\(\)/,
    )?.[0];

    expect(coldStartBlock).toBeDefined();
    expect(coldStartBlock).toMatch(/registerDevice\(\)\.then\(/);
    expect(coldStartBlock).toMatch(/Platform\.OS === 'android'/);
    expect(coldStartBlock).toMatch(/registerForPushNotifications\(clientDeviceId\)/);
  });
});
