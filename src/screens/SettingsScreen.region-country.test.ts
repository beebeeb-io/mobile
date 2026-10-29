// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 2050 — Settings > Data residency is wired for COUNTRIES and "Only store
// in <country>". Source-text convention (SettingsScreen is too heavy to render
// here); the row/copy logic itself is unit-tested in lib/regions.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'SettingsScreen.tsx'), 'utf-8');

describe('Settings > Data residency (task 2050)', () => {
  test('lists countries under "Or choose a country" and shows Coming soon from the shared copy', () => {
    expect(source).toContain('REGION_COUNTRY_HEADER');
    expect(source).toContain('REGION_COMING_SOON');
    expect(source).toContain('REGION_NOTE');
  });

  test('the strict switch is gated per platform (hidden on iOS/Android, task 2054), strict still carried and shown as a line', () => {
    expect(source).toContain('strictSwitchOnPlatform(regionRows, storageRegion, Platform.OS)');
    expect(source).toContain('strictNoticeFor(regionRows, storageRegion, regionStrict, Platform.OS)');
    expect(source).toContain('testID="region-strict-notice"');
    expect(source).not.toContain('strictSwitchFor(regionRows, storageRegion)');
    expect(source).toContain('testID="region-strict-switch"');
    expect(source).toContain('await selectRegion(row, regionStrict);');
    expect(source).toContain('await setStrict(row, next);');
    expect(source).toContain('setRegionStrict(data.strict);');
  });

  test('no user-facing copy talks about cities or datacenters', () => {
    const literals = source.match(/(['"`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? [];
    const offenders = literals.filter((l) => /\b(city|cities|datacenters?)\b/i.test(l));
    expect(offenders).toEqual([]);
  });

  test('task 2053: strict + unavailable country shows the refusal and an off switch that calls allowOthers', () => {
    expect(source).toContain('testID="region-strict-refusal-switch"');
    expect(source).toContain('await allowOthers(refusal);');
    expect(source).toContain('strictRefusalNote(regionStrictRefusal)');
    expect(source).toContain('setRegionStrictRefusal(data.strictRefusal);');
  });
});
